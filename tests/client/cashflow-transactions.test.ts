import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Locator, type Page } from "playwright";

const green = "rgb(47, 107, 72)", red = "rgb(173, 67, 59)", normal = "rgb(51, 42, 24)";

async function assertMoney(locator: Locator, text: string, color: string) {
  assert.equal(await locator.textContent(), text);
  assert.equal(await locator.evaluate(element => getComputedStyle(element).color), color);
}

async function chooseFilter(page: Page, name: string, value: RegExp) {
  await page.locator("#transactions").getByRole("button", { name: name + "で絞り込み", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: name + "で絞り込み", exact: true });
  await dialog.getByRole("checkbox", { name: "候補の値をすべて選択", exact: true }).uncheck();
  await dialog.getByRole("checkbox", { name: value }).check();
  await dialog.getByRole("button", { name: "適用", exact: true }).click();
}

test("収支・清算・明細の符号と色、種別編集と絞り込みをPC/mobileで検証する", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/cashflow-transactions.tsx"], bundle: true, write: false,
    outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    const asset = bundle.outputFiles.find(file => file.path.endsWith(req.url === "/bundle.css" ? "/bundle.css" : "/bundle.js"));
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : req.url === "/bundle.css" ? "text/css" : "text/html");
    res.end(req.url?.startsWith("/bundle.") ? asset!.text : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(resolve => server.close(() => resolve())); throw error; });
  try {
    for (const width of [1440, 390, 320]) await t.test(`${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ja-JP" });
      const page = await context.newPage(), errors: string[] = [], writes: Record<string, unknown>[] = [];
      page.setDefaultTimeout(6000);
      page.on("pageerror", error => errors.push(error.message));
      let fail = true;
      await page.clock.setFixedTime(new Date("2026-10-15T03:00:00.000Z"));
      await page.route("**/api/app", async route => {
        const payload = route.request().postDataJSON();
        writes.push(payload);
        if (fail) { await route.fulfill({ status: 503, json: { error: "種別の保存失敗" } }); return; }
        await route.fulfill({ json: { ok: true, transaction: { ...payload, id: payload.transactionId,
          actorName: payload.actorUserId === "a" ? "A" : "B" } } });
      });
      try {
        for (const [mode, expected, color, payment] of [
          ["positive", "+￥6,000", green, "−￥11,000"],
          ["negative", "−￥1,000", red, "−￥18,000"],
          ["zero", "￥0", normal, "−￥17,000"],
        ]) {
          await page.goto(origin + "?balance=" + mode);
          const month = page.locator("#home .kpi").nth(0);
          await month.locator("strong").waitFor();
          await assertMoney(month.locator(":scope > strong"), expected, color);
          assert.equal(await month.locator(":scope > span").textContent(), "今月の収支（月全体）");
          assert.match(await month.locator("small").textContent() ?? "", /5件の取引/);
          await assertMoney(month.locator("small span").nth(0), "+￥17,000", green);
          await assertMoney(month.locator("small span").nth(1), payment, red);
          await assertMoney(page.locator("#home .kpi").nth(1).locator(":scope > strong"), "−￥8,000", red);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        }
        await page.goto(origin);
        const home = page.locator("#home"), transactions = page.locator("#transactions"), settlement = page.locator("#settlement");
        const payment = transactions.locator('[data-transaction-id="payment"]');
        const receipt = transactions.locator('[data-transaction-id="receipt"]');
        const settled = transactions.locator('[data-transaction-id="settled-receipt"]');
        await payment.waitFor();
        await assertMoney(home.locator(".recent-row").filter({ has: page.locator("b", { hasText: /^payment$/ }) }).locator(":scope > strong"), "−￥10,000", red);
        await assertMoney(home.locator(".recent-row").filter({ has: page.locator("b", { hasText: /^receipt$/ }) }).locator(":scope > strong"), "+￥2,000", green);
        assert.deepEqual(await settlement.locator(".people-flow b").allTextContents(), ["B", "A"]);
        assert.equal(await settlement.locator(".settlement-hero > strong").textContent(), "￥6,000");
        const summary = settlement.locator(".summary-list dd");
        await assertMoney(summary.nth(0), "−￥10,000", red);
        await assertMoney(summary.nth(1), "+￥2,000", green);
        await assertMoney(summary.nth(2), "−￥8,000", red);
        const people = settlement.locator(".person-calc");
        assert.deepEqual(await people.nth(0).locator("p").allTextContents(), ["実際の収支 −￥10,000", "配分後の収支 −￥4,000", "清算で受け取る額 +￥6,000"]);
        assert.deepEqual(await people.nth(1).locator("p").allTextContents(), ["実際の収支 +￥2,000", "配分後の収支 −￥4,000", "清算で支払う額 −￥6,000"]);
        await assertMoney(people.nth(0).locator("p b").nth(2), "+￥6,000", green);
        await assertMoney(people.nth(1).locator("p b").nth(2), "−￥6,000", red);
        assert.equal(await settlement.locator(".history strong").textContent(), "￥600", "双方に共通の送金指示・履歴は方向と絶対額を維持する");
        assert.equal(writes.length, 0);

        if (width < 768) {
          await assertMoney(payment.getByRole("button", { name: "paymentの詳細を開く", exact: true }).locator("strong"), "−￥10,000", red);
          await assertMoney(receipt.getByRole("button", { name: "receiptの詳細を開く", exact: true }).locator("strong"), "+￥2,000", green);
          await assertMoney(settled.getByRole("button", { name: "settled-receiptの詳細を開く", exact: true }).locator("strong"), "+￥5,000", green);
          await payment.getByRole("button", { name: "paymentの詳細を開く", exact: true }).click();
          await receipt.getByRole("button", { name: "receiptの詳細を開く", exact: true }).click();
          await settled.getByRole("button", { name: "settled-receiptの詳細を開く", exact: true }).click();
        }
        assert.equal(await payment.getByLabel("支払者", { exact: true }).inputValue(), "a");
        assert.equal(await receipt.getByLabel("受取者", { exact: true }).inputValue(), "b");
        assert.equal(await settled.locator('[data-label="種別"]').textContent(), "収入");
        assert.equal(await settled.getByLabel("種別", { exact: true }).count(), 0, "清算済みの種別は変更不可");
        await assertMoney(settled.locator('[data-label="金額（円）"]'), "+￥5,000", green);
        assert.deepEqual(await settled.locator('[data-label^="配分割合"] span.positive').allTextContents(), ["+￥2,500", "+￥2,500"]);

        await chooseFilter(page, "金額（円）", /^−￥10,000/);
        assert.deepEqual(await transactions.locator("tr[data-transaction-id]").evaluateAll(rows => rows.map(row => row.getAttribute("data-transaction-id"))), ["payment"], "同額の収入を支払いの金額フィルタに含めない");
        await transactions.getByRole("button", { name: "絞り込みをすべて解除", exact: true }).click();
        await chooseFilter(page, "種別", /^収入/);
        assert.deepEqual(await transactions.locator("tr[data-transaction-id]").evaluateAll(rows => rows.map(row => row.getAttribute("data-transaction-id"))), ["receipt", "settled-receipt", "same-amount-receipt"]);
        await transactions.getByRole("button", { name: "絞り込みをすべて解除", exact: true }).click();
        if (width < 768) await payment.getByRole("button", { name: "paymentの詳細を開く", exact: true }).click();
        const type = payment.getByLabel("種別", { exact: true });
        await type.selectOption("RECEIPT");
        const feedback = transactions.locator('[data-feedback-for="payment"]');
        await feedback.getByRole("alert").waitFor();
        assert.equal(await type.inputValue(), "RECEIPT", "種別保存失敗時にも編集内容を保持する");
        assert.equal(await payment.getByLabel("受取者", { exact: true }).inputValue(), "a");
        assert.equal(await payment.getByLabel("金額（円）", { exact: true }).inputValue(), "10000");
        assert.equal(await payment.locator(".signed-amount-input > span").textContent(), "+");
        assert.equal(writes.length, 1, "種別選択時に即時保存する");
        assert.equal(writes[0].amountYen, 10_000);
        assert.equal(writes[0].type, "RECEIPT");
        assert.equal(writes[0].expenseClass, "SHARED");
        assert.deepEqual(writes[0].splitWeights, { a: 1, b: 1 });
        assert.equal(await page.locator("#saved-transactions").evaluate(element => JSON.parse(element.textContent!)[0].type), "PAYMENT", "保存失敗時に確定値は変更しない");
        fail = false;
        await feedback.getByRole("button", { name: "再試行", exact: true }).click();
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!)[0].type === "RECEIPT");
        assert.deepEqual(writes[1], writes[0]);
        assert.equal(await payment.getByLabel("区分", { exact: true }).inputValue(), "SHARED");
        assert.deepEqual(await payment.locator(".split-editor-fields small").allTextContents(), ["+￥5,000", "+￥5,000"]);
        const selection = payment.getByRole("checkbox", { name: "paymentの明細を選択", exact: true }).filter({ visible: true });
        await selection.check();
        assert.equal(await transactions.getByRole("button", { name: "区分のルールの適用", exact: true }).isDisabled(), true, "収入には支払い用ルールを適用しない");
        await selection.uncheck();

        const amount = payment.getByLabel("金額（円）", { exact: true });
        await amount.fill("2147483647");
        await amount.blur();
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!)[0].amountYen === 2147483647);
        const cell = await payment.locator('[data-label="金額（円）"]').boundingBox();
        const input = await amount.boundingBox(), signed = await payment.locator(".signed-amount-input").boundingBox();
        assert.ok(cell && input && signed);
        assert.ok(signed.x >= cell.x - 1 && signed.x + signed.width <= cell.x + cell.width + 1);
        assert.ok(input.x >= signed.x && input.x + input.width <= signed.x + signed.width + 1, "符号付きの金額入力をセル内へ収める");
        assert.equal(await amount.evaluate(element => getComputedStyle(element).color), green);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

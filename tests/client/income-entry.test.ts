import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium } from "playwright";

test("収入入力は種別に応じた初期配分を使い、入力保持・正額保存・失敗時再試行に対応する", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/income-entry.tsx"], bundle: true, write: false,
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
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage(), errors: string[] = [], writes: Record<string, unknown>[] = [];
      let fail = true, release: (() => Promise<void>) | undefined;
      async function completeSave() {
        for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(release);
        const currentRelease = release;
        release = undefined;
        await currentRelease();
      }
      page.setDefaultTimeout(6000);
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/app", async route => {
        writes.push(route.request().postDataJSON());
        release = () => route.fulfill(fail ? { status: 503, json: { error: "保存できませんでした" } } : { json: { ok: true } });
      });
      try {
        await page.goto(origin);
        const modal = page.getByRole("dialog", { name: "明細を追加", exact: true });
        const type = modal.getByLabel("種別", { exact: true }), amount = modal.getByLabel("金額（円）", { exact: true });
        const classification = modal.getByLabel("区分", { exact: true });
        assert.equal(await type.inputValue(), "PAYMENT");
        assert.equal(await classification.inputValue(), "SHARED");
        assert.deepEqual(await type.locator("option").allTextContents(), ["支払い", "収入"]);
        assert.equal(await modal.getByLabel("支払者", { exact: true }).inputValue(), "a");
        const paymentActor = modal.getByLabel("支払者", { exact: true });
        await paymentActor.selectOption("b");
        await modal.getByText("個人の取引を登録する場合は、担当者を自分に変更してください。", { exact: true }).waitFor();
        assert.equal(await classification.locator('option[value="PERSONAL"]').evaluate(element => (element as HTMLOptionElement).disabled), true);
        await modal.getByLabel("取引先", { exact: true }).fill("個人専用");
        assert.equal(await classification.inputValue(), "PERSONAL", "相手の担当者でも自動ルールの入力を保持する");
        assert.equal(await modal.getByRole("button", { name: "追加する", exact: true }).isDisabled(), true, "ルール経由でも相手の個人費は登録しない");
        await paymentActor.selectOption("a");
        await modal.getByText("個人の取引を登録する場合は、担当者を自分に変更してください。", { exact: true }).waitFor({ state: "hidden" });
        assert.equal(await paymentActor.locator('option[value="b"]').evaluate(element => (element as HTMLOptionElement).disabled), true, "個人の明細は相手を担当者にできない");
        assert.equal(await modal.locator(".signed-amount-input > span").textContent(), "", "空欄は無符号で表示する");
        assert.equal(await amount.getAttribute("class"), "", "空欄は中立色で表示する");
        await modal.getByLabel("取引日時", { exact: true }).fill("2026-10-18T12:34");
        await modal.getByLabel("取引先", { exact: true }).fill("ルール店");
        await amount.fill("1001");
        assert.equal(await modal.locator(".signed-amount-input > span").textContent(), "−");
        await modal.getByLabel("取引方法", { exact: true }).fill("振込");
        await modal.getByLabel("カテゴリ", { exact: true }).selectOption("income");
        await modal.getByLabel("メモ", { exact: true }).fill("手入力の収入");
        assert.equal(await modal.getByLabel("Aの配分割合", { exact: true }).inputValue(), "75");

        await type.selectOption("RECEIPT");
        assert.equal(await modal.getByLabel("受取者", { exact: true }).inputValue(), "a");
        assert.equal(await modal.getByLabel("支払者", { exact: true }).count(), 0);
        assert.equal(await classification.inputValue(), "PERSONAL");
        assert.equal(await modal.getByLabel("Aの配分割合", { exact: true }).inputValue(), "100");
        assert.equal(await modal.getByLabel("Bの配分割合", { exact: true }).inputValue(), "0");
        assert.equal(await modal.getByRole("button", { name: "取引先のルールを適用", exact: true }).count(), 0);
        assert.equal(await modal.locator(".signed-amount-input > span").textContent(), "+");
        assert.equal(await modal.getByLabel("取引日時", { exact: true }).inputValue(), "2026-10-18T12:34");
        assert.equal(await modal.getByLabel("取引先", { exact: true }).inputValue(), "ルール店");
        assert.equal(await modal.getByLabel("取引方法", { exact: true }).inputValue(), "振込");
        assert.equal(await amount.inputValue(), "1001");
        assert.equal(await modal.getByLabel("カテゴリ", { exact: true }).inputValue(), "income");
        assert.equal(await modal.getByLabel("メモ", { exact: true }).inputValue(), "手入力の収入");
        await modal.getByLabel("取引先", { exact: true }).fill("ルール店の返金");
        assert.equal(await classification.inputValue(), "PERSONAL", "収入には支払い向けルールを自動適用しない");
        await type.selectOption("PAYMENT");
        assert.equal(await modal.getByLabel("Aの配分割合", { exact: true }).inputValue(), "75", "支払いへ戻したときはルールを再適用する");
        await type.selectOption("RECEIPT");
        await classification.selectOption("SHARED");
        const unit = modal.getByRole("combobox", { name: /配分割合.*の単位/ });
        await unit.selectOption("AMOUNT");
        await modal.getByLabel("Aの配分金額（円）", { exact: true }).fill("0");
        assert.equal(await modal.locator(".amount-sign").first().textContent(), "", "0円の配分は無符号で表示する");
        assert.equal(await modal.getByLabel("Aの配分金額（円）", { exact: true }).getAttribute("class"), "", "0円の配分は中立色で表示する");
        await modal.getByLabel("Aの配分金額（円）", { exact: true }).fill("300");
        assert.equal(await modal.getByLabel("Bの配分金額（円）", { exact: true }).inputValue(), "701");
        assert.deepEqual(await modal.locator(".amount-sign").allTextContents(), ["+", "+"]);
        await unit.selectOption("RATIO");
        assert.ok((await modal.locator(".split-editor-fields small").allTextContents()).every(text => text.startsWith("+")));
        await unit.selectOption("AMOUNT");
        await modal.getByLabel("受取者", { exact: true }).selectOption("b");
        assert.equal(await modal.getByLabel("Aの配分金額（円）", { exact: true }).inputValue(), "300", "共有時に受取者を変えても配分を維持する");
        assert.equal(await classification.locator('option[value="PERSONAL"]').evaluate(element => (element as HTMLOptionElement).disabled), true, "相手の個人収入へは変更できない");
        await modal.getByText("個人の取引を登録する場合は、担当者を自分に変更してください。", { exact: true }).waitFor();
        assert.equal(writes.length, 0, "入力操作では登録APIを呼ばない");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);

        await amount.fill("-1");
        await modal.getByRole("button", { name: "追加する", exact: true }).click();
        assert.equal(writes.length, 0, "負数の入力は登録しない");
        await amount.fill("1001");
        await modal.getByRole("button", { name: "追加する", exact: true }).click();
        await modal.getByRole("button", { name: "保存中…", exact: true }).waitFor();
        assert.equal(await type.isDisabled(), true);
        assert.equal(await amount.isDisabled(), true);
        assert.equal(await modal.getByLabel("取引先", { exact: true }).isDisabled(), true);
        assert.equal(await classification.isDisabled(), true);
        assert.equal(await unit.isDisabled(), true);
        await page.waitForFunction(() => document.querySelector('button.primary')?.textContent === "保存中…");
        await completeSave();
        await modal.getByRole("alert").waitFor();
        assert.equal(await type.inputValue(), "RECEIPT");
        assert.equal(await modal.getByLabel("受取者", { exact: true }).inputValue(), "b");
        assert.equal(await modal.getByLabel("メモ", { exact: true }).inputValue(), "手入力の収入");
        assert.equal(await modal.getByLabel("Aの配分金額（円）", { exact: true }).inputValue(), "300");
        assert.equal(writes.length, 1);
        assert.equal(writes[0].type, "RECEIPT");
        assert.equal(writes[0].amountYen, 1001);
        assert.equal(writes[0].actorUserId, "b");
        assert.equal(writes[0].expenseClass, "SHARED");
        assert.deepEqual(writes[0].splitWeights, { a: 300, b: 701 });
        assert.equal(writes[0].occurredAt, "2026-10-18T03:34:00.000Z");
        assert.equal(writes[0].categoryId, "income");
        fail = false;
        await modal.getByRole("button", { name: "追加する", exact: true }).click();
        await completeSave();
        await modal.waitFor({ state: "hidden" });
        assert.deepEqual(writes[1], writes[0]);
        assert.deepEqual(errors, []);
      } finally { await release?.(); await context.close(); }
    });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium } from "playwright";

test("明細カテゴリの保存・失敗保持・精算済み編集とPC/mobile表示を検証する", async t => {
  const bundle = await build({ entryPoints: ["tests/fixtures/transaction-categories.tsx"], bundle: true, write: false, outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
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
    for (const width of [1440, 390]) await t.test(`${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const writes: Record<string, unknown>[] = [], errors: string[] = [];
      let fail = false, hold = false, release: (() => void) | undefined, refreshes = 0;
      page.setDefaultTimeout(6000);
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.route("**/api/**", async route => {
          if (route.request().method() === "GET") { refreshes++; await route.fulfill({ json: { ok: true } }); return; }
          const payload = route.request().postDataJSON();
          writes.push(payload);
          if (hold) await new Promise<void>(resolve => { release = resolve; });
          if (fail) { await route.fulfill({ status: 503, json: { error: "カテゴリ保存失敗" } }); return; }
          await route.fulfill({ json: payload.action === "saveTransactionCategory"
            ? { ok: true, transactionId: payload.transactionId, categoryId: payload.categoryId, categoryConfirmed: payload.categoryId !== null }
            : { ok: true, transaction: { ...payload, id: payload.transactionId ?? "created", actorName: "A", source: "MANUAL", externalId: "new", settledAt: null } } });
        });
        await page.goto(origin);
        const first = page.locator('[data-transaction-id="first"]');
        const settled = page.locator('[data-transaction-id="settled"]');
        if (width < 768) {
          await first.getByRole("button", { name: "firstの詳細を開く", exact: true }).click();
          await settled.getByRole("button", { name: "settledの詳細を開く", exact: true }).click();
        }
        const select = first.getByLabel("firstのカテゴリ", { exact: true });
        const settledSelect = settled.getByLabel("settledのカテゴリ", { exact: true });
        assert.deepEqual(await select.locator("option").allTextContents(), ["未分類", "食費", "食費 › 生鮮食品", "食費 › 生鮮食品 › 野菜"]);
        assert.equal(await settledSelect.inputValue(), "old");
        assert.equal(await settledSelect.locator('option[value="old"]').isDisabled(), true);
        assert.match(await settled.locator("[data-category-editor]").textContent() ?? "", /以前のカテゴリ（使用停止）/);

        fail = true;
        await select.selectOption("leaf");
        await first.getByRole("alert").waitFor();
        assert.equal(await select.inputValue(), "leaf", "失敗しても選択を保持する");
        await page.getByRole("button", { name: "更新", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-transaction-id="first"] [role="alert"]') && !document.querySelector('[aria-busy="true"]'));
        assert.equal(refreshes, 0, "カテゴリ保存失敗時は再取得しない");
        fail = false;
        await first.getByRole("button", { name: "再試行", exact: true }).click();
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!)[0].categoryId === "leaf");
        assert.equal(await first.getByRole("alert").count(), 0);
        assert.equal(await first.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(255, 248, 241)");
        if (width < 768) assert.equal(await first.locator('[data-swipe-open] > div').first().evaluate(element => getComputedStyle(element).backgroundColor), "rgb(255, 248, 241)", "スマホの概要部分もカテゴリ色を反映する");
        await page.getByLabel("カテゴリの表示範囲").selectOption("root");
        assert.equal(await select.inputValue(), "leaf", "大分類表示でも保存IDを変えない");
        assert.equal(await first.locator('[data-category-editor] [aria-hidden="true"]').first().textContent(), "食費▾");
        assert.equal(await select.locator('option[value="leaf"]').textContent(), "食費 › 生鮮食品 › 野菜", "選択肢は全階層のままにする");

        hold = true;
        const before = writes.length;
        await select.selectOption("food");
        await page.waitForFunction(() => (document.querySelector('[data-transaction-id="first"] select[aria-label="firstのカテゴリ"]') as HTMLSelectElement).disabled);
        assert.equal(await select.isDisabled(), true);
        await first.getByLabel("取引先", { exact: true }).fill("first edited");
        await first.getByLabel("取引先", { exact: true }).blur();
        await page.waitForTimeout(20);
        assert.equal(writes.length, before + 1, "通常保存も同じキューで待機する");
        assert.ok(release);
        hold = false; release();
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!)[0].merchant === "first edited");
        assert.deepEqual(writes.slice(before).map(value => value.action), ["saveTransactionCategory", "saveTransaction"]);
        assert.equal(await first.getByLabel("first editedのカテゴリ", { exact: true }).inputValue(), "food");

        await settledSelect.selectOption("");
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!)[1].categoryId === null);
        const saved = await page.locator("#saved-transactions").textContent();
        assert.equal(JSON.parse(saved!)[1].amountYen, 100);
        assert.equal(JSON.parse(saved!)[1].settledAt, "2026-10-20T04:00:00Z");
        assert.equal(await settledSelect.isEnabled(), true);
        await page.getByLabel("カテゴリの表示範囲").selectOption("full");
        if (width < 768) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);

        await page.getByRole("button", { name: "＋ 明細を追加", exact: true }).click();
        const modal = page.getByRole("dialog", { name: "明細を追加", exact: true });
        await modal.getByLabel("取引先", { exact: true }).fill("新しい支払い");
        await modal.getByLabel("金額（円）", { exact: true }).fill("500");
        await modal.getByLabel("カテゴリ", { exact: true }).selectOption("leaf");
        await modal.getByRole("button", { name: "追加する", exact: true }).click();
        await modal.waitFor({ state: "hidden" });
        assert.equal(writes.at(-1)?.categoryId, "leaf");
        assert.equal(writes.at(-1)?.merchant, "新しい支払い");
        assert.deepEqual(errors, []);
      } finally { release?.(); await context.close(); }
    });
    await t.test("保存中に新しいカテゴリを取得した場合、旧応答を入力欄でも承認しない", async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      let release: (() => void) | undefined;
      await page.route("**/api/app", async route => {
        const payload = route.request().postDataJSON();
        await new Promise<void>(resolve => { release = resolve; });
        await route.fulfill({ json: { transactionId: "first", categoryId: payload.categoryId, categoryConfirmed: true, categoryRevision: 1 } });
      });
      try {
        await page.goto(origin);
        const select = page.getByLabel("firstのカテゴリ", { exact: true });
        await select.selectOption("leaf");
        await page.waitForFunction(() => (document.querySelector('select[aria-label="firstのカテゴリ"]') as HTMLSelectElement).disabled);
        await page.getByRole("button", { name: "外部のカテゴリ更新を受信", exact: true }).click();
        assert.ok(release); release();
        await page.waitForFunction(() => !(document.querySelector('select[aria-label="firstのカテゴリ"]') as HTMLSelectElement).disabled);
        assert.equal(await select.inputValue(), "fresh");
        assert.equal(JSON.parse((await page.locator("#saved-transactions").textContent())!)[0].categoryRevision, 10);
      } finally { release?.(); await context.close(); }
    });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

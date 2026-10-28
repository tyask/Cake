import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";
import type { TransactionRecord, WorkspaceData } from "../../lib/shared/types";

function transaction(id: string, extra: Partial<TransactionRecord>): TransactionRecord {
  return { id, merchant: id, type: "PAYMENT", amountYen: 300, occurredAt: "2026-10-20T00:00:00.001Z",
    method: "現金", memo: "", actorUserId: "a", actorName: "A", expenseClass: "SHARED", splitWeights: { a: 1, b: 1 },
    settledAt: null, externalId: id, source: "MANUAL", categoryId: "food", categoryConfirmed: true, categoryRevision: 1, ...extra };
}

const initial: WorkspaceData = {
  workspace: { id: "sort-summary-workspace", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
  members: [
    { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 1, role: "OWNER" },
    { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 1, role: "MEMBER" },
  ], categories: [
    { id: "food", name: "食費", parentId: null, revision: 1, colorHex: "#f97316", sortOrder: 0, archivedAt: null },
    { id: "income", name: "収入", parentId: null, revision: 1, colorHex: "#3b82f6", sortOrder: 1, archivedAt: null },
  ], rules: [], settlement: null, settlementHistory: [], transactions: [
    transaction("small", { merchant: "店2" }),
    transaction("income", { merchant: "店10", type: "RECEIPT", amountYen: 2000, method: "銀行", categoryId: "income",
      occurredAt: "2026-10-20T00:00:00.002Z", actorUserId: "b", actorName: "B" }),
    transaction("settled", { merchant: "清算済み", amountYen: 700, occurredAt: "2026-10-19T00:00:00.000Z", settledAt: "2026-10-20T00:00:00.000Z" }),
    transaction("own", { merchant: "個人費", amountYen: 500, method: "カード", expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 },
      occurredAt: "2026-10-18T00:00:00.000Z" }),
    transaction("partner", { merchant: "個人収入", type: "RECEIPT", amountYen: 1000, method: "銀行", categoryId: "income",
      expenseClass: "PERSONAL", actorUserId: "b", actorName: "B", splitWeights: { a: 0, b: 1 }, occurredAt: "2026-10-17T00:00:00.000Z" }),
    transaction("past", { merchant: "前月の未清算", amountYen: 900, occurredAt: "2026-09-20T00:00:00.000Z" }),
  ],
};

async function chooseFilter(page: Page, name: string, value?: RegExp) {
  await page.getByRole("button", { name: name + "で絞り込み", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: name + "で絞り込み", exact: true });
  await dialog.getByRole("checkbox", { name: "候補の値をすべて選択", exact: true }).uncheck();
  if (value) await dialog.getByRole("checkbox", { name: value }).check();
  await dialog.getByRole("button", { name: "適用", exact: true }).click();
}

async function assertTotals(page: Page, expected: string[]) {
  const summary = page.getByRole("group", { name: "フィルタ結果の収支", exact: true });
  await page.waitForFunction(values => {
    const summary = document.querySelector('[role="group"][aria-label="フィルタ結果の収支"]');
    return JSON.stringify(Array.from(summary?.querySelectorAll("dd") ?? []).map(cell => cell.textContent)) === JSON.stringify(values);
  }, expected);
  assert.deepEqual(await summary.locator("dt").allTextContents(), ["収入", "支出", "収支"]);
  assert.deepEqual(await summary.locator("dd").allTextContents(), expected);
}

async function rowIds(page: Page) {
  return page.locator("tr[data-transaction-id]").evaluateAll(rows => rows.map(row => row.getAttribute("data-transaction-id")));
}

test("取引明細のソートと絞り込み結果の合計はPC/mobileで確定値と表示範囲に追従する", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/transaction-sort-summary.tsx"], bundle: true,
    write: false, outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    const suffix = req.url === "/bundle.css" ? "/bundle.css" : "/bundle.js";
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : req.url === "/bundle.css" ? "text/css" : "text/html");
    res.end(req.url?.startsWith("/bundle.") ? bundle.outputFiles.find(file => file.path.endsWith(suffix))!.text
      : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  try {
    for (const width of [1920, 1000, 390, 320]) await t.test(`${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      await page.clock.setFixedTime(new Date("2026-10-20T03:00:00.000Z"));
      await page.addInitScript(data => { window.sortSummaryInitial = data; }, initial);
      const errors: string[] = [], writes: Record<string, unknown>[] = [];
      const records = new Map(initial.transactions.map(row => [row.id, { ...row }]));
      let fail = true;
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/**", async route => {
        const request = route.request();
        if (request.method() === "GET") {
          await route.fulfill({ json: [...records.values()] });
          return;
        }
        const payload = request.postDataJSON();
        writes.push(payload);
        if (fail) { await route.fulfill({ status: 503, json: { error: "保存失敗の確認" } }); return; }
        if (payload.action === "deleteTransactions") {
          for (const id of payload.transactionIds) records.delete(id);
          await route.fulfill({ json: { deletedTransactionIds: payload.transactionIds } });
          return;
        }
        const id = payload.transactionId ?? "added";
        const saved = { ...transaction(id, {}), ...records.get(id), ...payload, id,
          actorName: payload.actorUserId === "a" ? "A" : "B" };
        records.set(id, saved);
        await route.fulfill({ json: { transaction: saved } });
      });
      try {
        await page.goto(origin);
        await assertTotals(page, ["+￥3,000", "−￥1,500", "+￥1,500"]);
        if (process.env.CAKE_LAYOUT_SCREENSHOTS) {
          await mkdir(".cake", { recursive: true });
          await page.screenshot({ path: `.cake/transaction-sort-summary-${width}.png`, fullPage: true });
        }
        assert.deepEqual(await rowIds(page), ["income", "small", "settled", "own", "partner"], "初期順はミリ秒までの日時降順で月外を除く");
        assert.equal(await page.getByRole("button", { name: /で(昇順|降順)に並べ替え$/ }).count(), 11);
        assert.equal(await page.locator('th[aria-sort="descending"]').textContent().then(value => value?.includes("取引日時")), true);
        const small = page.locator('[data-transaction-id="small"]');
        if (width <= 768) await small.getByRole("button", { name: "店2の詳細を開く", exact: true }).click();
        await small.getByRole("checkbox", { name: "店2の明細を選択", exact: true }).check();
        await page.getByRole("button", { name: "金額（円）で昇順に並べ替え", exact: true }).click();
        assert.deepEqual(await rowIds(page), ["settled", "own", "small", "partner", "income"], "金額は支払いを負、収入を正として並べる");
        const amountSort = page.getByRole("button", { name: "金額（円）で降順に並べ替え", exact: true });
        await amountSort.focus();
        await page.keyboard.press("Enter");
        assert.deepEqual(await rowIds(page), ["income", "partner", "small", "own", "settled"]);
        assert.equal(await small.getByRole("checkbox", { name: "店2の明細を選択", exact: true }).isChecked(), true);
        if (width <= 768) assert.equal(await small.getAttribute("data-expanded"), "true", "ソートで展開状態を失わない");
        await assertTotals(page, ["+￥3,000", "−￥1,500", "+￥1,500"]);
        assert.equal(writes.length, 0, "並べ替えは業務データを更新しない");

        await chooseFilter(page, "種別", /^支払い/);
        await chooseFilter(page, "方法", /^現金/);
        await assertTotals(page, ["￥0", "−￥1,000", "−￥1,000"]);
        const amount = small.getByRole("spinbutton", { name: "金額（円）", exact: true });
        await amount.fill("999");
        await assertTotals(page, ["￥0", "−￥1,000", "−￥1,000"]);
        await page.getByRole("button", { name: "金額（円）で昇順に並べ替え", exact: true }).click();
        const feedback = page.locator('[data-feedback-for="small"]');
        await feedback.getByRole("alert").waitFor();
        await chooseFilter(page, "取引先", /^清算済み/);
        await assertTotals(page, ["￥0", "−￥700", "−￥700"]);
        assert.equal(await small.count(), 1, "保存失敗の条件外行を編集継続のために保持する");
        assert.equal(await amount.inputValue(), "999");
        assert.match(await feedback.textContent() ?? "", /編集中のため表示/);
        assert.equal(await small.getByRole("checkbox", { name: "店2の明細を選択", exact: true }).isChecked(), true);
        await page.getByRole("button", { name: "取引先で昇順に並べ替え", exact: true }).click();
        assert.equal(await amount.inputValue(), "999", "並べ替えても保存失敗の下書きを維持する");

        await page.getByRole("button", { name: "絞り込みをすべて解除", exact: true }).click();
        await assertTotals(page, ["+￥3,000", "−￥1,500", "+￥1,500"]);
        fail = false;
        await feedback.getByRole("button", { name: "再試行", exact: true }).click();
        await assertTotals(page, ["+￥3,000", "−￥2,199", "+￥801"]);
        await small.getByRole("checkbox", { name: "店2の明細を選択", exact: true }).uncheck();

        await page.getByRole("button", { name: "＋ 明細を追加", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "明細を追加", exact: true });
        await dialog.getByLabel("取引先", { exact: true }).fill("追加収入");
        await dialog.getByLabel("種別", { exact: true }).selectOption("RECEIPT");
        await dialog.getByLabel("金額（円）", { exact: true }).fill("250");
        await dialog.getByRole("button", { name: "追加する", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await assertTotals(page, ["+￥3,250", "−￥2,199", "+￥1,051"]);
        const added = page.locator('[data-transaction-id="added"]');
        await added.getByRole("checkbox", { name: "追加収入の明細を選択", exact: true }).check();
        page.once("dialog", dialog => { void dialog.accept(); });
        await page.getByRole("button", { name: "削除", exact: true }).click();
        await added.waitFor({ state: "detached" });
        await assertTotals(page, ["+￥3,000", "−￥2,199", "+￥801"]);

        records.set("small", { ...records.get("small")!, amountYen: 100 });
        await page.getByRole("button", { name: "更新", exact: true }).click();
        await assertTotals(page, ["+￥3,000", "−￥1,300", "+￥1,700"]);
        assert.equal(await page.locator('th[aria-sort="ascending"]').textContent().then(value => value?.includes("取引先")), true,
          "再取得しても選択したソートを維持する");
        await page.getByRole("radio", { name: "未精算明細", exact: true }).click();
        await assertTotals(page, ["+￥2,000", "−￥1,000", "+￥1,000"]);
        assert.equal(await page.locator('[data-transaction-id="past"]').count(), 1);
        assert.equal(await page.locator('[data-transaction-id="partner"]').count(), 0);
        assert.equal(await page.locator('[data-transaction-id="settled"]').count(), 0);
        await page.getByRole("radio", { name: "月単位明細", exact: true }).click();
        await assertTotals(page, ["+￥3,000", "−￥1,300", "+￥1,700"]);
        await chooseFilter(page, "種別", /^収入/);
        await chooseFilter(page, "方法", /^現金/);
        await assertTotals(page, ["￥0", "￥0", "￥0"]);
        assert.deepEqual(await rowIds(page), []);
        assert.equal(await page.getByText("条件に一致する明細がありません。", { exact: true }).count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "合計と操作を画面幅に収める");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test("320pxで大きな合計額を収め、再表示でソートを初期化する", async () => {
      const context = await browser.newContext({ viewport: { width: 320, height: 1000 }, locale: "ja-JP" });
      try {
        const page = await context.newPage();
        await page.addInitScript(data => { window.sortSummaryInitial = data; }, {
          ...initial, transactions: initial.transactions.slice(0, 3).map(row => ({ ...row, amountYen: 2147483647 })),
        });
        await page.goto(origin);
        await assertTotals(page, ["+￥2,147,483,647", "−￥4,294,967,294", "−￥2,147,483,647"]);
        const summary = page.getByRole("group", { name: "フィルタ結果の収支", exact: true });
        for (const cell of await summary.locator("dd").all()) {
          const box = await cell.boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= 321);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.getByRole("button", { name: "金額（円）で昇順に並べ替え", exact: true }).click();
        await page.reload();
        assert.equal(await page.locator('th[aria-sort="descending"]').textContent().then(value => value?.includes("取引日時")), true);
      } finally { await context.close(); }
    });
  } finally {
    await browser.close();
    await new Promise<void>(done => server.close(() => done()));
  }
});

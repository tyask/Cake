import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Page, type Route } from "playwright";
import type { TransactionRecord } from "../../lib/shared/types";
import type { TransactionViewDataset } from "../../lib/shared/transaction-view";

const record = (id = "october", amountYen = 100): TransactionRecord => ({ id, occurredAt: "2026-10-18T00:00:00Z", merchant: id,
  method: "現金", type: "PAYMENT", amountYen, actorUserId: "user", actorName: "A", expenseClass: "SHARED", splitWeights: { user: 1 },
  settledAt: null, externalId: id, source: "MANUAL", memo: "", categoryId: null, categoryConfirmed: false, categoryRevision: 0 });

async function expectView(page: Page, expected: Record<string, unknown>) {
  await page.waitForFunction(expected => Object.entries(expected).every(([path, wanted]) => {
    let actual: unknown = window.transactionViewHarness?.view;
    for (const key of path.split(".")) actual = (actual as Record<string, unknown> | undefined)?.[key];
    return JSON.stringify(actual) === JSON.stringify(wanted);
  }), expected);
}

test("月別取得は保存確定・ワークスペース切替・権限失効と整合する", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/transaction-view-data.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/bundle.js" ? "application/javascript" : "text/html");
    response.end(request.url === "/bundle.js" ? bundle.outputFiles[0].text : '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) });
  async function scenario(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    await t.test(name, async () => {
      const f = await fixture();
      try { await run(f); assert.deepEqual(f.errors, []); }
      finally { await f.context.close(); }
    });
  }
  async function fixture() {
    const context = await browser.newContext(), page = await context.newPage();
    const requests: Route[] = [], errors: string[] = [];
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/transactions?**", route => { requests.push(route); });
    await page.addInitScript(() => {
      for (const workspaceId of ["a", "b"]) localStorage.setItem(`cake:transaction-view:v1:user:${workspaceId}`, JSON.stringify({ mode: "month", month: "2026-10" }));
    });
    await page.goto(origin);
    async function take() {
      await page.waitForFunction(() => !!window.transactionViewHarness);
      for (let attempt = 0; requests.length === 0 && attempt < 200; attempt += 1) await new Promise(done => setTimeout(done, 5));
      assert.ok(requests.length, "missing scoped GET");
      return requests.shift()!;
    }
    async function reply(route: Route, transactions: TransactionRecord[], status = 200) {
      const query = new URL(route.request().url()).searchParams;
      const dataset: TransactionViewDataset = { workspaceId: query.get("workspaceId")!, mode: query.get("mode") as "month" | "unsettled",
        month: query.get("mode") === "month" ? query.get("month") : null, transactions };
      await route.fulfill({ status, json: status === 200 ? dataset : { error: "権限がありません。" } });
    }
    const change = (month: string) => page.evaluate(month => {
      window.transactionViewOperation = window.transactionViewHarness.view.onChange({ mode: "month", month }, async () => {});
    }, month);
    return { context, page, requests, errors, take, reply, change };
  }
  try {
    await scenario("Aの遅い保存応答は切替後のBの取得を中断しない", async f => {
      await f.reply(await f.take(), [record()]);
      await expectView(f.page, { "data.workspaceId": "a", loading: false });
      await f.page.evaluate(() => window.transactionViewHarness.configure({ userId: "user", workspaceId: "b", active: true }));
      const other = await f.take();
      await f.page.evaluate(() => window.transactionViewHarness.view.applyUpdate("a", { transactionId: "october", memo: "遅い保存" }));
      await f.reply(other, [record("b-row")]);
      await expectView(f.page, { "data.workspaceId": "b", "data.transactions.0.id": "b-row", loading: false });
    });
    await scenario("取得開始後の保存成功は古いsnapshotを拒否して新しく取得する", async f => {
      const older = await f.take();
      await f.page.evaluate(transaction => window.transactionViewHarness.view.applyUpdate("a", { transaction }), record("saved", 900));
      const newer = await f.take();
      await f.reply(older, [record("old", 100)]);
      await f.reply(newer, [record("saved", 900)]);
      await expectView(f.page, { "data.transactions.0.merchant": "saved", "data.transactions.0.amountYen": 900, loading: false });
    });
    await scenario("離れた画面の月取得は完了しても選択月を保存しない", async f => {
      await f.reply(await f.take(), [record()]);
      await expectView(f.page, { loading: false });
      await f.change("2026-09");
      const older = await f.take();
      await f.page.evaluate(() => window.transactionViewHarness.configure({ userId: "user", workspaceId: "b", active: true }));
      const newer = await f.take();
      await f.reply(older, [{ ...record("old-month"), occurredAt: "2026-09-01T00:00:00Z" }]);
      await f.reply(newer, [record("b-row")]);
      await expectView(f.page, { "selection.month": "2026-10", "data.workspaceId": "b", loading: false });
      assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem("cake:transaction-view:v1:user:a")!).month), "2026-10");
    });
    await scenario("確定値は他月のcacheにも反映し、戻ったとき追加GETしない", async f => {
      await f.reply(await f.take(), [record()]);
      await expectView(f.page, { loading: false });
      await f.change("2026-09");
      await f.reply(await f.take(), [{ ...record("september"), occurredAt: "2026-09-18T00:00:00Z" }]);
      await expectView(f.page, { "selection.month": "2026-09", loading: false });
      await f.page.evaluate(transaction => window.transactionViewHarness.view.applyUpdate("a", { transaction }), record("october", 700));
      await f.change("2026-10");
      await expectView(f.page, { "selection.month": "2026-10", "data.transactions.0.amountYen": 700, loading: false });
      assert.equal(f.requests.length, 0);
    });
    await scenario("権限失効時は表示データと取得済み月を破棄する", async f => {
      await f.reply(await f.take(), [record()]);
      await expectView(f.page, { loading: false });
      await f.change("2026-09");
      await f.reply(await f.take(), [], 403);
      await expectView(f.page, { data: null, "selection.month": "2026-10", loading: false, error: "権限がありません。" });
      await f.page.evaluate(() => { window.transactionViewOperation = window.transactionViewHarness.view.refresh(); });
      await f.reply(await f.take(), []);
      await expectView(f.page, { "data.transactions": [], loading: false, error: null });
    });
    await scenario("metadataによる無効化直後の手動取得を自動reloadが中断しない", async f => {
      await f.reply(await f.take(), [record()]);
      await expectView(f.page, { loading: false });
      await f.page.evaluate(() => {
        window.transactionViewHarness.view.invalidate("a");
        window.transactionViewOperation = window.transactionViewHarness.view.refresh();
      });
      await f.reply(await f.take(), [record("refreshed", 500)]);
      await expectView(f.page, { "data.transactions.0.id": "refreshed", loading: false, error: null });
      assert.equal(await f.page.evaluate(() => window.transactionViewOperation), true);
      assert.equal(f.requests.length, 0);
    });
    await scenario("月取得が失敗しても同じ月への切替を再試行できる", async f => {
      await f.reply(await f.take(), [record()]);
      await expectView(f.page, { loading: false });
      await f.change("2026-09");
      await f.reply(await f.take(), [], 503);
      await expectView(f.page, { "selection.month": "2026-10", loading: false });
      assert.equal(await f.page.evaluate(() => window.transactionViewOperation), false);
      await f.change("2026-09");
      await f.reply(await f.take(), []);
      await expectView(f.page, { "selection.month": "2026-09", loading: false, error: null });
      assert.equal(await f.page.evaluate(() => window.transactionViewOperation), true);
    });
    await scenario("別月へ移る通常保存が遅くても先に保存したメモとカテゴリを移動先cacheで保持する", async f => {
      await f.reply(await f.take(), [record()]);
      await expectView(f.page, { loading: false });
      await f.change("2026-09");
      await f.reply(await f.take(), []);
      await expectView(f.page, { "selection.month": "2026-09", loading: false });
      await f.change("2026-10");
      await expectView(f.page, { "selection.month": "2026-10", loading: false });
      await f.page.evaluate(transaction => {
        const view = window.transactionViewHarness.view;
        view.applyUpdate("a", { transactionId: transaction.id, memo: "先に保存したメモ" });
        view.applyUpdate("a", { transactionId: transaction.id, categoryId: "food", categoryConfirmed: true, categoryRevision: 4 });
        view.applyUpdate("a", { transaction });
      }, { ...record(), occurredAt: "2026-09-18T00:00:00Z" });
      await f.change("2026-09");
      await expectView(f.page, { "selection.month": "2026-09", loading: false });
      assert.equal(await f.page.evaluate(() => window.transactionViewHarness.view.data!.transactions[0].memo), "先に保存したメモ");
      assert.equal(await f.page.evaluate(() => window.transactionViewHarness.view.data!.transactions[0].categoryId), "food");
      assert.equal(await f.page.evaluate(() => window.transactionViewHarness.view.data!.transactions[0].categoryRevision), 4);
      assert.equal(f.requests.length, 0);
    });
  } finally {
    await browser.close();
    await new Promise<void>(done => server.close(() => done()));
  }
});

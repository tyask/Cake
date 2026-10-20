import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Page, type Route } from "playwright";
import type { BootstrapData, BootstrapMetadata, TransactionRecord } from "../lib/types";
import type { DashboardTab } from "../lib/bootstrap";

function data(id = "a", merchant = "initial"): BootstrapData {
  const user = { id: "user", name: "A", email: "a@example.test", imageUrl: null };
  const workspaces = ["a", "b", "c"].map(id => ({ id, name: id, type: "PERSONAL" as const, ownerUserId: user.id, memberCount: 1 }));
  return { user, workspaces, pendingInvitations: [], selected: {
    workspace: workspaces.find(w => w.id === id)!, members: [{ ...user, weight: 1, role: "OWNER" }], categories: [], rules: [],
    transactions: [{ id: "transaction-" + id, occurredAt: "2026-10-18T00:00:42.123Z", merchant, method: "現金", type: "PAYMENT",
      amountYen: 100, actorUserId: user.id, actorName: user.name, expenseClass: "PERSONAL", splitWeights: { user: 1 }, settledAt: null,
      memo: "original", externalId: "manual-" + id, source: "MANUAL", categoryId: null, categoryConfirmed: false, categoryRevision: 0 }], settlement: null, settlementHistory: [],
  } };
}
function metadata(id = "a"): BootstrapMetadata {
  const full = data(id), { workspace, members, rules, categories } = full.selected!;
  return { ...full, selected: { workspace: { ...workspace, name: "metadata" }, members, rules, categories } };
}
async function expectState(page: Page, expected: Record<string, unknown>) {
  await page.waitForFunction(expected => Object.entries(expected).every(([path, wanted]) => {
    let actual: unknown = window.controller;
    for (const key of path.split(".")) actual = (actual as Record<string, unknown> | undefined)?.[key];
    return JSON.stringify(actual) === JSON.stringify(wanted);
  }), expected);
}

test("Dashboard hookの取得・保存・切替・通知を実React/Chromiumで回帰検証する", async t => {
  const bundle = await build({ entryPoints: ["tests/fixtures/dashboard-controller.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : "text/html");
    res.end(req.url === "/bundle.js" ? bundle.outputFiles[0].text : '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  async function scenario(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, initialTab?: DashboardTab) {
    await t.test(name, async () => {
      const f = await fixture(initialTab);
      try { await run(f); assert.deepEqual(f.errors, []); }
      finally { await f.context.close(); }
    });
  }
  async function fixture(initialTab?: DashboardTab) {
    const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
    const requests: Route[] = [], errors: string[] = [];
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { errors.push("unexpected origin"); await route.abort(); return; }
      if (url.pathname === "/api/app") requests.push(route); else await route.continue();
    });
    await page.addInitScript(({ initial, initialTab }) => { window.initialData = initial; window.initialTab = initialTab; }, { initial: data(), initialTab });
    await page.goto(origin);
    await page.waitForFunction(() => !!window.controller);
    async function take(method = "GET") {
      for (let i = 0; !requests.some(r => r.request().method() === method) && i < 200; i++) await new Promise(done => setTimeout(done, 5));
      const index = requests.findIndex(r => r.request().method() === method);
      assert.notEqual(index, -1, `missing ${method} request`);
      return requests.splice(index, 1)[0];
    }
    const reply = (route: Route, json: unknown, status = 200) => route.fulfill({ status, json });
    return { context, page, requests, errors, take, reply };
  }
  try {
    await scenario("取込から開始すると初回描画からimportを選び、更新はmetadata、homeへの移動はfullを要求する", async f => {
      await expectState(f.page, { tab: "import", loading: false }); assert.equal(f.requests.length, 0);
      await f.page.evaluate(() => { window.operation = window.controller.refresh(); });
      let request = await f.take(); assert.equal(new URL(request.request().url()).searchParams.get("scope"), "metadata");
      await f.reply(request, metadata()); await expectState(f.page, { tab: "import", "selected.workspace.name": "metadata", "selected.transactions.0.merchant": "initial" });
      await f.page.evaluate(() => window.controller.openTab("home"));
      request = await f.take(); assert.equal(new URL(request.request().url()).searchParams.has("scope"), false);
      await f.reply(request, data("a", "home")); await expectState(f.page, { tab: "home", "selected.transactions.0.merchant": "home", loading: false });
    }, "import");
    await scenario("metadataは同一家計の明細を保持し、homeとworkspace切替はfullを要求する", async f => {
      await expectState(f.page, { tab: "home" });
      await f.page.evaluate(() => window.controller.openTab("settings"));
      let request = await f.take(); assert.equal(new URL(request.request().url()).searchParams.get("scope"), "metadata");
      await f.reply(request, metadata()); await expectState(f.page, { "selected.workspace.name": "metadata", "selected.transactions.0.merchant": "initial", loading: false });
      await f.page.evaluate(() => window.controller.openTab("home"));
      request = await f.take(); assert.equal(new URL(request.request().url()).searchParams.has("scope"), false);
      await f.reply(request, data("a", "full")); await expectState(f.page, { "selected.transactions.0.merchant": "full" });
      await f.page.evaluate(() => { window.operation = window.controller.switchWorkspace("b"); });
      request = await f.take(); assert.equal(new URL(request.request().url()).searchParams.get("workspaceId"), "b"); assert.equal(new URL(request.request().url()).searchParams.has("scope"), false);
      await f.reply(request, data("b")); await expectState(f.page, { "selected.workspace.id": "b", loading: false });
    });
    await scenario("GETが逆順に完了しても後から要求したタブのデータを保持する", async f => {
      await f.page.evaluate(() => window.controller.openTab("settings")); const older = await f.take();
      await f.page.evaluate(() => window.controller.openTab("home")); const newer = await f.take();
      await f.reply(newer, data("a", "newest")); await expectState(f.page, { "selected.transactions.0.merchant": "newest", loading: true });
      await f.reply(older, metadata()); await expectState(f.page, { "selected.transactions.0.merchant": "newest", "selected.workspace.name": "a", loading: false });
    });
    await scenario("同じworkspaceへ戻っても前の世代の応答を採用しない", async f => {
      await f.page.evaluate(() => { window.operation = window.controller.switchWorkspace("b"); }); const oldB = await f.take();
      await f.page.evaluate(() => { window.operation = window.controller.switchWorkspace("a"); }); const currentA = await f.take();
      await f.reply(currentA, data("a", "returned")); await expectState(f.page, { "selected.transactions.0.merchant": "returned" });
      await f.reply(oldB, data("b", "stale")); await expectState(f.page, { "selected.workspace.id": "a", "selected.transactions.0.merchant": "returned", loading: false });
    });
    await scenario("カテゴリ追加は明細保存と重なっても確定値を直接反映し、追加GETに依存しない", async f => {
      const category = { id: "food", revision: 1, parentId: null, name: "食費", colorHex: "#f97316", sortOrder: 0, archivedAt: null };
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "createCategory", workspaceId: "a", parentId: null, name: "食費", colorHex: "#f97316" }, "category"); });
      const categoryPost = await f.take("POST");
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "saveTransactionCategory", workspaceId: "a", transactionId: "transaction-a", categoryId: null }, ""); });
      const transactionPost = await f.take("POST");
      await f.reply(categoryPost, { ok: true, category });
      await f.reply(transactionPost, { ok: true, transactionId: "transaction-a", categoryId: null, categoryConfirmed: false, categoryRevision: 1 });
      await expectState(f.page, { "selected.categories.0.id": "food", "selected.transactions.0.categoryId": null, loading: false });
      assert.equal(f.requests.length, 0);
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "archiveCategory", workspaceId: "a", categoryId: "food" }, "archive"); });
      await f.reply(await f.take("POST"), { ok: true, archivedCategoryIds: ["food"], archivedCategories: [{ ...category, revision: 2, archivedAt: "2026-10-20T00:00:00.123Z" }] });
      await expectState(f.page, { "selected.categories.0.archivedAt": "2026-10-20T00:00:00.123Z", loading: false });
      assert.equal(f.requests.length, 0);
    });
    await scenario("カテゴリ更新と使用停止の応答が逆順でもDBの新しいrevisionを保持する", async f => {
      const category = { id: "food", revision: 1, parentId: null, name: "食費", colorHex: "#f97316", sortOrder: 0, archivedAt: null };
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "createCategory", workspaceId: "a", parentId: null, name: "食費", colorHex: "#f97316" }, ""); });
      await f.reply(await f.take("POST"), { ok: true, category });
      const update = () => f.page.evaluate(() => { window.operation = window.controller.run({ action: "updateCategory", workspaceId: "a", categoryId: "food", name: "編集", colorHex: "#f97316" }, ""); });
      await update(); const older = await f.take("POST");
      await update(); const newer = await f.take("POST");
      await f.reply(newer, { ok: true, category: { ...category, name: "新しい名前", revision: 3 } });
      await f.reply(older, { ok: true, category: { ...category, name: "古い名前", revision: 2 } });
      await expectState(f.page, { "selected.categories.0.name": "新しい名前", "selected.categories.0.revision": 3, loading: false });
      await update(); const beforeArchive = await f.take("POST");
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "archiveCategory", workspaceId: "a", categoryId: "food" }, ""); });
      await f.reply(await f.take("POST"), { ok: true, archivedCategoryIds: ["food"], archivedCategories: [{ ...category, name: "確定した名前", colorHex: "#2563eb", revision: 5, archivedAt: "2026-10-20T00:00:00Z" }] });
      await f.reply(beforeArchive, { ok: true, category: { ...category, revision: 4 } });
      await expectState(f.page, { "selected.categories.0.archivedAt": "2026-10-20T00:00:00Z", "selected.categories.0.revision": 5,
        "selected.categories.0.name": "確定した名前", "selected.categories.0.colorHex": "#2563eb", loading: false });
      assert.equal(f.requests.length, 0);
    });
    await scenario("明細画面を開き直した後のカテゴリ保存は遅い旧応答で戻らない", async f => {
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "saveTransactionCategory", workspaceId: "a", transactionId: "transaction-a", categoryId: "c1" }, ""); });
      const older = await f.take("POST");
      await f.page.evaluate(() => window.controller.openTab("settings")); await f.reply(await f.take(), metadata());
      await f.page.evaluate(() => window.controller.openTab("transactions"));
      const committed = data();
      committed.selected!.transactions[0] = { ...committed.selected!.transactions[0], categoryId: "c1", categoryConfirmed: true, categoryRevision: 1 };
      await f.reply(await f.take(), committed);
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "saveTransactionCategory", workspaceId: "a", transactionId: "transaction-a", categoryId: "c2" }, ""); });
      await f.reply(await f.take("POST"), { ok: true, transactionId: "transaction-a", categoryId: "c2", categoryConfirmed: true, categoryRevision: 2 });
      await f.reply(older, { ok: true, transactionId: "transaction-a", categoryId: "c1", categoryConfirmed: true, categoryRevision: 1 });
      await expectState(f.page, { "selected.transactions.0.categoryId": "c2", "selected.transactions.0.categoryRevision": 2, loading: false });
    });
    await scenario("移動応答の順序が逆転しても親と全兄弟順を保持し、保存開始前のGETで戻さない", async f => {
      const food = { id: "food", revision: 1, parentId: null, name: "食費", colorHex: "#f97316", sortOrder: 0, archivedAt: null };
      const daily = { ...food, id: "daily", name: "日用品", sortOrder: 1 };
      const child = { ...food, id: "child", parentId: "food", name: "食品" };
      const initial = data(); initial.selected!.categories = [food, daily, child];
      await f.page.evaluate(() => { window.operation = window.controller.refresh(); });
      await f.reply(await f.take(), initial);
      await expectState(f.page, { "selected.categories.2.parentId": "food" });
      await f.page.evaluate(() => { window.operation = window.controller.refresh(); }); const staleGet = await f.take();
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "moveCategory", workspaceId: "a", categoryId: "child", parentId: null, beforeCategoryId: "food" }, ""); });
      const older = await f.take("POST");
      assert.deepEqual(older.request().postDataJSON(), { action: "moveCategory", workspaceId: "a", categoryId: "child", parentId: null, beforeCategoryId: "food" });
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "moveCategory", workspaceId: "a", categoryId: "child", parentId: "daily", beforeCategoryId: null }, ""); });
      await f.reply(await f.take("POST"), { ok: true, movedCategories: [food, daily, { ...child, parentId: "daily", revision: 3 }].map(category => ({ ...category, revision: 3 })) });
      await f.reply(older, { ok: true, movedCategories: [{ ...food, sortOrder: 1, revision: 2 }, { ...daily, sortOrder: 2, revision: 2 }, { ...child, parentId: null, revision: 2 }] });
      await f.reply(staleGet, initial);
      await expectState(f.page, { "selected.categories.0.sortOrder": 0, "selected.categories.1.sortOrder": 1,
        "selected.categories.2.parentId": "daily", "selected.categories.2.revision": 3, loading: false });
      assert.equal(f.requests.length, 0, "移動確定後の追加GETは不要");
    });
    await scenario("workspace切替後のカテゴリ移動応答を破棄し、現在の家計へ兄弟を混ぜない", async f => {
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "moveCategory", workspaceId: "a", categoryId: "food", parentId: null, beforeCategoryId: null }, "古い移動通知"); });
      const post = await f.take("POST");
      await f.page.evaluate(() => { window.operation = window.controller.switchWorkspace("b"); });
      await f.reply(await f.take(), data("b"));
      await f.reply(post, { ok: true, movedCategories: [{ id: "food", revision: 2, parentId: null, name: "食費", colorHex: "#f97316", sortOrder: 1, archivedAt: null }] });
      await expectState(f.page, { "selected.workspace.id": "b", "selected.categories": [], notice: null, loading: false });
      assert.equal(f.requests.length, 0);
    });
    await scenario("保存開始前のGETは保存確定後の明細を上書きしない", async f => {
      await f.page.evaluate(() => window.controller.openTab("transactions")); const older = await f.take();
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "saveTransaction", workspaceId: "a", occurredAt: "2026-10-18T00:00:42.123Z", merchant: "saved", method: "現金", type: "PAYMENT", amountYen: 200, actorUserId: "user" }, "saved"); });
      const post = await f.take("POST"), transaction: TransactionRecord = { ...data().selected!.transactions[0], merchant: "saved", amountYen: 200 };
      await f.reply(post, { ok: true, transaction }); await expectState(f.page, { "selected.transactions.0.amountYen": 200, notice: "saved" });
      await f.reply(older, data("a", "old")); await expectState(f.page, { "selected.transactions.0.merchant": "saved", loading: false }); assert.equal(f.requests.length, 0);
    });
    await scenario("別workspaceへ移動した後の保存応答は現在の家計と通知へ反映しない", async f => {
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "saveTransactionMemo", workspaceId: "a", transactionId: "transaction-a", memo: "old save" }, "stale notice"); }); const post = await f.take("POST");
      await f.page.evaluate(() => { window.operation = window.controller.switchWorkspace("b"); }); const get = await f.take();
      await f.reply(get, data("b")); await expectState(f.page, { "selected.workspace.id": "b" });
      await f.reply(post, { ok: true, transactionId: "transaction-a", memo: "old save" }); await expectState(f.page, { "selected.workspace.id": "b", "selected.transactions.0.memo": "original", notice: null, loading: false });
    });
    await scenario("タブ往復後の同一家計の保存は確定値だけを反映し、古い通知を出さない", async f => {
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "saveTransactionMemo", workspaceId: "a", transactionId: "transaction-a", memo: "saved" }, "old notice"); }); const post = await f.take("POST");
      await f.page.evaluate(() => window.controller.openTab("settings")); const settings = await f.take();
      await f.page.evaluate(() => window.controller.openTab("home")); const home = await f.take();
      await f.reply(settings, metadata()); await f.reply(home, data()); await expectState(f.page, { tab: "home" });
      await f.reply(post, { ok: true, transactionId: "transaction-a", memo: "saved" }); await expectState(f.page, { "selected.transactions.0.memo": "saved", notice: null, loading: false });
    });
    await scenario("手動更新はprepare完了までGETせず、二重実行を抑える", async f => {
      await f.page.evaluate(() => {
        window.prepareCount = 0;
        window.operation = window.controller.refreshCurrentView(() => { window.prepareCount++; return new Promise<void>(resolve => { window.releasePrepare = resolve; }); });
        void window.controller.refreshCurrentView(async () => { window.prepareCount++; });
      });
      await expectState(f.page, { refreshing: true, loading: true }); assert.equal(await f.page.evaluate(() => window.prepareCount), 1); assert.equal(f.requests.length, 0);
      await f.page.evaluate(() => window.releasePrepare()); const get = await f.take(); assert.equal(new URL(get.request().url()).searchParams.has("scope"), false);
      await f.reply(get, data("a", "refreshed")); await expectState(f.page, { refreshing: false, loading: false, notice: "最新状態に更新しました。", "selected.transactions.0.merchant": "refreshed" });
    });
    await scenario("prepareの保存失敗ではGETせず、既存データとエラーを保持する", async f => {
      await f.page.evaluate(() => { window.operation = window.controller.refreshCurrentView(async () => { throw new Error("メモを保存できませんでした。"); }); });
      await expectState(f.page, { notice: "メモを保存できませんでした。", refreshing: false, loading: false, "selected.transactions.0.memo": "original" }); assert.equal(f.requests.length, 0);
    });
    await scenario("手動更新の保存待ちにタブを往復したら古い更新と通知を中止する", async f => {
      await f.page.evaluate(() => { window.operation = window.controller.refreshCurrentView(() => new Promise<void>(resolve => { window.releasePrepare = resolve; })); });
      await f.page.evaluate(() => window.controller.openTab("settings")); const settings = await f.take();
      await f.page.evaluate(() => window.controller.openTab("home")); const home = await f.take();
      await f.reply(settings, metadata()); await f.reply(home, data("a", "current"));
      await f.page.evaluate(() => window.releasePrepare()); await expectState(f.page, { refreshing: false, loading: false, notice: null, "selected.transactions.0.merchant": "current" }); assert.equal(f.requests.length, 0);
    });
    await scenario("手動更新のGET中にworkspaceを切り替えると古い全件応答と通知を破棄する", async f => {
      await f.page.evaluate(() => { window.operation = window.controller.refreshCurrentView(); }); const oldRefresh = await f.take();
      await f.page.evaluate(() => { window.operation = window.controller.switchWorkspace("b"); }); const current = await f.take();
      await f.reply(current, data("b", "current")); await expectState(f.page, { "selected.workspace.id": "b" });
      await f.reply(oldRefresh, data("a", "old refresh")); await expectState(f.page, { "selected.workspace.id": "b", notice: null, refreshing: false, loading: false });
    });
    await scenario("metadataの選択先が変わるとfullを追加取得し、以前の家計の明細を混ぜない", async f => {
      await f.page.evaluate(() => window.controller.openTab("settings")); await f.reply(await f.take(), metadata("b"));
      const full = await f.take(); assert.equal(new URL(full.request().url()).searchParams.get("workspaceId"), "b"); assert.equal(new URL(full.request().url()).searchParams.has("scope"), false);
      await expectState(f.page, { "selected.workspace.id": "a" }); await f.reply(full, data("b", "other")); await expectState(f.page, { "selected.workspace.id": "b", "selected.transactions.0.merchant": "other", loading: false });
    });
    await scenario("workspace読込失敗は元の家計へ戻り、保存失敗は呼出し元にも伝える", async f => {
      await f.page.evaluate(() => { window.operation = window.controller.switchWorkspace("b"); }); await f.reply(await f.take(), { error: "読込失敗" }, 503);
      await expectState(f.page, { notice: "読込失敗", "selected.workspace.id": "a", loading: false });
      await f.page.evaluate(() => { window.operation = window.controller.run({ action: "saveTransactionMemo", workspaceId: "a", transactionId: "transaction-a", memo: "failed" }, "saved").catch(error => { window.operationError = error.message; }); });
      await f.reply(await f.take("POST"), { error: "保存失敗" }, 400); await expectState(f.page, { notice: "保存失敗", "selected.transactions.0.memo": "original", loading: false }); assert.equal(await f.page.evaluate(() => window.operationError), "保存失敗");
    });
    await scenario("同じ通知でも表示時間をリセットし、古いタイマーと手動閉じを区別する", async f => {
      await f.page.clock.install();
      await f.page.evaluate(() => window.controller.setNotice("saved")); await expectState(f.page, { notice: "saved" });
      await f.page.clock.runFor(1800); await f.page.evaluate(() => window.controller.setNotice("saved")); await expectState(f.page, { notice: "saved" });
      await f.page.clock.runFor(300); await expectState(f.page, { notice: "saved" });
      await f.page.clock.runFor(1800); await expectState(f.page, { notice: null });
      await f.page.evaluate(() => window.controller.setNotice("closed")); await expectState(f.page, { notice: "closed" });
      await f.page.evaluate(() => window.controller.setNotice(null)); await expectState(f.page, { notice: null });
    });
  } finally {
    try { await browser.close(); } finally { await new Promise<void>(done => server.close(() => done())); }
  }
});

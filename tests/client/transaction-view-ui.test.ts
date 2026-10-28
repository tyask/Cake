import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Page, type Route } from "playwright";
import type { BootstrapMetadata, TransactionRecord } from "../../lib/shared/types";

const user = { id: "user-a", name: "A", email: "a@example.test", imageUrl: null };
const workspace = { id: "workspace", name: "家計", type: "SHARED" as const, ownerUserId: user.id, memberCount: 2 };
const initial: BootstrapMetadata = { user, workspaces: [workspace], pendingInvitations: [], selected: {
  workspace, members: [{ ...user, weight: 1, role: "OWNER" },
    { ...user, id: "user-b", name: "B", email: "b@example.test", weight: 1, role: "MEMBER" }],
  categories: [], rules: [],
} };

function transaction(id: string, occurredAt: string, extra: Partial<TransactionRecord> = {}): TransactionRecord {
  return { id, occurredAt, merchant: id, method: "現金", type: "PAYMENT", amountYen: 100,
    actorUserId: user.id, actorName: user.name, expenseClass: "SHARED", splitWeights: { "user-a": 1, "user-b": 1 },
    settledAt: null, memo: "", externalId: id, source: "MANUAL", categoryId: null, categoryConfirmed: false, categoryRevision: 0, ...extra };
}
const october = transaction("10月の支払い", "2026-10-01T00:00:00.000Z");
const september = transaction("9月の支払い", "2026-09-15T00:00:00.000Z");
const november = transaction("11月の支払い", "2026-11-01T00:00:00.000Z");
const income = transaction("10月末の収入", "2026-10-31T03:00:00.000Z", { type: "RECEIPT" });
const settled = transaction("清算済み", "2026-10-20T00:00:00.000Z", { settledAt: "2026-10-21T00:00:00.000Z" });
const personal = transaction("個人の支払い", "2026-10-20T00:00:00.000Z", { expenseClass: "PERSONAL", splitWeights: { "user-a": 1, "user-b": 0 } });

async function waitForSelection(page: Page, mode: string, month = "2026-10") {
  await page.waitForFunction(({ mode, month }) => {
    const view = window.viewUiController.transactionView;
    return view.selection.mode === mode && view.selection.month === month && !view.loading;
  }, { mode, month });
}

test("取引明細の月・未精算切替を実UIとcontrollerで確認する", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/transaction-view-ui.tsx"], bundle: true,
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

  async function fixture(width = 1280) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    await page.clock.setFixedTime(new Date("2026-10-28T03:00:00.000Z"));
    const queries: string[] = [], posts: Route[] = [], errors: string[] = [];
    const records = new Map([october, september, november, income, settled, personal].map(item => [item.id, { ...item }]));
    let holdSaves = false;
    let savedRequest: (() => void) | undefined;
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(data => { window.viewUiInitial = data; }, initial);
    await page.route("**/api/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === "POST") {
        if (holdSaves) { posts.push(route); savedRequest?.(); return; }
        const payload = request.postDataJSON();
        const saved = { ...records.get(payload.transactionId)!, ...payload };
        records.set(saved.id, saved);
        await route.fulfill({ json: { transaction: saved } });
        return;
      }
      if (url.pathname === "/api/app") { await route.fulfill({ json: initial }); return; }
      if (url.pathname === "/api/transactions") {
        queries.push(url.search);
        const mode = url.searchParams.get("mode"), month = url.searchParams.get("month");
        const ids = mode === "unsettled" ? [october.id, september.id, november.id, income.id]
          : month === "2026-09" ? [september.id] : month === "2026-11" ? [november.id]
            : month === "2026-10" ? [october.id, income.id, settled.id, personal.id] : [];
        await route.fulfill({ json: { workspaceId: workspace.id, mode, month: mode === "month" ? month : null,
          transactions: ids.map(id => records.get(id)) } });
        return;
      }
      errors.push(`unexpected API: ${url.pathname}`);
      await route.abort();
    });
    await page.goto(origin);
    await waitForSelection(page, "month");
    await page.locator(`[data-transaction-id="${october.id}"]`).waitFor();
    const close = async () => { assert.deepEqual(errors, []); await context.close(); };
    return { page, context, queries, posts, close, holdSaves: () => { holdSaves = true; },
      releaseSave: async (status = 200) => {
        await page.waitForFunction(() => window.viewUiController.refreshing || document.querySelector('button[aria-busy="true"]') !== null);
        if (posts.length === 0) await new Promise<void>(done => { savedRequest = done; });
        savedRequest = undefined;
        assert.ok(posts.length > 0, "保存要求が開始されている");
        const route = posts.shift()!;
        const payload = route.request().postDataJSON();
        const saved = { ...records.get(payload.transactionId)!, ...payload };
        if (status === 200) records.set(saved.id, saved);
        await route.fulfill({ status, json: status === 200 ? { transaction: saved } : { error: "保存の確認用エラー" } });
      } };
  }

  try {
    await t.test("月の往復・画面移動はキャッシュを使い、更新・モード変更は再取得して条件を復元する", async () => {
      const f = await fixture();
      try {
        assert.equal(f.queries.length, 1);
        assert.equal(await f.page.locator(`[data-transaction-id="${income.id}"]`).count(), 1, "月末の未来収入も表示する");
        await f.page.getByRole("button", { name: "前の月", exact: true }).click();
        await waitForSelection(f.page, "month", "2026-09");
        assert.equal(f.queries.length, 2);
        await f.page.getByRole("button", { name: "次の月", exact: true }).click();
        await waitForSelection(f.page, "month");
        assert.equal(f.queries.length, 2, "取得済みの月へ戻ってもGETしない");
        await f.page.getByRole("button", { name: "別画面へ", exact: true }).click();
        await f.page.getByRole("button", { name: "取引明細へ戻る", exact: true }).click();
        await waitForSelection(f.page, "month");
        assert.equal(f.queries.length, 2, "画面往復でも同じ月を再取得しない");
        await f.page.getByRole("button", { name: "更新", exact: true }).click();
        await f.page.waitForFunction(() => !window.viewUiController.refreshing);
        assert.equal(f.queries.length, 3);
        await f.page.getByRole("radio", { name: "未精算明細", exact: true }).click();
        await waitForSelection(f.page, "unsettled");
        assert.equal(f.queries.length, 4);
        assert.equal(await f.page.getByRole("group", { name: "取引明細の対象月", exact: true }).count(), 0);
        assert.equal(await f.page.locator(`[data-transaction-id="${september.id}"]`).count(), 1, "月外の未清算も表示する");
        assert.equal(await f.page.locator(`[data-transaction-id="${personal.id}"]`).count(), 0);
        assert.equal(await f.page.locator(`[data-transaction-id="${settled.id}"]`).count(), 0);
        await f.page.reload();
        await waitForSelection(f.page, "unsettled");
        assert.equal(await f.page.getByRole("radio", { name: "未精算明細", exact: true }).isChecked(), true, "モードを再読込後も復元する");
        await f.page.getByRole("radio", { name: "月単位明細", exact: true }).click();
        await waitForSelection(f.page, "month");
        await f.page.getByLabel("取引明細の対象年月", { exact: true }).fill("2026-11");
        await waitForSelection(f.page, "month", "2026-11");
        await f.page.reload();
        await waitForSelection(f.page, "month", "2026-11");
        await f.page.getByRole("button", { name: "今月", exact: true }).click();
        await waitForSelection(f.page, "month");
        assert.equal(await f.page.getByLabel("取引明細の対象年月", { exact: true }).inputValue(), "2026-10");
      } finally { await f.close(); }
    });

    await t.test("切替成功で行選択を解除し、列フィルターは保持する", async () => {
      const f = await fixture();
      try {
        await f.page.getByRole("button", { name: "種別で絞り込み", exact: true }).click();
        const dialog = f.page.getByRole("dialog");
        await dialog.getByLabel("収入", { exact: false }).uncheck();
        await dialog.getByRole("button", { name: "適用", exact: true }).click();
        await f.page.locator(`[data-transaction-id="${october.id}"]`).getByRole("checkbox", { name: `${october.id}の明細を選択`, exact: true }).check();
        await f.page.getByText(/件・1件選択/).waitFor();
        await f.page.getByRole("button", { name: "前の月", exact: true }).click();
        await waitForSelection(f.page, "month", "2026-09");
        assert.equal(await f.page.getByRole("button", { name: "種別の絞り込みを解除", exact: true }).count(), 1);
        assert.equal(await f.page.getByText(/件・0件選択/).count(), 1);
        await f.page.getByRole("button", { name: "次の月", exact: true }).click();
        await waitForSelection(f.page, "month");
        assert.equal(await f.page.locator(`[data-transaction-id="${income.id}"]`).count(), 0, "元の月でも支払いだけの条件を維持する");
        assert.equal(await f.page.locator(`[data-transaction-id="${october.id}"]`).getByRole("checkbox", { name: `${october.id}の明細を選択`, exact: true }).isChecked(), false);
      } finally { await f.close(); }
    });

    await t.test("月切替は保存完了を待ち、モード切替の保存失敗では入力と選択月を保持する", async () => {
      const f = await fixture();
      try {
        f.holdSaves();
        const merchant = f.page.locator(`[data-transaction-id="${october.id}"]`).getByRole("textbox", { name: "取引先", exact: true });
        await merchant.fill("保存してから切替");
        await f.page.getByRole("button", { name: "前の月", exact: true }).click();
        assert.equal(f.queries.length, 1, "保存完了前に次の月のGETを開始しない");
        assert.equal(await f.page.getByLabel("取引明細の対象年月", { exact: true }).inputValue(), "2026-10");
        await f.releaseSave();
        await waitForSelection(f.page, "month", "2026-09");
        await f.page.getByRole("button", { name: "次の月", exact: true }).click();
        await waitForSelection(f.page, "month");
        await merchant.fill("保存失敗でも残す入力");
        const before = f.queries.length;
        await f.page.getByRole("radio", { name: "未精算明細", exact: true }).click();
        await f.releaseSave(503);
        await f.page.getByRole("button", { name: "前の月", exact: true }).waitFor({ state: "visible" });
        await f.page.waitForFunction(() => !window.viewUiController.transactionView.loading && !window.viewUiController.refreshing);
        assert.equal(f.queries.length, before, "保存失敗では未精算GETしない");
        assert.equal(await f.page.getByRole("radio", { name: "月単位明細", exact: true }).isChecked(), true);
        assert.equal(await merchant.inputValue(), "保存失敗でも残す入力");
        assert.equal(await f.page.getByLabel("取引明細の対象年月", { exact: true }).inputValue(), "2026-10");
      } finally { await f.close(); }
    });

    for (const width of [320, 390]) await t.test(`mobile ${width}pxの月操作は1行に収まり、モード切替で月操作を隠す`, async () => {
      const f = await fixture(width);
      try {
        const navigation = f.page.getByRole("group", { name: "取引明細の対象月", exact: true });
        const controls = await navigation.locator("button, input").all();
        const boxes = await Promise.all(controls.map(control => control.boundingBox()));
        assert.ok(boxes.every(box => box && box.x >= 0 && box.x + box.width <= width + 1 && box.height >= 44));
        assert.ok(boxes.every(box => box && Math.abs(box.y - boxes[0]!.y) <= 1), "前月・年月・翌月・今月を1行に配置する");
        await f.page.getByRole("button", { name: "前の月", exact: true }).click();
        await waitForSelection(f.page, "month", "2026-09");
        await f.page.getByRole("button", { name: "今月", exact: true }).click();
        await waitForSelection(f.page, "month");
        await f.page.getByRole("radio", { name: "未精算明細", exact: true }).click();
        await waitForSelection(f.page, "unsettled");
        assert.equal(await navigation.count(), 0);
      } finally { await f.close(); }
    });
  } finally {
    await browser.close();
    await new Promise<void>(done => server.close(() => done()));
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Browser, type Route } from "playwright";
import type { ImportHistoryEntry } from "../../lib/shared/import-history";
import type { WorkspaceData } from "../../lib/shared/types";

const history: ImportHistoryEntry[] = Array.from({ length: 10 }, (_, index) => ({
  id: `batch-${index}`, format: "PAYPAY", importedBy: index % 2 ? "b" : "a",
  importedByName: index === 0 ? "長い取込者名でも一行を保つ名前" : index % 2 ? "太郎" : "花子",
  fileName: index === 0 ? "非常に長いファイル名".repeat(20) + ".csv" : `PayPay_${index}.csv`,
  totalRows: 2000, importedRows: index === 0 ? 2000 : index, skippedRows: index === 0 ? 0 : 2000 - index,
  createdAt: new Date(Date.UTC(2026, 9, 25, 5, 32 - index, 42, 123)).toISOString(),
}));
const workspace: WorkspaceData = {
  workspace: { id: "workspace", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
  members: [
    { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 1, role: "OWNER" },
    { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 1, role: "MEMBER" },
  ], categories: [], rules: [], transactions: [], settlement: null, settlementHistory: [],
};

type Api = (route: Route, url: URL) => Promise<void>;
async function openFixture(browser: Browser, origin: string, width: number, api: Api, mode: boolean | "controller" = false) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", hasTouch: width <= 768 });
  const page = await context.newPage(), errors: string[] = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => api(route, new URL(route.request().url())));
  await page.addInitScript(selected => { window.importHistoryWorkspace = selected; }, workspace);
  await page.goto(mode === "controller" ? `${origin}/?controller` : mode ? `${origin}/?import` : origin);
  return { context, page, errors };
}

test("取込履歴は取込者ごとの履歴を一行の表で表示し、専用APIの状態と登録成功に追随する", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/import-history.tsx"], bundle: true, write: false,
    outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    const output = bundle.outputFiles.find(file => file.path.endsWith(req.url === "/bundle.css" ? "/bundle.css" : "/bundle.js"));
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : req.url === "/bundle.css" ? "text/css" : "text/html");
    res.end(req.url?.startsWith("/bundle.") ? output!.text : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  try {
    for (const width of [1440, 390, 320]) await t.test(`幅${width}px: 2人分10件を1履歴1行に保ち、詳細とキーボード操作で全文を確認する`, async () => {
      const { context, page, errors } = await openFixture(browser, origin, width, async (route, url) => {
        assert.equal(route.request().method(), "GET");
        assert.equal(url.pathname, "/api/import/history");
        assert.equal(url.searchParams.get("workspaceId"), "workspace");
        assert.equal(url.searchParams.get("format"), "PAYPAY");
        await route.fulfill({ json: { history } });
      });
      try {
        const table = page.getByRole("table", { name: "PayPayの取込履歴", exact: true });
        await table.waitFor();
        assert.equal(await table.locator("tbody tr").count(), 10, "合計5件には切り詰めない");
        assert.equal(await page.getByText("取込者ごとに最新5件 · 新しい順", { exact: true }).count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await table.locator("tbody tr").evaluateAll(rows => rows.every(row => row.getBoundingClientRect().height <= 45
          && [...row.children].every(cell => Math.abs(cell.getBoundingClientRect().y - row.getBoundingClientRect().y) < 1))), true);
        const filename = table.locator("tbody tr").first().getByRole("button");
        assert.equal(await filename.evaluate(button => button.scrollWidth > button.clientWidth), true, "長い名前を省略表示する");
        await filename.click();
        const dialog = page.getByRole("dialog", { name: "取込の詳細", exact: true });
        await dialog.waitFor();
        assert.equal(await dialog.getByText(history[0].fileName, { exact: true }).isVisible(), true);
        assert.equal(await dialog.getByText(history[0].importedByName, { exact: true }).isVisible(), true);
        assert.equal(await dialog.getByText("2026/10/25 14:32", { exact: true }).isVisible(), true);
        assert.equal(await dialog.getByText("2000件", { exact: true }).isVisible(), true);
        assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        assert.equal(await filename.evaluate(element => document.activeElement === element), true, "閉じるとファイル名にfocusが戻る");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t.test("取得中・失敗・再試行・空を区別し、更新中に古い履歴を表示しない", async () => {
      let attempts = 0, release: (() => Promise<void>) | undefined;
      const { context, page, errors } = await openFixture(browser, origin, 390, async route => {
        attempts += 1;
        if (attempts === 1) release = () => route.fulfill({ status: 503, json: { error: "検証用の取得失敗" } });
        else await route.fulfill({ json: { history: attempts === 2 ? history : [] } });
      });
      try {
        await page.getByRole("status").waitFor();
        assert.equal(await page.getByText("PayPayの取込履歴はまだありません。", { exact: true }).count(), 0);
        assert.ok(release); await release();
        await page.getByRole("alert").waitFor();
        assert.equal(await page.getByRole("alert").innerText(), "検証用の取得失敗");
        await page.getByRole("button", { name: "再試行", exact: true }).click();
        await page.getByRole("table").waitFor();
        await page.getByRole("button", { name: "履歴を更新する", exact: true }).click();
        await page.getByText("PayPayの取込履歴はまだありません。", { exact: true }).waitFor();
        assert.equal(await page.getByRole("table").count(), 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t.test("workspace変更前の遅延応答を採用しない", async () => {
      let releaseOld: (() => Promise<void>) | undefined;
      const { context, page, errors } = await openFixture(browser, origin, 390, async (route, url) => {
        if (url.searchParams.get("workspaceId") === "workspace") releaseOld = () => route.fulfill({ json: { history } });
        else await route.fulfill({ json: { history: [{ ...history[0], id: "other", fileName: "切替後のファイル.csv" }] } });
      });
      try {
        await page.getByRole("status").waitFor();
        await page.getByRole("button", { name: "家計を切り替える", exact: true }).click();
        await page.getByRole("button", { name: "切替後のファイル.csvの取込詳細を開く", exact: true }).waitFor();
        assert.ok(releaseOld); await releaseOld().catch(() => {});
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        assert.equal(await page.getByRole("table").locator("tbody tr").count(), 1);
        assert.equal(await page.getByRole("button", { name: "切替後のファイル.csvの取込詳細を開く", exact: true }).count(), 1);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t.test("取込ページ最下部に配置し、登録失敗時は再取得せず成功時だけ履歴を更新する", async () => {
      let historyRequests = 0, saves = 0;
      const { context, page, errors } = await openFixture(browser, origin, 390, async (route, url) => {
        if (url.pathname === "/api/import/history") {
          historyRequests += 1;
          await route.fulfill({ json: { history: saves >= 2 ? [{ ...history[0], fileName: "今回の取込.csv" }] : [] } });
        } else if (url.pathname === "/api/import/duplicates") await route.fulfill({ json: { transactions: [], externalIds: [] } });
        else if (url.pathname === "/api/app") {
          saves += 1;
          await route.fulfill(saves === 1 ? { status: 503, json: { error: "登録失敗" } } : { json: { ok: true, imported: 1, skipped: 0 } });
        } else assert.fail(`unexpected API ${url.pathname}`);
      }, true);
      try {
        await page.getByText("PayPayの取込履歴はまだありません。", { exact: true }).waitFor();
        const source = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n2026/10/25 14:32:42,100,支払い,取込履歴テスト,PayPay,12345";
        await page.locator("input[type=file]").setInputFiles({ name: "今回の取込.csv", mimeType: "text/csv", buffer: Buffer.from(source) });
        const save = page.getByRole("button", { name: "確認して登録", exact: true });
        await save.click();
        await page.getByRole("alert").waitFor();
        assert.equal(historyRequests, 1);
        await save.click();
        await page.getByRole("button", { name: "今回の取込.csvの取込詳細を開く", exact: true }).waitFor();
        assert.equal(historyRequests, 2);
        assert.equal(await page.locator("main > section").last().getByRole("heading", { name: "最近の取込履歴", exact: true }).count(), 1);
        assert.equal(await page.getByRole("button", { name: "確認して登録", exact: true }).count(), 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t.test("controller: 登録済みならmetadata GETだけ失敗しても履歴を更新し、再登録を促さない", async () => {
      let historyRequests = 0, saves = 0, metadataRequests = 0;
      const { context, page, errors } = await openFixture(browser, origin, 390, async (route, url) => {
        if (url.pathname === "/api/import/history") {
          historyRequests += 1;
          await route.fulfill({ json: { history: saves ? [{ ...history[0], fileName: "保存済み.csv" }] : [] } });
        } else if (url.pathname === "/api/import/duplicates") await route.fulfill({ json: { transactions: [], externalIds: [] } });
        else if (url.pathname === "/api/app" && route.request().method() === "POST") {
          saves += 1;
          await route.fulfill({ json: { ok: true, imported: 1, skipped: 0 } });
        } else if (url.pathname === "/api/app") {
          metadataRequests += 1;
          assert.equal(url.searchParams.get("scope"), "metadata");
          await route.fulfill({ status: 503, json: { error: "検証用metadata失敗" } });
        } else assert.fail(`unexpected API ${url.pathname}`);
      }, "controller");
      try {
        await page.getByText("PayPayの取込履歴はまだありません。", { exact: true }).waitFor();
        const source = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n2026/10/25 14:32:42,100,支払い,取込履歴テスト,PayPay,12345";
        await page.locator("input[type=file]").setInputFiles({ name: "保存済み.csv", mimeType: "text/csv", buffer: Buffer.from(source) });
        await page.getByRole("button", { name: "確認して登録", exact: true }).click();
        await page.getByRole("button", { name: "保存済み.csvの取込詳細を開く", exact: true }).waitFor();
        await page.getByRole("status").filter({ hasText: "1件を取り込みました。家計の最新状態を取得できないため、画面を更新してください。" }).waitFor();
        assert.equal(await page.getByRole("button", { name: "確認して登録", exact: true }).count(), 0, "成功済みCSVのプレビューを閉じる");
        assert.equal(await page.getByRole("alert").count(), 0, "metadata失敗を保存失敗として表示しない");
        assert.equal(saves, 1);
        assert.equal(historyRequests, 2);
        assert.equal(metadataRequests, 1);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t.test("controller: 保存中に別tabへ離脱して戻っても現在のPanelへ保存完了を反映する", async () => {
      let historyRequests = 0, saves = 0, committed = false, releaseSave: (() => Promise<void>) | undefined;
      const { context, page, errors } = await openFixture(browser, origin, 390, async (route, url) => {
        if (url.pathname === "/api/import/history") {
          historyRequests += 1;
          await route.fulfill({ json: { history: committed ? [{ ...history[0], fileName: "離脱中の取込.csv" }] : [] } });
        } else if (url.pathname === "/api/import/duplicates") await route.fulfill({ json: { transactions: [], externalIds: [] } });
        else if (url.pathname === "/api/app" && route.request().method() === "POST") {
          saves += 1;
          releaseSave = async () => {
            committed = true;
            await route.fulfill({ json: { ok: true, imported: 1, skipped: 0 } });
          };
        } else if (url.pathname === "/api/app") await route.fulfill({ json: {
          user: workspace.members[0], workspaces: [workspace.workspace], selected: workspace, pendingInvitations: [],
        } });
        else assert.fail(`unexpected API ${url.pathname}`);
      }, "controller");
      try {
        await page.getByText("PayPayの取込履歴はまだありません。", { exact: true }).waitFor();
        const source = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n2026/10/25 14:32:42,100,支払い,取込履歴テスト,PayPay,12345";
        await page.locator("input[type=file]").setInputFiles({ name: "離脱中の取込.csv", mimeType: "text/csv", buffer: Buffer.from(source) });
        await page.getByRole("button", { name: "確認して登録", exact: true }).click();
        await page.getByRole("button", { name: "登録中…", exact: true }).waitFor();
        await page.getByRole("button", { name: "ホームへ移動", exact: true }).click();
        await page.getByRole("heading", { name: "ホーム", exact: true }).waitFor();
        await page.getByRole("button", { name: "取込へ移動", exact: true }).click();
        await page.getByText("PayPayの取込履歴はまだありません。", { exact: true }).waitFor();
        assert.equal(historyRequests, 2);
        assert.ok(releaseSave); await releaseSave();
        await page.getByRole("button", { name: "離脱中の取込.csvの取込詳細を開く", exact: true }).waitFor();
        assert.equal(historyRequests, 3, "現在のPanelもcontrollerのrevisionで履歴を再取得する");
        assert.equal(saves, 1);
        assert.equal(await page.getByRole("alert").count(), 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); }
});

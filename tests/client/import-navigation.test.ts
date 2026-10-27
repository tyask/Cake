import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { resolveAnalyticsPeriods, type AnalyticsQuery } from "../../lib/shared/analytics";
import type { BootstrapData, BootstrapMetadata, DashboardTab } from "../../lib/shared/types";

const now = new Date("2026-10-23T02:00:00Z");
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const tabs: Record<DashboardTab, string> = { home: "ホーム", transactions: "取引明細", import: "取込", analytics: "集計", settings: "設定" };
const csv = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n" +
  ["draft", "personal", "removed"].map(merchant => `2026/10/18 12:00:42,100,支払い,${merchant},PayPay,${merchant}`).join("\n");
type Request = { path: string; method: string; payload?: Record<string, unknown> };
type Api = (route: Route, request: Request) => Promise<void>;

function bootstrap(id = workspaceId): BootstrapData {
  const user = { id: "a", name: "Aさん", email: "a@example.test", imageUrl: null };
  const workspaces = [workspaceId, otherWorkspaceId].map(id => ({ id, name: id === workspaceId ? "取込元の家計" : "別の家計",
    type: "SHARED" as const, ownerUserId: user.id, memberCount: 2 }));
  return { user, workspaces, pendingInvitations: [], selected: {
    workspace: workspaces.find(workspace => workspace.id === id)!,
    members: [{ ...user, weight: 6, role: "OWNER" },
      { id: "b", name: "Bさん", email: "b@example.test", imageUrl: null, weight: 4, role: "MEMBER" }],
    categories: [{ id: "food", parentId: null, name: "食費", colorHex: "#f97316", sortOrder: 0, archivedAt: null, revision: 1 }],
    rules: [], transactions: [], settlement: null, settlementHistory: [],
  } };
}

function metadata(data: BootstrapData): BootstrapMetadata {
  const { workspace, members, categories, rules } = data.selected!;
  return { ...data, selected: { workspace, members, categories, rules } };
}

async function stable(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openFixture(browser: Browser, origin: string, width: number, api?: Api) {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 },
    isMobile: width < 768, hasTouch: width < 768, reducedMotion: "reduce", serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = [], requests: Request[] = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => { void dialog.accept(); });
  await page.clock.setFixedTime(now);
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.origin !== origin) { errors.push("外部通信を検出"); await route.abort(); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    const request: Request = { path: url.pathname, method, ...(method === "POST" ? { payload: route.request().postDataJSON() } : {}) };
    requests.push(request);
    if (method === "GET" && url.pathname === "/api/app") {
      const data = bootstrap(url.searchParams.get("workspaceId") ?? workspaceId);
      await route.fulfill({ json: url.searchParams.get("scope") === "metadata" ? metadata(data) : data });
    } else if (url.pathname === "/api/import/history") await route.fulfill({ json: { history: [] } });
    else if (url.pathname === "/api/recurring-payments") await route.fulfill({ json: {
      now: now.toISOString(), today: "2026-10-23", eligibleActorUserIds: ["a", "b"], payments: [],
    } });
    else if (url.pathname === "/api/analytics") {
      const query: AnalyticsQuery = { workspaceId, period: "month", month: url.searchParams.get("month")! };
      await route.fulfill({ json: { workspaceId, snapshotAt: now.toISOString(), timeZone: "Asia/Tokyo",
        periods: resolveAnalyticsPeriods(query, now), members: [{ id: "a", name: "Aさん" }, { id: "b", name: "Bさん" }],
        categories: [], receiptBuckets: [], buckets: [] } });
    } else if (api) await api(route, request);
    else if (url.pathname === "/api/import/duplicates") await route.fulfill({ json: { transactions: [] } });
    else { errors.push(`想定外のAPI: ${method} ${url.pathname}`); await route.abort(); }
  });
  await page.addInitScript(data => { window.navigationInitialData = data; }, bootstrap());
  await page.goto(origin);
  const navigate = async (tab: DashboardTab) => {
    const response = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/app");
    await page.locator(width < 768 ? ".bottom-nav" : ".app-nav").getByRole("button", { name: new RegExp(`${tabs[tab]}$`) }).click();
    await response;
    if (tab === "home") await page.getByRole("table", { name: "2026年10月の収支", exact: true }).waitFor();
    else await page.getByRole("heading", { name: tab === "import" ? "明細を取込" : tab === "analytics" ? "収支の集計" : tabs[tab], level: 1, exact: true }).waitFor();
    await stable(page);
    assert.equal(await page.locator('table[aria-label="取り込み明細"]').count(), tab === "import" ? await page.getByRole("table", { name: "取り込み明細", exact: true }).count() : 0,
      "取込画面を離れると確認表のDOMを残さない");
    assert.equal(await page.getByRole("heading", { name: "最近の取込履歴", exact: true }).count(), tab === "import" ? 1 : 0);
  };
  const upload = async () => {
    await page.locator('input[type="file"]').setInputFiles({ name: "retained.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  };
  const row = (merchant: string) => page.locator("[data-import-key]").filter({ has: page.locator(`td[data-label="取引先"] input[value="${merchant}"]`) });
  const expand = async (merchant: string) => {
    if (width < 768 && await row(merchant).getAttribute("data-expanded") !== "true") {
      await row(merchant).getByRole("button", { name: /の詳細を開く$/ }).click();
    }
  };
  await navigate("import");
  return { context, page, errors, requests, navigate, upload, row, expand };
}

function deferredRoute() {
  let receive: (route: Route) => void;
  const promise = new Promise<Route>(resolve => { receive = resolve; });
  return { promise, receive: (route: Route) => receive(route) };
}

test("CSV取込の確認中・非同期処理中に実Dashboardを移動しても状態を失わない", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/dashboard-navigation.tsx"], bundle: true, write: false,
    outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
  const server = createServer((req, res) => {
    const asset = req.url === "/bundle.js" ? "js" : req.url === "/bundle.css" ? "css" : null;
    res.setHeader("Content-Type", asset === "js" ? "application/javascript" : asset === "css" ? "text/css" : "text/html");
    res.end(asset ? bundle.outputFiles.find(file => file.path.endsWith(`/bundle.${asset}`))!.text
      : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  try {
    for (const [name, width] of [["PC", 1440], ["mobile", 390]] as const) {
      await t.test(`${name}: 入力・選択・削除を全タブ往復で保ち、明示取消で解除する`, async () => {
        const { context, page, errors, requests, navigate, upload, row, expand } = await openFixture(browser, origin, width);
        try {
          await upload(); await page.getByRole("button", { name: "確認して登録", exact: true }).waitFor();
          await page.getByRole("button", { name: "やり直す", exact: true }).click();
          await navigate("home"); await navigate("import");
          assert.equal(await page.locator("[data-import-key]").count(), 0, "やり直した確認表は再表示しない");
          await upload(); await page.getByRole("button", { name: "確認して登録", exact: true }).waitFor();
          await expand("draft"); await expand("personal"); await expand("removed");
          await page.getByRole("combobox", { name: "支払者", exact: true }).selectOption("a");
          await row("draft").getByLabel("取引先", { exact: true }).fill("edited");
          await row("edited").getByLabel("メモ", { exact: true }).fill("編集中\nのメモ");
          await row("edited").getByLabel("Aさんの配分割合", { exact: true }).fill("70");
          await row("edited").getByLabel("カテゴリ", { exact: true }).selectOption("food");
          await row("personal").getByLabel("personalの区分", { exact: true }).selectOption("PERSONAL");
          await row("removed").getByRole("checkbox", { name: "removedを選択", exact: true }).check();
          await page.getByRole("button", { name: "削除", exact: true }).click();
          await row("edited").getByRole("checkbox", { name: "editedを選択", exact: true }).check();
          await page.getByRole("combobox", { name: "支払者", exact: true }).selectOption("b");
          await page.getByLabel("選択行のカテゴリ", { exact: true }).selectOption("food");
          for (const tab of ["home", "transactions", "settings", "analytics"] as const) {
            await navigate(tab); await navigate("import");
            await expand("edited"); await expand("personal");
            assert.match(await page.locator(".import-summary").innerText(), /retained\.csv/);
            assert.equal(await page.getByRole("combobox", { name: "支払者", exact: true }).inputValue(), "b");
            assert.equal(await row("edited").getByLabel("メモ", { exact: true }).inputValue(), "編集中\nのメモ");
            assert.equal(await row("edited").getByLabel("Aさんの配分割合", { exact: true }).inputValue(), "70");
            assert.equal(await row("edited").getByLabel("カテゴリ", { exact: true }).inputValue(), "food");
            assert.equal(await row("edited").getByRole("checkbox", { name: "editedを選択", exact: true }).isChecked(), true);
            assert.equal(await row("personal").getByLabel("personalの区分", { exact: true }).inputValue(), "PERSONAL");
            assert.equal(await row("removed").count(), 0);
            assert.equal(await page.getByLabel("選択行のカテゴリ", { exact: true }).inputValue(), "food");
          }
          assert.equal(requests.filter(request => request.path === "/api/import/duplicates").length, 2, "画面往復だけではCSVを再読込しない");
          assert.equal(requests.filter(request => request.method === "POST" && request.path === "/api/app").length, 0, "編集中の明細は未登録");
          assert.equal(requests.filter(request => request.path === "/api/import/history").length, 6, "取込履歴は画面への入場時だけ取得する");
          await page.getByRole("button", { name: "キャンセル", exact: true }).click();
          await navigate("home"); await navigate("import");
          assert.equal(await page.locator("[data-import-key]").count(), 0);
          await page.getByRole("button", { name: "ファイルを選択", exact: true }).waitFor();
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });

      await t.test(`${name}: 読込・補完・保存の遅延応答と失敗を往復後に引き継ぐ`, async () => {
        let phase: "read" | "suggest" | "failedSave" | "save" = "read", pending = deferredRoute();
        const { context, page, errors, requests, navigate, upload, row, expand } = await openFixture(browser, origin, width, async (route, request) => {
          if (request.path === "/api/import/duplicates" && phase !== "read") await route.fulfill({ json: { transactions: [] } });
          else if (["/api/import/duplicates", "/api/import/category-suggestions", "/api/app"].includes(request.path)) pending.receive(route);
          else assert.fail(`想定外のAPI: ${request.path}`);
        });
        try {
          await upload(); const reading = await pending.promise;
          await navigate("home"); await navigate("import");
          await page.getByText("CSVを読み込み、重複を確認しています…", { exact: true }).waitFor();
          await reading.fulfill({ json: { transactions: [] } });
          await page.getByRole("button", { name: "確認して登録", exact: true }).waitFor();
          phase = "suggest"; pending = deferredRoute();
          await page.getByRole("button", { name: "カテゴリ自動補完", exact: true }).click(); const suggestion = await pending.promise;
          await navigate("settings");
          await suggestion.fulfill({ json: { suggestions: ["draft", "personal", "removed"].map(merchant => ({ merchant, categoryId: "food" })) } });
          await navigate("import"); await expand("draft");
          await page.getByText("3件のカテゴリを補完しました。", { exact: true }).waitFor();
          assert.equal(await row("draft").getByLabel("カテゴリ", { exact: true }).inputValue(), "food");
          await row("draft").getByLabel("メモ", { exact: true }).fill("失敗後も残す");
          phase = "failedSave"; pending = deferredRoute();
          await page.getByRole("button", { name: "確認して登録", exact: true }).click(); const failedSave = await pending.promise;
          await navigate("home"); await failedSave.fulfill({ status: 503, json: { error: "検証用の取込失敗" } });
          await navigate("import"); await expand("draft");
          await page.getByText("検証用の取込失敗", { exact: true }).waitFor();
          assert.equal(await row("draft").getByLabel("メモ", { exact: true }).inputValue(), "失敗後も残す");
          phase = "save"; pending = deferredRoute();
          await page.getByRole("button", { name: "確認して登録", exact: true }).click(); const save = await pending.promise;
          await navigate("home"); await navigate("import");
          await page.getByRole("button", { name: "登録中…", exact: true }).waitFor();
          await navigate("home");
          await save.fulfill({ json: { ok: true, imported: 3, skipped: 0 } }); await stable(page);
          await navigate("import");
          await page.getByRole("button", { name: "ファイルを選択", exact: true }).waitFor();
          await navigate("home"); await navigate("import");
          assert.equal(await page.locator("[data-import-key]").count(), 0, "登録成功後の確認表は再表示しない");
          const writes = requests.filter(request => request.path === "/api/app" && request.method === "POST");
          assert.equal(writes.length, 2, "失敗時の再試行以外に登録要求を重複させない");
          assert.equal(writes[1].payload?.fileName, "retained.csv");
          assert.equal(writes[1].payload?.totalRows, 3);
          assert.equal((writes[1].payload?.items as { memo: string }[])[0].memo, "失敗後も残す");
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });

      await t.test(`${name}: 家計切替後に古い読込結果を混ぜない`, async () => {
        const pending = deferredRoute();
        const { context, page, errors, upload } = await openFixture(browser, origin, width, async route => { pending.receive(route); });
        try {
          await upload(); const reading = await pending.promise;
          const response = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/app");
          await page.locator(width < 768 ? ".mobile-header select" : ".workspace-picker select").selectOption(otherWorkspaceId);
          await response; await page.locator(".import-destination b", { hasText: "別の家計" }).waitFor();
          await reading.fulfill({ json: { transactions: [] } }); await stable(page);
          assert.equal(await page.locator("[data-import-key]").count(), 0);
          assert.equal(await page.getByRole("button", { name: "貼り付け", exact: true }).isEnabled(), true);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }
  } finally { try { await browser.close(); } finally { await new Promise<void>(done => server.close(() => done())); } }
});

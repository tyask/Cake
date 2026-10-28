import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Page, type Route } from "playwright";
import { resolveAnalyticsPeriods, type AnalyticsDataset, type AnalyticsQuery } from "../../lib/shared/analytics";
import type { HomeData } from "../../lib/shared/home-data";
import { cashflowSummary, transactionsInMonth, workspaceCashflowSummary } from "../../lib/shared/home-summary";
import { calculateSettlement } from "../../lib/shared/settlement";
import type { BootstrapData, BootstrapMetadata, DashboardTab } from "../../lib/shared/types";

const now = new Date("2026-10-23T02:00:00Z");
const workspaceId = "11111111-1111-4111-8111-111111111111";
const panels: Record<DashboardTab, { navigation: string; heading: string | null }> = {
  home: { navigation: "ホーム", heading: null },
  transactions: { navigation: "取引明細", heading: "取引明細" },
  settings: { navigation: "設定", heading: "設定" },
  analytics: { navigation: "集計", heading: "収支の集計" },
  import: { navigation: "取込", heading: "明細を取込" },
};

function bootstrap(): BootstrapData {
  const user = { id: "a", name: "Aさん", email: "a@example.test", imageUrl: null };
  const workspace = { id: workspaceId, name: "ナビゲーション検証用の家計", type: "SHARED" as const, ownerUserId: user.id, memberCount: 2 };
  return { user, workspaces: [workspace], pendingInvitations: [], selected: {
    workspace, members: [{ ...user, weight: 1, role: "OWNER" },
      { id: "b", name: "Bさん", email: "b@example.test", imageUrl: null, weight: 1, role: "MEMBER" }],
    categories: [], rules: [], settlement: null, settlementHistory: [],
    transactions: Array.from({ length: 12 }, (_, index) => ({
      id: `navigation-${index}`, occurredAt: "2026-10-18T03:00:42.123Z", merchant: `検証明細${index + 1}`,
      method: "現金", memo: "", type: "PAYMENT", amountYen: 100, actorUserId: user.id, actorName: user.name,
      expenseClass: "SHARED", splitWeights: { a: 1, b: 1 }, settledAt: null, externalId: `manual-navigation-${index}`,
      source: "MANUAL", categoryId: null, categoryConfirmed: false, categoryRevision: 0,
    })),
  } };
}

function metadata(data: BootstrapData): BootstrapMetadata {
  const { workspace, members, categories, rules } = data.selected!;
  return { ...data, selected: { workspace, members, categories, rules } };
}

function home(data: BootstrapData, month: string): HomeData {
  const selected = data.selected!;
  const monthly = workspaceCashflowSummary(transactionsInMonth(selected.transactions, month), selected.members);
  const totals = (value: ReturnType<typeof cashflowSummary>) => ({ paymentTotal: String(value.paymentTotal), receiptTotal: String(value.receiptTotal), balanceYen: String(value.balanceYen) });
  const unsettled = selected.transactions.filter(transaction => transaction.expenseClass === "SHARED" && !transaction.settledAt);
  const result = calculateSettlement(selected.members, selected.transactions);
  return {
    workspaceId, month, members: selected.members.map(({ id, name }) => ({ id, name })),
    monthly: { people: selected.members.map(member => ({ userId: member.id, ...totals(monthly.people.get(member.id)!) })), total: totals(monthly.total) },
    unsettled: { count: unsettled.length, ...totals(cashflowSummary(unsettled)) },
    settlement: result ? (({ transactionIds, ...summary }) => { void transactionIds; return summary; })(result) : null,
    settlementHistory: selected.settlementHistory,
  };
}

function analytics(query: AnalyticsQuery): AnalyticsDataset {
  return { workspaceId, snapshotAt: now.toISOString(), timeZone: "Asia/Tokyo", periods: resolveAnalyticsPeriods(query, now),
    members: [{ id: "a", name: "Aさん" }, { id: "b", name: "Bさん" }], categories: [], receiptBuckets: [],
    buckets: ["a", "b"].flatMap(memberId => ["current", "trend"].map(scope => ({
      scope: scope as "current" | "trend", month: "2026-10", memberId, expenseClass: "SHARED" as const, categoryId: null, burdenYen: "600",
    }))),
  };
}

async function stable(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertPanel(page: Page, tab: DashboardTab, loading = false, transactionLoading = false) {
  const main = page.locator(".app-main"), expected = panels[tab].heading;
  if (expected) await main.getByRole("heading", { name: expected, level: 1, exact: true }).waitFor();
  else await main.getByRole("table", { name: "2026年10月の収支", exact: true }).waitFor();
  if (!loading) await page.waitForFunction(() => !document.querySelector(".loading-line"));
  if (tab === "analytics") await main.getByTestId("analytics-total").waitFor();
  if (tab === "transactions") {
    assert.equal(await main.getByRole("radio", { name: "月単位明細", exact: true }).count(), 1);
    assert.equal(await main.getByRole("radio", { name: "未精算明細", exact: true }).count(), 1);
    assert.equal(await main.getByRole("group", { name: "取引明細の対象月", exact: true }).count(), 1,
      "一覧取得中も表示モードと対象月の操作欄を表示する");
    if (transactionLoading) {
      await main.getByRole("status").filter({ hasText: "明細を読み込んでいます…" }).waitFor();
      assert.equal(await main.locator("[data-transaction-id]").count(), 0, "取得前の一覧に他画面の古い行を表示しない");
      assert.equal(await main.getByRole("radio", { name: "月単位明細", exact: true }).isDisabled(), true);
    } else if (!loading) {
      await main.getByRole("radio", { name: "月単位明細", exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="radio"][value="month"]')?.disabled === false);
      assert.equal(await main.locator("[data-transaction-id]").count(), 12, "独立した一覧GETの成功後に対象月の明細を表示する");
    }
  }
  await stable(page);

  assert.equal(await page.locator(".app-shell").count(), 1);
  assert.equal(await page.locator(".app-main").count(), 1);
  assert.deepEqual(await main.getByRole("heading", { level: 1 }).allTextContents(), expected ? [expected] : [],
    `${tab}: 現在の画面の見出しだけを1つ表示する`);
  const allHeadings = await main.locator("h1").allTextContents();
  assert.equal(allHeadings.filter(value => value === "収支の集計").length, 1, "集計の保持用パネルは1つだけ存在する");
  for (const [id, panel] of Object.entries(panels)) {
    if (!panel.heading || id === "analytics") continue;
    assert.equal(allHeadings.filter(value => value === panel.heading).length, id === tab ? 1 : 0,
      `${tab}: ${panel.heading}の古いパネルを残さない`);
  }
  assert.equal(await main.getByRole("table", { name: "取引明細", exact: true }).count(), tab === "transactions" ? 1 : 0);
  assert.equal(await main.locator('table[aria-label="取引明細"]').count(), tab === "transactions" ? 1 : 0,
    "非表示の取引明細テーブルも残さない");
  assert.equal(await main.locator(".kpi-grid").count(), tab === "home" ? 1 : 0);
  assert.equal(await main.locator('input[type="file"]').count(), tab === "import" ? 1 : 0);
  assert.equal(await main.getByRole("heading", { name: "最近の取込履歴", exact: true }).count(), tab === "import" ? 1 : 0);
  assert.equal(await main.locator('section[aria-labelledby="workspace-settings-title"]').count(), tab === "settings" ? 1 : 0);
}

test("実DashboardのPC・mobileタブ移動で見出しとパネルが重複・残留しない", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/dashboard-navigation.tsx"], bundle: true, write: false,
    outfile: "bundle.js", platform: "browser", format: "iife",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
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
    for (const [name, width] of [["PC", 1440], ["mobile", 390]] as const) await t.test(`${name}: 全タブを往復して現在のパネルだけを表示する`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 },
        isMobile: width < 768, hasTouch: width < 768, reducedMotion: "reduce", serviceWorkers: "block" });
      try {
        const page = await context.newPage(), errors: string[] = [], requests: string[] = [], appRequests: Route[] = [], transactionRequests: Route[] = [];
        const data = bootstrap();
        page.setDefaultTimeout(10000);
        page.on("pageerror", error => errors.push(error.message));
        await page.clock.setFixedTime(now);
        await page.route("**/*", async route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) { errors.push("外部通信を検出"); await route.abort(); return; }
          if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
          requests.push(url.pathname);
          if (route.request().method() !== "GET") { errors.push("想定外の更新API"); await route.abort(); return; }
          if (url.pathname === "/api/app") {
            appRequests.push(route);
          } else if (url.pathname === "/api/transactions") {
            transactionRequests.push(route);
          } else if (url.pathname === "/api/home") {
            await route.fulfill({ json: home(data, url.searchParams.get("month")!) });
          } else if (url.pathname === "/api/analytics") {
            const query: AnalyticsQuery = { workspaceId, period: "month", month: url.searchParams.get("month")! };
            await route.fulfill({ json: analytics(query) });
          } else if (url.pathname === "/api/recurring-payments") {
            await route.fulfill({ json: { now: now.toISOString(), today: "2026-10-23", eligibleActorUserIds: ["a", "b"], payments: [] } });
          } else if (url.pathname === "/api/import/history") {
            await route.fulfill({ json: { history: [] } });
          } else { errors.push(`想定外のAPI: ${url.pathname}`); await route.abort(); }
        });
        await page.addInitScript(data => { window.navigationInitialData = data; }, metadata(data));
        await page.goto(origin);
        await assertPanel(page, "home");
        const nav = page.locator(width < 768 ? ".bottom-nav" : ".app-nav");
        assert.equal(await nav.getByRole("button").count(), 5);
        assert.equal(await nav.getByRole("button", { name: /清算$/ }).count(), 0, "清算操作はホームへ統合する");
        const sequence: DashboardTab[] = ["transactions", "settings", "home", "analytics", "import", "home", "transactions",
          "analytics", "transactions", "import", "home", "settings", "transactions", "home"];
        let transactionsLoaded = false;
        for (const tab of sequence) {
          const transactionLoading = tab === "transactions" && !transactionsLoaded;
          const firstTransactions = transactionLoading
            ? page.waitForRequest(request => new URL(request.url()).pathname === "/api/transactions") : null;
          await nav.getByRole("button", { name: new RegExp(`${panels[tab].navigation}$`) }).click();
          if (firstTransactions) await firstTransactions;
          await page.locator(".loading-line").waitFor({ state: "visible" });
          await assertPanel(page, tab, true, transactionLoading);
          assert.deepEqual(errors, []);
          assert.equal(appRequests.length, 1, "タブ移動のGETを1件ずつ制御する");
          const request = appRequests.shift()!, url = new URL(request.request().url());
          assert.equal(url.searchParams.get("scope"), "metadata", "全タブで共通情報だけを取得する");
          await request.fulfill({ json: metadata(data) });
          if (transactionLoading) {
            await page.locator(".loading-line").waitFor({ state: "hidden" });
            await assertPanel(page, tab, true, true);
            assert.equal(transactionRequests.length, 1, "明細一覧のGETを共通情報とは独立して制御する");
            const list = transactionRequests.shift()!, listUrl = new URL(list.request().url());
            assert.equal(listUrl.searchParams.get("workspaceId"), workspaceId);
            assert.equal(listUrl.searchParams.get("mode"), "month");
            assert.equal(listUrl.searchParams.get("month"), "2026-10");
            await list.fulfill({ json: { workspaceId, mode: "month", month: "2026-10", transactions: data.selected!.transactions } });
            transactionsLoaded = true;
          }
          await assertPanel(page, tab);
          assert.deepEqual(errors, []);
        }
        assert.equal(requests.filter(path => path === "/api/transactions").length, 1,
          "同じ月の明細はタブ往復後もキャッシュを再利用する");
        assert.equal(transactionRequests.length, 0);
        assert.equal(requests.filter(path => path === "/api/analytics").length, sequence.filter(tab => tab === "analytics").length,
          "集計は再入場ごとに1回取得し、保持用パネルの重複取得を起こさない");
        assert.equal(requests.filter(path => path === "/api/import/history").length, sequence.filter(tab => tab === "import").length,
          "取込履歴は取込画面への入場時だけ取得する");
        const homeRequests = () => requests.filter(path => path === "/api/home").length;
        async function selectHomeMonth(month: string) {
          await page.getByLabel("収支の対象年月", { exact: true }).fill(month);
          const [year, number] = month.split("-").map(Number);
          await page.getByRole("table", { name: `${year}年${number}月の収支`, exact: true }).waitFor();
          await page.locator('.home-month-summary[aria-busy="false"]').waitFor();
          await stable(page);
        }
        for (const status of [503, 403]) {
          await selectHomeMonth("2026-11");
          const cached = homeRequests();
          await selectHomeMonth("2026-10");
          await selectHomeMonth("2026-11");
          assert.equal(homeRequests(), cached, "手動更新前は取得済み2か月をキャッシュから表示する");
          await page.locator(".home-actions").getByRole("button", { name: "更新", exact: true }).click();
          await page.locator(".loading-line").waitFor({ state: "visible" });
          await stable(page);
          assert.equal(appRequests.length, 1, "手動更新の共通情報GETを制御する");
          const request = appRequests.shift()!;
          assert.equal(new URL(request.request().url()).searchParams.get("scope"), "metadata");
          const error = `共通情報の更新に失敗しました（${status}）。`;
          await request.fulfill({ status, json: { error } });
          await page.locator(".loading-line").waitFor({ state: "hidden" });
          await page.locator('.home-month-summary[aria-busy="false"]').waitFor();
          await page.getByRole("status").filter({ hasText: error }).waitFor();
          await stable(page);
          assert.equal(homeRequests(), cached + 1, `共通情報が${status}でも現在月の強制再取得を行う`);
          await selectHomeMonth("2026-10");
          assert.equal(homeRequests(), cached + 2, `共通情報が${status}でも旧月キャッシュを破棄し、戻った月を再取得する`);
          assert.equal(appRequests.length, 0);
        }
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { try { await browser.close(); } finally { await new Promise<void>(done => server.close(() => done())); } }
});

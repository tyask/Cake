import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Page, type Route } from "playwright";
import { resolveAnalyticsPeriods, type AnalyticsDataset, type AnalyticsQuery } from "../../lib/shared/analytics";
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

async function assertPanel(page: Page, tab: DashboardTab, loading = false) {
  const main = page.locator(".app-main"), expected = panels[tab].heading;
  if (expected) await main.getByRole("heading", { name: expected, level: 1, exact: true }).waitFor();
  else await main.getByRole("table", { name: "2026年10月の収支", exact: true }).waitFor();
  if (!loading) await page.waitForFunction(() => !document.querySelector(".loading-line"));
  if (tab === "analytics") await main.getByTestId("analytics-total").waitFor();
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
        const page = await context.newPage(), errors: string[] = [], requests: string[] = [], appRequests: Route[] = [];
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
          } else if (url.pathname === "/api/analytics") {
            const query: AnalyticsQuery = { workspaceId, period: "month", month: url.searchParams.get("month")! };
            await route.fulfill({ json: analytics(query) });
          } else if (url.pathname === "/api/recurring-payments") {
            await route.fulfill({ json: { now: now.toISOString(), today: "2026-10-23", eligibleActorUserIds: ["a", "b"], payments: [] } });
          } else if (url.pathname === "/api/import/history") {
            await route.fulfill({ json: { history: [] } });
          } else { errors.push(`想定外のAPI: ${url.pathname}`); await route.abort(); }
        });
        await page.addInitScript(data => { window.navigationInitialData = data; }, data);
        await page.goto(origin);
        await assertPanel(page, "home");
        const nav = page.locator(width < 768 ? ".bottom-nav" : ".app-nav");
        assert.equal(await nav.getByRole("button").count(), 5);
        assert.equal(await nav.getByRole("button", { name: /清算$/ }).count(), 0, "清算操作はホームへ統合する");
        const sequence: DashboardTab[] = ["transactions", "settings", "home", "analytics", "import", "home", "transactions",
          "analytics", "transactions", "import", "home", "settings", "transactions", "home"];
        for (const tab of sequence) {
          await nav.getByRole("button", { name: new RegExp(`${panels[tab].navigation}$`) }).click();
          await page.locator(".loading-line").waitFor({ state: "visible" });
          await assertPanel(page, tab, true);
          assert.deepEqual(errors, []);
          assert.equal(appRequests.length, 1, "タブ移動のGETを1件ずつ制御する");
          const request = appRequests.shift()!, url = new URL(request.request().url());
          await request.fulfill({ json: url.searchParams.get("scope") === "metadata" ? metadata(data) : data });
          await assertPanel(page, tab);
          assert.deepEqual(errors, []);
        }
        assert.equal(requests.filter(path => path === "/api/analytics").length, sequence.filter(tab => tab === "analytics").length,
          "集計は再入場ごとに1回取得し、保持用パネルの重複取得を起こさない");
        assert.equal(requests.filter(path => path === "/api/import/history").length, sequence.filter(tab => tab === "import").length,
          "取込履歴は取込画面への入場時だけ取得する");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { try { await browser.close(); } finally { await new Promise<void>(done => server.close(() => done())); } }
});

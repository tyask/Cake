import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, type Route } from "playwright";
import { resolveAnalyticsPeriods, type AnalyticsDataset, type AnalyticsQuery } from "../../lib/shared/analytics";
import { formatCashflow, formatYen } from "../../lib/shared/display-formatters";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-23T02:00:00Z");
function dataset(query: AnalyticsQuery = { workspaceId, period: "month", month: "2026-10" }): AnalyticsDataset {
  const periods = resolveAnalyticsPeriods(query, now);
  const month = periods.current.to.slice(0, 7), previousMonth = periods.comparison.to.slice(0, 7);
  const bucket = (scope: "current" | "comparison" | "trend", memberId: string, expenseClass: "SHARED" | "PERSONAL", categoryId: string | null, burdenYen: string) => ({ scope, month: scope === "comparison" ? previousMonth : month, memberId, expenseClass, categoryId, burdenYen });
  return {
    workspaceId: query.workspaceId, snapshotAt: now.toISOString(), timeZone: "Asia/Tokyo", periods,
    members: [{ id: "a", name: "Aさん" }, { id: "b", name: "Bさん" }],
    categories: [
      { id: "food", parentId: null, name: "食費", colorHex: "#f97316", sortOrder: 0, revision: 1, archivedAt: null },
      { id: "grocery", parentId: "food", name: "スーパー", colorHex: "#fb923c", sortOrder: 0, revision: 1, archivedAt: null },
      { id: "transport", parentId: null, name: "交通費", colorHex: "#3b82f6", sortOrder: 1, revision: 1, archivedAt: null },
      { id: "archived", parentId: null, name: "以前のカテゴリ", colorHex: "#94a3b8", sortOrder: 2, revision: 1, archivedAt: "2026-01-01T00:00:00Z" },
    ],
    buckets: [
      bucket("current", "a", "SHARED", "grocery", "60"), bucket("current", "b", "SHARED", "grocery", "40"),
      bucket("current", "a", "PERSONAL", "food", "20"), bucket("current", "b", "PERSONAL", null, "30"),
      bucket("comparison", "a", "SHARED", "transport", "50"), bucket("comparison", "b", "SHARED", "archived", "50"),
      bucket("trend", "a", "SHARED", "grocery", "60"), bucket("trend", "b", "SHARED", "grocery", "40"),
      bucket("trend", "a", "PERSONAL", "food", "20"), bucket("trend", "b", "PERSONAL", null, "30"),
    ],
    receiptBuckets: [
      bucket("current", "a", "SHARED", null, "120"), bucket("current", "b", "SHARED", null, "80"),
      bucket("current", "a", "PERSONAL", null, "300"), bucket("current", "b", "PERSONAL", null, "200"),
      bucket("comparison", "a", "SHARED", null, "100"),
      bucket("trend", "a", "SHARED", null, "120"), bucket("trend", "a", "PERSONAL", null, "300"),
    ],
  };
}
function queryFromRoute(route: Route): AnalyticsQuery {
  const params = new URL(route.request().url()).searchParams;
  const id = params.get("workspaceId")!;
  return params.get("period") === "range" ? { workspaceId: id, period: "range", from: params.get("from")!, to: params.get("to")! }
    : { workspaceId: id, period: "month", month: params.get("month")! };
}

test("集計は自分の収支と共有費全体をローカルで切り替え、期間と取得世代だけをAPIへ送る", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/analytics.tsx"], bundle: true, write: false,
    outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    const extension = req.url === "/bundle.css" ? "css" : "js";
    const output = bundle.outputFiles.find(file => file.path.endsWith(`/bundle.${extension}`));
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : req.url === "/bundle.css" ? "text/css" : "text/html");
    res.end(req.url?.startsWith("/bundle.") ? output!.text : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });

  async function fixture(width = 1440, initialActive = true, currentUserId = "a") {
    const context = await browser.newContext({ viewport: { width, height: width <= 768 ? 844 : 1000 }, isMobile: width <= 768, hasTouch: width <= 768, reducedMotion: "reduce", serviceWorkers: "block" });
    const page = await context.newPage(), requests: Route[] = [], urls: string[] = [], errors: string[] = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.clock.setFixedTime(now);
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { errors.push("unexpected origin"); await route.abort(); return; }
      if (url.pathname === "/api/analytics") {
        assert.equal(route.request().method(), "GET");
        urls.push(route.request().url()); requests.push(route);
      } else await route.continue();
    });
    await page.addInitScript(({ workspaceId, active, currentUserId }) => { window.analyticsProps = { workspaceId, currentUserId, revision: 0, active }; window.ignoreAnalyticsAbort = true; }, { workspaceId, active: initialActive, currentUserId });
    await page.goto(origin);
    await page.waitForFunction(() => !!window.updateAnalytics);
    async function take() {
      for (let index = 0; !requests.length && index < 200; index++) await new Promise(done => setTimeout(done, 5));
      assert.ok(requests.length, "集計APIの呼び出しを待つ");
      return requests.shift()!;
    }
    async function reply(route: Route, body = dataset(queryFromRoute(route)), status = 200) { await route.fulfill({ json: body, status }); }
    async function total(value: string) { await page.waitForFunction(expected => document.querySelector('[data-testid="analytics-total"]')?.textContent === expected, value); }
    async function stable() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
    async function chartOrder(trendTitle: string, compositionTitle: string) {
      const trend = page.getByRole("heading", { name: trendTitle, exact: true });
      const composition = page.getByRole("heading", { name: compositionTitle, exact: true });
      await trend.waitFor(); await composition.waitFor();
      assert.deepEqual(await page.getByRole("heading", { level: 2 }).allTextContents(), [trendTitle, compositionTitle, "カテゴリ別の増減"], "月次→カテゴリ内訳→差分のDOM順に表示する");
      const cardBounds = (heading: typeof trend) => heading.evaluate(element => {
        const rect = element.closest("section")!.getBoundingClientRect();
        return { x: rect.x, width: rect.width, top: rect.top, bottom: rect.bottom };
      });
      const [trendBounds, compositionBounds] = await Promise.all([cardBounds(trend), cardBounds(composition)]);
      assert.ok(trendBounds.bottom <= compositionBounds.top, "月次グラフをカテゴリ内訳の上へ縦配置する");
      assert.ok(Math.abs(trendBounds.x - compositionBounds.x) < 1 && Math.abs(trendBounds.width - compositionBounds.width) < 1, "画面幅にかかわらず両カードは同じ幅で表示する");
    }
    return { context, page, requests, urls, errors, take, reply, total, stable, chartOrder };
  }
  try {
    for (const width of [1440, 1000, 850, 800, 769, 390, 320]) await t.test(`${width}px: 自分と共有全体・階層・表を変えても再通信しない`, async () => {
      const f = await fixture(width);
      try {
        const request = await f.take();
        assert.deepEqual([...new URL(request.request().url()).searchParams.keys()].sort(), ["month", "period", "workspaceId"]);
        await f.reply(request); await f.total("−￥80");
        const summary = f.page.getByRole("table", { name: "対象期間の自分の収支", exact: true });
        assert.deepEqual(await summary.getByRole("rowheader").allTextContents(), ["収入", "支出", "収支"]);
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥420");
        assert.equal(await f.page.getByTestId("analytics-balance").textContent(), "+￥340");
        assert.equal(await f.page.getByTestId("analytics-income").evaluate(element => getComputedStyle(element).color), "rgb(47, 107, 72)");
        assert.equal(await f.page.getByTestId("analytics-total").evaluate(element => getComputedStyle(element).color), "rgb(173, 67, 59)", "収支表の支出は赤・負の金額で表示する");
        assert.equal(await f.page.getByTestId("analytics-difference").textContent(), "+￥30", "支出の増加はプラスで表示する");
        assert.equal(await f.page.getByTestId("analytics-difference").evaluate(element => getComputedStyle(element).color), "rgb(51, 42, 24)", "差額も収支の色分けをしない");
        await f.page.getByRole("heading", { name: "カテゴリ別の内訳", exact: true }).waitFor();
        await f.chartOrder("月ごとの収入・支出・収支", "カテゴリ別の内訳");
        const pie = f.page.getByRole("group", { name: "カテゴリ別の支出額。金額と割合は次の一覧でも確認できます。", exact: true });
        await pie.locator("path.recharts-sector").first().waitFor();
        const categoryAmounts = f.page.getByLabel("全カテゴリの支出額と割合").locator("strong");
        assert.ok((await categoryAmounts.allTextContents()).every(text => /^￥[\d,]+$/.test(text)), "カテゴリの費用も無符号の正額で表示する");
        assert.ok((await categoryAmounts.evaluateAll(elements => elements.map(element => getComputedStyle(element).color))).every(color => color === "rgb(51, 42, 24)"));
        if (width === 1440) {
          await pie.scrollIntoViewIfNeeded();
          // Hover the filled ring, since the sector's bounding-box center is in the donut hole.
          const point = await pie.locator("path.recharts-sector").first().evaluate(element => {
            const path = element as SVGGeometryElement, svg = path.ownerSVGElement!;
            const cx = Number(path.getAttribute("cx")), cy = Number(path.getAttribute("cy"));
            const radius = Math.min(svg.viewBox.baseVal.width, svg.viewBox.baseVal.height) * .375;
            const point = new DOMPoint(cx + radius / Math.SQRT2, cy - radius / Math.SQRT2);
            if (!path.isPointInFill(point)) throw new Error("最大カテゴリの内部を操作する");
            const screen = point.matrixTransform(path.getScreenCTM()!);
            return { x: screen.x, y: screen.y };
          });
          await f.page.mouse.move(point.x, point.y);
          const amount = pie.locator(".recharts-tooltip-wrapper strong");
          await amount.first().waitFor({ state: "visible" });
          assert.ok((await amount.allTextContents()).every(text => /^￥[\d,]+$/.test(text)), "ツールチップの費用も正額で表示する");
          assert.ok((await amount.evaluateAll(elements => elements.map(element => getComputedStyle(element).color))).every(color => color === "rgb(51, 42, 24)"));
        }
        const pieBounds = (await pie.locator("svg").first().boundingBox())!;
        assert.ok(pieBounds.width > 100 && pieBounds.height > 100, "中間幅でも円グラフが消えない");
        assert.equal(await f.page.getByRole("combobox", { name: "集計の基準" }).count(), 0);
        assert.equal(await f.page.getByRole("checkbox").count(), 2, "自分の配分に含める共有費と個人費を選べる");
        assert.equal(await f.page.getByRole("radio", { name: "自分の収支", exact: true }).isChecked(), true);
        await f.page.getByText("チェックした共有費の自分の配分と個人費を、収入・支出それぞれで合計します。", { exact: false }).waitFor();
        await f.page.getByRole("radio", { name: "共有費全体", exact: true }).check(); await f.total("￥100");
        assert.equal(await f.page.getByRole("table", { name: "対象期間の自分の収支", exact: true }).count(), 0);
        assert.equal(await f.page.getByTestId("analytics-cashflow-chart").count(), 0, "共有費全体は旧カテゴリ別の推移を維持する");
        await f.page.getByRole("heading", { name: "カテゴリ別の内訳", exact: true }).waitFor();
        await f.chartOrder("月ごとの推移", "カテゴリ別の内訳");
        assert.equal(await f.page.getByRole("checkbox").count(), 0);
        assert.equal(await f.page.getByTestId("analytics-total").evaluate(element => getComputedStyle(element).color), "rgb(51, 42, 24)");
        await f.page.getByText("共有費を支払者にかかわらず全額で集計します。個人費は含めません。", { exact: false }).waitFor();
        await f.page.getByRole("radio", { name: "自分の収支", exact: true }).check(); await f.total("−￥80");
        await f.page.getByRole("radio", { name: "共有費全体", exact: true }).check(); await f.total("￥100");
        await f.page.getByLabel("カテゴリの細かさ", { exact: true }).selectOption("all");
        await f.page.getByLabel("全カテゴリの支出額と割合").getByText("食費 › スーパー", { exact: true }).waitFor();
        await f.page.getByText("月ごとの金額を表で見る", { exact: true }).click();
        await f.page.getByRole("table", { name: "月ごとの支出額（円）" }).waitFor();
        const monthlyAmounts = f.page.getByRole("table", { name: "月ごとの支出額（円）" }).locator("td");
        assert.ok((await monthlyAmounts.allTextContents()).every(text => /^￥[\d,]+$/.test(text)));
        assert.ok((await monthlyAmounts.evaluateAll(elements => elements.map(element => getComputedStyle(element).color))).every(color => color === "rgb(51, 42, 24)"), "月別表の費用も通常色で表示する");
        await f.stable();
        assert.equal(f.urls.length, 1, "表示条件と表の変更はAPIを呼ばない");
        if (width === 1440) {
          const trend = f.page.getByRole("group", { name: "月ごとのカテゴリ別支出額。下の表でも確認できます。", exact: true });
          const surface = trend.locator("svg.recharts-surface");
          await surface.scrollIntoViewIfNeeded();
          // Recharts gives an active mouse hover priority over keyboard focus.
          // Finish the pointer interaction before checking keyboard-only navigation.
          await f.page.mouse.move(0, 0); await f.stable();
          await surface.focus();
          assert.equal(await surface.evaluate(element => element === document.activeElement), true, "月次グラフへキーボードfocusを移す");
          await trend.getByText("2026-05", { exact: true }).waitFor();
          await f.page.keyboard.press("ArrowRight");
          await trend.getByText("2026-06", { exact: true }).waitFor();
        }
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "ページ全体の横溢れなし");
        if (width <= 768) {
          const group = f.page.getByRole("region", { name: "集計の表示条件" });
          const before = (await group.boundingBox())!.y;
          await f.page.evaluate(() => window.scrollBy(0, 450));
          const after = (await group.boundingBox())!.y;
          assert.ok(after < before - 100, "条件領域はスクロールすると画面外へ移動する");
        }
        if (process.env.CAKE_ANALYTICS_SCREENSHOTS) {
          await mkdir(".cake/output/playwright", { recursive: true });
          await f.page.evaluate(() => window.scrollTo(0, 0));
          await f.page.screenshot({ path: `.cake/output/playwright/analytics-${width}.png`, fullPage: true, animations: "disabled" });
        }
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    for (const width of [1440, 390]) await t.test(`${width}px: 共有費・個人費の選択は収入と支出へ同時に反映し、共有費全体に影響せず保持する`, async () => {
      const f = await fixture(width);
      try {
        await f.reply(await f.take()); await f.total("−￥80");
        const shared = f.page.getByRole("checkbox", { name: "共有費", exact: true });
        const personal = f.page.getByRole("checkbox", { name: "個人費", exact: true });
        assert.equal(await shared.isChecked(), true); assert.equal(await personal.isChecked(), true);
        await personal.uncheck(); await f.total("−￥60");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥120");
        assert.equal(await f.page.getByTestId("analytics-balance").textContent(), "+￥60");
        assert.deepEqual(await f.page.getByLabel("全カテゴリの支出額と割合").locator("strong").allTextContents(), ["￥60", "￥0"], "比較期間だけのカテゴリも0円で残す");
        await f.page.getByRole("radio", { name: "共有費全体", exact: true }).check(); await f.total("￥100");
        assert.equal(await f.page.getByTestId("analytics-income").count(), 0);
        await f.page.getByRole("radio", { name: "自分の収支", exact: true }).check(); await f.total("−￥60");
        assert.equal(await personal.isChecked(), false); assert.equal(await shared.isChecked(), true);
        await shared.uncheck();
        await f.page.getByRole("status").filter({ hasText: "収支に含める内容を1つ以上選んでください。" }).waitFor();
        assert.equal(await f.page.getByTestId("analytics-total").count(), 0, "全OFFは0円の集計ではない");
        assert.equal(await f.page.getByRole("heading", { name: "カテゴリ別の内訳", exact: true }).count(), 0);
        await f.page.getByRole("radio", { name: "共有費全体", exact: true }).check(); await f.total("￥100");
        await f.page.getByRole("radio", { name: "自分の収支", exact: true }).check();
        await f.page.getByRole("status").filter({ hasText: "収支に含める内容を1つ以上選んでください。" }).waitFor();
        await personal.check(); await f.total("−￥20");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥300");
        assert.equal(await f.page.getByTestId("analytics-balance").textContent(), "+￥280");
        assert.deepEqual(await f.page.getByLabel("全カテゴリの支出額と割合").locator("strong").allTextContents(), ["￥20"]);
        await shared.check(); await f.total("−￥80");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥420");
        assert.equal(f.urls.length, 1); assert.deepEqual(f.errors, []);
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      } finally { await f.context.close(); }
    });

    for (const width of [1440, 390, 320]) await t.test(`${width}px: カテゴリの親子と未分類の選択を収支・月次・共有費へ反映し、再通信しない`, async () => {
      const f = await fixture(width);
      try {
        const request = await f.take(), data = dataset(queryFromRoute(request));
        data.receiptBuckets = data.receiptBuckets.map(bucket => ({ ...bucket, categoryId: bucket.expenseClass === "PERSONAL" ? "food" : "grocery" }));
        for (const scope of ["current", "trend"] as const) {
          data.buckets.push({ scope, month: "2026-10", memberId: "a", expenseClass: "SHARED", categoryId: null, burdenYen: "7" });
          data.receiptBuckets.push({ scope, month: "2026-10", memberId: "a", expenseClass: "SHARED", categoryId: null, burdenYen: "17" });
        }
        await f.reply(request, data); await f.total("−￥87");
        const summary = f.page.locator("summary").filter({ hasText: "集計に含めるカテゴリ" });
        assert.match(await summary.textContent() ?? "", /すべて選択中/);
        await summary.click();
        const categories = f.page.getByRole("group", { name: "集計に含めるカテゴリ", exact: true });
        assert.equal(await categories.getByRole("checkbox").count(), 5);
        assert.equal(await categories.getByRole("checkbox", { name: "以前のカテゴリ（使用停止）", exact: true }).isChecked(), true);
        await f.page.getByRole("button", { name: "すべて解除", exact: true }).click();
        await f.page.getByText("集計に含めるカテゴリを1つ以上選んでください。", { exact: true }).waitFor();
        assert.equal(await f.page.getByTestId("analytics-total").count(), 0);
        assert.match(await summary.textContent() ?? "", /未選択/);
        const food = categories.getByRole("checkbox", { name: "食費", exact: true });
        const grocery = categories.getByRole("checkbox", { name: "食費 › スーパー", exact: true });
        await food.check(); await f.total("−￥80");
        assert.equal(await grocery.isChecked(), true, "親の選択は子孫をまとめて含める");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥420");
        await grocery.uncheck(); await f.total("−￥20");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥300");
        assert.equal(await food.evaluate(element => (element as HTMLInputElement).indeterminate), true);
        assert.match(await summary.textContent() ?? "", /1 \/ 5件選択/);
        await f.page.getByLabel("カテゴリの細かさ", { exact: true }).selectOption("all"); await f.total("−￥20");
        await f.page.getByLabel("全カテゴリの支出額と割合").getByText("食費（直接設定）", { exact: true }).waitFor();
        await f.page.getByRole("radio", { name: "共有費全体", exact: true }).check(); await f.total("￥0");
        await grocery.check(); await f.total("￥100");
        assert.equal(await food.isChecked(), true);
        await f.page.getByRole("radio", { name: "自分の収支", exact: true }).check(); await f.total("−￥80");
        await f.page.getByRole("checkbox", { name: "個人費", exact: true }).uncheck(); await f.total("−￥60");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥120");
        await food.uncheck();
        await f.page.getByText("集計に含めるカテゴリを1つ以上選んでください。", { exact: true }).waitFor();
        await categories.getByRole("checkbox", { name: "未分類", exact: true }).check(); await f.total("−￥7");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥17");
        assert.equal(await f.page.getByTestId("analytics-balance").textContent(), "+￥10");
        await f.page.getByText("月ごとの金額を表で見る", { exact: true }).click();
        const monthly = f.page.getByRole("table", { name: "月ごとの収入・支出・収支（円）", exact: true });
        assert.deepEqual(await monthly.getByRole("row", { name: /^2026\/10 / }).getByRole("cell").allTextContents(), ["+￥17", "−￥7", "+￥10"]);
        await summary.click();
        assert.match(await summary.textContent() ?? "", /1 \/ 5件選択/, "折りたたんでも選択状態が分かる");
        assert.equal(f.urls.length, 1, "カテゴリ・表示対象・区分・粒度は追加通信しない");
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test("カテゴリは取得中・期間変更・再入場でも保持し、workspace切替で初期化する", async () => {
      const f = await fixture();
      try {
        await f.reply(await f.take()); await f.total("−￥80");
        const summary = f.page.locator("summary").filter({ hasText: "集計に含めるカテゴリ" });
        await summary.click();
        const categories = f.page.getByRole("group", { name: "集計に含めるカテゴリ", exact: true });
        await f.page.getByRole("button", { name: "すべて解除", exact: true }).click();
        await categories.getByRole("checkbox", { name: "食費 › スーパー", exact: true }).check(); await f.total("−￥60");
        await f.page.getByLabel("集計する月", { exact: true }).fill("2026-09");
        const periodRequest = await f.take();
        await f.page.getByRole("button", { name: "すべて解除", exact: true }).click();
        await f.reply(periodRequest);
        await f.page.getByText("集計に含めるカテゴリを1つ以上選んでください。", { exact: true }).waitFor();
        assert.equal(await f.page.getByTestId("analytics-total").count(), 0, "取得が終わっても最新の空選択を保つ");
        await categories.getByRole("checkbox", { name: "食費 › スーパー", exact: true }).check(); await f.total("−￥60");
        await f.page.evaluate(() => window.updateAnalytics({ active: false }));
        await f.page.getByRole("heading", { name: "収支の集計", exact: true }).waitFor({ state: "hidden" });
        await f.page.evaluate(() => window.updateAnalytics({ active: true }));
        await f.reply(await f.take()); await f.total("−￥60");
        assert.equal(await categories.getByRole("checkbox", { name: "食費 › スーパー", exact: true }).isChecked(), true);
        const beforeRefresh = f.urls.length;
        await f.page.getByRole("button", { name: "すべて選択", exact: true }).click(); await f.total("−￥80");
        assert.equal(f.urls.length, beforeRefresh, "全選択へ戻す操作も取得済みデータを使う");
        await f.page.getByRole("button", { name: "すべて解除", exact: true }).click();
        await f.page.evaluate(id => window.updateAnalytics({ workspaceId: id }), otherWorkspaceId);
        await f.reply(await f.take()); await f.total("−￥80");
        assert.match(await f.page.locator("summary").filter({ hasText: "集計に含めるカテゴリ" }).textContent() ?? "", /すべて選択中/);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test("カテゴリ取得更新時は全選択だけ新規カテゴリを含め、選択済みカテゴリの削除は空選択になる", async () => {
      const f = await fixture();
      try {
        await f.reply(await f.take()); await f.total("−￥80");
        const summary = f.page.locator("summary").filter({ hasText: "集計に含めるカテゴリ" });
        await summary.click();
        const categories = f.page.getByRole("group", { name: "集計に含めるカテゴリ", exact: true });
        await f.page.getByRole("button", { name: "更新", exact: false }).click();
        const refresh = await f.take(), added = dataset(queryFromRoute(refresh));
        added.categories.push({ id: "new", parentId: null, name: "新しいカテゴリ", colorHex: "#123456", sortOrder: 4, revision: 1, archivedAt: null });
        added.buckets.push({ ...added.buckets[0], categoryId: "new", burdenYen: "9" });
        await f.reply(refresh, added); await f.total("−￥89");
        assert.equal(await categories.getByRole("checkbox", { name: "新しいカテゴリ", exact: true }).isChecked(), true);
        await f.page.getByRole("button", { name: "すべて解除", exact: true }).click();
        await categories.getByRole("checkbox", { name: "新しいカテゴリ", exact: true }).check(); await f.total("−￥9");
        await f.page.getByRole("button", { name: "更新", exact: false }).click();
        const customRequest = await f.take(), addedAgain = structuredClone(added);
        addedAgain.categories.push({ id: "newer", parentId: null, name: "さらに新しいカテゴリ", colorHex: "#654321", sortOrder: 5, revision: 1, archivedAt: null });
        addedAgain.buckets.push({ ...addedAgain.buckets[0], categoryId: "newer", burdenYen: "11" });
        await f.reply(customRequest, addedAgain);
        await categories.getByRole("checkbox", { name: "さらに新しいカテゴリ", exact: true }).waitFor();
        await f.total("−￥9");
        assert.equal(await categories.getByRole("checkbox", { name: "さらに新しいカテゴリ", exact: true }).isChecked(), false, "個別選択には新しいカテゴリを自動追加しない");
        await f.page.getByRole("button", { name: "更新", exact: false }).click();
        await f.reply(await f.take());
        await f.page.getByText("集計に含めるカテゴリを1つ以上選んでください。", { exact: true }).waitFor();
        assert.match(await summary.textContent() ?? "", /未選択/);
        assert.equal(await f.page.getByTestId("analytics-total").count(), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test("収入のみ・赤字・0円の収支を区別し、大きい収入も安全整数を超えて全桁表示する", async () => {
      const f = await fixture(320);
      try {
        const initial = await f.take(), incomeOnly = dataset(queryFromRoute(initial)); incomeOnly.buckets = [];
        await f.reply(initial, incomeOnly); await f.total("￥0");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥420");
        assert.equal(await f.page.getByTestId("analytics-balance").textContent(), "+￥420");
        assert.equal(await f.page.getByTestId("analytics-total").getAttribute("class"), null);
        await f.page.getByText("この期間の支出額はありません。", { exact: true }).waitFor();
        await f.page.getByRole("button", { name: "更新", exact: false }).click();
        const deficitRequest = await f.take(), deficit = dataset(queryFromRoute(deficitRequest)); deficit.receiptBuckets = [];
        await f.reply(deficitRequest, deficit); await f.total("−￥80");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "￥0");
        assert.equal(await f.page.getByTestId("analytics-balance").textContent(), "−￥80");
        assert.equal(await f.page.getByTestId("analytics-balance").evaluate(element => getComputedStyle(element).color), "rgb(173, 67, 59)");
        await f.page.getByRole("button", { name: "更新", exact: false }).click();
        const emptyRequest = await f.take(), empty = dataset(queryFromRoute(emptyRequest)); empty.buckets = []; empty.receiptBuckets = [];
        await f.reply(emptyRequest, empty); await f.total("￥0");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "￥0");
        assert.equal(await f.page.getByTestId("analytics-balance").textContent(), "￥0");
        assert.equal(await f.page.getByTestId("analytics-balance").getAttribute("class"), null);
        await f.page.getByRole("button", { name: "更新", exact: false }).click();
        const exactRequest = await f.take(), huge = dataset(queryFromRoute(exactRequest)); huge.buckets = [];
        huge.receiptBuckets = [{ ...huge.receiptBuckets[0], burdenYen: "9007199254740993123456789" }];
        await f.reply(exactRequest, huge);
        // The expense stays zero, so wait for the changed income instead of
        // accepting the previous empty response's still-rendered expense.
        await f.page.waitForFunction(expected => document.querySelector('[data-testid="analytics-income"]')?.textContent === expected,
          "+￥9,007,199,254,740,993,123,456,789");
        await f.total("￥0");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥9,007,199,254,740,993,123,456,789");
        assert.equal(await f.page.getByTestId("analytics-balance").textContent(), "+￥9,007,199,254,740,993,123,456,789");
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(f.urls.length, 4); assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    for (const width of [1440, 1000, 390, 320]) await t.test(`${width}px: 円は12時から時計回りの金額順で、収まる金額だけを図中に表示する`, async () => {
      const f = await fixture(width);
      try {
        const response = await f.take(), data = dataset(queryFromRoute(response));
        const amounts = [90, 80, 70, 57, 50, 40, 30, 20, 19, 18, 1];
        data.categories = amounts.map((_, index) => ({ id: `c${index}`, parentId: null, name: `分類${index}`, colorHex: `#${(90000 + index * 20000).toString(16).padStart(6, "0")}`, sortOrder: index, revision: 1, archivedAt: null }));
        data.buckets = [];
        for (const [index, amount] of amounts.entries()) for (const scope of ["current", "comparison", "trend"] as const) {
          data.buckets.push({ scope, month: scope === "comparison" ? "2026-09" : "2026-10", memberId: "a", expenseClass: "SHARED", categoryId: `c${index}`, burdenYen: String(scope === "comparison" ? index === 10 ? 500 : 0 : amount) });
        }
        for (const scope of ["current", "trend"] as const) data.buckets.push({ scope, month: "2026-10", memberId: "a", expenseClass: "SHARED", categoryId: null, burdenYen: "250" });
        await f.reply(response, data);
        const pie = f.page.getByRole("group", { name: "カテゴリ別の支出額。金額と割合は次の一覧でも確認できます。", exact: true });
        const paths = pie.locator("path.recharts-sector");
        await paths.nth(9).waitFor();
        assert.deepEqual(await paths.evaluateAll(elements => elements.map(element => element.getAttribute("fill"))),
          ["#94a3b8", ...data.categories.slice(0, 4).map(category => category.colorHex), "#cbd5e1", ...data.categories.slice(4, 7).map(category => category.colorHex), data.categories[10].colorHex], "その他・未分類を含め降順、同額は安定順");
        assert.equal(await paths.first().evaluate(element => {
          const path = element as SVGGeometryElement, svg = path.ownerSVGElement!;
          const cx = svg.viewBox.baseVal.width / 2, cy = svg.viewBox.baseVal.height / 2;
          const r = Math.min(cx, cy) * .75, angle = 8 * Math.PI / 180;
          return path.isPointInFill(new DOMPoint(cx + Math.sin(angle) * r, cy - Math.cos(angle) * r))
            && !path.isPointInFill(new DOMPoint(cx - Math.sin(angle) * r, cy - Math.cos(angle) * r));
        }), true, "最大の領域は12時の右から時計回りに始まる");
        await pie.locator('[data-analytics-amount="pie"]').first().waitFor();
        assert.equal(await pie.locator('[data-analytics-amount="pie"][data-category-id="c10"]').count(), 0, "1円の小さい領域は非表示");
        const expectedValues = new Set(["￥250", "￥57", ...amounts.slice(0, 7).map(value => formatYen(value))]);
        const labels = await pie.locator('[data-analytics-amount="pie"]').allTextContents();
        assert.ok(labels.length > 0 && labels.every(label => expectedValues.has(label)), "図内の金額は正確な円表記");
        const trend = f.page.getByRole("group", { name: "月ごとの収入・支出・収支。棒は収入・支出、折れ線は収支。下の表でも確認できます。", exact: true });
        await trend.locator(".analytics-cashflow-expense .recharts-bar-rectangle path").first().waitFor();
        assert.equal(await trend.locator('[data-analytics-amount="trend"][data-category-id="c10"]').count(), 0);
        const difference = f.page.getByRole("group", { name: "カテゴリ別の支出額の増減。正は増加、負は減少。全カテゴリの金額は次の表に表示します。", exact: true });
        assert.equal(await difference.locator('[data-analytics-amount="difference"][data-category-id="c10"]').textContent(), "-￥499", "支出の減少額はマイナスで表示する");
        const decrease = f.page.getByRole("row").filter({ has: f.page.getByRole("rowheader", { name: "分類10", exact: true }) });
        assert.equal(await decrease.getByRole("cell").nth(2).evaluate(element => getComputedStyle(element).color), "rgb(51, 42, 24)", "支出減少の差額も通常色で表示する");
        assert.ok((await f.page.locator("[data-analytics-amount]").evaluateAll(elements => elements.map(element => element.getAttribute("fill")))).every(color => color === "#000000" || color === "#ffffff"), "図内の金額はカテゴリ背景に応じた白黒で表示する");
        assert.equal(await f.page.locator("[data-analytics-amount][stroke]").count(), 0, "図内金額へ色付き表示のための縁取りを強制しない");
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (process.env.CAKE_ANALYTICS_SCREENSHOTS) {
          await mkdir(".cake/output/playwright", { recursive: true });
          await f.page.screenshot({ path: `.cake/output/playwright/analytics-labels-${width}.png`, fullPage: true, animations: "disabled" });
        }
        assert.equal(f.urls.length, 1); assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    async function centerWithinHole(page: Awaited<ReturnType<typeof fixture>>["page"], expected: string) {
      const center = page.locator('[data-analytics-center="total"]');
      await center.locator("text").last().waitFor();
      assert.equal(await center.locator("text").last().textContent(), expected, "中央合計も全桁を保持する");
      assert.equal(await center.locator("text").last().evaluate(element => getComputedStyle(element).fill), "rgb(51, 42, 24)", "中央の費用合計も通常色で表示する");
      const lines = await center.locator("text").last().locator("tspan").allTextContents();
      assert.ok(lines.slice(0, -1).every(line => line.endsWith(",")), "改行は桁区切りで行う");
      assert.ok(await center.evaluate(element => {
        const group = element as SVGGElement, inverse = group.getScreenCTM()!.inverse();
        const cx = Number(group.getAttribute("data-center-x")), cy = Number(group.getAttribute("data-center-y"));
        const radius = Number(group.getAttribute("data-inner-radius"));
        return radius > 0 && [...group.querySelectorAll("text")].every(text => {
          const bounds = text.getBoundingClientRect();
          return [[bounds.left, bounds.top], [bounds.left, bounds.bottom], [bounds.right, bounds.top], [bounds.right, bounds.bottom]].every(([x, y]) => {
            const point = new DOMPoint(x, y).matrixTransform(inverse);
            return Math.hypot(point.x - cx, point.y - cy) < radius;
          });
        });
      }), "中央の合計と金額は円の内側に収まる");
    }

    for (const width of [1440, 1000, 390, 320]) await t.test(`${width}px: 大きい中央合計もリングと重ならず表示する`, async () => {
      const f = await fixture(width);
      try {
        const first = await f.take();
        const initial = dataset(queryFromRoute(first));
        initial.buckets = [{ ...initial.buckets[0], burdenYen: "100000" }];
        await f.reply(first, initial); await f.total("−￥100,000");
        await centerWithinHole(f.page, "￥100,000");
        await f.page.getByRole("button", { name: "更新", exact: false }).click();
        const next = await f.take(), data = dataset(queryFromRoute(next));
        data.buckets = [{ ...data.buckets[0], burdenYen: "10000000" }];
        await f.reply(next, data); await f.total("−￥10,000,000");
        await centerWithinHole(f.page, "￥10,000,000");
        if (process.env.CAKE_ANALYTICS_SCREENSHOTS) {
          await mkdir(".cake/output/playwright", { recursive: true });
          await f.page.screenshot({ path: `.cake/output/playwright/analytics-center-${width}.png`, fullPage: true, animations: "disabled" });
        }
        assert.equal(f.urls.length, 2); assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test("グラフ内の金額は安全整数を超えても元の整数を表示する", async () => {
      const f = await fixture();
      try {
        const request = await f.take(), data = dataset(queryFromRoute(request));
        const exact = "9007199254740993";
        data.buckets = ["current", "trend"].map(scope => ({ scope: scope as "current" | "trend", month: "2026-10", memberId: "a", expenseClass: "SHARED", categoryId: "grocery", burdenYen: exact }));
        await f.reply(request, data); await f.total("−" + formatYen(BigInt(exact)));
        await centerWithinHole(f.page, formatYen(BigInt(exact)));
        await f.page.locator('[data-analytics-amount="trend"][data-cashflow-series="expense"]').first().waitFor();
        assert.deepEqual(await f.page.locator('[data-analytics-amount="trend"][data-cashflow-series="expense"]').allTextContents(), [formatCashflow(-BigInt(exact))]);
        assert.equal(f.urls.length, 1); assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    for (const width of [1440, 390]) await t.test(`${width}px: 自分の月次は収入・支出の棒と正負の収支の線を共有軸へ表示し、区分選択を反映する`, async () => {
      const f = await fixture(width);
      try {
        const request = await f.take(), data = dataset(queryFromRoute(request));
        const receipt = (scope: "current" | "trend", memberId: string, expenseClass: "SHARED" | "PERSONAL", amount: string, month = "2026-10") => ({ scope, month, memberId, expenseClass, categoryId: null, burdenYen: amount });
        data.receiptBuckets = [receipt("current", "a", "SHARED", "200"), receipt("current", "b", "SHARED", "100"),
          receipt("current", "a", "PERSONAL", "50"), receipt("current", "b", "PERSONAL", "25"),
          receipt("trend", "a", "SHARED", "200"), receipt("trend", "b", "SHARED", "100"),
          receipt("trend", "a", "PERSONAL", "50"), receipt("trend", "b", "PERSONAL", "25"),
          receipt("trend", "a", "SHARED", "100", "2026-09")];
        data.buckets.push({ ...data.buckets[0], scope: "trend", month: "2026-09", burdenYen: "200" });
        await f.reply(request, data); await f.total("−￥80");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥250");
        assert.equal(await f.page.getByTestId("analytics-balance").textContent(), "+￥170");
        const chart = f.page.getByTestId("analytics-cashflow-chart");
        await chart.locator(".analytics-cashflow-balance .recharts-line-curve").waitFor();
        assert.equal(await chart.locator(".recharts-yAxis").count(), 1);
        const ticks = await chart.locator(".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value").allTextContents();
        assert.ok(ticks.includes("0") && ticks.some(tick => tick.startsWith("-")), `ゼロと負の収支の目盛りを表示: ${JSON.stringify(ticks)}`);
        assert.ok(ticks.length >= 3 && ticks.every(tick => tick === "0" || /^-?\d+万$/.test(tick)));
        assert.deepEqual([ticks[0], ticks.at(-1)], ["-1万", "1万"], "万円単位の上下端も表示する");
        assert.deepEqual(await chart.locator(".analytics-cashflow-income .recharts-bar-rectangle path").evaluateAll(paths => [...new Set(paths.map(path => path.getAttribute("fill")))]), ["#2f6b48"]);
        assert.deepEqual(await chart.locator(".analytics-cashflow-expense .recharts-bar-rectangle path").evaluateAll(paths => [...new Set(paths.map(path => path.getAttribute("fill")))]), ["#ad433b"]);
        assert.equal(await chart.locator(".analytics-cashflow-balance .recharts-line-curve").getAttribute("stroke"), "var(--ink)");
        assert.deepEqual(await f.page.getByRole("list", { name: "収支グラフの凡例" }).locator("li").allTextContents(), ["収入", "支出", "収支（収入 − 支出）"]);
        const trendHeading = f.page.getByRole("heading", { name: "月ごとの収入・支出・収支", exact: true });
        const compositionHeading = f.page.getByRole("heading", { name: "カテゴリ別の内訳", exact: true });
        assert.ok((await trendHeading.boundingBox())!.y < (await compositionHeading.boundingBox())!.y, "自分の収支では月次が先頭にある");
        await f.page.getByText("月ごとの金額を表で見る", { exact: true }).click();
        const monthly = f.page.getByRole("table", { name: "月ごとの収入・支出・収支（円）" });
        const monthCells = (month: string) => monthly.getByRole("row").filter({ has: f.page.getByRole("rowheader", { name: month, exact: true }) }).locator("td");
        assert.deepEqual(await monthCells("2026/09").allTextContents(), ["+￥100", "−￥200", "−￥100"]);
        assert.deepEqual(await monthCells("2026/10").allTextContents(), ["+￥250", "−￥80", "+￥170"]);
        await f.page.getByRole("checkbox", { name: "個人費", exact: true }).uncheck(); await f.total("−￥60");
        assert.deepEqual(await monthCells("2026/10").allTextContents(), ["+￥200", "−￥60", "+￥140"]);
        await f.page.getByLabel("カテゴリの細かさ", { exact: true }).selectOption("all");
        assert.deepEqual(await monthCells("2026/10").allTextContents(), ["+￥200", "−￥60", "+￥140"], "カテゴリ粒度は収入と支出の合計を変えない");
        await f.page.getByRole("checkbox", { name: "共有費", exact: true }).uncheck();
        await f.page.getByRole("status").filter({ hasText: "収支に含める内容を1つ以上選んでください。" }).waitFor();
        await f.page.getByRole("checkbox", { name: "個人費", exact: true }).check(); await f.total("−￥20");
        await f.page.getByText("月ごとの金額を表で見る", { exact: true }).click();
        assert.deepEqual(await monthCells("2026/10").allTextContents(), ["+￥50", "−￥20", "+￥30"]);
        await f.page.getByRole("radio", { name: "共有費全体", exact: true }).check(); await f.total("￥100");
        assert.equal(await f.page.getByTestId("analytics-cashflow-chart").count(), 0);
        const sharedTrend = f.page.getByRole("group", { name: "月ごとのカテゴリ別支出額。下の表でも確認できます。", exact: true });
        await sharedTrend.locator(".recharts-bar-rectangle path").first().waitFor();
        assert.equal(await sharedTrend.locator(".recharts-line").count(), 0);
        await f.page.getByRole("radio", { name: "自分の収支", exact: true }).check(); await f.total("−￥20");
        assert.equal(await f.page.getByRole("checkbox", { name: "共有費", exact: true }).isChecked(), false);
        await f.page.getByRole("checkbox", { name: "共有費", exact: true }).check();
        await f.page.getByRole("checkbox", { name: "個人費", exact: true }).uncheck(); await f.total("−￥60");
        assert.equal(f.urls.length, 1, "共有/個人・表示対象・カテゴリの変更は追加通信しない");
        await f.page.evaluate(() => window.updateAnalytics({ revision: 1 }));
        const boundaryRequest = await f.take(), boundary = dataset(queryFromRoute(boundaryRequest));
        boundary.buckets = [{ ...data.buckets[0], scope: "trend", burdenYen: "654240" }];
        boundary.receiptBuckets = [receipt("trend", "a", "SHARED", "609000")];
        await f.reply(boundaryRequest, boundary);
        await chart.getByText("66万", { exact: true }).waitFor();
        const boundaryTicks = await chart.locator(".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value").allTextContents();
        assert.deepEqual([boundaryTicks[0], boundaryTicks.at(-1)], ["-5万", "66万"]);
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test("スマートフォンでも収入のみの月を表示し、巨大額の表・月次tooltipは元の整数を保持する", async () => {
      const f = await fixture(390);
      try {
        const request = await f.take(), data = dataset(queryFromRoute(request)), exact = "9007199254740993";
        data.buckets = [];
        data.receiptBuckets = ["current", "trend"].map(scope => ({ scope: scope as "current" | "trend", month: "2026-10", memberId: "a", expenseClass: "SHARED", categoryId: null, burdenYen: exact }));
        await f.reply(request, data); await f.total("￥0");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), formatCashflow(BigInt(exact)));
        assert.equal(await f.page.getByTestId("analytics-balance").textContent(), formatCashflow(BigInt(exact)));
        const chart = f.page.getByTestId("analytics-cashflow-chart");
        await chart.locator(".analytics-cashflow-balance .recharts-line-curve").waitFor();
        await chart.locator("svg.recharts-surface").focus();
        for (let index = 0; index < 5; index++) await f.page.keyboard.press("ArrowRight");
        await chart.getByText("2026/10", { exact: true }).waitFor();
        assert.deepEqual(await chart.locator(".recharts-tooltip-wrapper strong").allTextContents(), [formatCashflow(BigInt(exact)), "￥0", formatCashflow(BigInt(exact))]);
        await f.stable();
        assert.deepEqual(await f.page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth })), { viewport: 390, content: 390 });
        await f.page.getByText("この期間の支出額はありません。", { exact: true }).waitFor();
        assert.equal(f.urls.length, 1); assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test("相手のアカウントでも自分の配分と個人費を初期表示する", async () => {
      const f = await fixture(390, true, "b");
      try {
        await f.reply(await f.take()); await f.total("−￥70");
        assert.equal(await f.page.getByTestId("analytics-income").textContent(), "+￥280");
        assert.equal(await f.page.getByTestId("analytics-balance").textContent(), "+￥210");
        assert.equal(await f.page.getByRole("radio", { name: "自分の収支", exact: true }).isChecked(), true);
        await f.page.getByRole("radio", { name: "共有費全体", exact: true }).check(); await f.total("￥100");
        await f.page.getByRole("radio", { name: "自分の収支", exact: true }).check(); await f.total("−￥70");
        assert.equal(f.urls.length, 1); assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test("取得中に表示対象を変更したら、最新の選択で応答を描画する", async () => {
      const f = await fixture();
      try {
        await f.reply(await f.take()); await f.total("−￥80");
        await f.page.getByRole("button", { name: "更新", exact: false }).click(); const refreshing = await f.take();
        await f.page.getByRole("radio", { name: "共有費全体", exact: true }).check();
        await f.reply(refreshing); await f.total("￥100");
        assert.equal(f.urls.length, 2); assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test("期間draftは適用時にだけ通信し、応答逆転・revision・再入場・workspaceを区別する", async () => {
      const f = await fixture(1440, false);
      try {
        await f.stable(); assert.equal(f.urls.length, 0, "未訪問の画面は取得しない");
        await f.page.evaluate(() => window.updateAnalytics({ active: true })); await f.reply(await f.take()); await f.total("−￥80");
        await f.page.getByLabel("集計する月", { exact: true }).fill("2026-09"); const older = await f.take();
        assert.equal(await f.page.getByTestId("analytics-total").count(), 0, "別期間の古いグラフを表示しない");
        await f.page.getByLabel("集計する月", { exact: true }).fill("2026-08"); const newer = await f.take();
        const latest = dataset(queryFromRoute(newer)); latest.buckets[0].burdenYen = "560";
        await f.reply(newer, latest); await f.total("−￥580");
        await f.reply(older); await f.stable(); await f.total("−￥580");
        await f.page.getByRole("radio", { name: "共有費全体", exact: true }).check(); await f.total("￥600");
        await f.page.getByLabel("集計する期間", { exact: true }).selectOption("range");
        await f.page.getByLabel("開始日", { exact: true }).fill("2026-07-10");
        await f.page.getByLabel("終了日", { exact: true }).fill("2026-07-20");
        await f.stable(); assert.equal(f.urls.length, 3, "日付入力中は通信しない");
        await f.page.getByRole("button", { name: "この期間で表示" }).click(); const custom = await f.take();
        assert.deepEqual(queryFromRoute(custom), { workspaceId, period: "range", from: "2026-07-10", to: "2026-07-20" });
        await f.reply(custom); await f.total("￥100");
        await f.page.evaluate(() => window.updateAnalytics({ revision: 1 })); await f.reply(await f.take()); await f.total("￥100");
        await f.page.evaluate(() => window.updateAnalytics({ active: false, revision: 2 })); await f.stable(); assert.equal(f.urls.length, 5);
        await f.page.evaluate(() => window.updateAnalytics({ active: true })); await f.reply(await f.take()); await f.total("￥100");
        assert.equal(await f.page.getByLabel("開始日", { exact: true }).inputValue(), "2026-07-10");
        assert.equal(await f.page.getByRole("radio", { name: "共有費全体", exact: true }).isChecked(), true);
        await f.page.evaluate(id => window.updateAnalytics({ workspaceId: id }), otherWorkspaceId); const other = await f.take();
        assert.equal(queryFromRoute(other).workspaceId, otherWorkspaceId);
        await f.reply(other); await f.total("−￥80");
        assert.equal(await f.page.getByRole("radio", { name: "自分の収支", exact: true }).isChecked(), true);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test("取得失敗でも表示対象を保持して再試行でき、支出のない期間は0円を表示する", async () => {
      const f = await fixture();
      try {
        await f.reply(await f.take()); await f.total("−￥80");
        await f.page.getByRole("radio", { name: "共有費全体", exact: true }).check();
        await f.page.getByRole("button", { name: "更新", exact: false }).click();
        await (await f.take()).fulfill({ status: 503, json: { error: "集計を再取得してください。" } });
        await f.page.getByRole("alert").filter({ hasText: "集計を再取得してください。" }).waitFor();
        assert.equal(await f.page.getByRole("radio", { name: "共有費全体", exact: true }).isChecked(), true);
        assert.equal(await f.page.getByTestId("analytics-total").count(), 0);
        await f.page.getByRole("button", { name: "再試行", exact: true }).click();
        const request = await f.take(), empty = dataset(queryFromRoute(request)); empty.buckets = [];
        await f.reply(request, empty); await f.total("￥0");
        assert.equal(await f.page.getByTestId("analytics-total").getAttribute("class"), null, "0円にも収入・支払いの色を付けない");
        await f.page.getByText("この期間の支出額はありません。", { exact: true }).waitFor();
        await f.page.getByText("この6か月の支出額はありません。", { exact: true }).waitFor();
        assert.equal(f.urls.length, 3); assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
  } finally {
    await browser.close();
    await new Promise<void>(done => server.close(() => done()));
  }
});

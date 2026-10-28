import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Page, type Route } from "playwright";
import type { HomeData } from "../../lib/shared/home-data";

function data(workspaceId = "workspace-a", month = "2026-10", paymentTotal = "100"): HomeData {
  const amounts = { paymentTotal, receiptTotal: "0", balanceYen: String(-BigInt(paymentTotal)) };
  return {
    workspaceId, month, members: [{ id: "a", name: "A" }],
    monthly: { people: [{ userId: "a", ...amounts }], total: amounts },
    unsettled: { count: 0, paymentTotal: "0", receiptTotal: "0", balanceYen: "0" },
    settlement: null, settlementHistory: [],
  };
}

async function expectState(page: Page, expected: Record<string, unknown>) {
  await page.waitForFunction(expected => Object.entries(expected).every(([path, wanted]) => {
    let actual: unknown = window.homeHook;
    for (const key of path.split(".")) actual = (actual as Record<string, unknown> | undefined)?.[key];
    return JSON.stringify(actual) === JSON.stringify(wanted);
  }), expected);
}

test("ホームの月・workspace・保存後revisionの応答採用と更新失敗を実React/Chromiumで検証する", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/home-data.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : "text/html");
    res.end(req.url === "/bundle.js" ? bundle.outputFiles[0].text : '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });

  async function scenario(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    await t.test(name, async () => {
      const f = await fixture();
      try { await run(f); assert.deepEqual(f.errors, []); }
      finally { await f.context.close(); }
    });
  }
  async function fixture() {
    const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
    const requests: Route[] = [], urls: string[] = [], errors: string[] = [];
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { errors.push("unexpected origin"); await route.abort(); return; }
      if (url.pathname === "/api/home") {
        requests.push(route);
        urls.push(url.pathname + url.search);
      } else if (url.pathname.startsWith("/api/")) {
        errors.push("unexpected API: " + url.pathname);
        await route.abort();
      } else await route.continue();
    });
    await page.goto(origin);
    await page.waitForFunction(() => !!window.homeHook);
    async function take() {
      for (let i = 0; !requests.length && i < 200; i++) await new Promise(done => setTimeout(done, 5));
      assert.ok(requests.length, "missing home GET");
      return requests.shift()!;
    }
    const reply = (route: Route, json: unknown, status = 200) => route.fulfill({ status, json });
    return { context, page, requests, urls, errors, take, reply };
  }
  try {
    await scenario("選択月だけ取得し、切替中は旧月を隠して遅い応答を破棄する", async f => {
      const initial = await f.take();
      assert.equal(new URL(initial.request().url()).searchParams.get("month"), "2026-10");
      assert.equal(initial.request().method(), "GET");
      await f.reply(initial, data());
      await expectState(f.page, { loading: false, "data.month": "2026-10", "data.monthly.total.paymentTotal": "100" });
      await f.page.evaluate(() => window.homeControls.month("2026-11"));
      const november = await f.take();
      await expectState(f.page, { data: null, loading: true });
      await f.page.evaluate(() => window.homeControls.month("2026-12"));
      const december = await f.take();
      await f.reply(december, data("workspace-a", "2026-12", "300"));
      await expectState(f.page, { loading: false, "data.month": "2026-12", "data.monthly.total.paymentTotal": "300" });
      await f.reply(november, data("workspace-a", "2026-11", "200"));
      await f.page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      await expectState(f.page, { loading: false, "data.month": "2026-12", "data.monthly.total.paymentTotal": "300" });
      assert.deepEqual(f.urls.map(url => new URL(url, origin).searchParams.get("month")), ["2026-10", "2026-11", "2026-12"]);
    });

    await scenario("workspace切替中の応答と保存前revisionの応答は採用しない", async f => {
      const a = await f.take();
      await f.page.evaluate(() => window.homeControls.workspace("workspace-b"));
      const b = await f.take();
      await f.reply(a, data());
      await expectState(f.page, { data: null, loading: true });
      await f.reply(b, data("workspace-b"));
      await expectState(f.page, { loading: false, "data.workspaceId": "workspace-b" });
      await f.page.evaluate(() => { window.homeOperation = window.homeHook.refresh(); });
      const stale = await f.take();
      await f.page.evaluate(() => window.homeControls.revision(1));
      const saved = await f.take();
      await f.reply(saved, data("workspace-b", "2026-10", "9007199254740993"));
      await expectState(f.page, { loading: false, "data.monthly.total.paymentTotal": "9007199254740993" });
      await f.reply(stale, data("workspace-b", "2026-10", "1"));
      await f.page.evaluate(() => window.homeOperation);
      await expectState(f.page, { loading: false, "data.monthly.total.paymentTotal": "9007199254740993" });
    });

    await scenario("初期取得失敗は保存成功と扱わず、手動更新の失敗はrejectして再試行できる", async f => {
      await f.reply(await f.take(), { error: "集計が一時的に利用できません。" }, 503);
      await expectState(f.page, { data: null, loading: false, error: "集計が一時的に利用できません。" });
      await f.page.evaluate(() => {
        window.homeOperation = window.homeHook.refresh().catch(error => { window.homeOperationError = error.message; });
      });
      await f.reply(await f.take(), { error: "再取得できません。" }, 500);
      await f.page.evaluate(() => window.homeOperation);
      assert.equal(await f.page.evaluate(() => window.homeOperationError), "再取得できません。");
      await f.page.evaluate(() => { window.homeOperation = window.homeHook.refresh(); });
      await f.reply(await f.take(), data());
      await f.page.evaluate(() => window.homeOperation);
      await expectState(f.page, { loading: false, error: null, "data.month": "2026-10" });
    });

    await scenario("保存後の取得失敗は保存済みと説明し、古い金額を再表示しない", async f => {
      await f.reply(await f.take(), data());
      await expectState(f.page, { loading: false });
      await f.page.evaluate(() => window.homeControls.revision(1));
      await f.reply(await f.take(), { error: "集計失敗" }, 503);
      await expectState(f.page, { data: null, loading: false });
      assert.match(await f.page.evaluate(() => window.homeHook.error) ?? "", /^変更は保存されました。/);
      assert.equal(f.urls.length, 2, "表示更新の失敗でPOSTや全明細取得を発生させない");
      await f.page.evaluate(() => { window.homeOperation = window.homeHook.refresh(); });
      await f.reply(await f.take(), data("workspace-a", "2026-10", "200"));
      await f.page.evaluate(() => window.homeOperation);
      await expectState(f.page, { loading: false, error: null, "data.monthly.total.paymentTotal": "200" });
    });

    await scenario("中断中は表示・取得を止め、再開後も対象不一致の応答を拒否する", async f => {
      const initial = await f.take();
      await f.page.evaluate(() => window.homeControls.active(false));
      await f.reply(initial, data());
      await expectState(f.page, { data: null, loading: false });
      await f.page.evaluate(() => { window.homeOperation = window.homeHook.refresh(); });
      await f.page.evaluate(() => window.homeOperation);
      assert.equal(f.requests.length, 0);
      await f.page.evaluate(() => window.homeControls.active(true));
      await f.reply(await f.take(), data("workspace-b"));
      await expectState(f.page, { data: null, loading: false, error: "集計の対象が一致しません。再度お試しください。" });
    });
  } finally {
    await browser.close();
    await new Promise<void>(done => server.close(() => done()));
  }
});

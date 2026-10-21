import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, type Locator } from "playwright";

async function assertInside(locator: Locator, left: number, right: number) {
  for (const element of await locator.all()) {
    if (!await element.isVisible()) continue;
    const box = await element.boundingBox();
    assert.ok(box && box.x >= left - 1 && box.x + box.width <= right + 1,
      `項目・操作が表示領域に収まる: ${await element.getAttribute("data-label")} ${JSON.stringify(box)}`);
  }
}

test("PC明細は表示領域に合わせて項目を折り返し、入力・絞り込み・選択とmobile表示を保つ", async t => {
  const bundle = await build({ entryPoints: ["tests/fixtures/transaction-categories.tsx"], bundle: true,
    write: false, outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    const asset = bundle.outputFiles.find(file => file.path.endsWith(req.url === "/bundle.css" ? "/bundle.css" : "/bundle.js"));
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : req.url === "/bundle.css" ? "text/css" : "text/html");
    res.end(req.url?.startsWith("/bundle.") ? asset!.text : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(resolve => server.close(() => resolve())); throw error; });
  try {
    for (const [available, longNames] of [
      ...[560, 760, 1000, 1312, 1343, 1344, 1500].map(width => [width, false] as const),
      ...[560, 760, 1000, 1312].map(width => [width, true] as const),
    ]) await t.test(`PC表示領域${available}px${longNames ? "・参加者名120文字" : ""}`, async () => {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1100 } });
      const page = await context.newPage();
      const writes: Record<string, unknown>[] = [], errors: string[] = [];
      page.setDefaultTimeout(6000);
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.route("**/api/**", async route => {
          writes.push(route.request().postDataJSON());
          await route.fulfill({ status: 503, json: { error: "保存失敗の確認" } });
        });
        await page.goto(origin + (longNames ? "/?longNames" : ""));
        // PCのサイドバーを除いた明細パネルの表示領域を再現する。
        await page.locator("main").evaluate((element, width) => { element.style.width = `${width + 26}px`; }, available);
        const table = page.getByRole("table", { name: "取引明細", exact: true });
        const wrapper = table.locator("..");
        await table.waitFor();
        const bounds = await wrapper.boundingBox();
        assert.ok(bounds);
        assert.equal(Math.round(bounds.width), available);
        assert.equal(await wrapper.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, "明細表に横スクロールが発生しない");
        const wrapped = available < 1344;
        const first = page.locator('[data-transaction-id="first"]');
        const settled = page.locator('[data-transaction-id="settled"]');
        for (const row of [first, settled]) {
          await assertInside(row.locator("td, input, select, textarea"), bounds.x, bounds.x + bounds.width);
          const date = await row.locator('[data-label="取引日時"]').boundingBox();
          const memo = await row.locator('[data-label="メモ"]').boundingBox();
          assert.ok(date && memo);
          assert.equal(memo.y > date.y + 5, wrapped, "幅不足時だけメモを次の行へ配置する");
          assert.equal(await row.locator('[data-label="メモ"]').evaluate(element => getComputedStyle(element, "::before").content), wrapped ? '"メモ"' : "none");
          assert.equal(await row.getByRole("button", { name: /の詳細を開く$/ }).isVisible(), false, "PCでは展開操作なしで全項目を表示する");
        }
        await assertInside(table.locator("thead th"), bounds.x, bounds.x + bounds.width);
        if (wrapped) {
          const line = await settled.evaluate(element => ({
            height: parseFloat(getComputedStyle(element, "::before").height),
            color: getComputedStyle(element, "::before").backgroundColor,
            rowHeight: element.getBoundingClientRect().height,
          }));
          assert.ok(Math.abs(line.rowHeight - line.height) <= 2);
          assert.equal(line.color, "rgb(59, 130, 246)");
        }
        if (process.env.CAKE_LAYOUT_SCREENSHOTS && available === 1000 && !longNames) {
          await mkdir(".cake", { recursive: true });
          await page.screenshot({ path: ".cake/transaction-layout-pc.png", fullPage: true });
        }
        await table.getByRole("checkbox", { name: "表示中の未清算明細をすべて選択", exact: true }).check();
        assert.equal(await first.getByRole("checkbox", { name: "firstの明細を選択", exact: true }).isChecked(), true);
        assert.equal(await settled.getByRole("checkbox", { name: "settledの明細を選択", exact: true }).isDisabled(), true);
        await table.getByRole("button", { name: "取引先で絞り込み", exact: true }).click();
        await page.getByRole("dialog").waitFor();
        await page.keyboard.press("Escape");
        const memo = first.getByRole("textbox", { name: "firstのメモ", exact: true });
        await memo.fill("折り返し中のメモ\n次の行");
        await page.locator("main").evaluate(element => { element.style.width = "1526px"; });
        await page.locator("main").evaluate((element, width) => { element.style.width = `${width + 26}px`; }, available);
        assert.equal(await memo.inputValue(), "折り返し中のメモ\n次の行");
        assert.equal(await memo.evaluate(element => element === document.activeElement), true);
        assert.equal(writes.length, 0, "表示幅の切替だけでは保存しない");
        await memo.blur();
        await first.getByRole("alert").waitFor();
        assert.equal(await memo.inputValue(), "折り返し中のメモ\n次の行", "保存失敗時も入力を保持する");
        assert.equal(writes.length, 1);
        await assertInside(first.locator('[role="alert"]'), bounds.x, bounds.x + bounds.width);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test("mobileの要約・詳細展開", async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      try {
        const page = await context.newPage();
        await page.goto(origin);
        const first = page.locator('[data-transaction-id="first"]');
        const memo = first.getByRole("textbox", { name: "firstのメモ", exact: true });
        assert.equal(await memo.isVisible(), false);
        await first.getByRole("button", { name: "firstの詳細を開く", exact: true }).click();
        assert.equal(await memo.isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

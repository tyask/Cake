import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Locator, type Page } from "playwright";

async function assertDeletePanel(action: Locator, card: Locator) {
  const panel = (await action.boundingBox())!, row = (await card.boundingBox())!;
  assert.ok(Math.abs(panel.y - row.y) <= 2, "削除領域はカード上端から始まる");
  assert.ok(Math.abs(panel.height - row.height) <= 2, "削除領域はカード全体の高さを使う");
  assert.ok(Math.abs(panel.x + panel.width - row.x - row.width) <= 2, "削除領域はカード右端に接する");
  assert.equal(await action.evaluate(element => getComputedStyle(element).borderRadius), "0px");
}

async function settleScroll(page: Page) {
  await page.evaluate(async () => {
    let previous = window.scrollY, stable = 0;
    for (let frame = 0; frame < 180; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const current = window.scrollY;
      stable = current === previous ? stable + 1 : 0;previous = current;
      if (stable >= 4) return;
    }
    throw new Error("スクロールが停止しませんでした。");
  });
}

async function swipe(page: Page, target: Locator, dx = -100, dy = 0, cancel = false) {
  await settleScroll(page);
  await target.scrollIntoViewIfNeeded();
  await settleScroll(page);
  const box = (await target.boundingBox())!;
  const x = box.x + box.width * .65, y = box.y + box.height / 2;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 6, y: y + dy * step / 6 }] });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    }
    await session.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  } finally { await session.detach(); }
  await settleScroll(page);
}

test("スマホの4画面でスワイプ削除・確認・取消・失敗とPC表示を検証する", async t => {
  const bundle = await build({ entryPoints: ["tests/fixtures/swipe-delete.tsx"], bundle: true, write: false, outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    const asset = bundle.outputFiles.find(file => file.path.endsWith(req.url === "/bundle.css" ? "/bundle.css" : "/bundle.js"));
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : req.url === "/bundle.css" ? "text/css" : "text/html");
    res.end(req.url?.startsWith("/bundle.") ? asset!.text : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  try {
    for (const view of ["transactions", "import", "rules", "recurring"]) await t.test(view, async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }), page = await context.newPage();
      const writes: Record<string, unknown>[] = [], errors: string[] = [];
      let fail = false, archived = false;
      let hold = false, releaseWrite: (() => void) | undefined;
      const payment = { id: "recurring", workspaceId: "workspace", state: "ACTIVE", revision: 1, authorizedById: "a", nextScheduledOn: "2026-11-18", blockedReason: null,
        currentConfig: { dayOfMonth: 18, merchant: "家賃", method: "現金", amountYen: 100, actorUserId: "a", expenseClass: "SHARED", splitWeights: { a: 6, b: 4 }, memo: "" } };
      page.on("pageerror", error => errors.push(error.message));page.setDefaultTimeout(6000);
      try {
        await page.route("**/api/**", async route => {
          const path = new URL(route.request().url()).pathname;
          if (path === "/api/recurring-payments" && route.request().method() === "GET") { await route.fulfill({ json: { payments: archived ? [] : [payment], eligibleActorUserIds: ["a", "b"], today: "2026-10-18", now: "2026-10-18T03:00:00.000Z" } });return; }
          const payload = route.request().postDataJSON();
          if (path === "/api/import/duplicates") { await route.fulfill({ json: { transactions: [] } });return; }
          writes.push(payload);
          if (hold) await new Promise<void>(resolve => { releaseWrite = resolve; });
          if (fail) { await route.fulfill({ status: 503, json: { error: "テスト保存失敗" } });return; }
          if (path === "/api/recurring-payments" && payload.action === "archive") archived = true;
          await route.fulfill({ json: path === "/api/recurring-payments" ? { payment: { ...payment, state: "ARCHIVED", revision: 2 } } : { ok: true, transaction: { ...payload, id: payload.transactionId, actorName: "A", source: "MANUAL", settledAt: null, memo: "" } } });
        });
        await page.goto(`${origin}/?view=${view}`);
        if (view === "import") await page.locator('input[type="file"]').setInputFiles({ name: "swipe.csv", mimeType: "text/csv", buffer: Buffer.from("取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n2026/10/18 12:00:00,100,支払い,first,現金,1\n2026/10/18 12:01:00,200,支払い,second,現金,2") });
        const name = view === "rules" ? "rule1" : view === "recurring" ? "家賃" : "first";
        const reveal = page.getByRole("button", { name: `${name}の削除操作`, exact: true });
        await reveal.waitFor();
        assert.equal(await page.getByRole("button", { name: "⋯", exact: true }).count(), 0);
        assert.ok((await reveal.boundingBox())!.width <= 1, "通常表示では補助操作が行幅を使わない");
        const row = page.locator("[data-swipe-open]").filter({ has: page.getByRole("button", { name: `${name}の削除操作`, exact: true, includeHidden: true }) });
        const action = page.getByRole("button", { name: `${name}を削除`, exact: true });
        const card = row.locator("xpath=ancestor::*[self::tr or self::li][1]");
        const surface = row.locator('[class*="body"]');
        assert.equal(await action.isVisible(), false);
        if (view !== "rules") {
          await swipe(page, surface, -20, 0, true);
          const summary = page.getByRole("button", { name: `${name}の詳細を開く`, exact: true });
          await summary.focus();await page.keyboard.press("Enter");
          await page.getByRole("button", { name: `${name}の詳細を閉じる`, exact: true }).waitFor();
          await reveal.focus();await page.keyboard.press("Enter");await action.waitFor();
          await assertDeletePanel(action, card);
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: `${name}の詳細を閉じる`, exact: true }).focus();await page.keyboard.press("Enter");
          await swipe(page, surface, -100, -130);assert.equal(await action.isVisible(), false);
          await swipe(page, surface);await action.waitFor();
          assert.equal(await page.getByRole("button", { name: `${name}の詳細を閉じる`, exact: true }).count(), 0, "スワイプで詳細を開かない");
          await swipe(page, surface, 100);await action.waitFor({ state: "hidden" });
        }
        await reveal.focus();await page.keyboard.press("Enter");await action.waitFor();
        await assertDeletePanel(action, card);
        await page.getByRole("button", { name: "一覧の外", exact: true }).click();await action.waitFor({ state: "hidden" });
        await reveal.scrollIntoViewIfNeeded();await reveal.focus();await page.keyboard.press("Enter");await action.waitFor();
        await page.keyboard.press("Escape");await action.waitFor({ state: "hidden" });
        assert.equal(await reveal.evaluate(element => element === document.activeElement), true);
        if (process.env.CAKE_SWIPE_SCREENSHOTS) { await reveal.focus();await page.keyboard.press("Enter");await page.screenshot({ animations: "disabled", path: `.cake/swipe-open-${view}.png` });await page.keyboard.press("Escape"); }
        if (view === "import") {
          page.on("dialog", () => { errors.push("取込で不要な確認"); });
          const other = page.getByRole("button", { name: "secondの削除操作", exact: true });
          await reveal.focus();await page.keyboard.press("Enter");await other.focus();await page.keyboard.press("Enter");await action.waitFor({ state: "hidden" });
          await page.keyboard.press("Escape");
          await swipe(page, surface);await action.click();await reveal.waitFor({ state: "hidden" });
          assert.equal(writes.length, 0);hold = true;await page.getByRole("button", { name: "選択した1件を登録", exact: true }).click();
          await page.getByRole("button", { name: "登録中…", exact: true }).waitFor();
          assert.equal(await other.isDisabled(), true);
          await swipe(page, page.locator("[data-import-key]").locator('[class*="body"]'));assert.equal(await page.locator('[data-swipe-open="true"]').count(), 0);
          for (let attempt = 0; !releaseWrite && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
          assert.ok(releaseWrite);releaseWrite();
          await page.getByRole("button", { name: "ファイルを選択", exact: true }).waitFor();
          assert.equal(writes.length, 1);assert.equal(writes[0].totalRows, 2);
          assert.deepEqual((writes[0].items as { merchant: string }[]).map(item => item.merchant), ["second"]);
        } else if (view === "recurring") {
          await swipe(page, surface);await action.click();
          const dialog = page.getByRole("dialog", { name: "定期支払いを削除", exact: true });await dialog.waitFor();
          assert.match((await dialog.textContent())!, /追加済みの明細は残ります/);assert.equal(writes.length, 0);
          await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();assert.equal(writes.length, 0);
          await reveal.focus();await page.keyboard.press("Enter");await action.click();fail = true;await dialog.getByRole("button", { name: "削除する", exact: true }).click();
          await dialog.getByRole("alert").waitFor();assert.equal(writes.length, 1);assert.equal(await row.count(), 1);
          fail = false;await dialog.getByRole("button", { name: "削除する", exact: true }).click();await reveal.waitFor({ state: "hidden" });
          assert.equal(writes[1].action, "archive");assert.equal(writes[1].paymentId, "recurring");assert.equal(writes[1].expectedRevision, 1);
        } else {
          if (view === "transactions") {
            assert.equal(await page.getByRole("button", { name: "settledの削除操作", exact: true }).count(), 0);
            await page.locator('[data-transaction-id="second"]').getByRole("checkbox", { name: "secondの明細を選択", exact: true }).check();
          } else await page.getByRole("checkbox", { name: "「rule2」を削除対象に選択", exact: true }).check();
          if (view === "rules") await swipe(page, surface.locator('label').filter({ hasText: "取引先" }).first().locator('span').first());
          else await swipe(page, surface);
          await action.waitFor();
          page.once("dialog", dialog => dialog.dismiss());await action.click();assert.equal(writes.length, 0);assert.equal(await row.count(), 1);
          fail = true;page.once("dialog", dialog => dialog.accept());await action.click();
          await page.getByRole("alert").filter({ hasText: "テスト保存失敗" }).waitFor();assert.equal(writes.length, 1);assert.equal(await row.count(), 1);
          fail = false;if (!await action.isVisible()) { await reveal.focus();await page.keyboard.press("Enter"); }page.once("dialog", dialog => dialog.accept());await action.click();await reveal.waitFor({ state: "hidden" });
          assert.deepEqual(writes[1][view === "rules" ? "ruleIds" : "transactionIds"], [view === "rules" ? "rule1" : "first"]);
          const otherCheckbox = view === "rules" ? page.getByRole("checkbox", { name: "「rule2」を削除対象に選択", exact: true }) : page.locator('[data-transaction-id="second"]').getByRole("checkbox", { name: "secondの明細を選択", exact: true });
          assert.equal(await otherCheckbox.isChecked(), true);
        }
        if (process.env.CAKE_SWIPE_SCREENSHOTS) await page.screenshot({ animations: "disabled", path: `.cake/swipe-${view}.png` });
        assert.deepEqual(errors, []);
        await page.setViewportSize({ width: 1440, height: 1000 });
        assert.equal(await page.getByRole("button", { name: /の削除操作$/ }).count(), 0, "PCの既存表示を維持");
      } finally { await context.close(); }
    });
    await t.test("取込の固定操作欄がスクロール中も明細より手前で押せる", async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }), page = await context.newPage();
      const writes: Record<string, unknown>[] = [];
      const csv = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n" + Array.from({ length: 30 }, (_, index) => `2026/10/18 12:00:00,100,支払い,sticky${index},現金,${index}`).join("\n");
      try {
        await page.route("**/api/**", async route => {
          if (new URL(route.request().url()).pathname === "/api/import/duplicates") await route.fulfill({ json: { transactions: [] } });
          else { writes.push(route.request().postDataJSON());await route.fulfill({ json: { ok: true } }); }
        });
        await page.goto(origin + "/?view=import");
        async function loadAndScroll() {
          await page.locator('input[type="file"]').setInputFiles({ name: "sticky.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
          await page.getByRole("button", { name: "選択した30件を登録", exact: true }).waitFor();
          const card = page.locator("[data-import-key]").nth(7);
          await card.getByRole("button", { name: "sticky7の削除操作", exact: true }).focus();await page.keyboard.press("Enter");
          const footer = page.locator(".sticky-actions"), bar = (await footer.boundingBox())!, row = (await card.boundingBox())!;
          const scroll = await page.evaluate(() => window.scrollY);
          await page.evaluate(top => window.scrollTo(0, top), row.y + scroll - (bar.y - 20));await settleScroll(page);
          const currentRow = (await card.boundingBox())!, currentBar = (await footer.boundingBox())!;
          assert.ok(currentRow.y < currentBar.y + currentBar.height && currentRow.y + currentRow.height > currentBar.y, "明細と操作欄を実際に重ねる");
          for (const name of ["キャンセル", "選択した30件を登録"]) {
            const button = page.getByRole("button", { name, exact: true });
            assert.equal(await button.evaluate(element => {
              const rect = element.getBoundingClientRect(), top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return top === element || element.contains(top);
            }), true, `${name}が最前面にある`);
          }
          if (process.env.CAKE_SWIPE_SCREENSHOTS) await page.screenshot({ animations: "disabled", path: ".cake/import-sticky-actions.png" });
        }
        await loadAndScroll();await page.getByRole("button", { name: "キャンセル", exact: true }).click();
        await page.getByRole("button", { name: "ファイルを選択", exact: true }).waitFor();assert.equal(writes.length, 0);
        await loadAndScroll();await page.getByRole("button", { name: "選択した30件を登録", exact: true }).click();
        await page.getByRole("button", { name: "ファイルを選択", exact: true }).waitFor();assert.equal(writes.length, 1);
        assert.equal(writes[0].action, "bulkImport");assert.equal((writes[0].items as unknown[]).length, 30);
      } finally { await context.close(); }
    });
    for (const saveFails of [false, true]) await t.test(`明細の保存待ち${saveFails ? "失敗" : "成功"}`, async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }), page = await context.newPage();
      const writes: Record<string, unknown>[] = [];
      let releaseSave!: () => void, started!: () => void;
      const pendingSave = new Promise<void>(resolve => { releaseSave = resolve; });
      const saveStarted = new Promise<void>(resolve => { started = resolve; });
      try {
        await page.route("**/api/app", async route => {
          const payload = route.request().postDataJSON();writes.push(payload);
          if (payload.action === "saveTransaction") {
            started();await pendingSave;
            await route.fulfill(saveFails ? { status: 503, json: { error: "保存待ち失敗" } } : { json: { transaction: { ...payload, id: "first", actorName: "A", settledAt: null, memo: "", source: "MANUAL" } } });
          } else await route.fulfill({ json: { ok: true } });
        });
        await page.goto(origin);
        const row = page.locator('[data-transaction-id="first"]');
        await row.getByRole("button", { name: "firstの詳細を開く", exact: true }).click();
        await row.getByLabel("金額（円）", { exact: true }).fill("222");
        await row.getByRole("button", { name: "firstの削除操作", exact: true }).focus();await page.keyboard.press("Enter");await saveStarted;
        page.once("dialog", dialog => dialog.accept());await row.getByRole("button", { name: "firstを削除", exact: true }).click();
        assert.deepEqual(writes.map(item => item.action), ["saveTransaction"]);
        releaseSave();
        if (saveFails) {
          await page.getByRole("alert").filter({ hasText: "保存待ち失敗" }).first().waitFor();
          assert.equal(await row.getByLabel("金額（円）", { exact: true }).inputValue(), "222");assert.equal(writes.length, 1);
        } else {
          await row.waitFor({ state: "hidden" });assert.deepEqual(writes.map(item => item.action), ["saveTransaction", "deleteTransactions"]);
          assert.deepEqual(writes[1].transactionIds, ["first"]);
        }
      } finally { releaseSave();await context.close(); }
    });
  } finally { await browser.close();await new Promise<void>(done => server.close(() => done())); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Locator, type Page } from "playwright";

function summary(group: Locator, title: string) {
  return group.locator("summary").filter({ hasText: title });
}

async function assertFits(page: Page, width: number) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, "設定画面は横にあふれない");
}

test("個人・ワークスペースの設定枠は閉じて始まり、独立開閉と未保存入力を保持する", async t => {
  const bundle = await build({ entryPoints: ["tests/fixtures/collapsible-settings.tsx"], bundle: true, write: false,
    outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
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
    for (const width of [1440, 390, 320]) await t.test(`${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 768 });
      const page = await context.newPage(), errors: string[] = [], writes: Record<string, unknown>[] = [];
      let reads = 0;
      page.setDefaultTimeout(6000);
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.route("**/api/**", async route => {
          const request = route.request();
          if (request.method() === "GET" && new URL(request.url()).pathname === "/api/recurring-payments") {
            reads++;
            await route.fulfill({ json: { payments: [], eligibleActorUserIds: ["a", "b"], today: "2026-10-21", now: "2026-10-21T03:00:00.000Z" } });
          } else {
            writes.push(request.postDataJSON());
            await route.fulfill({ status: 503, json: { error: "テスト保存失敗" } });
          }
        });
        await page.goto(origin);
        const personal = page.getByRole("region", { name: "個人設定", exact: true });
        const workspace = page.getByRole("region", { name: "ワークスペース設定", exact: true });
        const panels = [
          { toggle: summary(personal, "基本情報"), content: personal.getByLabel("ユーザー名", { exact: true }) },
          { toggle: summary(workspace, "基本情報"), content: workspace.getByLabel("ワークスペース名", { exact: true }) },
          { toggle: summary(workspace, "ワークスペースのデフォルト割合"), content: workspace.getByRole("button", { name: "割合を保存", exact: true, includeHidden: true }) },
          { toggle: summary(workspace, "集計用カテゴリ"), content: workspace.getByRole("button", { name: "＋ 大分類を追加", exact: true, includeHidden: true }) },
          { toggle: summary(workspace, "定期支払い"), content: workspace.getByRole("button", { name: "＋ 定期支払いを追加", exact: true, includeHidden: true }) },
          { toggle: summary(workspace, "費用区分のデフォルトルール"), content: workspace.getByRole("button", { name: "ルールを追加", exact: true, includeHidden: true }) },
          { toggle: summary(workspace, "ワークスペースを削除"), content: workspace.getByRole("button", { name: "完全に削除", exact: true, includeHidden: true }) },
        ];
        for (const { toggle, content } of panels) {
          await toggle.waitFor();
          assert.equal(await content.isVisible(), false, "各設定の操作欄は初期状態で隠れる");
          await toggle.scrollIntoViewIfNeeded();
          const box = (await toggle.boundingBox())!;
          assert.ok(box.height >= 44 && box.width >= 44, "開閉領域は44px以上ある");
          assert.ok(box.x >= 0 && box.x + box.width <= width, "開閉領域は画面内に収まる");
          assert.equal(await toggle.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
          }), true, "見出しの中央で開閉できる");
          await toggle.click();
          assert.equal(await content.isVisible(), true, "見出しを押すと操作欄が現れる");
          await assertFits(page, width);
          await toggle.click();
          assert.equal(await content.isVisible(), false, "見出しを再度押すと操作欄が隠れる");
        }
        assert.equal(reads, 1, "折りたたみ中も既存の定期支払い取得を一度行い、開閉で再取得しない");
        assert.deepEqual(writes, [], "枠の開閉では更新しない");

        await panels[0].toggle.focus(); await page.keyboard.press("Enter");
        await panels[0].content.waitFor();
        await panels[0].content.fill("変更中の名前");
        await panels[1].toggle.focus(); await page.keyboard.press("Space");
        await panels[1].content.waitFor();
        await panels[1].content.fill("保存前の家計名");
        assert.equal(await panels[0].content.isVisible(), true, "他の枠を開いても個人設定は開いたまま");
        await panels[2].toggle.click();
        await workspace.getByLabel("Aの支払い割合", { exact: true }).fill("7");
        assert.equal(await panels[1].content.isVisible(), true, "割合を開いても基本情報は開いたまま");
        for (const index of [0, 1, 2]) { await panels[index].toggle.click(); await panels[index].toggle.click(); }
        assert.equal(await panels[0].content.inputValue(), "変更中の名前");
        assert.equal(await panels[1].content.inputValue(), "保存前の家計名");
        assert.equal(await workspace.getByLabel("Aの支払い割合", { exact: true }).inputValue(), "7");

        await panels[3].toggle.click();
        await workspace.getByRole("button", { name: "食費を選択", exact: true }).click();
        await workspace.getByLabel("カテゴリ名", { exact: true }).fill("入力中カテゴリ");
        await panels[3].toggle.click(); await panels[3].toggle.click();
        assert.equal(await workspace.getByLabel("カテゴリ名", { exact: true }).inputValue(), "入力中カテゴリ");

        await panels[5].toggle.click();
        const createRule = workspace.getByRole("heading", { name: "ルールを追加", exact: true }).locator("..");
        await createRule.getByLabel("取引先に含まれる文字", { exact: true }).fill("追加前ルール");
        const selectedRule = workspace.getByRole("checkbox", { name: "「スーパー」を削除対象に選択", exact: true });
        await selectedRule.check();
        await panels[5].toggle.click(); await panels[5].toggle.click();
        assert.equal(await createRule.getByLabel("取引先に含まれる文字", { exact: true }).inputValue(), "追加前ルール");
        assert.equal(await selectedRule.isChecked(), true, "ルールの選択も開閉で保持する");

        await panels[6].toggle.click();
        const confirmation = workspace.getByLabel("確認のため「ふたりの家計」と入力", { exact: true });
        await confirmation.fill("削除前の入力");
        await panels[6].toggle.click(); await panels[6].toggle.click();
        assert.equal(await confirmation.inputValue(), "削除前の入力");
        assert.equal(await panels[6].content.isDisabled(), true, "開閉で削除の確認条件を変えない");
        await assertFits(page, width);
        assert.equal(reads, 1); assert.deepEqual(writes, [], "開閉は未保存の入力や選択を送信しない");

        await personal.getByRole("button", { name: "変更を保存", exact: true }).click();
        await personal.getByRole("alert").waitFor();
        await panels[0].toggle.click(); await panels[0].toggle.click();
        assert.equal(await panels[0].content.inputValue(), "変更中の名前");
        assert.equal(await personal.getByRole("alert").textContent(), "テスト保存失敗", "失敗と再入力内容を保持する");
        assert.deepEqual(writes, [{ action: "updateProfile", name: "変更中の名前" }]);

        await page.getByRole("button", { name: "設定画面を離れる", exact: true }).click();
        await page.getByRole("button", { name: "設定画面に戻る", exact: true }).click();
        for (const { toggle, content } of panels) { await toggle.waitFor(); assert.equal(await content.isVisible(), false, "設定画面へ入り直すと全枠が閉じる"); }
        assert.equal(writes.length, 1, "設定画面への再入場で更新しない");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test("一人の共有ワークスペースでも招待入力を開閉で保持する", async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 1000 } }), page = await context.newPage();
      const writes: string[] = [];
      try {
        await page.route("**/api/**", async route => {
          if (route.request().method() !== "GET") writes.push(route.request().method());
          await route.fulfill({ json: { payments: [], eligibleActorUserIds: ["a"], today: "2026-10-21", now: "2026-10-21T03:00:00.000Z" } });
        });
        await page.goto(origin + "/?members=1");
        const workspace = page.getByRole("region", { name: "ワークスペース設定", exact: true });
        const toggle = summary(workspace, "ワークスペースのデフォルト割合");
        await toggle.click();
        const email = workspace.getByLabel("相手のGoogleアカウントのメール", { exact: true });
        await email.fill("partner@example.test");
        await toggle.click(); await toggle.click();
        assert.equal(await email.inputValue(), "partner@example.test");
        assert.equal(await workspace.getByLabel("Aの支払い割合", { exact: true }).isDisabled(), true, "一人参加時の割合編集条件を維持する");
        assert.deepEqual(writes, []);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";
import type { Category } from "../lib/types";

async function drag(page: Page, sourceId: string, targetId: string, position: string, touch = false, invalid = false) {
  const handle = page.locator(`[data-category-move-handle="${sourceId}"]`);
  const target = page.locator(`[data-category-drop-id="${targetId}"][data-category-drop-position="${position}"]`);
  await handle.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = (await handle.boundingBox())!;
  const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const session = touch ? await page.context().newCDPSession(page) : null;
  if (session) {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x - 8, y: start.y }] });
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 8, start.y);
  }
  await page.locator(`[data-category-id="${sourceId}"][data-category-dragging="true"]`).waitFor();
  for (let step = 1; step <= 10; step++) {
    const targetBox = (await target.boundingBox())!;
    const end = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
    const point = { x: start.x + (end.x - start.x) * step / 10, y: start.y + (end.y - start.y) * step / 10 };
    if (session) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
    else await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(12);
  }
  // Track the row while dnd-kit's scroll container is moving near an edge.
  for (let step = 0; step < 4; step++) {
    const box = (await target.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (session) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
    else await page.mouse.move(point.x, point.y);
    if (step < 3) await page.waitForTimeout(20);
  }
  await page.locator(`[data-category-drop-id="${targetId}"][data-category-drop-position="${position}"][data-category-drop-over="${invalid ? "invalid" : "valid"}"]`).waitFor();
  const preview = await page.getByRole("status").last().textContent();
  if (session) {
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
  } else await page.mouse.up();
  await page.waitForTimeout(60); // dnd-kit releases its activated-drag click guard after pointerup.
  return preview;
}

test("カテゴリ設定の上下・マウス・タッチ・キーボード移動、入力保持、拒否・失敗・再試行・子孫削除を検証する", async t => {
  const bundle = await build({ entryPoints: ["tests/fixtures/category-settings.tsx"], bundle: true, write: false, outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
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
      const context = await browser.newContext({ viewport: { width, height: 1100 }, hasTouch: width < 768 });
      const page = await context.newPage();
      const writes: Record<string, unknown>[] = [], errors: string[] = [], dialogs: string[] = [];
      let acceptDialog = true;
      let saved: Category[] = [], fail = false, hold = false, release: (() => void) | undefined;
      page.setDefaultTimeout(6000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("dialog", dialog => { dialogs.push(dialog.message()); void (acceptDialog ? dialog.accept() : dialog.dismiss()); });
      try {
        await page.route("**/api/app", async route => {
          const payload = route.request().postDataJSON();
          writes.push(payload);
          if (hold) await new Promise<void>(resolve => { release = resolve; });
          if (fail) { await route.fulfill({ status: 503, json: { error: payload.action === "deleteCategory" ? "カテゴリ削除失敗" : "カテゴリ移動失敗" } }); return; }
          if (payload.action === "deleteCategory") {
            const deleted = new Set<string>([payload.categoryId]);
            for (let changed = true; changed;) {
              changed = false;
              for (const category of saved) if (category.parentId && deleted.has(category.parentId) && !deleted.has(category.id)) { deleted.add(category.id); changed = true; }
            }
            saved = saved.filter(category => !deleted.has(category.id));
            await route.fulfill({ json: { ok: true, deletedCategoryIds: [...deleted], detachedTransactions: [] } }); return;
          }
          if (payload.action === "createCategory") {
            const category: Category = { id: "new-root", name: payload.name, colorHex: payload.colorHex, parentId: payload.parentId, sortOrder: 10, revision: 1, archivedAt: null };
            saved.push(category);
            await route.fulfill({ json: { ok: true, category } }); return;
          }
          if (payload.action === "updateCategory") {
            const category = saved.find(category => category.id === payload.categoryId)!;
            Object.assign(category, { name: payload.name, colorHex: payload.colorHex, revision: category.revision + 1 });
            await route.fulfill({ json: { ok: true, category } }); return;
          }
          assert.equal(payload.action, "moveCategory");
          const before = saved.map(category => ({ ...category }));
          const source = saved.find(category => category.id === payload.categoryId)!;
          const oldParentId = source.parentId;
          const siblings = saved.filter(category => !category.archivedAt && category.parentId === payload.parentId && category.id !== source.id).sort((a, b) => a.sortOrder - b.sortOrder);
          const at = payload.beforeCategoryId === null ? siblings.length : siblings.findIndex(category => category.id === payload.beforeCategoryId);
          assert.ok(at >= 0);
          siblings.splice(at, 0, source);
          source.parentId = payload.parentId;
          const oldSiblings = saved.filter(category => !category.archivedAt && category.parentId === oldParentId && category.id !== source.id).sort((a, b) => a.sortOrder - b.sortOrder);
          oldSiblings.forEach((category, index) => { category.sortOrder = index; });
          siblings.forEach((category, index) => { category.sortOrder = index; });
          saved.forEach(category => { const previous = before.find(row => row.id === category.id)!; if (previous.parentId !== category.parentId || previous.sortOrder !== category.sortOrder) category.revision++; });
          await route.fulfill({ json: { ok: true, movedCategories: saved.filter(category => category.parentId === oldParentId || category.parentId === payload.parentId) } });
        });
        await page.goto(origin);
        saved = JSON.parse((await page.locator("#saved-categories").textContent())!);
        const waitParent = async (id: string, parentId: string | null) => page.waitForFunction(({ id, parentId }) => JSON.parse(document.getElementById("saved-categories")!.textContent!).find((category: Category) => category.id === id).parentId === parentId, { id, parentId });
        const waitOrder = async (id: string, sortOrder: number) => page.waitForFunction(({ id, sortOrder }) => JSON.parse(document.getElementById("saved-categories")!.textContent!).find((category: Category) => category.id === id).sortOrder === sortOrder, { id, sortOrder });
        assert.equal(await page.locator('[data-category-drop-id="root"]').count(), 0);
        assert.equal(await page.getByText(/最上位の末尾|使用停止/).count(), 0);
        assert.equal(await page.getByRole("button", { name: "食費を上へ", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: "娯楽を下へ", exact: true }).isDisabled(), true, "旧使用停止カテゴリは兄弟順に含めない");
        assert.equal(await page.getByRole("button", { name: "食費 › 食料品 › 生鮮食品を上へ", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: "食費 › 食料品 › お菓子を下へ", exact: true }).isDisabled(), true);
        await page.getByRole("button", { name: "食費を下へ", exact: true }).click();
        await waitOrder("food", 1);
        assert.deepEqual(writes.at(-1), { action: "moveCategory", workspaceId: "workspace", categoryId: "food", parentId: null, beforeCategoryId: "fun" });
        await page.getByRole("button", { name: "食費を上へ", exact: true }).click();
        await waitOrder("food", 0);
        assert.deepEqual(writes.at(-1), { action: "moveCategory", workspaceId: "workspace", categoryId: "food", parentId: null, beforeCategoryId: "daily" });
        await page.getByRole("button", { name: "食費 › 食料品を選択", exact: true }).click();
        await page.getByLabel("カテゴリ名", { exact: true }).fill("並べ替え中の名前");
        const beforeStepDialogs = dialogs.length;
        await page.getByRole("button", { name: "食費 › 保存前の名前を上へ", exact: true }).click();
        await waitOrder("old-conflict", 0);
        assert.deepEqual(writes.at(-1), { action: "moveCategory", workspaceId: "workspace", categoryId: "old-conflict", parentId: "food", beforeCategoryId: "grocery" });
        assert.equal(await page.getByLabel("カテゴリ名", { exact: true }).inputValue(), "並べ替え中の名前");
        assert.equal(dialogs.length, beforeStepDialogs, "並べ替えは編集中の入力を破棄しない");
        fail = true;
        await page.getByRole("button", { name: "食費 › 保存前の名前を下へ", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "カテゴリ移動失敗" }).waitFor();
        assert.equal(saved.find(category => category.id === "old-conflict")!.sortOrder, 0);
        fail = false; hold = true;
        await page.getByRole("button", { name: "移動を再試行", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('section[aria-busy="true"]'));
        assert.equal(await page.getByRole("button", { name: "食費を下へ", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: "削除する", exact: true }).isDisabled(), true);
        assert.ok(release); hold = false; release();
        await waitOrder("old-conflict", 1);
        assert.equal(await page.getByLabel("カテゴリ名", { exact: true }).inputValue(), "並べ替え中の名前");
        if (width === 1440) {
          await page.getByRole("button", { name: "食費 › 食料品を選択", exact: true }).click();
          await page.getByLabel("カテゴリ名", { exact: true }).fill("保存前の名前");
          await page.getByLabel("カラーコード", { exact: true }).fill("#123456");
          const preview = page.getByText("明細の表示プレビュー", { exact: true }).locator("..");
          assert.deepEqual(await preview.evaluate(element => { const style = getComputedStyle(element); return [style.backgroundColor, style.borderInlineStartWidth, style.borderInlineStartColor]; }), ["rgb(255, 254, 248)", "4px", "rgb(18, 52, 86)"]);

          assert.match((await drag(page, "books", "movie", "before"))!, /映画.*前/);
          await page.waitForFunction(() => JSON.parse(document.getElementById("saved-categories")!.textContent!).find((category: Category) => category.id === "books").sortOrder === 0);
          assert.deepEqual(writes.at(-1), { action: "moveCategory", workspaceId: "workspace", categoryId: "books", parentId: "fun", beforeCategoryId: "movie" });
          const beforeRejected = writes.length;
          assert.match((await drag(page, "grocery", "leaf", "inside", false, true))!, /子孫/);
          await page.getByRole("alert").filter({ hasText: "子孫" }).waitFor();
          assert.match((await drag(page, "grocery", "daily", "inside", false, true))!, /同じ名前/);
          assert.match((await drag(page, "grocery", "archived", "inside", false, true))!, /変更できない/);
          assert.equal(writes.length, beforeRejected, "無効な移動はAPIへ送らない");

          await drag(page, "grocery", "books", "inside");
          await waitParent("grocery", "books");
          assert.equal(await page.getByLabel("カテゴリ名", { exact: true }).inputValue(), "保存前の名前");
          assert.equal(await page.getByLabel("カラーコード", { exact: true }).inputValue(), "#123456");
          assert.match((await preview.textContent())!, /娯楽 › 書籍 › 保存前の名前/);
          for (const [id, parent] of [["fresh", "grocery"], ["leaf", "fresh"], ["snacks", "grocery"]]) assert.equal(saved.find(row => row.id === id)!.parentId, parent);
          await page.getByRole("button", { name: "変更を保存", exact: true }).click();
          await page.getByRole("heading", { name: "カテゴリと色を設定", exact: true }).waitFor();
          assert.equal(writes.at(-1)?.action, "updateCategory", "移動前の親でdraftの同名判定をしない");

          fail = true;
          await drag(page, "leaf", "daily", "before");
          await page.getByRole("alert").filter({ hasText: "カテゴリ移動失敗" }).waitFor();
          assert.equal(saved.find(row => row.id === "leaf")!.parentId, "fresh");
          assert.equal(await page.getByRole("heading", { name: "カテゴリと色を設定", exact: true }).isVisible(), true, "編集欄を閉じていても失敗が見える");
          fail = false; hold = true;
          const beforeRetry = writes.length;
          await page.getByRole("button", { name: "移動を再試行", exact: true }).click();
          await page.waitForFunction(() => document.querySelector('section[aria-busy="true"]'));
          assert.equal(await page.locator('[data-category-move-handle="movie"]').isDisabled(), true);
          assert.equal(await page.getByRole("button", { name: "＋ 大分類を追加", exact: true }).isDisabled(), true);
          assert.equal(writes.length, beforeRetry + 1);
          assert.ok(release); hold = false; release();
          await waitParent("leaf", null);
          await page.getByRole("alert").waitFor({ state: "hidden" });
          const handle = page.locator('[data-category-move-handle="leaf"]');
          await handle.focus(); await handle.press("Enter");
          const moveForm = page.getByRole("form", { name: "カテゴリを移動", exact: true });
          assert.equal(await moveForm.locator("option").filter({ hasText: "最上位の末尾" }).count(), 0);
          assert.equal(await moveForm.getByRole("button", { name: "この位置へ移動", exact: true }).isDisabled(), true);
          await moveForm.getByLabel("移動先のカテゴリ", { exact: true }).selectOption("fresh");
          await moveForm.getByLabel("子カテゴリにする（末尾）", { exact: true }).check();
          await moveForm.getByRole("button", { name: "この位置へ移動", exact: true }).click();
          await waitParent("leaf", "fresh");
        } else {
          const beforeClipped = writes.length;
          const treeScroll = page.locator("[data-category-tree-scroll]");
          for (const delay of [0, 3, 6, 9]) {
            await treeScroll.evaluate(element => { element.scrollTop = 0; });
            const clippedSource = page.locator('[data-category-move-handle="grocery"]');
            await clippedSource.scrollIntoViewIfNeeded();
            const sourceBox = (await clippedSource.boundingBox())!;
            await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
            await page.mouse.down();
            await page.mouse.move(sourceBox.x + sourceBox.width / 2 - 8, sourceBox.y + sourceBox.height / 2);
            await page.locator('[data-category-id="grocery"][data-category-dragging="true"]').waitFor();
            const clipBox = (await treeScroll.boundingBox())!;
            const clippedTarget = (await page.locator('[data-category-drop-id="books"][data-category-drop-position="inside"]').boundingBox())!;
            assert.ok(clippedTarget.y >= clipBox.y + clipBox.height, "対象行はツリーのoverflowで完全に隠れている");
            await page.mouse.move(clippedTarget.x + clippedTarget.width / 2, clippedTarget.y + clippedTarget.height / 2);
            if (delay) await page.waitForTimeout(delay);
            await page.mouse.up();
            await page.locator('[data-category-id="grocery"][data-category-dragging="true"]').waitFor({ state: "hidden" });
            await page.waitForTimeout(60);
            assert.equal(await page.locator("[data-category-drop-over]").count(), 0);
            assert.equal(writes.length, beforeClipped, `ツリー外の隠れた行で${delay}ms後に離しても保存しない`);
            assert.equal(saved.find(row => row.id === "grocery")!.parentId, "food");
          }
          assert.match((await drag(page, "movie", "books", "inside", true))!, /書籍.*子カテゴリ/);
          await waitParent("movie", "books");
          assert.equal(writes.at(-1)?.parentId, "books");
          assert.match((await drag(page, "movie", "books", "before", true))!, /書籍.*前/);
          await waitParent("movie", "fun");
          assert.equal(writes.at(-1)?.beforeCategoryId, "books");
          const handle = page.locator('[data-category-move-handle="movie"]');
          await handle.focus(); await handle.press("Space");
          const moveForm = page.getByRole("form", { name: "カテゴリを移動", exact: true });
          await moveForm.getByLabel("移動先のカテゴリ", { exact: true }).selectOption("books");
          await moveForm.getByLabel("後に並べる", { exact: true }).check();
          await moveForm.getByRole("button", { name: "この位置へ移動", exact: true }).click();
          await page.waitForFunction(() => JSON.parse(document.getElementById("saved-categories")!.textContent!).find((category: Category) => category.id === "movie").sortOrder === 1);
        }
        await page.locator('[data-category-id="fresh"]').getByRole("button", { name: /を選択$/ }).click();
        await page.getByLabel("カテゴリ名", { exact: true }).fill("削除前の下書き");
        acceptDialog = false;
        const beforeCancel = writes.length;
        await page.getByRole("button", { name: "削除する", exact: true }).click();
        assert.equal(writes.length, beforeCancel);
        assert.match(dialogs.at(-1)!, /生鮮食品.*子カテゴリ.*2件.*削除.*清算済み.*未分類.*未保存/);
        assert.equal(await page.getByLabel("カテゴリ名", { exact: true }).inputValue(), "削除前の下書き");
        acceptDialog = true; fail = true;
        await page.getByRole("button", { name: "削除する", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "カテゴリ削除失敗" }).waitFor();
        assert.equal(await page.getByLabel("カテゴリ名", { exact: true }).inputValue(), "削除前の下書き");
        assert.equal(saved.some(category => category.id === "fresh"), true);
        fail = false; hold = true;
        await page.getByRole("button", { name: "削除する", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('section[aria-busy="true"]'));
        assert.equal(await page.getByRole("button", { name: "削除する", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: "保存中…", exact: true }).isDisabled(), true);
        assert.ok(release); hold = false; release();
        await page.locator('[data-category-id="fresh"]').waitFor({ state: "hidden" });
        assert.equal(await page.locator('[data-category-id="leaf"]').count(), 0);
        assert.equal(saved.some(category => category.id === "grocery"), true);
        assert.deepEqual(writes.at(-1), { action: "deleteCategory", workspaceId: "workspace", categoryId: "fresh" });
        await page.getByRole("button", { name: "以前のカテゴリを選択", exact: true }).click();
        await page.getByText("このカテゴリは変更できません。削除はできます。", { exact: true }).waitFor();
        assert.equal(await page.getByLabel("カテゴリ名", { exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: "以前のカテゴリを上へ", exact: true }).isDisabled(), true);
        assert.equal(await page.locator('[data-category-move-handle="archived"]').isDisabled(), true);
        await page.getByRole("button", { name: "削除する", exact: true }).click();
        await page.locator('[data-category-id="archived"]').waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "＋ 大分類を追加", exact: true }).click();
        await page.getByLabel("カテゴリ名", { exact: true }).fill("新しい大分類");
        await page.getByRole("button", { name: "カテゴリを追加", exact: true }).click();
        await page.locator('[data-category-id="new-root"]').waitFor();
        assert.equal(writes.at(-1)?.action, "createCategory");
        assert.equal(writes.at(-1)?.parentId, null);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.equal(await page.locator('[data-category-tree-scroll]').evaluate(element => element.scrollWidth <= element.clientWidth), true, "ツリーも横にあふれない");
        assert.deepEqual(errors, []);
      } finally { release?.(); await context.close(); }
    });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

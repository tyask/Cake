import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Locator } from "playwright";

async function assertCategoryLine(row: Locator, width: number, color: string) {
  if (width >= 768) {
    assert.equal(await row.locator('[data-label="選択"]').evaluate(element => getComputedStyle(element).boxShadow), `${color} 4px 0px 0px 0px inset`);
    return;
  }
  const line = await row.evaluate(element => {
    const style = getComputedStyle(element, "::before");
    return { color: style.backgroundColor, width: style.width, height: parseFloat(style.height), left: style.left, zIndex: style.zIndex, pointerEvents: style.pointerEvents, cardHeight: element.getBoundingClientRect().height };
  });
  assert.equal(line.color, color);
  assert.equal(line.width, "4px");
  assert.equal(line.left, "0px");
  assert.ok(Math.abs(line.height - line.cardHeight) <= 2.1, `色線はカード全体の高さを使う: ${JSON.stringify(line)}`);
  assert.equal(line.zIndex, "3", "スワイプ内容より前面に表示する");
  assert.equal(line.pointerEvents, "none");
}

test("明細カテゴリの保存・失敗保持・精算済み編集とPC/mobile表示を検証する", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/transaction-categories.tsx"], bundle: true, write: false, outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
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
    for (const width of [1600, 390]) await t.test(`${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const writes: Record<string, unknown>[] = [], errors: string[] = [];
      let fail = false, hold = false, release: (() => void) | undefined, refreshes = 0;
      page.setDefaultTimeout(6000);
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.route("**/api/**", async route => {
          if (route.request().method() === "GET") { refreshes++; await route.fulfill({ json: { ok: true } }); return; }
          const payload = route.request().postDataJSON();
          writes.push(payload);
          if (hold) await new Promise<void>(resolve => { release = resolve; });
          if (fail) { await route.fulfill({ status: 503, json: { error: "カテゴリ保存失敗" } }); return; }
          await route.fulfill({ json: payload.action === "saveTransactionCategory"
            ? { ok: true, transactionId: payload.transactionId, categoryId: payload.categoryId, categoryConfirmed: payload.categoryId !== null }
            : { ok: true, transaction: { ...payload, id: payload.transactionId ?? "created", actorName: "A", source: "MANUAL", externalId: "new", settledAt: null } } });
        });
        await page.goto(origin);
        const first = page.locator('[data-transaction-id="first"]');
        const settled = page.locator('[data-transaction-id="settled"]');
        const normalBackground = await first.evaluate(element => getComputedStyle(element).backgroundColor);
        assert.equal(normalBackground, width < 768 ? "rgb(255, 254, 248)" : "rgba(0, 0, 0, 0)");
        assert.equal(await settled.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(251, 245, 223)", "カテゴリ付き清算済み行も既存の背景を保つ");
        await assertCategoryLine(first, width, "rgba(0, 0, 0, 0)");
        await assertCategoryLine(settled, width, "rgb(59, 130, 246)");
        const headers = await page.getByRole("table", { name: "取引明細", exact: true }).locator("thead th").allTextContents();
        const categoryIndex = headers.findIndex(header => header.startsWith("カテゴリ"));
        assert.match(headers[categoryIndex + 1], /^メモ/);
        for (const row of [first, settled]) {
          const labels = await row.locator("td[data-label]").evaluateAll(elements => elements.map(element => element.getAttribute("data-label")));
          assert.equal(labels[categoryIndex], "カテゴリ");
          assert.equal(labels[categoryIndex + 1], "メモ");
        }
        if (width >= 768) {
          const categoryColumn = page.getByRole("table", { name: "取引明細", exact: true }).locator("col").nth(categoryIndex);
          const categoryWidth = await categoryColumn.evaluate(element => element.getBoundingClientRect().width);
          assert.ok(categoryWidth <= 176, `カテゴリ列は従来の13remより狭くする: ${categoryWidth}px`);
          assert.equal(await first.locator('[data-label="カテゴリ"]').evaluate(element => element.getBoundingClientRect().width), categoryWidth);
        }
        if (width < 768) {
          await first.getByRole("button", { name: "firstの詳細を開く", exact: true }).click();
          await settled.getByRole("button", { name: "settledの詳細を開く", exact: true }).click();
          await assertCategoryLine(settled, width, "rgb(59, 130, 246)");
        }
        const select = first.getByLabel("firstのカテゴリ", { exact: true });
        const settledSelect = settled.getByLabel("settledのカテゴリ", { exact: true });
        assert.deepEqual(await select.locator("option").allTextContents(), ["未分類", "食費", "食費 › 生鮮食品", "食費 › 生鮮食品 › 野菜"]);
        assert.equal(await settledSelect.inputValue(), "old");
        assert.equal(await settledSelect.locator('option[value="old"]').isDisabled(), true);
        assert.match(await settled.locator("[data-category-editor]").textContent() ?? "", /以前のカテゴリ（使用停止）/);

        fail = true;
        await select.selectOption("leaf");
        await first.getByRole("alert").waitFor();
        assert.equal(await select.inputValue(), "leaf", "失敗しても選択を保持する");
        await page.getByRole("button", { name: "更新", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-transaction-id="first"] [role="alert"]') && !document.querySelector('[aria-busy="true"]'));
        assert.equal(refreshes, 0, "カテゴリ保存失敗時は再取得しない");
        fail = false;
        await first.getByRole("button", { name: "再試行", exact: true }).click();
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!)[0].categoryId === "leaf");
        assert.equal(await first.getByRole("alert").count(), 0);
        assert.equal(await first.evaluate(element => getComputedStyle(element).backgroundColor), normalBackground, "カテゴリ保存後も通常背景を保つ");
        await assertCategoryLine(first, width, "rgb(253, 186, 116)");
        if (width < 768) {
          assert.equal(await first.locator('[data-swipe-open] > div').first().evaluate(element => getComputedStyle(element).backgroundColor), normalBackground, "スワイプ内容も通常背景を保つ");
          const reveal = first.getByRole("button", { name: "firstの削除操作", exact: true });
          await reveal.focus();
          await page.keyboard.press("Enter");
          await first.getByRole("button", { name: "firstを削除", exact: true }).waitFor();
          await assertCategoryLine(first, width, "rgb(253, 186, 116)");
          await page.keyboard.press("Escape");
          await first.getByRole("button", { name: "firstの詳細を閉じる", exact: true }).click();
          await assertCategoryLine(first, width, "rgb(253, 186, 116)");
          await first.getByRole("button", { name: "firstの詳細を開く", exact: true }).click();
        }
        await page.getByLabel("カテゴリの表示範囲").selectOption("root");
        assert.equal(await select.inputValue(), "leaf", "大分類表示でも保存IDを変えない");
        assert.equal(await first.locator('[data-category-editor] [aria-hidden="true"]').first().textContent(), "食費▾");
        await assertCategoryLine(first, width, "rgb(253, 186, 116)");
        assert.equal(await select.locator('option[value="leaf"]').textContent(), "食費 › 生鮮食品 › 野菜", "選択肢は全階層のままにする");

        hold = true;
        const before = writes.length;
        await select.selectOption("food");
        await page.waitForFunction(() => (document.querySelector('[data-transaction-id="first"] select[aria-label="firstのカテゴリ"]') as HTMLSelectElement).disabled);
        assert.equal(await select.isDisabled(), true);
        await first.getByLabel("取引先", { exact: true }).fill("first edited");
        await first.getByLabel("取引先", { exact: true }).blur();
        await page.waitForTimeout(20);
        assert.equal(writes.length, before + 1, "通常保存も同じキューで待機する");
        assert.ok(release);
        hold = false; release();
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!)[0].merchant === "first edited");
        assert.deepEqual(writes.slice(before).map(value => value.action), ["saveTransactionCategory", "saveTransaction"]);
        assert.equal(await first.getByLabel("first editedのカテゴリ", { exact: true }).inputValue(), "food");

        await settledSelect.selectOption("");
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!)[1].categoryId === null);
        const saved = await page.locator("#saved-transactions").textContent();
        assert.equal(JSON.parse(saved!)[1].amountYen, 100);
        assert.equal(JSON.parse(saved!)[1].settledAt, "2026-10-20T04:00:00Z");
        assert.equal(await settledSelect.isEnabled(), true);
        await assertCategoryLine(settled, width, "rgba(0, 0, 0, 0)");
        assert.equal(await settled.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(251, 245, 223)");
        await page.getByLabel("カテゴリの表示範囲").selectOption("full");
        if (width < 768) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);

        await page.getByRole("button", { name: "＋ 明細を追加", exact: true }).click();
        const modal = page.getByRole("dialog", { name: "明細を追加", exact: true });
        await modal.getByLabel("取引先", { exact: true }).fill("新しい支払い");
        await modal.getByLabel("金額（円）", { exact: true }).fill("500");
        await modal.getByLabel("カテゴリ", { exact: true }).selectOption("leaf");
        await modal.getByRole("button", { name: "追加する", exact: true }).click();
        await modal.waitFor({ state: "hidden" });
        assert.equal(writes.at(-1)?.categoryId, "leaf");
        assert.equal(writes.at(-1)?.merchant, "新しい支払い");
        assert.deepEqual(errors, []);
      } finally { release?.(); await context.close(); }
    });
    for (const width of [1600, 390]) await t.test(`${width}px: カテゴリの絞り込み・保存復元・他列との併用・編集後の再判定`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const writes: Record<string, unknown>[] = [], errors: string[] = [];
      let release: (() => void) | undefined;
      page.setDefaultTimeout(6000);
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/app", async route => {
        const payload = route.request().postDataJSON();
        writes.push(payload);
        await new Promise<void>(resolve => { release = resolve; });
        await route.fulfill({ json: { transactionId: payload.transactionId, categoryId: payload.categoryId, categoryConfirmed: true, categoryRevision: 2 } });
      });
      const visible = async (ids: string[]) => {
        await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll("[data-transaction-id]")].map(row => row.getAttribute("data-transaction-id"))) === JSON.stringify(expected), ids);
      };
      const openFilter = async (column: string) => {
        await page.getByRole("button", { name: column + "で絞り込み", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: column + "で絞り込み", exact: true });
        await dialog.waitFor();
        return dialog;
      };
      const choose = async (column: string, labels: string[]) => {
        const dialog = await openFilter(column);
        const all = dialog.getByRole("checkbox", { name: "候補の値をすべて選択", exact: true });
        await all.check();
        await all.uncheck();
        for (const label of labels) await dialog.getByText(label, { exact: true }).locator("..").getByRole("checkbox").check();
        await dialog.getByRole("button", { name: "適用", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
      };
      try {
        await page.goto(origin + "?categoryFilters");
        const allIds = ["first", "settled", "category-food", "category-fresh", "category-leaf"];
        await visible(allIds);
        const dialog = await openFilter("カテゴリ");
        assert.equal(await dialog.getByRole("combobox", { name: "列", exact: true }).inputValue(), "category");
        for (const label of ["未分類", "以前のカテゴリ（使用停止）", "食費", "食費 › 生鮮食品", "食費 › 生鮮食品 › 野菜"]) {
          await dialog.getByText(label, { exact: true }).waitFor();
        }
        await dialog.getByLabel("候補の値を検索", { exact: true }).fill("野菜");
        assert.equal(await dialog.getByRole("checkbox").count(), 2, "検索結果の全選択と全階層名に一致するカテゴリだけを示す");
        await page.keyboard.press("Escape");

        await choose("カテゴリ", ["食費", "食費 › 生鮮食品 › 野菜"]);
        await visible(["category-food", "category-leaf"]);
        await page.getByRole("button", { name: "カテゴリの絞り込みを解除", exact: true }).waitFor();
        await page.getByLabel("カテゴリの表示範囲").selectOption("root");
        await visible(["category-food", "category-leaf"]);
        await page.getByLabel("カテゴリの表示範囲").selectOption("full");
        await page.reload();
        await visible(["category-food", "category-leaf"]);
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("cake:transaction-filters:v1:a:workspace")!).category), ["food", "leaf"]);

        await choose("取引先", ["category-leaf"]);
        await visible(["category-leaf"]);
        const filteredDialog = await openFilter("カテゴリ");
        assert.equal(await filteredDialog.getByText("食費", { exact: true }).locator("..").locator("small").textContent(), "0件");
        assert.equal(await filteredDialog.getByText("食費 › 生鮮食品 › 野菜", { exact: true }).locator("..").locator("small").textContent(), "1件");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "取引先の絞り込みを解除", exact: true }).click();
        await visible(["category-food", "category-leaf"]);

        await choose("カテゴリ", ["未分類", "以前のカテゴリ（使用停止）"]);
        await visible(["first", "settled"]);
        await choose("カテゴリ", []);
        await visible([]);
        await page.getByText("条件に一致する明細がありません。", { exact: true }).waitFor();
        await page.getByRole("button", { name: "絞り込み解除", exact: true }).click();
        await visible(allIds);
        assert.equal(await page.evaluate(() => localStorage.getItem("cake:transaction-filters:v1:a:workspace")), null);
        assert.equal(writes.length, 0, "絞り込み・表示範囲切替・再読み込み・解除だけでは業務更新しない");

        await choose("カテゴリ", ["食費 › 生鮮食品"]);
        await visible(["category-fresh"]);
        const row = page.locator('[data-transaction-id="category-fresh"]');
        if (width < 768) await row.getByRole("button", { name: "category-freshの詳細を開く", exact: true }).click();
        const select = row.getByLabel("category-freshのカテゴリ", { exact: true });
        await select.selectOption("leaf");
        await page.waitForFunction(() => (document.querySelector('select[aria-label="category-freshのカテゴリ"]') as HTMLSelectElement).disabled);
        await visible(["category-fresh"]);
        await page.getByRole("heading", { name: "取引明細", exact: true }).click();
        assert.ok(release);
        release();
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!).find((row: { id: string }) => row.id === "category-fresh").categoryId === "leaf");
        await visible([]);
        assert.match(await page.getByRole("button", { name: "カテゴリの絞り込みを解除", exact: true }).textContent() ?? "", /食費 › 生鮮食品/);
        assert.equal(writes.length, 1);
        assert.equal(writes[0].action, "saveTransactionCategory");
        assert.deepEqual(errors, []);
      } finally { release?.(); await context.close(); }
    });
    for (const width of [1440, 390]) await t.test(`${width}px: 個人費の担当者は本人に限定する`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const writes: Record<string, unknown>[] = [];
      await page.route("**/api/app", async route => {
        const payload = route.request().postDataJSON();
        writes.push(payload);
        await route.fulfill({ json: { transaction: { ...payload, id: payload.transactionId, actorName: payload.actorUserId === "a" ? "A" : "B", source: "MANUAL", externalId: "first", settledAt: null, memo: "", categoryId: null, categoryConfirmed: false, categoryRevision: 0 } } });
      });
      try {
        await page.goto(origin);
        const first = page.locator('[data-transaction-id="first"]');
        if (width < 768) await first.getByRole("button", { name: "firstの詳細を開く", exact: true }).click();
        const actor = first.getByLabel("支払者", { exact: true });
        const classification = first.getByLabel("区分", { exact: true });
        await actor.selectOption("b");
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!)[0].actorUserId === "b");
        assert.equal(await classification.locator('option[value="PERSONAL"]').isDisabled(), true);
        await first.getByText("個人に変更する場合は、担当者を自分に変更してください。", { exact: true }).waitFor();
        await actor.selectOption("a");
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!)[0].actorUserId === "a");
        await classification.selectOption("PERSONAL");
        await page.waitForFunction(() => JSON.parse(document.getElementById("saved-transactions")!.textContent!)[0].expenseClass === "PERSONAL");
        assert.equal(await actor.locator('option[value="b"]').isDisabled(), true);
        assert.equal(writes.length, 3);
        assert.ok(writes.every(payload => payload.expenseClass !== "PERSONAL" || payload.actorUserId === "a"));
      } finally { await context.close(); }
    });
    for (const width of [1440, 390]) await t.test(`${width}px: 相手の個人明細は閲覧のみで一括操作から除外する`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const writes: Record<string, unknown>[] = [];
      await page.route("**/api/**", async route => {
        if (route.request().method() !== "GET") writes.push(route.request().postDataJSON());
        await route.fulfill({ json: { ok: true } });
      });
      try {
        await page.goto(origin + "?partnerPersonal");
        const own = page.locator('[data-transaction-id="own-personal"]');
        for (const id of ["partner-payment", "partner-receipt"]) {
          const row = page.locator(`[data-transaction-id="${id}"]`);
          await row.waitFor();
          if (width < 768) await row.getByRole("button", { name: `${id}の詳細を開く`, exact: true }).click();
          assert.equal(await row.getByRole("checkbox", { name: `${id}の明細を選択`, exact: true }).filter({ visible: true }).isDisabled(), true);
          assert.equal(await row.locator("input:not([type=checkbox]), select, textarea").count(), 0, "金額・担当者・カテゴリ・メモを編集できない");
          assert.equal(await row.locator('[data-label="メモ"]').textContent(), "相手にも見えるメモ\n2行目");
          assert.equal(await row.locator('[data-label="カテゴリ"]').textContent(), "食費 › 生鮮食品 › 野菜");
          assert.equal(await row.locator('[data-label="清算"]').textContent(), "対象外");
          assert.equal(await row.getByRole("button", { name: `${id}の削除操作`, exact: true }).count(), 0);
        }
        if (width < 768) await own.getByRole("button", { name: "own-personalの詳細を開く", exact: true }).click();
        assert.equal(await own.getByLabel("取引先", { exact: true }).isEnabled(), true);
        assert.equal(await own.getByLabel("own-personalのカテゴリ", { exact: true }).isEnabled(), true);
        assert.equal(await own.getByLabel("own-personalのメモ", { exact: true }).isEnabled(), true);
        await page.getByRole("checkbox", { name: "表示中の未清算明細をすべて選択", exact: true }).check();
        assert.equal(await own.getByRole("checkbox", { name: "own-personalの明細を選択", exact: true }).filter({ visible: true }).isChecked(), true);
        await page.getByText("5件・2件選択", { exact: true }).waitFor();
        await page.getByRole("button", { name: "更新", exact: true }).click();
        assert.deepEqual(writes, [], "全選択・表示・更新で相手の個人明細への更新要求を作らない");
      } finally { await context.close(); }
    });
    await t.test("保存中に新しいカテゴリを取得した場合、旧応答を入力欄でも承認しない", async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      let release: (() => void) | undefined;
      await page.route("**/api/app", async route => {
        const payload = route.request().postDataJSON();
        await new Promise<void>(resolve => { release = resolve; });
        await route.fulfill({ json: { transactionId: "first", categoryId: payload.categoryId, categoryConfirmed: true, categoryRevision: 1 } });
      });
      try {
        await page.goto(origin);
        const select = page.getByLabel("firstのカテゴリ", { exact: true });
        await select.selectOption("leaf");
        await page.waitForFunction(() => (document.querySelector('select[aria-label="firstのカテゴリ"]') as HTMLSelectElement).disabled);
        await page.getByRole("button", { name: "外部のカテゴリ更新を受信", exact: true }).click();
        assert.ok(release); release();
        await page.waitForFunction(() => !(document.querySelector('select[aria-label="firstのカテゴリ"]') as HTMLSelectElement).disabled);
        assert.equal(await select.inputValue(), "fresh");
        assert.equal(JSON.parse((await page.locator("#saved-transactions").textContent())!)[0].categoryRevision, 10);
      } finally { release?.(); await context.close(); }
    });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

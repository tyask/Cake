import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, type Page, type Route } from "playwright";
import type { TransactionRecord, WorkspaceData } from "../../lib/shared/types";

function transaction(id: string, extra: Partial<TransactionRecord>): TransactionRecord {
  return { id, merchant: id, type: "PAYMENT", amountYen: 300, occurredAt: "2026-10-20T00:00:00.001Z",
    method: "現金", memo: "", actorUserId: "a", actorName: "A", expenseClass: "SHARED", splitWeights: { a: 1, b: 1 },
    settledAt: null, externalId: id, source: "MANUAL", categoryId: "food", categoryConfirmed: true, categoryRevision: 1, ...extra };
}

const initial: WorkspaceData = {
  workspace: { id: "sort-summary-workspace", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
  members: [
    { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 1, role: "OWNER" },
    { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 1, role: "MEMBER" },
  ], categories: [
    { id: "food", name: "食費", parentId: null, revision: 1, colorHex: "#f97316", sortOrder: 0, archivedAt: null },
    { id: "income", name: "収入", parentId: null, revision: 1, colorHex: "#3b82f6", sortOrder: 1, archivedAt: null },
  ], rules: [], settlement: null, settlementHistory: [], transactions: [
    transaction("income", { merchant: "店10", type: "RECEIPT", amountYen: 2000, method: "銀行", categoryId: "income",
      occurredAt: "2026-10-20T00:00:00.002Z", actorUserId: "b", actorName: "B" }),
    transaction("small", { merchant: "店2" }),
    transaction("settled", { merchant: "清算済み", amountYen: 700, occurredAt: "2026-10-19T00:00:00.000Z", settledAt: "2026-10-20T00:00:00.000Z" }),
    transaction("own", { merchant: "個人費", amountYen: 500, method: "カード", expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 },
      occurredAt: "2026-10-18T00:00:00.000Z" }),
    transaction("partner", { merchant: "個人収入", type: "RECEIPT", amountYen: 1000, method: "銀行", categoryId: "income",
      expenseClass: "PERSONAL", actorUserId: "b", actorName: "B", splitWeights: { a: 0, b: 1 }, occurredAt: "2026-10-17T00:00:00.000Z" }),
    transaction("past", { merchant: "前月の未清算", amountYen: 900, occurredAt: "2026-09-20T00:00:00.000Z" }),
  ],
};

async function chooseFilter(page: Page, name: string, value?: RegExp) {
  await page.getByRole("button", { name: name + "で絞り込み", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: name + "で絞り込み", exact: true });
  await dialog.getByRole("checkbox", { name: "候補の値をすべて選択", exact: true }).uncheck();
  if (value) await dialog.getByRole("checkbox", { name: value }).check();
  await dialog.getByRole("button", { name: "適用", exact: true }).click();
}

async function chooseSort(page: Page, name: string, direction: "none" | "asc" | "desc") {
  await page.getByRole("button", { name: name + "で絞り込み", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: name + "で絞り込み", exact: true });
  await dialog.getByRole("combobox", { name: "ソート順", exact: true }).selectOption(direction);
  await dialog.getByRole("button", { name: "適用", exact: true }).click();
}

async function assertSort(page: Page, name?: string, direction?: "ascending" | "descending") {
  const headers = page.locator('table[aria-label="取引明細"] thead');
  const arrows = headers.locator("button span").filter({ hasText: /^[↑↓]$/ });
  assert.equal(await arrows.count(), name ? 1 : 0, "ソート未指定の列には矢印のDOMがない");
  assert.equal(await headers.locator('th[aria-sort="ascending"], th[aria-sort="descending"]').count(), name ? 1 : 0);
  if (name) {
    const button = headers.getByRole("button", { name: name + "で絞り込み", exact: true, includeHidden: true });
    assert.equal(await button.evaluate(element => element.closest("th")?.getAttribute("aria-sort")), direction);
    assert.equal(await arrows.textContent(), direction === "ascending" ? "↑" : "↓");
  } else {
    assert.equal(await headers.locator('th[aria-sort="none"]').count(), 11);
  }
}

async function assertTotals(page: Page, expected: string[]) {
  const summary = page.locator('[role="group"][aria-label="フィルタ結果の収支"]');
  await page.waitForFunction(values => {
    const summary = document.querySelector('[role="group"][aria-label="フィルタ結果の収支"]');
    return JSON.stringify(Array.from(summary?.querySelectorAll("dd") ?? []).map(cell => cell.textContent)) === JSON.stringify(values);
  }, expected);
  assert.deepEqual(await summary.locator("dt").allTextContents(), ["収入", "支出", "収支"]);
  assert.deepEqual(await summary.locator("dd").allTextContents(), expected);
}

async function rowIds(page: Page) {
  return page.locator("tr[data-transaction-id]").evaluateAll(rows => rows.map(row => row.getAttribute("data-transaction-id")));
}

test("取引明細のソートと絞り込み結果の合計はPC/mobileで確定値と表示範囲に追従する", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/transaction-sort-summary.tsx"], bundle: true,
    write: false, outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    const suffix = req.url === "/bundle.css" ? "/bundle.css" : "/bundle.js";
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : req.url === "/bundle.css" ? "text/css" : "text/html");
    res.end(req.url?.startsWith("/bundle.") ? bundle.outputFiles.find(file => file.path.endsWith(suffix))!.text
      : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  try {
    for (const width of [1920, 1000, 390, 320]) await t.test(`${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      await page.clock.setFixedTime(new Date("2026-10-20T03:00:00.000Z"));
      await page.addInitScript(data => { window.sortSummaryInitial = data; }, initial);
      const errors: string[] = [], writes: Record<string, unknown>[] = [];
      const records = new Map(initial.transactions.map(row => [row.id, { ...row }]));
      let fail = true;
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/**", async route => {
        const request = route.request();
        if (request.method() === "GET") {
          await route.fulfill({ json: [...records.values()] });
          return;
        }
        const payload = request.postDataJSON();
        writes.push(payload);
        if (fail) { await route.fulfill({ status: 503, json: { error: "保存失敗の確認" } }); return; }
        if (payload.action === "deleteTransactions") {
          for (const id of payload.transactionIds) records.delete(id);
          await route.fulfill({ json: { deletedTransactionIds: payload.transactionIds } });
          return;
        }
        const id = payload.transactionId ?? "added";
        const saved = { ...transaction(id, {}), ...records.get(id), ...payload, id,
          actorName: payload.actorUserId === "a" ? "A" : "B" };
        records.set(id, saved);
        await route.fulfill({ json: { transaction: saved } });
      });
      try {
        await page.goto(origin);
        await assertTotals(page, ["+￥3,000", "−￥1,500", "+￥1,500"]);
        if (process.env.CAKE_LAYOUT_SCREENSHOTS) {
          await mkdir(".cake", { recursive: true });
          await page.screenshot({ path: `.cake/transaction-sort-summary-${width}.png`, fullPage: true });
        }
        assert.deepEqual(await rowIds(page), ["income", "small", "settled", "own", "partner"], "初期順はミリ秒までの日時降順で月外を除く");
        assert.equal(await page.getByRole("button", { name: /で絞り込み$/ }).count(), 11);
        assert.equal(await page.getByRole("button", { name: /で(昇順|降順)に並べ替え$/ }).count(), 0, "カラム名の操作をポップアップにまとめる");
        await assertSort(page);
        const small = page.locator('[data-transaction-id="small"]');
        if (width <= 768) await small.getByRole("button", { name: "店2の詳細を開く", exact: true }).click();
        await small.getByRole("checkbox", { name: "店2の明細を選択", exact: true }).check();

        const amountColumn = page.getByRole("button", { name: "金額（円）で絞り込み", exact: true });
        await amountColumn.focus();
        await page.keyboard.press("Enter");
        const amountDialog = page.getByRole("dialog", { name: "金額（円）で絞り込み", exact: true });
        const sortInput = amountDialog.getByRole("combobox", { name: "ソート順", exact: true });
        assert.equal(await sortInput.inputValue(), "none");
        assert.deepEqual(await sortInput.locator("option").allTextContents(), ["ソートなし", "昇順", "降順"]);
        if (process.env.CAKE_LAYOUT_SCREENSHOTS) {
          await page.screenshot({ path: `.cake/transaction-sort-summary-popup-${width}.png`, fullPage: true });
        }
        await sortInput.selectOption("asc");
        await amountDialog.getByRole("checkbox", { name: /^\+￥2,000/ }).uncheck();
        assert.deepEqual(await rowIds(page), ["income", "small", "settled", "own", "partner"], "適用前のソート・フィルタは一覧へ反映しない");
        await assertSort(page);
        await assertTotals(page, ["+￥3,000", "−￥1,500", "+￥1,500"]);
        await page.keyboard.press("Escape");
        await amountColumn.click();
        assert.equal(await sortInput.inputValue(), "none", "Escapeで未適用のソートを破棄する");
        assert.equal(await amountDialog.getByRole("checkbox", { name: /^\+￥2,000/ }).isChecked(), true, "Escapeで未適用のフィルタを破棄する");
        await sortInput.selectOption("asc");
        await amountDialog.getByRole("button", { name: "適用", exact: true }).click();
        assert.deepEqual(await rowIds(page), ["settled", "own", "small", "partner", "income"], "金額は支払いを負、収入を正として並べる");
        await assertSort(page, "金額（円）", "ascending");
        await amountColumn.click();
        assert.equal(await sortInput.inputValue(), "asc");
        await sortInput.selectOption("desc");
        await assertSort(page, "金額（円）", "ascending");
        await amountDialog.getByRole("button", { name: "フィルターを閉じる", exact: true }).click();
        await amountColumn.click();
        assert.equal(await sortInput.inputValue(), "asc", "閉じる操作でも未適用のソートを破棄する");
        await sortInput.selectOption("desc");
        await amountDialog.getByRole("button", { name: "適用", exact: true }).click();
        assert.deepEqual(await rowIds(page), ["income", "partner", "small", "own", "settled"]);
        await assertSort(page, "金額（円）", "descending");
        assert.equal(await small.getByRole("checkbox", { name: "店2の明細を選択", exact: true }).isChecked(), true);
        if (width <= 768) assert.equal(await small.getAttribute("data-expanded"), "true", "ソートで展開状態を失わない");
        await assertTotals(page, ["+￥3,000", "−￥1,500", "+￥1,500"]);
        assert.equal(writes.length, 0, "並べ替えは業務データを更新しない");

        await chooseFilter(page, "種別", /^支払い/);
        await chooseFilter(page, "方法", /^現金/);
        await assertSort(page, "金額（円）", "descending");
        assert.deepEqual(await rowIds(page), ["small", "settled"], "別列のフィルタ変更でソートを解除しない");
        await assertTotals(page, ["￥0", "−￥1,000", "−￥1,000"]);
        const amount = small.getByRole("spinbutton", { name: "金額（円）", exact: true });
        await amount.fill("999");
        await assertTotals(page, ["￥0", "−￥1,000", "−￥1,000"]);
        await chooseSort(page, "金額（円）", "asc");
        const feedback = page.locator('[data-feedback-for="small"]');
        await feedback.getByRole("alert").waitFor();
        await chooseFilter(page, "取引先", /^清算済み/);
        await assertTotals(page, ["￥0", "−￥700", "−￥700"]);
        assert.equal(await small.count(), 1, "保存失敗の条件外行を編集継続のために保持する");
        assert.equal(await amount.inputValue(), "999");
        assert.match(await feedback.textContent() ?? "", /編集中のため表示/);
        assert.equal(await small.getByRole("checkbox", { name: "店2の明細を選択", exact: true }).isChecked(), true);
        await chooseSort(page, "取引先", "asc");
        assert.equal(await amount.inputValue(), "999", "並べ替えても保存失敗の下書きを維持する");

        await page.getByRole("button", { name: "絞り込みをすべて解除", exact: true }).click();
        await assertSort(page, "取引先", "ascending");
        await assertTotals(page, ["+￥3,000", "−￥1,500", "+￥1,500"]);
        fail = false;
        await feedback.getByRole("button", { name: "再試行", exact: true }).click();
        await assertTotals(page, ["+￥3,000", "−￥2,199", "+￥801"]);
        await small.getByRole("checkbox", { name: "店2の明細を選択", exact: true }).uncheck();

        await page.getByRole("button", { name: "＋ 明細を追加", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "明細を追加", exact: true });
        await dialog.getByLabel("取引先", { exact: true }).fill("追加収入");
        await dialog.getByLabel("種別", { exact: true }).selectOption("RECEIPT");
        await dialog.getByLabel("金額（円）", { exact: true }).fill("250");
        await dialog.getByRole("button", { name: "追加する", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await assertTotals(page, ["+￥3,250", "−￥2,199", "+￥1,051"]);
        const added = page.locator('[data-transaction-id="added"]');
        await added.getByRole("checkbox", { name: "追加収入の明細を選択", exact: true }).check();
        page.once("dialog", dialog => { void dialog.accept(); });
        await page.getByRole("button", { name: "削除", exact: true }).click();
        await added.waitFor({ state: "detached" });
        await assertTotals(page, ["+￥3,000", "−￥2,199", "+￥801"]);

        records.set("small", { ...records.get("small")!, amountYen: 100 });
        await page.getByRole("button", { name: "更新", exact: true }).click();
        await assertTotals(page, ["+￥3,000", "−￥1,300", "+￥1,700"]);
        await assertSort(page, "取引先", "ascending");
        await page.getByRole("radio", { name: "未精算明細", exact: true }).click();
        await assertTotals(page, ["+￥2,000", "−￥1,000", "+￥1,000"]);
        assert.equal(await page.locator('[data-transaction-id="past"]').count(), 1);
        assert.equal(await page.locator('[data-transaction-id="partner"]').count(), 0);
        assert.equal(await page.locator('[data-transaction-id="settled"]').count(), 0);
        await page.getByRole("radio", { name: "月単位明細", exact: true }).click();
        await assertTotals(page, ["+￥3,000", "−￥1,300", "+￥1,700"]);
        await chooseFilter(page, "種別", /^収入/);
        await chooseFilter(page, "方法", /^現金/);
        await assertTotals(page, ["￥0", "￥0", "￥0"]);
        assert.deepEqual(await rowIds(page), []);
        assert.equal(await page.getByText("条件に一致する明細がありません。", { exact: true }).count(), 1);
        await page.getByRole("button", { name: "方法で絞り込み", exact: true }).click();
        const methodDialog = page.getByRole("dialog", { name: "方法で絞り込み", exact: true });
        await methodDialog.getByRole("combobox", { name: "ソート順", exact: true }).selectOption("desc");
        await methodDialog.getByRole("button", { name: "この列の絞り込みを解除", exact: true }).click();
        await assertSort(page, "取引先", "ascending");
        await assertTotals(page, ["+￥3,000", "￥0", "+￥3,000"]);
        await chooseSort(page, "取引先", "none");
        await assertSort(page);
        await page.getByRole("button", { name: "絞り込みをすべて解除", exact: true }).click();
        assert.deepEqual(await rowIds(page), ["income", "small", "settled", "own", "partner"], "ソート解除で取得時の日時降順へ戻る");
        await assertTotals(page, ["+￥3,000", "−￥1,300", "+￥1,700"]);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "合計と操作を画面幅に収める");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test("320pxで大きな合計額を収め、再表示でソートを初期化する", async () => {
      const context = await browser.newContext({ viewport: { width: 320, height: 1000 }, locale: "ja-JP" });
      try {
        const page = await context.newPage();
        await page.addInitScript(data => { window.sortSummaryInitial = data; }, {
          ...initial, transactions: initial.transactions.slice(0, 3).map(row => ({ ...row, amountYen: 2147483647 })),
        });
        await page.goto(origin);
        await assertTotals(page, ["+￥2,147,483,647", "−￥4,294,967,294", "−￥2,147,483,647"]);
        const summary = page.getByRole("group", { name: "フィルタ結果の収支", exact: true });
        for (const cell of await summary.locator("dd").all()) {
          const box = await cell.boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= 321);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await chooseSort(page, "金額（円）", "asc");
        await page.reload();
        await assertTotals(page, ["+￥2,147,483,647", "−￥4,294,967,294", "−￥2,147,483,647"]);
        await assertSort(page);
      } finally { await context.close(); }
    });
    for (const width of [1280, 390]) for (const filtered of [false, true]) {
      await t.test(`${width}px・保存応答で候補が変わってもソートだけの適用で${filtered ? "既存の金額条件を解除しない" : "金額条件を追加しない"}`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
        const page = await context.newPage();
        page.setDefaultTimeout(7000);
        const transactions = initial.transactions.filter(row => row.id === "small" || row.id === "settled");
        if (filtered) transactions.push(transaction("extra", { merchant: "別の金額", amountYen: 500, occurredAt: "2026-10-18T00:00:00.000Z" }));
        await page.addInitScript(data => { window.sortSummaryInitial = data; }, { ...initial, transactions });
        const records = new Map(transactions.map(row => [row.id, row]));
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        let observeSave!: (route: Route) => void;
        const pendingSave = new Promise<Route>(resolve => { observeSave = resolve; });
        await page.route("**/api/**", async route => {
          if (route.request().method() === "GET") {
            await route.fulfill({ json: [...records.values()] });
          } else {
            observeSave(route);
          }
        });
        try {
          await page.goto(origin);
          await assertTotals(page, ["￥0", filtered ? "−￥1,500" : "−￥1,000", filtered ? "−￥1,500" : "−￥1,000"]);
          const edited = page.locator(`[data-transaction-id="${filtered ? "extra" : "small"}"]`);
          if (width <= 768) await edited.getByRole("button", { name: filtered ? "別の金額の詳細を開く" : "店2の詳細を開く", exact: true }).click();
          await edited.getByRole("spinbutton", { name: "金額（円）", exact: true }).fill(filtered ? "700" : "999");
          const requested = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/app");
          const amountColumn = page.getByRole("button", { name: "金額（円）で絞り込み", exact: true });
          await amountColumn.click();
          await requested;
          const route = await pendingSave;
          const dialog = page.getByRole("dialog", { name: "金額（円）で絞り込み", exact: true });
          await dialog.getByRole("checkbox", { name: /^−￥300/ }).waitFor();

          if (filtered) {
            // 500円の保存待ち中に300/700円の条件を確定し、元の条件を持つポップアップを開き直す。
            await dialog.getByRole("checkbox", { name: "候補の値をすべて選択", exact: true }).uncheck();
            await dialog.getByRole("checkbox", { name: /^−￥300/ }).check();
            await dialog.getByRole("checkbox", { name: /^−￥700/ }).check();
            await dialog.getByRole("button", { name: "適用", exact: true }).click();
            await assertTotals(page, ["￥0", "−￥1,000", "−￥1,000"]);
            await amountColumn.click();
            assert.equal(await dialog.getByRole("checkbox", { name: /^−￥500/ }).isChecked(), false);
          } else {
            assert.equal(await dialog.getByRole("checkbox", { name: /^−￥300/ }).isChecked(), true);
          }

          // ポップアップのマウントを確認した後で、自動保存の成功応答を返す。
          const payload = route.request().postDataJSON();
          const saved = { ...records.get(payload.transactionId)!, ...payload };
          records.set(saved.id, saved);
          await route.fulfill({ json: { transaction: saved } });
          if (filtered) {
            await dialog.getByRole("checkbox", { name: /^−￥500/ }).waitFor({ state: "detached" });
            await assertTotals(page, ["￥0", "−￥1,700", "−￥1,700"]);
          } else {
            await dialog.getByRole("checkbox", { name: /^−￥999/ }).waitFor();
            assert.equal(await dialog.getByRole("checkbox", { name: /^−￥999/ }).isChecked(), true, "全選択の未操作状態は新しい候補にも追従する");
          }
          assert.equal(await dialog.getByRole("checkbox", { name: "候補の値をすべて選択", exact: true }).isChecked(), true);
          await dialog.getByRole("combobox", { name: "ソート順", exact: true }).selectOption("asc");
          await dialog.getByRole("button", { name: "適用", exact: true }).click();
          await assertSort(page, "金額（円）", "ascending");
          assert.equal(await page.getByRole("button", { name: "金額（円）の絞り込みを解除", exact: true }).count(), filtered ? 1 : 0,
            "ソート順だけの適用は元の金額条件の有無を変更しない");
          await assertTotals(page, ["￥0", filtered ? "−￥1,700" : "−￥1,699", filtered ? "−￥1,700" : "−￥1,699"]);
          assert.equal((await rowIds(page)).length, filtered ? 3 : 2);
          if (filtered) {
            records.set("later", transaction("later", { merchant: "後から届いた500円", amountYen: 500 }));
            await page.getByRole("button", { name: "更新", exact: true }).click();
            await assertTotals(page, ["￥0", "−￥1,700", "−￥1,700"]);
            assert.equal(await page.locator('[data-transaction-id="later"]').count(), 0, "全候補が選択済みに見えても保存済みのsubsetを維持する");
          }
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }
  } finally {
    await browser.close();
    await new Promise<void>(done => server.close(() => done()));
  }
});

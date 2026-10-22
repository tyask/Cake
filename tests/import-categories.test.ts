import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Browser, type Locator } from "playwright";
import type { Category, WorkspaceData } from "../lib/types";
import { payPayExternalId } from "../lib/paypay-id";

const categories: Category[] = [
  { id: "food", parentId: null, name: "食費", colorHex: "#f97316", sortOrder: 0, archivedAt: null, revision: 1 },
  { id: "restaurant", parentId: "food", name: "外食", colorHex: "#fb923c", sortOrder: 0, archivedAt: null, revision: 1 },
  { id: "japanese", parentId: "restaurant", name: "和食", colorHex: "#fdba74", sortOrder: 0, archivedAt: null, revision: 1 },
  { id: "transport", parentId: null, name: "交通費", colorHex: "#3b82f6", sortOrder: 1, archivedAt: null, revision: 1 },
  { id: "archived", parentId: null, name: "以前のカテゴリ", colorHex: "#94a3b8", sortOrder: 2, archivedAt: "2026-01-01T00:00:00.000Z", revision: 1 },
];
function workspace(selectedCategories = categories): WorkspaceData {
  return {
    workspace: { id: "workspace", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
    members: [
      { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 6, role: "OWNER" },
      { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 4, role: "MEMBER" },
    ],
    categories: selectedCategories,
    rules: [{ id: "personal", merchantContains: "personal", expenseClass: "PERSONAL", sortOrder: 0, splitWeights: null, enabled: true }],
    transactions: [], settlement: null, settlementHistory: [],
  };
}
const merchants = ["first", "second", "unchecked", "personal", "unclassified", "invalid", "duplicate"];
const csv = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n" + merchants
  .map(merchant => `2026/10/18 12:00:42,${merchant === "invalid" ? 0 : 100},支払い,${merchant},PayPay,${merchant}`).join("\n");
type Request = { path: string; payload: Record<string, unknown> };
type ImportedItem = { merchant: string; categoryId: string | null; actorUserId: string; expenseClass: string; splitWeights: Record<string, number> };

async function openFixture(browser: Browser, origin: string, width: number, selected = workspace()) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: "block" });
  const page = await context.newPage(), requests: Request[] = [], errors: string[] = [];
  let saves = 0, releaseSave: (() => Promise<void>) | undefined;
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { errors.push("unexpected origin"); await route.abort(); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    assert.equal(route.request().method(), "POST");
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    requests.push({ path: url.pathname, payload });
    if (url.pathname === "/api/import/duplicates") {
      await route.fulfill({ json: { externalIds: [], transactions: [{
        externalId: payPayExternalId("2026-10-18T03:00:42.000Z", "duplicate"), merchant: "duplicate", amountYen: 100, source: "PAYPAY",
      }] } });
    } else if (url.pathname === "/api/app" && payload.action === "bulkImport") {
      if (++saves === 1) await route.fulfill({ status: 503, json: { error: "検証用のカテゴリ登録失敗" } });
      else releaseSave = () => route.fulfill({ json: { ok: true, imported: 5, skipped: 2 } });
    } else { errors.push("unexpected API"); await route.abort(); }
  });
  await page.addInitScript(data => { window.importWorkspace = data; }, selected);
  await page.goto(origin);
  await page.locator("input[type=file]").setInputFiles({ name: "categories.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "登録", exact: true }).waitFor();
  const row = (merchant: string) => page.locator("[data-import-key]").filter({ has: page.locator('td[data-label="取引先"] b', { hasText: new RegExp(`^${merchant}$`) }) });
  if (width < 700) for (const merchant of merchants) await row(merchant).getByRole("button", { name: `${merchant}の詳細を開く`, exact: true }).click();
  return { context, page, requests, errors, row, completeSave: async () => { assert.ok(releaseSave); await releaseSave(); } };
}

async function assertCategoryLine(row: Locator, width: number, color: string) {
  if (width >= 768) {
    assert.equal(await row.locator('[data-label="選択"]').evaluate(element => getComputedStyle(element).boxShadow), `${color} 4px 0px 0px 0px inset`);
  } else {
    const line = await row.evaluate(element => {
      const style = getComputedStyle(element, "::before");
      return { color: style.backgroundColor, width: style.width };
    });
    assert.deepEqual(line, { color, width: "4px" });
  }
}

test("CSVカテゴリはプレビュー内で個別・選択行へ設定し、全登録可能行の選択値を登録時だけ送る", async t => {
  const bundle = await build({ entryPoints: ["tests/fixtures/import-equal-split.tsx"], bundle: true, write: false,
    outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    const output = bundle.outputFiles.find(file => file.path.endsWith(req.url === "/bundle.css" ? "/bundle.css" : "/bundle.js"));
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : req.url === "/bundle.css" ? "text/css" : "text/html");
    res.end(req.url?.startsWith("/bundle.") ? output!.text : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  try {
    for (const [name, width] of [["PC", 1440], ["mobile", 390]] as const) {
      await t.test(`${name}: 階層・未分類・一括設定と登録失敗時の保持`, async () => {
        const { context, page, requests, errors, row, completeSave } = await openFixture(browser, origin, width);
        const category = (merchant: string) => row(merchant).getByLabel("カテゴリ", { exact: true });
        const checkbox = (merchant: string) => row(merchant).getByRole("checkbox", { name: `${merchant}を選択`, exact: true });
        const bulkCategory = page.getByLabel("選択行のカテゴリ", { exact: true });
        const applyCategory = page.getByRole("button", { name: "カテゴリを設定", exact: true });
        try {
          const options = ["未分類", "食費", "食費 › 外食", "食費 › 外食 › 和食", "交通費"];
          assert.deepEqual(await category("first").locator("option").allTextContents(), options);
          assert.deepEqual(await bulkCategory.locator("option").allTextContents(), options);
          for (const merchant of merchants) {
            assert.equal(await category(merchant).inputValue(), "");
            assert.equal(await checkbox(merchant).isChecked(), false);
          }
          assert.equal(await bulkCategory.inputValue(), "");
          assert.equal(await bulkCategory.isDisabled(), true);
          assert.equal(await applyCategory.isDisabled(), true);
          for (const merchant of ["invalid", "duplicate"]) assert.equal(await category(merchant).isDisabled(), true);

          await category("first").selectOption("japanese");
          await category("second").selectOption("restaurant");
          await category("unchecked").selectOption("transport");
          assert.equal(await checkbox("first").isChecked(), false, "個別編集では行選択を変えない");
          await assertCategoryLine(row("first"), width, "rgb(253, 186, 116)");
          if (width < 700) {
            await row("first").getByRole("button", { name: "firstの詳細を閉じる", exact: true }).click();
            assert.ok((await row("first").innerText()).includes("食費 › 外食 › 和食"), "要約でも全階層を確認できる");
            await row("first").getByRole("button", { name: "firstの詳細を開く", exact: true }).click();
          }
          await checkbox("first").check();
          await checkbox("second").check();
          await bulkCategory.selectOption("food");
          assert.equal(await category("first").inputValue(), "japanese", "一括欄の選択だけでは行を変えない");
          await applyCategory.click();
          await applyCategory.click();
          for (const merchant of ["first", "second"]) assert.equal(await category(merchant).inputValue(), "food");
          assert.equal(await category("unchecked").inputValue(), "transport", "未選択行には一括設定しない");
          await bulkCategory.selectOption("");
          await applyCategory.click();
          for (const merchant of ["first", "second"]) assert.equal(await category(merchant).inputValue(), "", "選択行を未分類に戻せる");
          await assertCategoryLine(row("first"), width, "rgba(0, 0, 0, 0)");
          await checkbox("second").uncheck();
          await checkbox("personal").check();
          await bulkCategory.selectOption("japanese");
          await applyCategory.click();
          await category("second").selectOption("food");
          const expectedCategories = ["japanese", "food", "transport", "japanese", "", "", ""];
          for (const [index, merchant] of merchants.entries()) assert.equal(await category(merchant).inputValue(), expectedCategories[index]);

          await row("first").getByLabel("firstの費用区分", { exact: true }).selectOption("PERSONAL");
          await row("first").getByLabel("firstの費用区分", { exact: true }).selectOption("SHARED");
          await row("first").getByLabel("Aの支払い割合", { exact: true }).fill("70");
          await page.locator(".import-summary select").selectOption("b");
          for (const [index, merchant] of merchants.entries()) assert.equal(await category(merchant).inputValue(), expectedCategories[index], "費用区分・割合・支払者の変更でカテゴリを保持する");
          assert.equal(await checkbox("first").isChecked(), true);
          assert.equal(await checkbox("personal").isChecked(), true);
          assert.equal(await checkbox("unchecked").isChecked(), false);
          assert.equal(requests.length, 1, "プレビュー編集はサーバーへ送信しない");
          assert.equal(requests[0].path, "/api/import/duplicates");
          assert.deepEqual(await page.evaluate(() => window.importWorkspace.categories), categories);

          await page.getByRole("button", { name: "登録", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "検証用のカテゴリ登録失敗" }).waitFor();
          assert.equal(await page.locator("[data-import-key]").count(), merchants.length);
          for (const [index, merchant] of merchants.entries()) assert.equal(await category(merchant).inputValue(), expectedCategories[index], "登録失敗時に入力を保持する");
          for (const merchant of ["first", "personal"]) assert.equal(await checkbox(merchant).isChecked(), true);
          assert.equal(await checkbox("second").isChecked(), false);
          assert.equal(await bulkCategory.inputValue(), "japanese");
          assert.equal(await applyCategory.isEnabled(), true);
          const payload = requests[1].payload, items = payload.items as ImportedItem[];
          assert.equal(payload.action, "bulkImport");
          assert.equal(payload.workspaceId, "workspace");
          assert.equal(payload.totalRows, merchants.length);
          assert.equal(payload.fileName, "categories.csv");
          assert.deepEqual(items.map(item => [item.merchant, item.categoryId]), [
            ["first", "japanese"], ["second", "food"], ["unchecked", "transport"], ["personal", "japanese"], ["unclassified", null],
          ], "登録はチェックにかかわらず登録可能行をすべて含む");
          assert.ok(items.every(item => item.actorUserId === "b"));
          assert.deepEqual(items[0].splitWeights, { a: 700, b: 300 });
          assert.deepEqual(items.find(item => item.merchant === "personal")!.splitWeights, { a: 0, b: 1 });

          await page.getByRole("button", { name: "登録", exact: true }).click();
          await page.getByRole("button", { name: "登録中…", exact: true }).waitFor();
          for (const merchant of merchants) assert.equal(await category(merchant).isDisabled(), true, "保存中はすべてのカテゴリを無効にする");
          assert.equal(await bulkCategory.isDisabled(), true);
          assert.equal(await applyCategory.isDisabled(), true);
          assert.equal(requests.length, 3);
          assert.deepEqual(requests[2], requests[1], "再試行は保持した値を送る");
          await completeSave();
          await page.getByRole("button", { name: "ファイルを選択", exact: true }).waitFor();
          assert.equal(await page.locator("[data-import-key]").count(), 0);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });

      await t.test(`${name}: カテゴリがなくても未分類を個別・一括で選択できる`, async () => {
        const { context, page, requests, errors, row } = await openFixture(browser, origin, width, workspace([]));
        try {
          const category = row("first").getByLabel("カテゴリ", { exact: true });
          const bulkCategory = page.getByLabel("選択行のカテゴリ", { exact: true });
          assert.deepEqual(await category.locator("option").allTextContents(), ["未分類"]);
          assert.equal(await category.isEnabled(), true);
          await category.selectOption("");
          await row("first").getByRole("checkbox", { name: "firstを選択", exact: true }).check();
          assert.equal(await bulkCategory.isEnabled(), true);
          assert.deepEqual(await bulkCategory.locator("option").allTextContents(), ["未分類"]);
          await bulkCategory.selectOption("");
          await page.getByRole("button", { name: "カテゴリを設定", exact: true }).click();
          assert.equal(requests.length, 1);
          await page.getByRole("button", { name: "登録", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "検証用のカテゴリ登録失敗" }).waitFor();
          assert.ok((requests[1].payload.items as ImportedItem[]).every(item => item.categoryId === null));
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }
  } finally { try { await browser.close(); } finally { await new Promise<void>(done => server.close(() => done())); } }
});

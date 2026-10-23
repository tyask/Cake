import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Browser, type Route } from "playwright";
import type { Category, WorkspaceData } from "../../lib/shared/types";
import { MAX_IMPORT_CATEGORY_SUGGESTION_MERCHANTS } from "../../lib/shared/import-category-suggestions";
import { payPayExternalId } from "../../lib/shared/paypay-id";

const categories: Category[] = [
  { id: "food", parentId: null, name: "食費", colorHex: "#f97316", sortOrder: 0, archivedAt: null, revision: 1 },
  { id: "transport", parentId: null, name: "交通費", colorHex: "#3b82f6", sortOrder: 1, archivedAt: null, revision: 1 },
  { id: "archived", parentId: null, name: "以前のカテゴリ", colorHex: "#94a3b8", sortOrder: 2, archivedAt: "2026-01-01T00:00:00.000Z", revision: 1 },
];
function workspace(): WorkspaceData {
  return {
    workspace: { id: "workspace", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
    members: [
      { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 6, role: "OWNER" },
      { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 4, role: "MEMBER" },
    ],
    categories,
    rules: [{ id: "personal", merchantContains: "personal", expenseClass: "PERSONAL", sortOrder: 0, splitWeights: null, enabled: true }],
    transactions: [], settlement: null, settlementHistory: [],
  };
}
const merchants = ["classified", "unchecked", "selected", "personal", "none", "archived", "gone", "invalid", "duplicate", "unchecked"];
const csv = (names = merchants) => "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n" + names
  .map((merchant, index) => `2026/10/18 12:00:42,${merchant === "invalid" ? 0 : 100},支払い,${merchant},PayPay,${merchant}-${index}`).join("\n");
const description = "未分類の明細について、最近の登録履歴に基づいてカテゴリを補完します";
type Request = { path: string; payload: Record<string, unknown> };
type ImportedItem = { merchant: string; categoryId: string | null; actorUserId: string; expenseClass: string; splitWeights: Record<string, number> };

async function openFixture(browser: Browser, origin: string, width: number, api: (route: Route, request: Request) => Promise<void>, source = csv(), shell = false) {
  const context = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 1000 }, isMobile: width < 700, hasTouch: width < 700, serviceWorkers: "block" });
  const page = await context.newPage(), requests: Request[] = [], errors: string[] = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { errors.push("unexpected origin"); await route.abort(); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    assert.equal(route.request().method(), "POST");
    const request = { path: url.pathname, payload: route.request().postDataJSON() as Record<string, unknown> };
    requests.push(request);
    if (url.pathname === "/api/import/duplicates") {
      await route.fulfill({ json: { externalIds: [], transactions: [{
        externalId: payPayExternalId("2026-10-18T03:00:42.000Z", "duplicate-8"), merchant: "duplicate", amountYen: 100, source: "PAYPAY",
      }] } });
    } else await api(route, request);
  });
  await page.addInitScript(selected => { window.importSuggestionWorkspace = selected; }, workspace());
  await page.goto(shell ? `${origin}/?shell=1` : origin);
  const upload = async (text: string) => {
    await page.locator("input[type=file]").setInputFiles({ name: "suggestions.csv", mimeType: "text/csv", buffer: Buffer.from(text) });
    await page.getByRole("button", { name: "確認して登録", exact: true }).waitFor();
  };
  await upload(source);
  const row = (merchant: string) => page.locator("[data-import-key]").filter({ has: page.locator('td[data-label="取引先"] b', { hasText: new RegExp(`^${merchant}$`) }) });
  if (width < 700) for (const merchant of [...new Set(merchants)]) {
    const rows = row(merchant);
    for (let index = 0; index < await rows.count(); index++) await rows.nth(index).getByRole("button", { name: `${merchant}の詳細を開く`, exact: true }).click();
  }
  return { context, page, requests, errors, row, upload };
}

test("CSVカテゴリ補完は明示実行し、未分類全行だけを一括反映して登録時に確定する", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/import-category-suggestions.tsx"], bundle: true, write: false,
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
      await t.test(`${name}: 短い説明・操作中無効化・選択状態と入力の保持・再試行・保存payload`, async () => {
        let releaseSuggestion: (() => Promise<void>) | undefined, saveAttempts = 0;
        const fixture = await openFixture(browser, origin, width, async (route, request) => {
          if (request.path === "/api/import/category-suggestions") {
            releaseSuggestion = () => route.fulfill({ json: { suggestions: (request.payload.merchants as string[]).map(merchant => ({
              merchant, categoryId: merchant === "none" ? null : merchant === "archived" ? "archived" : merchant === "gone" ? "gone" : "food",
            })) } });
          } else if (request.path === "/api/app") {
            await route.fulfill(++saveAttempts === 1 ? { status: 503, json: { error: "検証用の登録失敗" } } : { json: { ok: true, imported: 8, skipped: 2 } });
          } else { assert.fail(`unexpected API ${request.path}`); }
        });
        const { context, page, requests, errors, row } = fixture;
        const category = (merchant: string) => row(merchant).first().getByLabel("カテゴリ", { exact: true });
        const auto = () => page.getByRole("button", { name: "カテゴリ自動補完", exact: true });
        try {
          assert.equal(requests.length, 1, "CSV読込だけではカテゴリAPIを呼ばない");
          assert.equal(await page.getByRole("tooltip").count(), 0);
          const info = page.getByRole("button", { name: "カテゴリ自動補完の説明", exact: true });
          if (width >= 700) {
            await auto().hover();
            assert.equal(await page.getByRole("tooltip").innerText(), description);
            await page.getByRole("tooltip").hover();
            assert.equal(await page.getByRole("tooltip").isVisible(), true, "説明へマウスを移動しても表示を保持する");
            await page.getByRole("heading", { name: "明細を取込", exact: true }).hover();
            await page.getByRole("tooltip").waitFor({ state: "hidden" });
            await auto().focus();
            assert.equal(await page.getByRole("tooltip").innerText(), description);
            await page.keyboard.press("Escape");
            assert.equal(await page.getByRole("tooltip").count(), 0);
            await info.focus();
            await page.keyboard.press("Enter");
          } else await info.tap();
          assert.equal(await page.getByRole("tooltip").innerText(), description);
          const bounds = await page.getByRole("tooltip").boundingBox();
          assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, "説明が画面内に収まる");
          if (width < 700) {
            await info.tap(); assert.equal(await page.getByRole("tooltip").count(), 0);
            await info.tap();
            await page.getByRole("heading", { name: "明細を取込", exact: true }).tap();
          } else await page.getByRole("heading", { name: "明細を取込", exact: true }).click();
          assert.equal(await page.getByRole("tooltip").count(), 0);
          assert.equal(requests.length, 1, "説明の表示は補完を実行しない");

          await category("classified").selectOption("transport");
          await row("selected").getByRole("checkbox", { name: "selectedを選択", exact: true }).check();
          await row("unchecked").first().getByLabel("Aの支払い割合", { exact: true }).fill("70");
          await page.locator(".import-summary select").selectOption("b");
          if (width < 700) await auto().tap(); else await auto().click();
          await page.getByRole("button", { name: "カテゴリ補完中…", exact: true }).waitFor();
          if (width < 700) assert.equal(await page.getByRole("tooltip").count(), 0, "補完ボタンのタップでは説明を開かない");
          const pendingButton = page.getByRole("button", { name: "カテゴリ補完中…", exact: true });
          assert.equal(await pendingButton.isDisabled(), true);
          for (const label of ["確認して登録", "やり直す", "キャンセル", "個人費に変更", "共通費に変更", "削除", "カテゴリを設定"]) {
            assert.equal(await page.getByRole("button", { name: label, exact: true }).isDisabled(), true, label);
          }
          assert.equal(await page.locator(".import-summary select").isDisabled(), true);
          assert.equal(await category("unchecked").isDisabled(), true);
          assert.equal(await row("selected").getByRole("checkbox").isDisabled(), true);
          assert.ok(releaseSuggestion);
          assert.deepEqual(requests[1], { path: "/api/import/category-suggestions", payload: { workspaceId: "workspace", merchants: ["unchecked", "selected", "personal", "none", "archived", "gone"] } });
          await releaseSuggestion();
          await page.getByRole("status").filter({ hasText: "4件のカテゴリを補完しました。" }).waitFor();
          assert.equal(await category("classified").inputValue(), "transport");
          for (const merchant of ["unchecked", "selected", "personal"]) assert.equal(await category(merchant).inputValue(), "food");
          assert.deepEqual(await row("unchecked").getByLabel("カテゴリ", { exact: true }).evaluateAll(elements => elements.map(element => (element as HTMLSelectElement).value)), ["food", "food"]);
          for (const merchant of ["none", "archived", "gone", "invalid", "duplicate"]) assert.equal(await category(merchant).inputValue(), "");
          assert.equal(await row("selected").getByRole("checkbox").isChecked(), true);
          assert.equal(await row("unchecked").first().getByRole("checkbox").isChecked(), false);
          assert.equal(await row("unchecked").first().getByLabel("Aの支払い割合", { exact: true }).inputValue(), "70");
          assert.equal(requests.filter(request => request.path === "/api/app").length, 0, "補完はDBへ登録しない");
          await category("unchecked").selectOption("transport");
          await page.getByRole("button", { name: "確認して登録", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "検証用の登録失敗" }).waitFor();
          assert.equal(await category("unchecked").inputValue(), "transport");
          const payload = requests.at(-1)!.payload, items = payload.items as ImportedItem[];
          assert.equal(payload.action, "bulkImport");
          assert.deepEqual(items.map(item => [item.merchant, item.categoryId]), [
            ["classified", "transport"], ["unchecked", "transport"], ["selected", "food"], ["personal", "food"], ["none", null], ["archived", null], ["gone", null], ["unchecked", "food"],
          ]);
          assert.ok(items.every(item => item.actorUserId === "b"));
          assert.deepEqual(items[1].splitWeights, { a: 700, b: 300 });
          assert.deepEqual(items[3].splitWeights, { a: 0, b: 1 });
          assert.equal(items[3].expenseClass, "PERSONAL");
          await page.getByRole("button", { name: "確認して登録", exact: true }).click();
          await page.getByRole("button", { name: "ファイルを選択", exact: true }).waitFor();
          assert.deepEqual(requests.at(-1)!.payload, payload);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }

    await t.test("mobile: 即時応答後も補完ボタンのタップでは説明を開かない", async () => {
      const { context, page, errors, requests, row } = await openFixture(browser, origin, 390, async (route, request) => {
        assert.equal(request.path, "/api/import/category-suggestions");
        await route.fulfill({ json: { suggestions: (request.payload.merchants as string[]).map(merchant => ({ merchant, categoryId: merchant === "none" ? null : "food" })) } });
      }, csv(["unchecked", "unchecked", "none", "classified", "invalid"]), true);
      try {
        await row("classified").getByLabel("カテゴリ", { exact: true }).selectOption("transport");
        await row("none").getByRole("checkbox").check();
        const info = page.getByRole("button", { name: "カテゴリ自動補完の説明", exact: true });
        await info.tap();
        assert.equal(await page.getByRole("tooltip").innerText(), description);
        await page.screenshot();
        await page.getByRole("heading", { name: "明細を取込", exact: true }).tap();
        await page.getByRole("tooltip").waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "カテゴリ自動補完", exact: true }).tap();
        await page.getByRole("status").filter({ hasText: "2件のカテゴリを補完しました。" }).waitFor();
        assert.equal(await page.getByRole("tooltip").count(), 0);
        await info.tap();
        assert.equal(await page.getByRole("tooltip").innerText(), description);
        await page.getByRole("button", { name: "カテゴリ自動補完", exact: true }).tap();
        await page.getByRole("status").filter({ hasText: "補完できるカテゴリがありませんでした。" }).waitFor();
        assert.equal(await page.getByRole("tooltip").count(), 0, "説明を開いていても補完実行時に閉じる");
        assert.equal(requests.filter(request => request.path === "/api/import/category-suggestions").length, 2, "各タップにつき一度だけ補完する");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t.test("複数batchの失敗で一部を反映せず、入力を保持して再試行できる", async () => {
      const names = Array.from({ length: MAX_IMPORT_CATEGORY_SUGGESTION_MERCHANTS + 1 }, (_, index) => `shop${index}`);
      let attempts = 0;
      const { context, page, requests, errors } = await openFixture(browser, origin, 1440, async (route, request) => {
        assert.equal(request.path, "/api/import/category-suggestions");
        if (++attempts === 2) await route.fulfill({ status: 503, json: { error: "2バッチ目の補完失敗" } });
        else await route.fulfill({ json: { suggestions: (request.payload.merchants as string[]).map(merchant => ({ merchant, categoryId: "food" })) } });
      }, csv(names));
      try {
        await page.getByRole("button", { name: "カテゴリ自動補完", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "2バッチ目の補完失敗" }).waitFor();
        assert.ok((await page.locator('[data-import-key] select[aria-label="カテゴリ"]').evaluateAll(elements => elements.map(element => (element as HTMLSelectElement).value))).every(value => value === ""));
        const batches = requests.filter(request => request.path.endsWith("category-suggestions"));
        assert.deepEqual(batches.map(request => (request.payload.merchants as string[]).length), [MAX_IMPORT_CATEGORY_SUGGESTION_MERCHANTS, 1]);
        assert.equal(await page.getByRole("button", { name: "確認して登録", exact: true }).isEnabled(), true);
        await page.getByRole("button", { name: "カテゴリ自動補完", exact: true }).click();
        await page.getByRole("status").filter({ hasText: `${names.length}件のカテゴリを補完しました。` }).waitFor();
        assert.ok((await page.locator('[data-import-key] select[aria-label="カテゴリ"]').evaluateAll(elements => elements.map(element => (element as HTMLSelectElement).value))).every(value => value === "food"));
        assert.equal(await page.getByRole("button", { name: "カテゴリ自動補完", exact: true }).isDisabled(), true);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t.test("最新metadataで削除・停止カテゴリを除き、workspace切替・アンマウント後の応答を破棄する", async () => {
      let release: (() => Promise<void>) | undefined;
      const { context, page, errors, upload, row } = await openFixture(browser, origin, 1440, async (route, request) => {
        assert.equal(request.path, "/api/import/category-suggestions");
        release = () => route.fulfill({ json: { suggestions: (request.payload.merchants as string[]).map(merchant => ({ merchant, categoryId: merchant === "classified" ? "food" : "transport" })) } });
      }, csv(["classified", "unchecked"]));
      try {
        const auto = page.getByRole("button", { name: "カテゴリ自動補完", exact: true });
        await auto.click();
        await page.getByRole("button", { name: "カテゴリ補完中…", exact: true }).waitFor();
        const changed = workspace();
        changed.categories = categories.filter(category => category.id !== "food").map(category => ({ ...category, archivedAt: "2026-10-01T00:00:00.000Z" }));
        await page.evaluate(selected => window.updateImportSuggestionWorkspace(selected), changed);
        assert.ok(release); await release();
        await page.getByRole("status").filter({ hasText: "補完できるカテゴリがありませんでした。" }).waitFor();
        for (const merchant of ["classified", "unchecked"]) assert.equal(await row(merchant).getByLabel("カテゴリ", { exact: true }).inputValue(), "");

        await page.evaluate(selected => window.updateImportSuggestionWorkspace(selected), workspace());
        await auto.click();
        await page.getByRole("button", { name: "カテゴリ補完中…", exact: true }).waitFor();
        const next = workspace(); next.workspace = { ...next.workspace, id: "workspace-next", name: "別の家計" };
        await page.evaluate(selected => window.updateImportSuggestionWorkspace(selected), next);
        assert.ok(release); await release().catch(() => {});
        await page.getByRole("button", { name: "ファイルを選択", exact: true }).waitFor();
        await upload(csv(["unchecked"]));
        assert.equal(await row("unchecked").getByLabel("カテゴリ", { exact: true }).inputValue(), "");
        await page.getByRole("button", { name: "カテゴリ自動補完", exact: true }).click();
        await page.getByRole("button", { name: "カテゴリ補完中…", exact: true }).waitFor();
        await page.evaluate(() => window.unmountImportSuggestions());
        assert.ok(release); await release().catch(() => {});
        assert.equal(await page.locator("[data-import-key]").count(), 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { try { await browser.close(); } finally { await new Promise<void>(done => server.close(() => done())); } }
});

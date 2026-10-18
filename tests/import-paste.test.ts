import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Browser, type Route } from "playwright";
import type { WorkspaceData } from "../lib/types";

const workspace: WorkspaceData = {
  workspace: { id: "workspace", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
  members: [
    { id: "a", name: "本人", email: "a@example.test", imageUrl: null, weight: 6, role: "OWNER" },
    { id: "b", name: "相手", email: "b@example.test", imageUrl: null, weight: 4, role: "MEMBER" },
  ],
  rules: [{ id: "personal", merchantContains: "個人", expenseClass: "PERSONAL", sortOrder: 0, splitWeights: null, enabled: true }],
  transactions: [], settlement: null, settlementHistory: [],
};
const header = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号";
const csv = "\uFEFF" + header + "\r\n" + [
  '2026/10/18 12:00:42,"1,234",支払い,和食のお店,PayPay残高,00001234',
  "2026/10/18 12:01:43,650,支払い,個人カフェ,PayPayカード,00001235",
  "2026/10/18 12:02:44,990,支払い,保存済みのお店,PayPay,00001236",
  '2026/10/18 12:00:42,"1,234",支払い,和食のお店,PayPay残高,00001234',
  "2026/10/18 12:03:45,400,受け取り,受取の行,PayPay,00001238",
  "2026/10/18 12:04:46,222,支払い,除外するお店,PayPay,00001237",
].join("\r\n");
const duplicateResult = { externalIds: [], transactions: [{
  externalId: "PayPay_20261018120244_00001236", merchant: "保存済みのお店", amountYen: 990, source: "PAYPAY",
}] };
type Request = { path: string; payload: Record<string, unknown> };

async function openFixture(browser: Browser, origin: string, width: number, api: (route: Route, request: Request) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: "block" });
  const page = await context.newPage(), requests: Request[] = [], errors: string[] = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { errors.push("unexpected origin"); await route.abort(); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    const request = { path: url.pathname, payload: route.request().postDataJSON() as Record<string, unknown> };
    requests.push(request);
    await api(route, request);
  });
  await page.addInitScript(selected => {
    window.importPasteWorkspace = selected;
    window.importPasteClipboardReads = 0;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText() {
      window.importPasteClipboardReads += 1;
      return Promise.reject(new Error("クリップボードの自動読み取りは禁止"));
    } } });
  }, workspace);
  await page.goto(origin);
  return { page, requests, errors, context };
}

test("CSV貼り付けは確認時だけ重複照会し、選択した構造化明細だけを登録する", async t => {
  const bundle = await build({ entryPoints: ["tests/fixtures/import-paste.tsx"], bundle: true, write: false,
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
      await t.test(`${name}: 貼り付け・確認・登録と失敗時の保持`, async () => {
        let releaseDuplicates: (() => Promise<void>) | undefined, releaseSave: (() => Promise<void>) | undefined, saves = 0;
        const fixture = await openFixture(browser, origin, width, async (route, request) => {
          if (request.path === "/api/import/duplicates") releaseDuplicates = () => route.fulfill({ json: duplicateResult });
          else if (request.path === "/api/app" && request.payload.action === "bulkImport") {
            if (++saves === 1) await route.fulfill({ status: 500, json: { error: "検証用の登録失敗" } });
            else releaseSave = () => route.fulfill({ json: { ok: true, imported: 2, skipped: 3 } });
          } else { fixture.errors.push("unexpected API"); await route.abort(); }
        });
        const { page, requests, errors, context } = fixture;
        try {
          const draft = page.getByLabel("CSVの内容", { exact: true });
          await draft.fill(csv);
          assert.equal(requests.length, 0);
          await Promise.all([
            page.waitForRequest(request => new URL(request.url()).pathname === "/api/import/duplicates"),
            page.getByRole("button", { name: "内容を確認", exact: true }).click(),
          ]);
          await page.getByRole("status").waitFor();
          assert.equal(await draft.isDisabled(), true);
          assert.equal(await page.getByRole("button", { name: "内容を確認", exact: true }).isDisabled(), true);
          assert.equal(await page.getByRole("button", { name: "ファイルを選択", exact: true }).isDisabled(), true);
          assert.equal(await page.locator("input[type=file]").isDisabled(), true);
          assert.equal(requests.length, 1);
          assert.deepEqual(requests[0], { path: "/api/import/duplicates", payload: { workspaceId: "workspace", externalIds: [
            "PayPay_20261018120042_00001234", "PayPay_20261018120143_00001235", "PayPay_20261018120244_00001236", "PayPay_20261018120446_00001237",
          ] } });
          assert.ok(releaseDuplicates); await releaseDuplicates();
          await page.getByRole("button", { name: "選択した3件を登録", exact: true }).waitFor();
          assert.equal(await page.locator("[data-import-key]").count(), 5);
          assert.equal(await page.getByText("受取の行", { exact: true }).count(), 0);
          const row = (merchant: string) => page.locator("[data-import-key]").filter({ has: page.locator('td[data-label="取引先"] b', { hasText: new RegExp(`^${merchant}$`) }) });
          for (const merchant of ["和食のお店", "個人カフェ", "保存済みのお店", "除外するお店"]) {
            for (const item of await row(merchant).all()) if (width < 700) await item.getByRole("button", { name: /の詳細を開く$/ }).click();
          }
          assert.equal(await page.getByRole("combobox", { name: /^支払者/ }).inputValue(), "a");
          assert.equal(await row("和食のお店").first().getByLabel("本人の支払い割合", { exact: true }).inputValue(), "60");
          assert.equal(await row("個人カフェ").getByLabel("個人カフェの費用区分", { exact: true }).inputValue(), "PERSONAL");
          assert.equal(await row("個人カフェ").getByLabel("本人の支払い割合", { exact: true }).inputValue(), "100");
          assert.equal(await row("保存済みのお店").getByRole("checkbox", { name: "保存済みのお店を取り込む", exact: true }).isDisabled(), true);
          assert.equal(await row("和食のお店").last().getByRole("checkbox", { name: "和食のお店を取り込む", exact: true }).isDisabled(), true);
          assert.ok((await row("和食のお店").last().textContent())?.includes("CSV内で重複しています"));
          await row("除外するお店").getByRole("checkbox", { name: "除外するお店を取り込む", exact: true }).uncheck();
          assert.equal(requests.length, 1);
          await page.getByRole("button", { name: "選択した2件を登録", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "検証用の登録失敗" }).waitFor();
          assert.equal(await page.locator("[data-import-key]").count(), 5);
          assert.equal(await row("除外するお店").getByRole("checkbox", { name: "除外するお店を取り込む", exact: true }).isChecked(), false);
          assert.deepEqual(Object.keys(requests[1].payload).sort(), ["action", "fileName", "items", "totalRows", "workspaceId"]);
          assert.deepEqual(requests[1].payload, {
            action: "bulkImport", workspaceId: "workspace", fileName: "PayPay貼り付け.csv", totalRows: 5,
            items: [
              { occurredAt: "2026-10-18T03:00:42.000Z", merchant: "和食のお店", method: "PayPay残高", amountYen: 1234,
                externalId: "PayPay_20261018120042_00001234", expenseClass: "SHARED", actorUserId: "a", splitWeights: { a: 6, b: 4 } },
              { occurredAt: "2026-10-18T03:01:43.000Z", merchant: "個人カフェ", method: "PayPayカード", amountYen: 650,
                externalId: "PayPay_20261018120143_00001235", expenseClass: "PERSONAL", actorUserId: "a", splitWeights: { a: 1, b: 0 } },
            ],
          });
          await Promise.all([
            page.waitForRequest(request => new URL(request.url()).pathname === "/api/app"),
            page.getByRole("button", { name: "選択した2件を登録", exact: true }).click(),
          ]);
          await page.getByRole("button", { name: "登録中…", exact: true }).waitFor();
          await page.waitForFunction(() => document.querySelector(".sticky-actions .primary")?.hasAttribute("disabled"));
          assert.equal(requests.length, 3); assert.deepEqual(requests[2], requests[1]);
          assert.ok(releaseSave); await releaseSave();
          await draft.waitFor(); assert.equal(await draft.inputValue(), "");
          assert.equal(await page.evaluate(() => window.importPasteClipboardReads), 0);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });

      await t.test(`${name}: 入力不備・照会失敗からの再試行とファイル取込`, async () => {
        let checks = 0;
        const fixture = await openFixture(browser, origin, width, async route => {
          if (++checks === 1) await route.fulfill({ status: 500, json: { error: "検証用の照会失敗" } });
          else await route.fulfill({ json: duplicateResult });
        });
        const { page, requests, errors, context } = fixture;
        try {
          const draft = page.getByLabel("CSVの内容", { exact: true });
          for (const [text, message] of [
            [" \n ", "CSVの内容が空です"], ["https://example.test/export.csv", "必要な列がありません"],
            ["取引日,取引内容\n2026/10/18,支払い", "必要な列がありません"],
            [header + "\n2026/10/18 12:00:42,100,受け取り,受取,PayPay,00001", "取引内容が「支払い」の行がありません"],
          ]) {
            await draft.fill(text); await page.getByRole("button", { name: "内容を確認", exact: true }).click();
            await page.getByRole("alert").filter({ hasText: message }).waitFor();
            assert.equal(await draft.inputValue(), text);
            assert.equal(requests.length, 0);
          }
          await draft.fill(csv); await page.getByRole("button", { name: "内容を確認", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "検証用の照会失敗" }).waitFor();
          assert.equal(await draft.inputValue(), csv.replaceAll("\r\n", "\n"));
          assert.equal(requests.length, 1);
          await page.getByRole("button", { name: "内容を確認", exact: true }).click();
          await page.getByRole("button", { name: "選択した3件を登録", exact: true }).waitFor();
          await page.getByRole("button", { name: "キャンセル", exact: true }).click();
          assert.equal(await draft.inputValue(), csv.replaceAll("\r\n", "\n"));
          await page.locator("input[type=file]").setInputFiles({ name: "paypay-file.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
          await page.getByRole("button", { name: "選択した3件を登録", exact: true }).waitFor();
          assert.ok((await page.locator(".import-summary").textContent())?.includes("paypay-file.csv"));
          assert.equal(requests.length, 3);
          assert.ok(requests.every(request => request.path === "/api/import/duplicates" && Object.keys(request.payload).sort().join() === "externalIds,workspaceId"));
          assert.equal(await page.evaluate(() => window.importPasteClipboardReads), 0);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }

    await t.test("mobile: 家計を切り替えた後の古い重複照会結果を破棄する", async () => {
      let release: (() => Promise<void>) | undefined;
      const { page, requests, errors, context } = await openFixture(browser, origin, 390, async route => {
        release = () => route.fulfill({ json: duplicateResult });
      });
      try {
        await page.getByLabel("CSVの内容", { exact: true }).fill(csv);
        await page.getByRole("button", { name: "内容を確認", exact: true }).click();
        await page.getByRole("status").waitFor();
        await page.getByRole("button", { name: "家計を切り替える", exact: true }).click();
        await page.getByText("切替後の家計", { exact: true }).waitFor();
        assert.ok(release);
        const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/import/duplicates");
        await release(); await (await response).finished();
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        assert.equal(await page.locator("[data-import-key]").count(), 0);
        assert.equal(await page.getByLabel("CSVの内容", { exact: true }).inputValue(), "");
        assert.equal(await page.getByRole("button", { name: "内容を確認", exact: true }).isEnabled(), true);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].payload.workspaceId, "workspace");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { try { await browser.close(); } finally { await new Promise<void>(done => server.close(() => done())); } }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Browser, type Page, type Route } from "playwright";
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
const safariNote = "※Safariの確認が出たら「ペースト」を選んでください";
const macSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const iphoneSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
type Request = { path: string; payload: Record<string, unknown> };
type ClipboardSetup = { mode: Window["importPasteClipboardMode"]; text?: string };

async function openFixture(browser: Browser, origin: string, width: number, api: (route: Route, request: Request) => Promise<void>, clipboard: ClipboardSetup = { mode: "reject" }, userAgent?: string) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: "block", ...(userAgent ? { userAgent } : {}) });
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
  await page.addInitScript(({ selected, clipboard }) => {
    window.importPasteWorkspace = selected;
    window.importPasteClipboardReads = 0;
    window.importPasteClipboardWrites = [];
    window.importPasteClipboardWriteMode = "success";
    window.importPasteClipboardActivations = [];
    window.importPasteClipboardMode = clipboard.mode;
    window.importPasteClipboardText = clipboard.text ?? "";
    window.importPasteResolveClipboard = null;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard.mode === "unsupported" ? undefined : {
      readText() {
        window.importPasteClipboardReads += 1;
        window.importPasteClipboardActivations.push(navigator.userActivation.isActive);
        if (window.importPasteClipboardMode === "success") return Promise.resolve(window.importPasteClipboardText);
        if (window.importPasteClipboardMode === "pending") return new Promise<string>(resolve => { window.importPasteResolveClipboard = resolve; });
        return Promise.reject(new Error("内部のクリップボードエラーを画面へ表示しない"));
      },
      writeText(text: string) {
        window.importPasteClipboardWrites.push(text);
        return window.importPasteClipboardWriteMode === "success" ? Promise.resolve() : Promise.reject(new Error("内部のコピーエラーを画面へ表示しない"));
      },
    } });
  }, { selected: workspace, clipboard });
  await page.goto(origin);
  return { page, requests, errors, context };
}

async function assertNoManualInput(page: Page) {
  assert.equal(await page.locator("textarea").count(), 0);
  assert.equal(await page.getByLabel("CSVの内容", { exact: true }).count(), 0);
  for (const name of ["内容を確認", "手動で貼り付ける", "手動入力を閉じる"]) {
    assert.equal(await page.getByRole("button", { name, exact: true, includeHidden: true }).count(), 0);
  }
  assert.equal((await page.locator("body").textContent())?.includes(header), false);
}

async function assertBusyInputs(page: Page) {
  await assertNoManualInput(page);
  for (const name of ["貼り付け", "ファイルを選択", "ヘルプ"]) {
    assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true);
  }
  assert.equal(await page.locator("input[type=file]").isDisabled(), true);
  assert.equal(await page.locator(".import-format select").isDisabled(), true);
  await page.evaluate(text => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(".import-inputs button")) button.click();
    const transfer = new DataTransfer();
    transfer.items.add(new File([text], "busy-drop.csv", { type: "text/csv" }));
    document.querySelector(".upload-panel")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, csv);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

test("CSV貼り付けはユーザー操作で読み取り・重複照会し、選択した構造化明細だけを登録する", async t => {
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
    await t.test("Safariの確認注記はmacOS・iPhoneのSafariだけに表示する", async () => {
      const agents = [
        ["macOS Safari", macSafari, true, 1440],
        ["iPhone Safari", iphoneSafari, true, 390],
        ["desktop Chrome", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", false, 1440],
        ["iPhone Chrome", iphoneSafari.replace("Version/18.0", "CriOS/130.0.6723.90"), false, 390],
        ["iPhone Firefox", iphoneSafari.replace("Version/18.0", "FxiOS/131.0"), false, 390],
        ["iPhone Edge", iphoneSafari.replace("Version/18.0", "Version/18.0 EdgiOS/130.0.2849.68"), false, 390],
        ["iPhone Opera", iphoneSafari.replace("Version/18.0", "Version/18.0 OPiOS/3.2.5"), false, 390],
        ["Android Chrome", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", false, 390],
      ] as const;
      for (const [name, userAgent, showNote, width] of agents) {
        const { page, requests, errors, context } = await openFixture(browser, origin, width, route => route.abort(), { mode: "reject" }, userAgent);
        try {
          const paste = page.getByRole("button", { name: "貼り付け", exact: true });
          await paste.waitFor();
          const note = page.getByText(safariNote, { exact: true });
          if (showNote) await note.waitFor();
          else await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
          assert.equal(await note.count(), showNote ? 1 : 0, name);
          assert.equal(await paste.isEnabled(), true, name);
          assert.equal(await page.getByRole("button", { name: "ヘルプ", exact: true }).isEnabled(), true, name);
          assert.equal(await page.evaluate(() => window.importPasteClipboardReads), 0, name);
          assert.deepEqual(await page.evaluate(() => window.importPasteClipboardWrites), [], name);
          assert.equal(requests.length, 0, name);
          assert.deepEqual(errors, [], name);
        } finally { await context.close(); }
      }
    });

    for (const [name, width] of [["PC", 1440], ["mobile", 390]] as const) {
      await t.test(`${name}: ヘルプでショートカットの設定を確認し、閉じると元の操作へ戻る`, async () => {
        const { page, requests, errors, context } = await openFixture(browser, origin, width, route => route.abort(), { mode: "reject" }, width < 700 ? iphoneSafari : macSafari);
        try {
          await page.setViewportSize({ width, height: width < 700 ? 600 : 800 });
          await page.evaluate(() => history.replaceState({}, "", "/?tab=import&workspaceId=workspace&csv=synthetic-csv&auth=synthetic-auth#synthetic-fragment"));
          await assertNoManualInput(page);
          assert.equal(await page.getByRole("heading", { name: "クリップボードから貼り付け", exact: true }).count(), 1);
          const paste = page.getByRole("button", { name: "貼り付け", exact: true });
          await page.getByText(safariNote, { exact: true }).waitFor();
          assert.equal(await paste.evaluate(button => button.nextElementSibling?.textContent), safariNote);
          const help = page.getByRole("button", { name: "ヘルプ", exact: true });
          assert.equal(await help.getAttribute("aria-haspopup"), "dialog");
          await help.click();
          const dialog = page.getByRole("dialog", { name: "iPhoneでショートカットを設定", exact: true });
          await dialog.waitFor();
          const content = await dialog.innerText();
          assert.match(content, /入力からテキストを取得[\s\S]*クリップボードにコピー[\s\S]*URLを開く/);
          assert.match(content, /共有/);
          assert.match(content, /PayPay/);
          assert.equal(await dialog.getByText(`${origin}/?tab=import`, { exact: true }).count(), 1);
          assert.doesNotMatch(content, /synthetic-csv|synthetic-auth|synthetic-fragment|workspaceId=/);
          await assertNoManualInput(page);
          assert.equal(await page.evaluate(() => window.importPasteClipboardReads), 0);
          assert.deepEqual(await page.evaluate(() => window.importPasteClipboardWrites), []);
          const copy = dialog.getByRole("button", { name: "URLをコピー", exact: true });
          await copy.click();
          await page.waitForFunction(() => window.importPasteClipboardWrites.length === 1);
          assert.deepEqual(await page.evaluate(() => window.importPasteClipboardWrites), [`${origin}/?tab=import`]);
          if (width < 700) {
            await page.evaluate(() => { window.importPasteClipboardWriteMode = "reject"; });
            await copy.click();
            await dialog.getByText(/長押し/).waitFor();
            assert.equal(await dialog.isVisible(), true);
            assert.doesNotMatch(await dialog.innerText(), /内部のコピーエラー/);
            assert.deepEqual(await page.evaluate(() => window.importPasteClipboardWrites), [`${origin}/?tab=import`, `${origin}/?tab=import`]);
          }
          const layout = await dialog.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const scrolls = [element, ...element.querySelectorAll<HTMLElement>("*")]
              .filter(item => item.scrollHeight > item.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(item).overflowY))
              .map(item => {
                item.scrollTop = item.scrollHeight;
                return item.scrollTop;
              });
            return { left: rect.left, right: rect.right, width: innerWidth,
              dialogOverflow: element.scrollWidth - element.clientWidth,
              pageOverflow: document.documentElement.scrollWidth - innerWidth, scrolls };
          });
          assert.ok(layout.left >= 0 && layout.right <= layout.width);
          assert.ok(layout.dialogOverflow <= 1 && layout.pageOverflow <= 1);
          if (width < 700) assert.ok(layout.scrolls.some(top => top > 0));
          for (const close of ["Escape", "ヘルプを閉じる", "閉じる"]) {
            if (close === "Escape") await page.keyboard.press("Escape");
            else await dialog.getByRole("button", { name: close, exact: true }).click();
            await dialog.waitFor({ state: "hidden" });
            await page.waitForFunction(() => document.activeElement?.textContent === "ヘルプ");
            assert.equal(await help.evaluate(button => button === document.activeElement), true);
            if (close !== "閉じる") { await help.click(); await dialog.waitFor(); }
          }
          assert.equal(await page.evaluate(() => window.importPasteClipboardReads), 0);
          assert.deepEqual(await page.evaluate(() => window.importPasteClipboardWrites),
            Array.from({ length: width < 700 ? 2 : 1 }, () => `${origin}/?tab=import`));
          assert.equal(requests.length, 0);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });

      await t.test(`${name}: 貼り付け・登録と失敗時の保持`, async () => {
        let releaseDuplicates: (() => Promise<void>) | undefined, releaseSave: (() => Promise<void>) | undefined, saves = 0;
        const fixture = await openFixture(browser, origin, width, async (route, request) => {
          if (request.path === "/api/import/duplicates") releaseDuplicates = () => route.fulfill({ json: duplicateResult });
          else if (request.path === "/api/app" && request.payload.action === "bulkImport") {
            if (++saves === 1) await route.fulfill({ status: 500, json: { error: "検証用の登録失敗" } });
            else releaseSave = () => route.fulfill({ json: { ok: true, imported: 2, skipped: 3 } });
          } else { fixture.errors.push("unexpected API"); await route.abort(); }
        }, { mode: "success", text: csv });
        const { page, requests, errors, context } = fixture;
        try {
          await assertNoManualInput(page);
          assert.equal(await page.evaluate(() => window.importPasteClipboardReads), 0);
          assert.equal(requests.length, 0);
          await Promise.all([
            page.waitForRequest(request => new URL(request.url()).pathname === "/api/import/duplicates"),
            page.getByRole("button", { name: "貼り付け", exact: true }).click(),
          ]);
          await page.getByRole("status").waitFor();
          assert.deepEqual(await page.evaluate(() => window.importPasteClipboardActivations), [true]);
          await assertBusyInputs(page);
          assert.equal(await page.evaluate(() => window.importPasteClipboardReads), 1);
          assert.equal(requests.length, 1);
          assert.deepEqual(requests[0], { path: "/api/import/duplicates", payload: { workspaceId: "workspace", externalIds: [
            "PayPay_20261018120042_00001234", "PayPay_20261018120143_00001235", "PayPay_20261018120244_00001236", "PayPay_20261018120446_00001237",
          ] } });
          assert.ok(releaseDuplicates); await releaseDuplicates();
          await page.getByRole("button", { name: "選択した3件を登録", exact: true }).waitFor();
          await assertNoManualInput(page);
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
          await assertNoManualInput(page);
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
          await assertNoManualInput(page);
          await page.waitForFunction(() => document.querySelector(".sticky-actions .primary")?.hasAttribute("disabled"));
          assert.equal(requests.length, 3); assert.deepEqual(requests[2], requests[1]);
          assert.ok(releaseSave); await releaseSave();
          await page.getByRole("button", { name: "貼り付け", exact: true }).waitFor();
          await assertNoManualInput(page);
          assert.equal(await page.evaluate(() => window.importPasteClipboardReads), 1);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });

      await t.test(`${name}: 入力不備・照会失敗からの再試行とファイル取込`, async () => {
        let checks = 0;
        const fixture = await openFixture(browser, origin, width, async route => {
          if (++checks === 1) await route.fulfill({ status: 500, json: { error: "検証用の照会失敗" } });
          else await route.fulfill({ json: duplicateResult });
        }, { mode: "success" });
        const { page, requests, errors, context } = fixture;
        try {
          await assertNoManualInput(page);
          for (const [text, message] of [
            [" \n ", "CSVの内容が空です"], ["https://example.test/export.csv", "必要な列がありません"],
            ["取引日,取引内容\n2026/10/18,支払い", "必要な列がありません"],
            [header + "\n2026/10/18 12:00:42,100,受け取り,受取,PayPay,00001", "取引内容が「支払い」の行がありません"],
          ]) {
            await page.evaluate(text => { window.importPasteClipboardText = text; }, text);
            await page.getByRole("button", { name: "貼り付け", exact: true }).click();
            await page.getByRole("alert").filter({ hasText: message }).waitFor();
            await assertNoManualInput(page);
            assert.equal(requests.length, 0);
          }
          await page.evaluate(text => { window.importPasteClipboardText = text; }, csv);
          await page.getByRole("button", { name: "貼り付け", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "検証用の照会失敗" }).waitFor();
          await assertNoManualInput(page);
          assert.equal(requests.length, 1);
          await page.getByRole("button", { name: "貼り付け", exact: true }).click();
          await page.getByRole("button", { name: "選択した3件を登録", exact: true }).waitFor();
          await page.getByRole("button", { name: "キャンセル", exact: true }).click();
          await assertNoManualInput(page);
          await page.locator("input[type=file]").setInputFiles({ name: "paypay-file.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
          await page.getByRole("button", { name: "選択した3件を登録", exact: true }).waitFor();
          await assertNoManualInput(page);
          assert.ok((await page.locator(".import-summary").textContent())?.includes("paypay-file.csv"));
          assert.equal(requests.length, 3);
          assert.ok(requests.every(request => request.path === "/api/import/duplicates" && Object.keys(request.payload).sort().join() === "externalIds,workspaceId"));
          assert.equal(await page.evaluate(() => window.importPasteClipboardReads), 6);
          assert.deepEqual(await page.evaluate(() => window.importPasteClipboardActivations), [true, true, true, true, true, true]);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }

    await t.test("mobile: キャンセル・やり直す後は本文を表示せず、クリップボードやDropから読み直す", async () => {
      const { page, requests, errors, context } = await openFixture(browser, origin, 390,
        route => route.fulfill({ json: duplicateResult }), { mode: "success", text: csv });
      try {
        await page.getByRole("button", { name: "貼り付け", exact: true }).click();
        await page.getByRole("button", { name: "選択した3件を登録", exact: true }).waitFor();
        await page.getByRole("button", { name: "キャンセル", exact: true }).click();
        await assertNoManualInput(page);
        assert.equal(requests.length, 1);
        await page.evaluate(() => { window.importPasteClipboardText = "新しくコピーした不正なCSV"; });
        await page.getByRole("button", { name: "貼り付け", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "必要な列がありません" }).waitFor();
        await assertNoManualInput(page);
        assert.equal(requests.length, 1);
        await page.evaluate(text => { window.importPasteClipboardText = text; }, csv);
        await page.getByRole("button", { name: "貼り付け", exact: true }).click();
        await page.getByRole("button", { name: "選択した3件を登録", exact: true }).waitFor();
        assert.equal(requests.length, 2);
        await page.getByRole("button", { name: "やり直す", exact: true }).click();
        await assertNoManualInput(page);
        await page.evaluate(text => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([text], "paypay-drop.csv", { type: "text/csv" }));
          document.querySelector(".upload-panel")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        }, csv);
        await page.getByRole("button", { name: "選択した3件を登録", exact: true }).waitFor();
        await assertNoManualInput(page);
        assert.ok((await page.locator(".import-summary").textContent())?.includes("paypay-drop.csv"));
        assert.equal(requests.length, 3);
        assert.ok(requests.every(request => request.path === "/api/import/duplicates" && Object.keys(request.payload).sort().join() === "externalIds,workspaceId"));
        assert.equal(await page.evaluate(() => window.importPasteClipboardReads), 3);
        assert.deepEqual(await page.evaluate(() => window.importPasteClipboardActivations), [true, true, true]);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    for (const mode of ["reject", "unsupported"] as const) {
      await t.test(`mobile: クリップボード${mode === "reject" ? "拒否" : "未対応"}時は再試行とファイル選択へ案内する`, async () => {
        const { page, requests, errors, context } = await openFixture(browser, origin, 390, route => route.abort(), { mode });
        try {
          await assertNoManualInput(page);
          await page.getByRole("button", { name: "貼り付け", exact: true }).click();
          const alert = page.getByRole("alert");
          await alert.waitFor();
          assert.match(await alert.innerText(), /ファイルを選択/);
          assert.match(await alert.innerText(), /許可/);
          assert.doesNotMatch(await alert.innerText(), /内部のクリップボードエラー/);
          assert.doesNotMatch(await alert.innerText(), /手動|長押し|内容を確認/);
          await assertNoManualInput(page);
          assert.equal(await page.getByRole("button", { name: "貼り付け", exact: true }).isEnabled(), true);
          assert.equal(await page.getByRole("button", { name: "ファイルを選択", exact: true }).isEnabled(), true);
          assert.equal(await page.evaluate(() => window.importPasteClipboardReads), mode === "reject" ? 1 : 0);
          assert.equal(requests.length, 0);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }

    await t.test("mobile: クリップボード読込中は別入口を止め、家計切替後は取得本文と照会を破棄する", async () => {
      const { page, requests, errors, context } = await openFixture(browser, origin, 390, route => route.abort(), { mode: "pending" });
      try {
        await assertNoManualInput(page);
        await page.getByRole("button", { name: "貼り付け", exact: true }).click();
        await page.getByRole("status").waitFor();
        await assertBusyInputs(page);
        assert.equal(await page.evaluate(() => window.importPasteClipboardReads), 1);
        assert.equal(requests.length, 0);
        await page.getByRole("button", { name: "家計を切り替える", exact: true }).click();
        await page.getByText("切替後の家計", { exact: true }).waitFor();
        await page.evaluate(text => {
          if (!window.importPasteResolveClipboard) throw new Error("保留中のクリップボード読み取りがありません");
          window.importPasteResolveClipboard(text);
        }, csv);
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        assert.equal(await page.locator("[data-import-key]").count(), 0);
        await assertNoManualInput(page);
        assert.equal(await page.getByRole("button", { name: "貼り付け", exact: true }).isEnabled(), true);
        assert.equal(await page.getByRole("alert").count(), 0);
        assert.equal(requests.length, 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t.test("mobile: 家計を切り替えた後の古い重複照会結果を破棄する", async () => {
      let release: (() => Promise<void>) | undefined;
      const { page, requests, errors, context } = await openFixture(browser, origin, 390, async route => {
        release = () => route.fulfill({ json: duplicateResult });
      }, { mode: "success", text: csv });
      try {
        await assertNoManualInput(page);
        await page.getByRole("button", { name: "貼り付け", exact: true }).click();
        await page.getByRole("status").waitFor();
        await assertBusyInputs(page);
        await page.getByRole("button", { name: "家計を切り替える", exact: true }).click();
        await page.getByText("切替後の家計", { exact: true }).waitFor();
        assert.ok(release);
        const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/import/duplicates");
        await release(); await (await response).finished();
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        assert.equal(await page.locator("[data-import-key]").count(), 0);
        await assertNoManualInput(page);
        assert.equal(await page.getByRole("button", { name: "貼り付け", exact: true }).isEnabled(), true);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].payload.workspaceId, "workspace");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { try { await browser.close(); } finally { await new Promise<void>(done => server.close(() => done())); } }
});

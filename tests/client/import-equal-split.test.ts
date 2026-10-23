import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium } from "playwright";
import type { WorkspaceData } from "../../lib/shared/types";
import { payPayExternalId } from "../../lib/shared/paypay-id";

function workspace(memberCount = 2): WorkspaceData {
  return {
    workspace: { id: "workspace", name: "家計", type: "SHARED", ownerUserId: "a", memberCount },
    members: [
      { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 6, role: "OWNER" as const },
      { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 4, role: "MEMBER" as const },
    ].slice(0, memberCount),
    categories: [], rules: [{ id: "personal", merchantContains: "personal", expenseClass: "PERSONAL", sortOrder: 0, splitWeights: null, enabled: true }],
    transactions: [], settlement: null, settlementHistory: [],
  };
}
const csv = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n" +
  [["odd", 101], ["even", 100], ["unchecked", 103], ["personal", 99], ["invalid", 0], ["duplicate", 101]]
    .map(([name, amount]) => `2026/10/18 12:00:42,${amount},支払い,${name},現金,${name}`).join("\n");

test("割合の単位は共通の3択で、CSV取込と定期支払いの保存時に1:1を送る", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/import-equal-split.tsx"], bundle: true, write: false,
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
    for (const [name, width, memberCount] of [["PC", 1440, 2], ["mobile", 390, 2], ["一人", 1440, 1]] as const) {
      await t.test(name, async () => {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: "block" }), page = await context.newPage();
        const requests: { path: string; payload: Record<string, unknown> }[] = [], errors: string[] = [];
        let releaseSave: (() => Promise<void>) | undefined;
        page.setDefaultTimeout(10000);page.on("pageerror", error => errors.push(error.message));
        try {
          await page.route("**/*", async route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) { errors.push("unexpected origin"); await route.abort(); return; }
            if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
            const payload = route.request().postDataJSON();requests.push({ path: url.pathname, payload });
            if (url.pathname === "/api/import/duplicates") await route.fulfill({ json: { externalIds: [], transactions: [{
              externalId: payPayExternalId("2026-10-18T03:00:42.000Z", "duplicate"), merchant: "duplicate", amountYen: 101, source: "PAYPAY",
            }] } });
            else if (url.pathname === "/api/app" && payload.action === "bulkImport") releaseSave = () => route.fulfill({ json: { ok: true, imported: 4, skipped: 2 } });
            else { errors.push("unexpected API"); await route.abort(); }
          });
          await page.addInitScript(selected => { window.importWorkspace = selected; }, workspace(memberCount));
          await page.goto(origin);
          await page.locator("input[type=file]").setInputFiles({ name: "equal.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
          await page.getByRole("button", { name: "確認して登録", exact: true }).waitFor();
          const row = (merchant: string) => page.locator("[data-import-key]").filter({ has: page.locator('td[data-label="取引先"] b', { hasText: new RegExp(`^${merchant}$`) }) });
          for (const merchant of ["odd", "even", "unchecked", "personal", "invalid", "duplicate"]) {
            const item = row(merchant); if (width < 700) await item.getByRole("button", { name: /の詳細を開く$/ }).click();
          }
          const unit = (merchant: string) => row(merchant).getByLabel("支払い割合の単位", { exact: true });
          assert.deepEqual(await unit("odd").locator("option").allTextContents(), ["%", "円", "1:1"]);
          if (memberCount === 1) {
            assert.equal(await unit("odd").locator('option[value="EQUAL"]').isDisabled(), true);
            assert.equal(await row("odd").getByLabel("Aの支払い割合", { exact: true }).isDisabled(), true);
            assert.equal(requests.length, 1);assert.deepEqual(errors, []);return;
          }
          assert.equal(await row("odd").getByLabel("Aの支払い割合", { exact: true }).inputValue(), "60");
          await unit("odd").selectOption("EQUAL");assert.equal(await unit("odd").inputValue(), "RATIO");
          for (const person of ["A", "B"]) assert.equal(await row("odd").getByLabel(person + "の支払い割合", { exact: true }).inputValue(), "50");
          assert.ok((await row("odd").textContent())!.includes("￥51"));assert.ok((await row("odd").textContent())!.includes("￥50"));
          assert.equal(await row("even").getByLabel("Aの支払い割合", { exact: true }).inputValue(), "60");
          await unit("even").selectOption("AMOUNT");await unit("even").selectOption("EQUAL");
          await row("even").getByLabel("Aの支払い割合", { exact: true }).fill("70");
          assert.equal(await row("even").getByLabel("Bの支払い割合", { exact: true }).inputValue(), "30");
          await unit("even").selectOption("AMOUNT");await row("even").getByLabel("Aの支払い金額（円）", { exact: true }).fill("20");
          assert.equal(await row("even").getByLabel("Bの支払い金額（円）", { exact: true }).inputValue(), "80");await unit("even").selectOption("EQUAL");
          const checkbox = row("unchecked").getByRole("checkbox", { name: "uncheckedを選択", exact: true });
          assert.equal(await checkbox.isChecked(), false);
          await unit("unchecked").selectOption("EQUAL");assert.equal(await checkbox.isChecked(), false);
          for (const merchant of ["personal", "invalid", "duplicate"]) assert.equal(await unit(merchant).isDisabled(), true);
          assert.equal(requests.length, 1);assert.deepEqual(await page.evaluate(() => window.importWorkspace.members.map(m => m.weight)), [6, 4]);
          await page.getByRole("button", { name: "確認して登録", exact: true }).click();
          await page.waitForFunction(() => document.querySelector(".sticky-actions .primary")?.textContent === "登録中…");
          for (const merchant of ["odd", "even", "unchecked"]) assert.equal(await unit(merchant).isDisabled(), true);
          assert.equal(requests.length, 2);assert.ok(releaseSave);const payload = requests[1].payload;
          assert.equal(requests[1].path, "/api/app");assert.equal(payload.action, "bulkImport");
          const items = payload.items as { merchant: string; splitWeights: Record<string, number>; amountYen: number }[];
          assert.deepEqual(items.map(item => item.merchant), ["odd", "even", "unchecked", "personal"]);
          for (const merchant of ["odd", "even", "unchecked"]) assert.deepEqual(items.find(item => item.merchant === merchant)!.splitWeights, { a: 1, b: 1 });
          assert.deepEqual(items.find(item => item.merchant === "personal")!.splitWeights, { a: 1, b: 0 });
          assert.equal(items.find(item => item.merchant === "odd")!.amountYen, 101);
          await releaseSave();await page.getByRole("button", { name: "ファイルを選択", exact: true }).waitFor();assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }
    for (const [name, width] of [["定期支払いPC", 1440], ["定期支払いmobile", 390]] as const) {
      await t.test(name, async () => {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: "block" }), page = await context.newPage();
        const errors: string[] = [], writes: Record<string, unknown>[] = [];
        let payments: import("../../lib/shared/recurring-payment-types").RecurringPayment[] = [], releaseSave: (() => Promise<void>) | undefined;
        async function completeSave() {
          for (let i = 0; !releaseSave && i < 200; i++) await new Promise(done => setTimeout(done, 5));
          assert.ok(releaseSave);await releaseSave();releaseSave = undefined;
        }
        page.setDefaultTimeout(10000);page.on("pageerror", error => errors.push(error.message));
        try {
          await page.route("**/*", async route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) { errors.push("unexpected origin"); await route.abort(); return; }
            if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
            if (url.pathname !== "/api/recurring-payments") { errors.push("unexpected API"); await route.abort(); return; }
            if (route.request().method() === "GET") {
              await route.fulfill({ json: { payments, eligibleActorUserIds: ["a", "b"], today: "2026-10-18", now: "2026-10-18T03:00:00.000Z" } });return;
            }
            const payload = route.request().postDataJSON();writes.push(payload);
            const { action, paymentId, expectedRevision, workspaceId, ...currentConfig } = payload;
            assert.ok(action === "create" || action === "update");assert.equal(workspaceId, "workspace");
            if (action === "update") { assert.equal(paymentId, "recurring");assert.equal(expectedRevision, 1); }
            const payment = { id: "recurring", workspaceId, state: "ACTIVE" as const, revision: payments.length ? 2 : 1, authorizedById: "a", currentConfig, nextScheduledOn: "2026-11-18", blockedReason: null };
            releaseSave = async () => { payments = [payment];await route.fulfill({ json: { payment } }); };
          });
          await page.addInitScript(selected => { window.importWorkspace = selected; }, workspace());
          await page.goto(origin + "/?view=recurring");
          await page.locator("summary").click();
          await page.getByRole("button", { name: "＋ 定期支払いを追加", exact: true }).click();
          let dialog = page.getByRole("dialog", { name: "定期支払いを追加", exact: true });await dialog.waitFor();
          const unit = () => dialog.getByRole("combobox", { name: /支払い割合.*の単位/ });
          const assertThree = async () => assert.deepEqual(await unit().locator("option").allTextContents(), ["%", "円", "1:1"]);
          await assertThree();await dialog.getByLabel("取引先", { exact: true }).fill("定期家賃");await dialog.getByLabel("金額（円）", { exact: true }).fill("101");
          await unit().selectOption("EQUAL");assert.equal(await unit().inputValue(), "RATIO");
          for (const who of ["A", "B"]) assert.equal(await dialog.getByLabel(who + "の支払い割合", { exact: true }).inputValue(), "50");
          await dialog.getByLabel("取引先", { exact: true }).fill("変更後の定期家賃");assert.equal(await dialog.getByLabel("Aの支払い割合", { exact: true }).inputValue(), "50");
          assert.equal(writes.length, 0);
          await dialog.getByRole("combobox", { name: /^費用区分/ }).selectOption("PERSONAL");await assertThree();assert.equal(await unit().isDisabled(), true);
          await dialog.getByRole("combobox", { name: /^費用区分/ }).selectOption("SHARED");await unit().selectOption("AMOUNT");await unit().selectOption("EQUAL");
          await dialog.getByRole("button", { name: "追加する", exact: true }).click();await dialog.getByRole("button", { name: "保存中…", exact: true }).waitFor();
          assert.equal(await unit().isDisabled(), true);await assertThree();
          await completeSave();
          await dialog.waitFor({ state: "hidden" });assert.equal(writes.length, 1);assert.deepEqual(writes[0].splitWeights, { a: 1, b: 1 });assert.equal(writes[0].amountYen, 101);
          if (width < 700) await page.getByRole("button", { name: /の詳細を開く$/ }).click();
          await page.getByRole("button", { name: "編集", exact: true }).click();dialog = page.getByRole("dialog", { name: "定期支払いを編集", exact: true });await dialog.waitFor();await assertThree();
          await unit().selectOption("AMOUNT");await dialog.getByLabel("Aの支払い金額（円）", { exact: true }).fill("80");await unit().selectOption("EQUAL");
          assert.equal(await dialog.getByLabel("Aの支払い割合", { exact: true }).inputValue(), "50");assert.equal(writes.length, 1);
          await dialog.getByRole("button", { name: "変更を保存", exact: true }).click();
          await completeSave();
          await dialog.waitFor({ state: "hidden" });assert.equal(writes.length, 2);assert.deepEqual(writes[1].splitWeights, { a: 1, b: 1 });
          assert.deepEqual(await page.evaluate(() => window.importWorkspace.members.map(m => m.weight)), [6, 4]);assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }
  } finally { try { await browser.close(); } finally { await new Promise<void>(done => server.close(() => done())); } }
});

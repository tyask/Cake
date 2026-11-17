import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Page, type Route } from "playwright";

const foodCategory = "20000000-0000-4000-8000-000000000001";
const dailyCategory = "20000000-0000-4000-8000-000000000002";
const extraction = {
  date: "2026-11-16", time: "18:42", merchant: "ルール店", amountYen: 1234,
  memo: "牛乳・パン", categoryId: foodCategory, categorySuggestionFailed: false,
};

async function sourcePhoto(page: Page, width = 3000, height = 1000) {
  const base64 = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "black";
    context.font = "40px sans-serif";
    context.fillText("2026/11/16 18:42 TOTAL 1234", 40, 80);
    return canvas.toDataURL("image/png").split(",")[1];
  }, { width, height });
  return { name: "receipt.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

test("写真入力は確認前に保存せず、補完・再試行・家計切替を安全に扱う", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/photo-transaction.tsx"], bundle: true, write: false,
    outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((request, response) => {
    const asset = bundle.outputFiles.find(file => file.path.endsWith(request.url === "/bundle.css" ? "/bundle.css" : "/bundle.js"));
    response.setHeader("Content-Type", request.url === "/bundle.js" ? "application/javascript" : request.url === "/bundle.css" ? "text/css" : "text/html");
    response.end(request.url?.startsWith("/bundle.") ? asset!.text : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(resolve => server.close(() => resolve())); throw error; });

  try {
    for (const width of [1440, 390, 320]) await t.test(`${width}px: 撮影から補完・確認・保存`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage(), errors: string[] = [], writes: Record<string, unknown>[] = [];
      let photoRequest: Route | undefined;
      function currentPhotoRequest(): Route { assert.ok(photoRequest); return photoRequest; }
      let receivePhoto: ((route: Route) => void) | undefined;
      page.setDefaultTimeout(8000);
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/transactions/photo", route => { photoRequest = route; receivePhoto?.(route); });
      await page.route("**/api/app", async route => {
        writes.push(route.request().postDataJSON());
        await route.fulfill({ json: { ok: true } });
      });
      try {
        await page.goto(origin);
        const modal = page.getByRole("dialog", { name: "明細を追加", exact: true });
        const file = modal.getByLabel("明細の写真", { exact: true });
        assert.equal(await file.getAttribute("capture"), "environment");
        assert.equal(await file.getAttribute("accept"), "image/jpeg,image/png,image/webp");
        const chooser = page.waitForEvent("filechooser");
        await modal.getByRole("button", { name: "写真から入力", exact: true }).click();
        await (await chooser).setFiles([]);
        assert.equal(photoRequest, undefined, "撮影を取り消しても解析しない");
        await modal.getByLabel("取引方法", { exact: true }).fill("クレジットカード");
        await modal.getByLabel("支払者", { exact: true }).selectOption("b");
        const requestEvent = new Promise<Route>(resolve => { receivePhoto = resolve; });
        await file.setInputFiles(await sourcePhoto(page));
        await requestEvent;
        await modal.getByText("写真を解析しています…", { exact: true }).waitFor();
        assert.equal(await modal.getByLabel("取引先", { exact: true }).isDisabled(), true);
        assert.equal(await modal.getByLabel("取引日時", { exact: true }).isDisabled(), true);
        assert.equal(await modal.getByLabel("メモ", { exact: true }).isDisabled(), true);
        assert.equal(await modal.getByLabel("カテゴリ", { exact: true }).isDisabled(), true);
        assert.equal(await modal.getByRole("button", { name: "追加する", exact: true }).isDisabled(), true);
        assert.equal(await modal.getByRole("button", { name: /写真から入力|解析中/ }).first().isDisabled(), true);
        assert.equal(await modal.getByRole("button", { name: "キャンセル", exact: true }).isEnabled(), true);
        assert.equal(writes.length, 0);
        const request = currentPhotoRequest().request();
        const form = await new Request(origin, { method: "POST", headers: { "Content-Type": request.headers()["content-type"] }, body: new Blob([new Uint8Array(request.postDataBuffer()!)]) }).formData();
        assert.equal(form.get("workspaceId"), "10000000-0000-4000-8000-000000000001");
        const image = form.get("image") as File;
        assert.equal(image.type, "image/jpeg");
        assert.ok(image.size > 0 && image.size <= 3 * 1024 * 1024);
        const dimensions = await page.evaluate(async base64 => {
          const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
          const image = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
          const dimensions = { width: image.width, height: image.height };
          image.close();
          return dimensions;
        }, Buffer.from(await image.arrayBuffer()).toString("base64"));
        assert.equal(dimensions.width, 2048);
        assert.ok(dimensions.height >= 682 && dimensions.height <= 683);
        await currentPhotoRequest().fulfill({ json: extraction });
        await modal.getByLabel("取引先", { exact: true }).waitFor({ state: "visible" });
        await page.waitForFunction(() => (document.querySelector('input[aria-label="金額（円）"]') as HTMLInputElement)?.value === "1234");
        assert.equal(await modal.getByLabel("取引日時", { exact: true }).inputValue(), "2026-11-16T18:42");
        assert.equal(await modal.getByLabel("取引先", { exact: true }).inputValue(), "ルール店");
        assert.equal(await modal.getByLabel("メモ", { exact: true }).inputValue(), "牛乳・パン");
        assert.equal(await modal.getByLabel("カテゴリ", { exact: true }).inputValue(), foodCategory);
        assert.equal(await modal.getByLabel("Aの配分割合", { exact: true }).inputValue(), "75");
        assert.equal(await modal.getByLabel("取引方法", { exact: true }).inputValue(), "クレジットカード");
        assert.equal(await modal.getByLabel("支払者", { exact: true }).inputValue(), "b");
        assert.equal(writes.length, 0, "解析成功だけでは明細を登録しない");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        await modal.getByRole("button", { name: "追加する", exact: true }).click();
        await modal.waitFor({ state: "hidden" });
        assert.equal(writes.length, 1);
        assert.equal(writes[0].occurredAt, "2026-11-16T09:42:00.000Z");
        assert.equal(writes[0].merchant, "ルール店");
        assert.equal(writes[0].amountYen, 1234);
        assert.equal(writes[0].categoryId, foodCategory);
        assert.equal(writes[0].memo, "牛乳・パン");
        assert.equal(writes[0].method, "クレジットカード");
        assert.equal(writes[0].actorUserId, "b");
        assert.equal(writes[0].type, "PAYMENT");
        assert.deepEqual(writes[0].splitWeights, { a: 3, b: 1 });
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t.test("失敗後の再試行と部分読取りで手動カテゴリ・割合・入力を保持する", async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
      const page = await context.newPage();
      const errors: string[] = [];
      let nextResponse: unknown = { error: "写真を解析できませんでした。もう一度お試しください。" };
      let nextStatus = 503, reads = 0, writes = 0;
      page.setDefaultTimeout(8000);
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/transactions/photo", async route => { reads++; await route.fulfill({ status: nextStatus, json: nextResponse }); });
      await page.route("**/api/app", async route => { writes++; await route.fulfill({ json: { ok: true } }); });
      try {
        await page.goto(origin);
        const modal = page.getByRole("dialog", { name: "明細を追加", exact: true });
        const file = modal.getByLabel("明細の写真", { exact: true });
        await modal.getByLabel("取引日時", { exact: true }).fill("2026-11-01T10:25");
        await modal.getByLabel("取引先", { exact: true }).fill("手入力店");
        await modal.getByLabel("金額（円）", { exact: true }).fill("987");
        await modal.getByLabel("メモ", { exact: true }).fill("手入力メモ");
        await modal.getByLabel("カテゴリ", { exact: true }).selectOption(dailyCategory);
        await modal.getByLabel("Aの配分割合", { exact: true }).fill("40");
        const photo = await sourcePhoto(page, 600, 1000);
        await file.setInputFiles(photo);
        await modal.getByRole("alert").waitFor();
        assert.equal(await modal.getByLabel("取引先", { exact: true }).inputValue(), "手入力店");
        assert.equal(await modal.getByLabel("金額（円）", { exact: true }).inputValue(), "987");
        assert.equal(await modal.getByLabel("メモ", { exact: true }).inputValue(), "手入力メモ");
        nextStatus = 200;
        nextResponse = { ...extraction, time: null, amountYen: null, memo: null, categorySuggestionFailed: true };
        await file.setInputFiles(photo);
        await page.waitForFunction(() => (document.querySelector('input[type="datetime-local"]') as HTMLInputElement)?.value === "2026-11-16T10:25");
        assert.equal(await modal.getByLabel("取引先", { exact: true }).inputValue(), "ルール店");
        assert.equal(await modal.getByLabel("カテゴリ", { exact: true }).inputValue(), dailyCategory);
        assert.equal(await modal.getByLabel("Aの配分割合", { exact: true }).inputValue(), "40");
        assert.equal(await modal.getByLabel("金額（円）", { exact: true }).inputValue(), "987");
        assert.equal(await modal.getByLabel("メモ", { exact: true }).inputValue(), "手入力メモ");
        assert.match(await modal.textContent() ?? "", /時刻/);
        assert.match(await modal.textContent() ?? "", /カテゴリ/);
        await modal.getByLabel("カテゴリ", { exact: true }).selectOption("");
        nextResponse = extraction;
        await file.setInputFiles(photo);
        await page.waitForFunction(() => (document.querySelector('input[aria-label="金額（円）"]') as HTMLInputElement)?.value === "1234");
        assert.equal(await modal.getByLabel("カテゴリ", { exact: true }).inputValue(), "", "手動で未分類へ戻した選択も維持する");
        assert.equal(reads, 3);
        assert.equal(writes, 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t.test("再撮影では未調整のカテゴリを新しい取引先の候補へ更新する", async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
      const page = await context.newPage();
      let nextResponse: Record<string, unknown> = extraction;
      let reads = 0, writes = 0;
      page.setDefaultTimeout(8000);
      await page.route("**/api/transactions/photo", async route => { reads++; await route.fulfill({ json: nextResponse }); });
      await page.route("**/api/app", async route => { writes++; await route.fulfill({ json: { ok: true } }); });
      try {
        await page.goto(origin);
        const modal = page.getByRole("dialog", { name: "明細を追加", exact: true });
        const file = modal.getByLabel("明細の写真", { exact: true });
        const category = modal.getByLabel("カテゴリ", { exact: true });
        const photo = await sourcePhoto(page, 600, 1000);
        async function importPhoto(response: Record<string, unknown>, expectedCategory: string, marker: number) {
          nextResponse = { ...response, amountYen: marker };
          await file.setInputFiles(photo);
          await page.waitForFunction(marker => (document.querySelector('input[aria-label="金額（円）"]') as HTMLInputElement)?.value === String(marker), marker);
          assert.equal(await category.inputValue(), expectedCategory);
        }
        await importPhoto(extraction, foodCategory, 101);
        await importPhoto({ ...extraction, merchant: "別の店", categoryId: dailyCategory }, dailyCategory, 102);
        await importPhoto({ ...extraction, merchant: null, categoryId: null }, dailyCategory, 103);
        await importPhoto({ ...extraction, merchant: "履歴のない店", categoryId: null }, "", 104);
        assert.equal(reads, 4);
        assert.equal(writes, 0);
      } finally { await context.close(); }
    });

    await t.test("不正画像・閉じる・家計切替後の遅い応答をフォームへ反映しない", async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      let receivePhoto: ((route: Route) => void) | undefined;
      let reads = 0, writes = 0;
      const errors: string[] = [];
      page.setDefaultTimeout(8000);
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/transactions/photo", route => { reads++; receivePhoto?.(route); });
      await page.route("**/api/app", async route => { writes++; await route.fulfill({ json: { ok: true } }); });
      try {
        await page.goto(origin);
        let modal = page.getByRole("dialog", { name: "明細を追加", exact: true });
        await modal.getByLabel("取引先", { exact: true }).fill("保持する店");
        await modal.getByLabel("明細の写真", { exact: true }).setInputFiles({ name: "broken.jpg", mimeType: "image/jpeg", buffer: Buffer.from("invalid") });
        await modal.getByRole("alert").waitFor();
        assert.equal(reads, 0);
        assert.equal(await modal.getByLabel("取引先", { exact: true }).inputValue(), "保持する店");
        const photo = await sourcePhoto(page, 600, 1000);
        let request = new Promise<Route>(resolve => { receivePhoto = resolve; });
        await modal.getByLabel("明細の写真", { exact: true }).setInputFiles(photo);
        const closedRequest = await request;
        await modal.getByRole("button", { name: "キャンセル", exact: true }).click();
        await modal.waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "明細を開く", exact: true }).click();
        await closedRequest.fulfill({ json: extraction }).catch(() => {});
        modal = page.getByRole("dialog", { name: "明細を追加", exact: true });
        assert.equal(await modal.getByLabel("取引先", { exact: true }).inputValue(), "");
        request = new Promise<Route>(resolve => { receivePhoto = resolve; });
        await modal.getByLabel("明細の写真", { exact: true }).setInputFiles(photo);
        const switchedRequest = await request;
        await page.getByRole("button", { name: "家計を切り替える", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
        await modal.getByRole("button", { name: "写真から入力", exact: true }).waitFor();
        await switchedRequest.fulfill({ json: extraction }).catch(() => {});
        assert.equal(await modal.getByLabel("取引先", { exact: true }).inputValue(), "");
        assert.equal(await modal.getByLabel("金額（円）", { exact: true }).inputValue(), "");
        assert.equal(writes, 0);
        assert.equal(reads, 2);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

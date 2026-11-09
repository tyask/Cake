import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { build } from "esbuild";
import { chromium, webkit, type Locator } from "playwright";

async function assertMonth(input: Locator, month: string, label: string, nativeMonth: boolean) {
  const page = input.page();
  await page.waitForFunction(expected => document.querySelector("output")?.textContent === expected, month);
  assert.equal(await input.inputValue(), month, "入力値とReactの選択月を同期する");
  if (!nativeMonth) return;
  const visible = page.locator(".month-input-value");
  assert.equal(await visible.textContent(), label);
  const layout = await visible.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect(), frame = element.getBoundingClientRect();
    return {
      width: frame.width, height: frame.height,
      fits: element.scrollWidth <= element.clientWidth && text.left >= frame.left && text.right <= frame.right
        && text.top >= frame.top && text.bottom <= frame.bottom,
      weight: getComputedStyle(element).fontWeight,
    };
  });
  assert.equal(layout.height, 44, "年月の可視枠は44px高を保つ");
  assert.equal(layout.width, 98);
  assert.equal(layout.fits, true, "98pxの枠でも日本語の年月全体を表示する");
  assert.equal(layout.weight, "400", "親ラベルの太字を年月へ継承しない");
}

test("年月入力はChromiumとWebKitで44pxの枠・操作・値同期を保つ", async t => {
  const bundle = await build({ entryPoints: ["tests/client/fixtures/month-input.tsx"], bundle: true, write: false,
    outfile: "bundle.js", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const fonts = new Map<string, Buffer>(await Promise.all([400, 800].map(async weight => [
    `/fonts/cake-${weight}.woff2`, await readFile(new URL(`../../public/fonts/m-plus-rounded-1c/m-plus-rounded-1c-${weight}.woff2`, import.meta.url)),
  ] as const)));
  const fontCss = [400, 800].map(weight => `@font-face{font-family:"Cake fixture";src:url("/fonts/cake-${weight}.woff2") format("woff2");font-weight:${weight};font-style:normal;font-display:block;}`).join("")
    + ':root{--font-cake:"Cake fixture";}';
  const server = createServer((request, response) => {
    const font = fonts.get(request.url ?? "");
    if (font) { response.setHeader("Content-Type", "font/woff2"); response.end(font); return; }
    if (request.url === "/bundle.js" || request.url === "/bundle.css") {
      const extension = request.url.endsWith("css") ? "css" : "js";
      response.setHeader("Content-Type", extension === "css" ? "text/css" : "application/javascript");
      response.end(bundle.outputFiles.find(file => file.path.endsWith(`/bundle.${extension}`))!.text);
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><style>${fontCss}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const engine of [chromium, webkit]) {
      const override = engine === webkit ? process.env.CAKE_WEBKIT_EXECUTABLE : process.env.CAKE_BROWSER_EXECUTABLE;
      const available = engine !== webkit || existsSync(override ?? engine.executablePath());
      const required = Boolean(process.env.CI && process.env.CI !== "false");
      await t.test(engine.name(), { skip: !available && !required ? "ローカル環境にPlaywright WebKitが未導入。CIでは必須実行する" : false }, async t => {
        assert.equal(available, true, "CIにはPlaywright WebKitを用意する必要がある");
        // 起動失敗は実行環境の不備として失敗させ、skipへ置き換えない。
        const browser = await engine.launch({ headless: true, ...(override ? { executablePath: override } : {}) });
        try {
          for (const width of engine === webkit ? [390, 320, 1440] : [390, 320]) await t.test(`${width}px`, async () => {
            const mobile = width < 768;
            const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: mobile, hasTouch: mobile,
              reducedMotion: "reduce", serviceWorkers: "block" });
            const page = await context.newPage(), errors: string[] = [];
            page.setDefaultTimeout(10000);
            page.on("pageerror", error => errors.push(error.message));
            await page.route("**/*", async route => {
              if (new URL(route.request().url()).origin !== origin) { errors.push("unexpected origin"); await route.abort(); }
              else await route.continue();
            });
            try {
              await page.goto(origin);
              const input = page.getByRole("textbox", { name: "対象月", exact: true }), frame = page.locator(".month-input");
              await input.waitFor();
              await page.evaluate(async () => {
                await Promise.all([document.fonts.load('400 12px "Cake fixture"', "2026年11月"), document.fonts.load('800 16px "Cake fixture"')]);
                await document.fonts.ready;
              });
              const nativeMonth = await input.evaluate(element => (element as HTMLInputElement).type === "month");
              // LinuxのWebKitはUIKit実機ではない。mobileのmonth操作面とdesktopのtext fallbackを区別する。
              assert.equal(nativeMonth, mobile, "mobileはnative month、desktop WebKitは通常のtext入力を使う");
              await page.waitForFunction(expected => document.querySelector(".month-input")?.getAttribute("data-native-month") === String(expected), nativeMonth);
              assert.equal(await input.getAttribute("min"), "0001-06");
              assert.equal(await input.getAttribute("max"), "2026-11");
              const inputBounds = (await input.boundingBox())!, frameBounds = (await frame.boundingBox())!;
              assert.equal(frameBounds.height, 44, "可視枠は44px高を保つ");
              assert.deepEqual(inputBounds, frameBounds, "操作面が98px×44pxの可視枠全体を覆う");
              assert.equal(await input.evaluate(element => getComputedStyle(element).opacity), nativeMonth ? "0" : "1");
              assert.equal(await page.locator(".month-input-value").evaluate(element => getComputedStyle(element).visibility), nativeMonth ? "visible" : "hidden");
              await assertMonth(input, "2026-11", "2026年11月", nativeMonth);

              await page.getByTestId("month-label").click();
              assert.equal(await input.evaluate(element => element === document.activeElement), true, "ラベル操作で入力をfocusする");
              await input.click();
              assert.equal(await input.evaluate(element => element === document.activeElement), true, "可視枠の上からnative入力を操作できる");
              await page.getByRole("button", { name: "入力の前", exact: true }).focus();
              await page.keyboard.press("Tab");
              assert.equal(await input.evaluate(element => element === document.activeElement), true, "透明な操作面へキーボードでも移動できる");
              assert.equal(await frame.evaluate(element => {
                const style = getComputedStyle(element);
                return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
              }), true, "入力にfocusしたことが枠のoutlineから分かる");

              // OSのpickerダイアログ内部は操作せず、native inputへの入力とReactの反映を確認する。
              if (!nativeMonth) {
                await input.fill("2026-");
                await assertMonth(input, "2026-", "", false);
                await input.pressSequentially("09");
                await assertMonth(input, "2026-09", "", false);
              }
              await input.fill("2026-09");
              await assertMonth(input, "2026-09", "2026年9月", nativeMonth);
              for (const [button, month, label] of [["年末", "2025-12", "2025年12月"], ["年始", "2026-01", "2026年1月"], ["今月", "2026-11", "2026年11月"]]) {
                await page.getByRole("button", { name: button, exact: true }).click();
                await assertMonth(input, month, label, nativeMonth);
              }
              for (const [month, label, underflow, overflow] of [
                ["0001-06", "1年6月", false, false], ["0001-05", "1年5月", true, false],
                ["2026-12", "2026年12月", false, true], ["9999-12", "9999年12月", false, true],
              ] as const) {
                await input.fill(month);
                await assertMonth(input, month, label, nativeMonth);
                const validity = await input.evaluate(element => {
                  const { rangeUnderflow, rangeOverflow, valid } = (element as HTMLInputElement).validity;
                  return { rangeUnderflow, rangeOverflow, valid };
                });
                assert.deepEqual(validity, nativeMonth
                  ? { rangeUnderflow: underflow, rangeOverflow: overflow, valid: !underflow && !overflow }
                  : { rangeUnderflow: false, rangeOverflow: false, valid: true }, "native monthはmin/maxを検証し、未対応ブラウザは通常のtext入力を維持する");
              }
              assert.deepEqual(errors, []);
            } finally { await context.close(); }
          });
        } finally { await browser.close(); }
      });
    }
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

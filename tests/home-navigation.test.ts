import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium } from "playwright";
import { homeNavigation } from "../lib/home-navigation";

test("取込直リンクとworkspace選択を内部URLへ保持し、通常URLと未知のtabはhomeを表示する", () => {
  assert.deepEqual(homeNavigation({}), { initialTab: "home", workspaceId: undefined, redirectTo: "/" });
  assert.deepEqual(homeNavigation({ tab: "import", workspaceId: "workspace-a" }), {
    initialTab: "import", workspaceId: "workspace-a", redirectTo: "/?tab=import&workspaceId=workspace-a",
  });
  assert.equal(homeNavigation({ tab: "https://outside.example/" }).redirectTo, "/");
  assert.equal(homeNavigation({ tab: ["import", "home"], workspaceId: ["a", "b"] }).redirectTo, "/");
  const encoded = homeNavigation({ tab: "import", workspaceId: "a&tab=home#fragment" });
  const destination = new URL(encoded.redirectTo, "https://cake.example");
  assert.equal(destination.origin, "https://cake.example");
  assert.equal(destination.pathname, "/");
  assert.equal(destination.searchParams.get("tab"), "import");
  assert.equal(destination.searchParams.get("workspaceId"), "a&tab=home#fragment");
  assert.equal(destination.hash, "");
});

test("Google・テストログインとも取込先workspaceを保った内部URLへ復帰する", async t => {
  const bundle = await build({ entryPoints: ["tests/fixtures/login-navigation.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "login-fixture", setup(build) {
      build.onResolve({ filter: /^(next-auth\/react|next\/image)$/ }, args => ({ path: args.path, namespace: "login-fixture" }));
      build.onLoad({ filter: /.*/, namespace: "login-fixture" }, args => ({ contents: args.path === "next/image"
        ? "export default function Image() { return null; }"
        : "export async function signIn(provider, options) { window.signInRequests.push({ provider, ...options }); }" }));
    } }],
  });
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : "text/html");
    res.end(req.url === "/bundle.js" ? bundle.outputFiles[0].text : '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) })
    .catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  try {
    for (const testAuth of [false, true]) await t.test(testAuth ? "test-login" : "google", async () => {
      const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(`${origin}/?tab=import&workspaceId=workspace-a&redirectTo=https%3A%2F%2Foutside.example${testAuth ? "&testAuth=1" : ""}`);
        await page.getByRole("button").first().click();
        await page.waitForFunction(() => window.signInRequests.length === 1);
        const [request] = await page.evaluate(() => window.signInRequests);
        assert.equal(request.provider, testAuth ? "test-login" : "google");
        assert.equal(request.redirectTo, "/?tab=import&workspaceId=workspace-a");
        if (testAuth) assert.equal(typeof request.testUserKey, "string");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally {
    try { await browser.close(); } finally { await new Promise<void>(done => server.close(() => done())); }
  }
});

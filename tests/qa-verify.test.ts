import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Browser, BrowserContext, LaunchOptions, Route } from "playwright";
import { saveQaLease, type QaActionRequest, type QaPublicLease } from "../scripts/qa-client";
import { protectedQaRoute, QA_VERIFY_FAILURE, qaVerificationPath, runQaVerify } from "../scripts/qa-verify";
import { QA_NEON_PROJECT_ID } from "../lib/qa-pool";
import type { WorkflowExecutor } from "../scripts/task-workflow";

const sha = "a".repeat(40), mainSha = "b".repeat(40), branch = "codex/browser-smoke";
const leaseId = "00000000-0000-4000-8000-000000000001";
const uniqueUrl = "https://cake-unique-fumin1.vercel.app", fixedUrl = "https://cake-qa1-fumin.vercel.app";
const token = "PRIVATE_FAKE_OIDC_TOKEN", cookie = "PRIVATE_FAKE_COOKIE";
const config = JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true } } });
const blob = createHash("sha1").update(`blob ${Buffer.byteLength(config)}\0`).update(config).digest("hex");
const fresh = (): QaPublicLease => ({ slot: "qa1", state: "reserved", pr: 46, branch, headSha: sha, leaseId, version: 3,
  database: { projectId: QA_NEON_PROJECT_ID, branchId: "br-browser-test", endpointId: "ep-browser-test" },
  readyDeploymentId: "dpl_browser_test", deployments: [{ id: "dpl_browser_test", sha, phase: "application", url: uniqueUrl }] });

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-qa-verify-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const state = {
    lease: fresh(), statusReads: 0, currentSha: sha, browserTitle: "Cake", sessionStatus: 200, appStatus: 200,
    wrongUser: false, exception: "", routeException: false, shutdownException: false,
    afterBrowser: undefined as (() => void) | undefined, finalLease: undefined as QaPublicLease | undefined,
  };
  const events: string[] = [], logs: string[] = [], launches: LaunchOptions[] = [];
  const contexts: { options: Parameters<Browser["newContext"]>[0]; user?: string; origin?: string }[] = [];
  const apiRequests: { url: string; init?: RequestInit }[] = [];
  const tokenHeaders: Record<string, string>[] = [];
  const execute: WorkflowExecutor = async (command, args) => {
    let stdout: string;
    if (command === "git") {
      if (args[0] === "status") stdout = "";
      else if (args[0] === "show") stdout = config;
      else if (args[0] === "remote") stdout = "git@github.com:tyask/Cake.git";
      else if (args[1] === "--show-toplevel") stdout = cwd;
      else if (args[1] === "--abbrev-ref") stdout = branch;
      else if (args[1] === "HEAD") stdout = state.currentSha;
      else if (args[1]?.endsWith(":vercel.json")) stdout = blob;
      else throw new Error("Unexpected Git call");
    } else if (command === "gh" && args[0] === "pr") stdout = JSON.stringify([{ number: 46, url: "https://github.com/tyask/Cake/pull/46", headRefOid: state.currentSha, isDraft: true }]);
    else if (command === "gh" && args.at(-1) === "repos/tyask/Cake/branches/main") stdout = JSON.stringify({ name: "main", commit: { sha: mainSha } });
    else if (command === "gh" && args.at(-1) === `repos/tyask/Cake/contents/vercel.json?ref=${mainSha}`) stdout = JSON.stringify({ type: "file", path: "vercel.json", name: "vercel.json", encoding: "base64", size: Buffer.byteLength(config), sha: blob, content: Buffer.from(config).toString("base64") });
    else throw new Error("Unexpected command");
    return { status: 0, signal: null, stdout };
  };
  const launch = async (options: LaunchOptions): Promise<Browser> => {
    launches.push(options);
    if (state.exception) throw new Error(state.exception);
    let currentBrowserContexts = 0;
    const browser = {
      async newContext(options: Parameters<Browser["newContext"]>[0]) {
        currentBrowserContexts++;
        const id = contexts.length, record: typeof contexts[number] = { options };
        contexts.push(record);
        let handler: ((route: Route) => Promise<void>) | undefined;
        const routed = async (url: string) => {
          const route = {
            request: () => ({ url: () => url, headers: () => ({ cookie }) }),
            fetch: async ({ headers, maxRedirects }: { headers: Record<string, string>; maxRedirects: number }) => {
              assert.equal(maxRedirects, 0);
              tokenHeaders.push(headers);
              if (state.routeException) throw new Error(`${token} ${cookie} in a Playwright stack`);
              return {};
            }, fulfill: async () => {}, continue: async () => {}, abort: async () => {},
          } as unknown as Route;
          if (handler) await handler(route);
        };
        const locator = (kind: string, name?: string | RegExp): Record<string, unknown> => ({
          async waitFor() {
            if ([".app-shell", ".demo-banner"].includes(kind) && !record.user) throw new Error("No login");
          },
          async click() {
            const label = String(name);
            if (label.includes("テストユーザーA")) record.user = "test-user-a";
            if (label.includes("テストユーザーB")) record.user = "test-user-b";
            events.push(`${id}:click:${kind}`);
          },
          getByRole(_role: string, options: { name: string | RegExp }) { return locator(kind, options.name); },
        });
        const page = {
          setDefaultTimeout() {},
          async goto(url: string) { record.origin = url; await routed(url); return { status: () => 200 }; },
          url: () => record.origin!, title: async () => state.browserTitle,
          getByRole(role: string, options: { name: string | RegExp }) { return locator(role, options.name); },
          locator,
          async evaluate(fn: (arg: { origin: string; userId: string }) => Promise<unknown>, arg: { origin: string; userId: string }) {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = async (input, init) => {
              const url = String(input); apiRequests.push({ url, init }); await routed(url);
              const status = url.endsWith("/session") ? state.sessionStatus : state.appStatus;
              const id = state.wrongUser ? "test-user-wrong" : record.user;
              return new Response(JSON.stringify({ user: { id, email: "PRIVATE_APP_EMAIL" }, workspaces: [] }), { status });
            };
            try { return await fn(arg); } finally { globalThis.fetch = originalFetch; }
          },
        };
        return {
          async route(_pattern: string, next: (route: Route) => Promise<void>) { handler = next; },
          async newPage() { return page; },
          async unrouteAll(options: { behavior: string }) {
            assert.equal(options.behavior, "wait"); events.push(`${id}:unroute`);
            if (state.shutdownException) throw new Error(`${token} ${cookie} sensitive shutdown stack`);
          },
          async close() { events.push(`${id}:close`); },
        } as unknown as BrowserContext;
      },
      async close() { events.push("browser:close"); if (currentBrowserContexts) state.afterBrowser?.(); },
    };
    return browser as unknown as Browser;
  };
  const options = {
    cwd, execute, launch, environment: { VERCEL_OIDC_TOKEN: token, CAKE_BROWSER_EXECUTABLE: "/test/chromium",
      HTTPS_PROXY: "http://proxy.example:8080", NODE_EXTRA_CA_CERTS: "/test/ca.pem", GH_TOKEN: "PRIVATE_GH_TOKEN" },
    log: (message: string) => { logs.push(message); }, now: () => new Date("2026-10-14T12:00:00Z"),
    statusRequest: async () => {
      state.statusReads++;
      const payload = structuredClone(state.statusReads % 2 === 0 && state.finalLease ? state.finalLease : state.lease);
      return { protocol: "cake-qa-result/v1" as const, action: "status" as const, requestId: leaseId,
        status: "success" as const, payload, workflowUrl: "https://github.com/tyask/Cake/actions/runs/123" };
    },
  };
  return { cwd, options, state, logs, events, launches, contexts, apiRequests, tokenHeaders };
}

test("固有URLと固定URLのPC/mobile・A/B確認が同じ貸出で揃った場合だけReady用proofを作る", async t => {
  const f = await fixture(t);
  const unique = await runQaVerify({ ...f.options, args: ["--url", uniqueUrl] });
  assert.equal(unique.success, false);
  assert.equal(unique.uniqueVerified, true);
  f.state.lease.state = "published"; f.state.lease.aliasSha = sha;
  const fixed = await runQaVerify({ ...f.options, args: ["--url", `${fixedUrl}/`] });
  assert.equal(fixed.success, true);
  assert.equal(fixed.uniqueUrl, uniqueUrl); assert.equal(fixed.fixedUrl, fixedUrl);
  assert.equal(f.state.statusReads, 4);
  assert.deepEqual(f.contexts.map(c => c.user), ["test-user-a", "test-user-b", "test-user-a", "test-user-b", "test-user-a", "test-user-b", "test-user-a", "test-user-b"]);
  assert.deepEqual(f.contexts.map(c => c.options?.viewport?.width), [1440, 1440, 390, 390, 1440, 1440, 390, 390]);
  assert.ok(f.apiRequests.every(r => r.init?.method === "GET" && r.init.redirect === "error"));
  assert.equal(f.apiRequests.length, 16);
  assert.ok(f.tokenHeaders.every(headers => headers["x-vercel-trusted-oidc-idp-token"] === token));
  for (let id = 0; id < 8; id++) assert.ok(f.events.indexOf(`${id}:unroute`) < f.events.indexOf(`${id}:close`));
  const raw = await readFile(qaVerificationPath(f.cwd), "utf8");
  assert.deepEqual(JSON.parse(raw), fixed);
  assert.doesNotMatch(raw, /PRIVATE_|database|Cookie|headers/);
  assert.equal((await stat(qaVerificationPath(f.cwd))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.cwd, ".cake"))).mode & 0o777, 0o700);
  assert.ok(f.logs.every(message => !message.includes(token) && !message.includes(cookie)));
});

test("検証前後のstatus artifact取得案内をその場で転送しCloud adapterが各結果を取得できる", async t => {
  const f = await fixture(t), notices: string[] = [];
  const readStatus = f.options.statusRequest;
  await runQaVerify({ ...f.options, args: ["--url", uniqueUrl], statusRequest: async (request: QaActionRequest) => {
    const index = notices.length + 1;
    const requestId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const notice = `Cake: QA artifact ${200 + index} run ${100 + index} request ${requestId} name qa-result-${requestId}`;
    notices.push(notice);
    request.log?.(notice);
    // The adapter must observe the exact artifact before the status request
    // returns; a completion-only report cannot unblock its archive download.
    assert.equal(f.logs.at(-1), notice);
    if (index === 1) assert.equal(f.launches.length, 0);
    else assert.equal(f.events.at(-1), "browser:close");
    return readStatus();
  } });
  assert.equal(f.state.statusReads, 2);
  assert.deepEqual(f.logs.filter(message => message.startsWith("Cake: QA artifact ")), notices);
  assert.ok(f.logs.every(message => !message.includes(token) && !message.includes(cookie) && !message.includes("PRIVATE_")));
});

test("ブラウザはTLS検証・CA環境を維持し秘密情報を子プロセスへ渡さない", async t => {
  const f = await fixture(t);
  await runQaVerify({ ...f.options, args: ["--url", uniqueUrl] });
  assert.equal(f.launches[0].executablePath, "/test/chromium");
  assert.equal(f.launches[0].env?.NODE_EXTRA_CA_CERTS, "/test/ca.pem");
  assert.equal(f.launches[0].env?.VERCEL_OIDC_TOKEN, undefined);
  assert.equal(f.launches[0].env?.GH_TOKEN, undefined);
  assert.deepEqual(f.launches[0].proxy, { server: "http://proxy.example:8080" });
  assert.ok(f.contexts.every(c => c.options?.ignoreHTTPSErrors === false && c.options.serviceWorkers === "block"));
});

test("固定URLを確認しても固有URL未確認ならsuccessにしない", async t => {
  const f = await fixture(t); f.state.lease.state = "published"; f.state.lease.aliasSha = sha;
  const proof = await runQaVerify({ ...f.options, args: ["--url", fixedUrl] });
  assert.equal(proof.fixedVerified, true); assert.equal(proof.uniqueVerified, false); assert.equal(proof.success, false);
});

test("他のoriginや未公開の固定URLには認証情報を送信しない", async t => {
  for (const url of ["https://foreign.vercel.app", fixedUrl, `${uniqueUrl}/path`, `${uniqueUrl}?token=secret`, "https://user:secret@cake-unique-fumin1.vercel.app"]) {
    const f = await fixture(t);
    await assert.rejects(runQaVerify({ ...f.options, args: ["--url", url] }), { message: QA_VERIFY_FAILURE });
    assert.equal(f.launches.length, 0); assert.equal(f.tokenHeaders.length, 0);
  }
});

test("古いローカル貸出・古いSHA・削除中の貸出はブラウザ開始前に停止する", async t => {
  for (const change of ["lease", "sha", "deleting"] as const) {
    const f = await fixture(t);
    if (change === "deleting") { f.state.lease.state = "deleting"; delete f.state.lease.readyDeploymentId; }
    else {
      const cached = fresh();
      if (change === "lease") cached.leaseId = "00000000-0000-4000-8000-000000000099";
      else cached.headSha = "c".repeat(40);
      await saveQaLease(f.cwd, cached);
    }
    await assert.rejects(runQaVerify({ ...f.options, args: ["--url", uniqueUrl] }), { message: QA_VERIFY_FAILURE });
    assert.equal(f.launches.length, 0);
  }
});

test("検証中の貸出変更・Deployment変更・HEAD変更でproofを成功にしない", async t => {
  for (const change of ["lease", "deployment", "sha"] as const) {
    const f = await fixture(t);
    if (change === "sha") f.state.afterBrowser = () => { f.state.currentSha = "c".repeat(40); };
    else {
      f.state.finalLease = fresh();
      if (change === "lease") f.state.finalLease.leaseId = "00000000-0000-4000-8000-000000000099";
      else { f.state.finalLease.readyDeploymentId = "dpl_other"; f.state.finalLease.deployments[0].id = "dpl_other"; }
    }
    await assert.rejects(runQaVerify({ ...f.options, args: ["--url", uniqueUrl] }), { message: QA_VERIFY_FAILURE });
    assert.equal(JSON.parse(await readFile(qaVerificationPath(f.cwd), "utf8")).success, false);
    assert.equal(f.events.at(-1), "browser:close");
  }
});

test("別Deploymentの古いproofを同じ貸出の新しい検証へ引き継がない", async t => {
  const f = await fixture(t);
  const proof = await runQaVerify({ ...f.options, args: ["--url", uniqueUrl] });
  await writeFile(qaVerificationPath(f.cwd), JSON.stringify({ ...proof, uniqueVerified: true, fixedVerified: true, success: true, deploymentId: "dpl_old" }));
  f.state.lease.state = "published"; f.state.lease.aliasSha = sha;
  const next = await runQaVerify({ ...f.options, args: ["--url", fixedUrl] });
  assert.equal(next.fixedVerified, true); assert.equal(next.uniqueVerified, false); assert.equal(next.success, false);
});

test("認証・API・TLS失敗は個人データやCookieを表示せず終了して古い成功を無効化する", async t => {
  for (const change of ["api", "session", "user", "title", "route", "shutdown", "launch"] as const) {
    const f = await fixture(t);
    const proof = await runQaVerify({ ...f.options, args: ["--url", uniqueUrl] });
    await writeFile(qaVerificationPath(f.cwd), JSON.stringify({ ...proof, fixedVerified: true, success: true }));
    if (change === "api") f.state.appStatus = 401;
    if (change === "session") f.state.sessionStatus = 401;
    if (change === "user") f.state.wrongUser = true;
    if (change === "title") f.state.browserTitle = "Login – Vercel";
    if (change === "route") f.state.routeException = true;
    if (change === "shutdown") f.state.shutdownException = true;
    if (change === "launch") f.state.exception = `${token} ${cookie} sensitive Playwright stack`;
    await assert.rejects(runQaVerify({ ...f.options, args: ["--url", uniqueUrl] }), { message: QA_VERIFY_FAILURE });
    assert.equal(JSON.parse(await readFile(qaVerificationPath(f.cwd), "utf8")).success, false);
    assert.ok(f.logs.every(log => !/PRIVATE_|stack/.test(log)));
  }
});

test("TLS無効化やPlaywright debugログ設定では開始しない", async t => {
  for (const setting of [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { DEBUG: "pw:api" }, { PWDEBUG: "1" }, { VERCEL_OIDC_TOKEN: "" }]) {
    const f = await fixture(t);
    await assert.rejects(runQaVerify({ ...f.options, environment: { ...f.options.environment, ...setting }, args: ["--url", uniqueUrl] }), { message: QA_VERIFY_FAILURE });
    assert.equal(f.launches.length, 0); assert.equal(f.state.statusReads, 0);
  }
});

test("認証ヘッダーはexact originだけに追加しredirectや外部リクエストへ引き継がない", async () => {
  const calls: { kind: string; options?: Record<string, unknown> }[] = [];
  let failed = false;
  for (const url of [uniqueUrl, `${uniqueUrl}/api/app`, "https://foreign.vercel.app", "https://cake-unique-fumin1.vercel.app.evil.test"]) {
    const route = {
      request: () => ({ url: () => url, headers: () => ({ "X-Vercel-Trusted-Oidc-Idp-Token": "stale", cookie }) }),
      fetch: async (options: Record<string, unknown>) => { calls.push({ kind: "fetch", options }); return {}; },
      fulfill: async () => { calls.push({ kind: "fulfill" }); },
      continue: async (options: Record<string, unknown>) => { calls.push({ kind: "continue", options }); },
      abort: async () => { calls.push({ kind: "abort" }); },
    } as unknown as Route;
    await protectedQaRoute(uniqueUrl, token, () => { failed = true; })(route);
  }
  assert.equal(failed, false);
  assert.deepEqual(calls.map(call => call.kind), ["fetch", "fulfill", "fetch", "fulfill", "continue", "continue"]);
  for (const call of calls.filter(call => call.kind === "fetch")) {
    assert.equal(call.options?.maxRedirects, 0);
    assert.equal((call.options?.headers as Record<string, string>)["x-vercel-trusted-oidc-idp-token"], token);
  }
  for (const call of calls.filter(call => call.kind === "continue")) assert.ok(!Object.keys(call.options?.headers as object).some(key => key.toLowerCase() === "x-vercel-trusted-oidc-idp-token"));
});

test("非同期route失敗は機密の原例外を再throwせずabortする", async () => {
  let failed = false, aborted = false;
  const route = {
    request: () => ({ url: () => uniqueUrl, headers: () => ({ cookie }) }),
    fetch: async () => { throw new Error(`${token} ${cookie}`); },
    abort: async () => { aborted = true; throw new Error(`${token} shutdown`); },
  } as unknown as Route;
  await protectedQaRoute(uniqueUrl, token, () => { failed = true; })(route);
  assert.equal(failed, true); assert.equal(aborted, true);
});

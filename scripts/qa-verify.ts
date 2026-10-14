import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, LaunchOptions, Route } from "playwright";
import { qaAlias } from "../lib/qa-pool";
import { TEST_USERS } from "../lib/test-users";
import {
  parseQaPublicLease, qaLeaseRecordPath, requestQaAction, saveQaLease,
  type QaActionRequest, type QaActionResult, type QaPublicLease,
} from "./qa-client";
import {
  assertTaskGitGate, cleanTaskHead, executeWorkflowCommand, previewUrl, taskPullRequests,
  type WorkflowExecutor,
} from "./task-workflow";

export const QA_VERIFICATION_PROTOCOL = "cake-qa-verification/v1" as const;
export const QA_VERIFY_FAILURE = "QAの画面・API確認を完了できませんでした。認証・Actions・現在の貸出とコミットを確認してください。";
const OIDC_HEADER = "x-vercel-trusted-oidc-idp-token";
const TIMEOUT_MS = 30_000;
type VerificationIdentity = {
  pr: number; leaseId: string; sha: string; deploymentId: string; uniqueUrl: string; fixedUrl: string;
};
export type QaVerificationProof = VerificationIdentity & {
  protocol: typeof QA_VERIFICATION_PROTOCOL; uniqueVerified: boolean; fixedVerified: boolean;
  success: boolean; verifiedAt: string;
};
type VerifyOptions = {
  args?: readonly string[]; cwd?: string; execute?: WorkflowExecutor; log?: (message: string) => void;
  environment?: Readonly<Record<string, string | undefined>>; now?: () => Date;
  statusRequest?: (request: QaActionRequest) => Promise<QaActionResult>;
  launch?: (options: LaunchOptions) => Promise<Browser>;
};
const failure = () => new Error(QA_VERIFY_FAILURE);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sameIdentity = (value: Record<string, unknown>, identity: VerificationIdentity) =>
  Object.entries(identity).every(([key, expected]) => value[key] === expected);

export function qaVerificationPath(cwd: string): string { return resolve(cwd, ".cake/qa-verification.json"); }

function verificationIdentity(lease: QaPublicLease, sha: string): VerificationIdentity {
  if (!["reserved", "published"].includes(lease.state) || lease.headSha !== sha || !lease.database || !lease.readyDeploymentId) throw failure();
  const deployment = lease.deployments.find(entry => entry.id === lease.readyDeploymentId);
  if (!deployment || deployment.phase !== "application" || deployment.sha !== sha || !deployment.url) throw failure();
  const uniqueUrl = previewUrl(deployment.url), fixedUrl = `https://${qaAlias(lease.slot)}`;
  if (uniqueUrl === fixedUrl || deployment.url !== uniqueUrl) throw failure();
  return { pr: lease.pr, leaseId: lease.leaseId, sha, deploymentId: deployment.id, uniqueUrl, fixedUrl };
}

async function localLease(cwd: string): Promise<QaPublicLease | null> {
  let raw: string;
  try { raw = await readFile(qaLeaseRecordPath(cwd), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null; throw failure(); }
  if (Buffer.byteLength(raw) > 128_000) throw failure();
  try { return parseQaPublicLease(JSON.parse(raw)); } catch { throw failure(); }
}

async function previousProof(cwd: string, identity: VerificationIdentity): Promise<QaVerificationProof | null> {
  try {
    const raw = await readFile(qaVerificationPath(cwd), "utf8");
    if (Buffer.byteLength(raw) > 16_000) return null;
    const value: unknown = JSON.parse(raw);
    if (!object(value) || Object.keys(value).some(key => !["protocol", "pr", "leaseId", "sha", "deploymentId", "uniqueUrl", "fixedUrl",
      "uniqueVerified", "fixedVerified", "success", "verifiedAt"].includes(key))
      || value.protocol !== QA_VERIFICATION_PROTOCOL || !sameIdentity(value, identity)
      || typeof value.uniqueVerified !== "boolean" || typeof value.fixedVerified !== "boolean"
      || value.success !== (value.uniqueVerified && value.fixedVerified)
      || typeof value.verifiedAt !== "string" || !Number.isFinite(Date.parse(value.verifiedAt))) return null;
    return value as QaVerificationProof;
  } catch { return null; }
}

async function writeProof(cwd: string, proof: QaVerificationProof): Promise<void> {
  const path = qaVerificationPath(cwd);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await rm(temporary, { force: true }); }
}

function browserOptions(environment: Readonly<Record<string, string | undefined>>): LaunchOptions {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0" || environment.DEBUG || environment.PWDEBUG) throw failure();
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !/(?:TOKEN|SECRET|COOKIE|DATABASE_URL|DATABASE_HOST|API_KEY)/i.test(key)) inherited[key] = value;
  }
  const options: LaunchOptions = { headless: true, env: inherited };
  if (environment.CAKE_BROWSER_EXECUTABLE) options.executablePath = environment.CAKE_BROWSER_EXECUTABLE;
  const configuredProxy = environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy;
  if (configuredProxy) {
    let proxy: URL;
    try { proxy = new URL(configuredProxy); } catch { throw failure(); }
    if (!["http:", "https:"].includes(proxy.protocol) || proxy.pathname !== "/" || proxy.search || proxy.hash) throw failure();
    options.proxy = { server: proxy.origin };
    if (proxy.username) options.proxy.username = decodeURIComponent(proxy.username);
    if (proxy.password) options.proxy.password = decodeURIComponent(proxy.password);
  }
  return options;
}

/** route.fetch keeps TLS/CA validation enabled and never follows a credentialed redirect. */
export function protectedQaRoute(origin: string, token: string, failed: () => void): (route: Route) => Promise<void> {
  return async route => {
    try {
      const request = route.request(), headers = { ...request.headers() };
      for (const key of Object.keys(headers)) if (key.toLowerCase() === OIDC_HEADER) delete headers[key];
      if (new URL(request.url()).origin === origin) {
        headers[OIDC_HEADER] = token;
        const response = await route.fetch({ headers, maxRedirects: 0, timeout: TIMEOUT_MS });
        await route.fulfill({ response });
      } else { await route.continue({ headers }); }
    } catch {
      failed();
      // Playwright errors can include headers/Cookies. Do not throw them from an asynchronous handler.
      try { await route.abort("failed"); } catch { /* Context shutdown also fails closed. */ }
    }
  };
}

async function contextSmoke(context: BrowserContext, origin: string, user: typeof TEST_USERS[number], mobile: boolean): Promise<void> {
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  const response = await page.goto(origin, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  if (response?.status() !== 200 || new URL(page.url()).origin !== origin || await page.title() !== "Cake") throw failure();
  const login = page.getByRole("button", { name: new RegExp(user.name) });
  await login.waitFor({ state: "visible" });
  await login.click();
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await page.locator(".demo-banner").waitFor({ state: "visible" });
  if (new URL(page.url()).origin !== origin || await page.title() !== "Cake") throw failure();

  // Only booleans cross back to Node. Session/App responses contain private data and are never logged.
  const api = await page.evaluate(async ({ origin, userId }) => {
    try {
      const session = await fetch(new URL("/api/auth/session", origin), { method: "GET", credentials: "same-origin", redirect: "error" });
      const app = await fetch(new URL("/api/app", origin), { method: "GET", credentials: "same-origin", redirect: "error" });
      const sessionData = await session.json(), appData = await app.json();
      return { sessionOk: session.status === 200 && sessionData?.user?.id === userId,
        appOk: app.status === 200 && appData?.user?.id === userId && Array.isArray(appData.workspaces) };
    } catch { return { sessionOk: false, appOk: false }; }
  }, { origin, userId: user.id });
  if (!api?.sessionOk || !api.appOk) throw failure();
  const navigation = page.locator(mobile ? ".bottom-nav" : ".app-nav");
  await navigation.getByRole("button", { name: /設定/ }).click();
  await page.getByRole("heading", { name: "設定", exact: true }).waitFor({ state: "visible" });
  await navigation.getByRole("button", { name: /ホーム/ }).click();
  await page.locator(".app-shell").waitFor({ state: "visible" });
  if (new URL(page.url()).origin !== origin) throw failure();
}

async function browserSmoke(origin: string, token: string, options: LaunchOptions, launch: NonNullable<VerifyOptions["launch"]>): Promise<void> {
  let browser: Browser | undefined;
  try {
    browser = await launch(options);
    for (const mobile of [false, true]) for (const user of TEST_USERS) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        isMobile: mobile, hasTouch: mobile, ignoreHTTPSErrors: false, serviceWorkers: "block", acceptDownloads: false });
      let routeFailed = false;
      try {
        await context.route("**/*", protectedQaRoute(origin, token, () => { routeFailed = true; }));
        await contextSmoke(context, origin, user, mobile);
      } finally {
        try { await context.unrouteAll({ behavior: "wait" }); }
        finally { await context.close(); }
      }
      if (routeFailed) throw failure();
    }
  } finally { if (browser) await browser.close(); }
}

/** The verification result is bound to the authoritative lease both before and after browser work. */
export async function runQaVerify({
  args = [], cwd = process.cwd(), execute = executeWorkflowCommand, log = console.log,
  environment = process.env, now = () => new Date(), statusRequest = requestQaAction,
  launch = async options => (await import("playwright")).chromium.launch(options),
}: VerifyOptions = {}): Promise<QaVerificationProof> {
  // Never propagate provider/browser exceptions: callers must not accidentally dump a raw stack.
  try {
    if (args.length !== 2 || args[0] !== "--url") throw failure();
    const origin = previewUrl(args[1]), token = environment.VERCEL_OIDC_TOKEN;
    if (!token || /\s/.test(token) || token.length > 16_000) throw failure();
    const options = browserOptions(environment);
    const head = await cleanTaskHead(cwd, execute), mainSha = await assertTaskGitGate(head, execute);
    const requests = await taskPullRequests(head, execute), pr = requests[0];
    if (!pr || pr.headRefOid !== head.sha) throw failure();
    const cached = await localLease(head.cwd);
    if (cached && (cached.pr !== pr.number || cached.branch !== head.branch || cached.headSha !== head.sha)) throw failure();
    const request: QaActionRequest = { action: "status", head, mainSha, prNumber: pr.number,
      leaseId: cached?.leaseId, execute, log: () => {} };
    const receipt = await statusRequest(request);
    if (receipt.status !== "success" || !receipt.payload) throw failure();
    const lease = parseQaPublicLease(receipt.payload);
    if (lease.pr !== pr.number || lease.branch !== head.branch || cached && cached.leaseId !== lease.leaseId) throw failure();
    const identity = verificationIdentity(lease, head.sha), fixed = origin === identity.fixedUrl;
    if (origin !== identity.uniqueUrl && !fixed || fixed && (lease.state !== "published" || lease.aliasSha !== head.sha)) throw failure();
    await saveQaLease(head.cwd, lease);
    const previous = await previousProof(head.cwd, identity);
    const proof: QaVerificationProof = { ...identity, protocol: QA_VERIFICATION_PROTOCOL,
      uniqueVerified: fixed && previous?.uniqueVerified === true, fixedVerified: !fixed && previous?.fixedVerified === true,
      success: false, verifiedAt: now().toISOString() };
    // An unsuccessful rerun must invalidate an older complete proof for this deployment.
    await writeProof(head.cwd, proof);
    log("Cake: QAの画面・APIスモーク確認を開始します。");
    await browserSmoke(origin, token, options, launch);
    const current = await cleanTaskHead(head.cwd, execute);
    if (current.sha !== head.sha || current.branch !== head.branch) throw failure();
    const finalReceipt = await statusRequest({ ...request, leaseId: lease.leaseId });
    if (finalReceipt.status !== "success" || !finalReceipt.payload) throw failure();
    const latest = parseQaPublicLease(finalReceipt.payload);
    if (latest.pr !== pr.number || latest.branch !== head.branch || !sameIdentity(verificationIdentity(latest, head.sha), identity)
      || fixed && (latest.state !== "published" || latest.aliasSha !== head.sha)) throw failure();
    if (fixed) proof.fixedVerified = true; else proof.uniqueVerified = true;
    proof.success = proof.uniqueVerified && proof.fixedVerified;
    proof.verifiedAt = now().toISOString();
    await writeProof(head.cwd, proof);
    await saveQaLease(head.cwd, latest);
    log(proof.success ? "Cake: 同じ貸出・コミットの固有URLと固定QA URLでPC/mobile・A/Bログイン・画面・APIを確認しました。"
      : "Cake: このURLのPC/mobile・A/Bログイン・画面・APIを確認しました。もう一方のURLの確認後にReadyへ進めます。");
    return proof;
  } catch { throw failure(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fatal = () => { console.error(QA_VERIFY_FAILURE); process.exit(1); };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  void runQaVerify({ args: process.argv.slice(2) }).catch(() => { console.error(QA_VERIFY_FAILURE); process.exitCode = 1; });
}

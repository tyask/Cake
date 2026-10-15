import assert from "node:assert/strict";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import type { Browser, Route } from "playwright";
import { createCakeBrowserVerifier } from "../scripts/cannele-browser.mjs";
import { browserOptions, browserSmoke } from "../scripts/qa-verify";

const cwd = process.cwd();
const profile = { appId: "cake", instanceId: "10000000-0000-4000-8000-000000000001", repository: { fullName: "tyask/Cake" },
  vercelProjectId: "prj_Z37vquodhpRd08ZTAtYnP0qa59jD", vercelTeamId: "team_D1Mcx2TdFWPKcypfu8KzNMub", neonProjectId: "misty-meadow-88903426" };
const source = { cwd, branch: "codex/browser-flow", sourceSha: "a".repeat(40), prNumber: 91 };
const proof = { leaseId: "20000000-0000-4000-8000-000000000002", slot: "qa1", prNumber: 91, sourceSha: source.sourceSha,
  deploymentId: "dpl_Example123", database: { projectId: profile.neonProjectId, branchId: "br_preview", endpointId: "ep_preview" },
  databaseHostDigest: "c".repeat(64), productionHostDigest: "d".repeat(64), urlKind: "unique" as const,
  url: "https://cake-unique-fumin1.vercel.app", leaseVersion: 3, checkedAt: "2026-10-15T12:00:00.000Z" };
const cases = ["desktop-a", "desktop-b", "mobile-a", "mobile-b", "read-api"];
const oidc = "PRIVATE_FIXTURE_OIDC_TOKEN";

test("browser helper runs the existing actual four-case smoke and read API checks with in-memory OIDC", async () => {
  const contexts: Record<string, unknown>[] = []; const apiUsers: string[] = [];
  const headers: Record<string, string>[] = []; let closed = 0;
  const verify = createCakeBrowserVerifier({ browser: async () => ({ options: browserOptions, smoke: browserSmoke,
    launch: async options => {
      assert.equal(options.env?.VERCEL_OIDC_TOKEN, undefined); assert.equal(options.env?.GITHUB_TOKEN, undefined);
      assert.equal(options.env?.CANNELE_STATE_DIR, undefined); assert.equal(options.env?.AUTH_SECRET, undefined);
      return {
        async newContext(contextOptions: Record<string, unknown>) {
          contexts.push(contextOptions); let handler: ((route: Route) => Promise<void>) | undefined;
          const locator = () => ({ async waitFor() {}, async click() {}, getByRole: () => locator() });
          return { async route(_pattern: string, callback: (route: Route) => Promise<void>) { handler = callback; },
            async newPage() { return {
              setDefaultTimeout() {}, url: () => proof.url, title: async () => "Cake",
              async goto() { await handler?.({ request: () => ({ url: () => proof.url, headers: () => ({}) }),
                fetch: async (options: { headers: Record<string, string>; maxRedirects: number }) => { headers.push(options.headers); assert.equal(options.maxRedirects, 0); return {}; },
                fulfill: async () => {}, abort: async () => {}, continue: async () => {} } as unknown as Route); return { status: () => 200 }; },
              getByRole: () => locator(), locator: () => locator(),
              async evaluate(_callback: unknown, argument: { userId: string }) { apiUsers.push(argument.userId); return { sessionOk: true, appOk: true }; },
            }; }, async unrouteAll() {}, async close() { closed += 1; },
          };
        }, async close() { closed += 1; },
      } as unknown as Browser;
    },
  }) });
  assert.deepEqual(await verify(proof, { profile, cwd, source, environment: { VERCEL_OIDC_TOKEN: oidc,
    GITHUB_TOKEN: "PRIVATE_API_TOKEN", AUTH_SECRET: "PRIVATE_APP_SECRET", CANNELE_STATE_DIR: "/private/session" } }), { cases });
  assert.equal(contexts.length, 4); assert.equal(closed, 5);
  assert.deepEqual(apiUsers, ["test-user-a", "test-user-b", "test-user-a", "test-user-b"]);
  assert.ok(headers.every(value => value["x-vercel-trusted-oidc-idp-token"] === oidc));
});

test("missing OIDC uses the pinned SDK env-run child with exact project/scope and public private-mode handoff", async () => {
  let temporary = "";
  const verify = createCakeBrowserVerifier({ launcher: async () => ({ entry: "/pinned/vercel/dist/index.js", guardPath: "/pinned/vercel-guard.mjs" }),
    execute: async (command, args, options) => {
      assert.equal(command, process.execPath); assert.ok(args.includes("env") && args.includes("run"));
      assert.equal(args[args.indexOf("--project") + 1], profile.vercelProjectId);
      assert.equal(args[args.indexOf("--scope") + 1], profile.vercelTeamId);
      assert.equal(args[args.indexOf("--environment") + 1], "development");
      assert.equal(args[args.indexOf("--global-config") + 1], resolve(cwd, "../vercel-profile"));
      assert.ok(!args.some(value => /PRIVATE_|--token|env.*pull/.test(value)));
      for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "VERCEL_TOKEN", "AUTH_SECRET", "CAKE_TEST_DATABASE_URL", "CANNELE_STATE_DIR", "NODE_OPTIONS"]) assert.equal(options.environment[key], undefined);
      assert.equal(options.environment.HTTPS_PROXY, "http://proxy.example:8080");
      assert.equal(options.environment.NODE_EXTRA_CA_CERTS, "/public/ca.pem");
      const inputFile = args.at(-2)!, resultFile = args.at(-1)!; temporary = dirname(inputFile);
      assert.equal(options.cwd, temporary); assert.equal((await stat(temporary)).mode & 0o777, 0o700);
      assert.equal((await stat(inputFile)).mode & 0o777, 0o600);
      const contents = await readFile(inputFile, "utf8"); assert.doesNotMatch(contents, /PRIVATE_|postgresql|password|session/);
      const input = JSON.parse(contents) as { proof: typeof proof; profile: typeof profile };
      assert.equal(input.proof.url, proof.url); assert.equal(input.profile.vercelProjectId, profile.vercelProjectId);
      await writeFile(resultFile, JSON.stringify({ protocol: "cake-cannele-browser/v1", cases }), { mode: 0o600, flag: "wx" });
      return { status: 0 };
    },
  });
  assert.deepEqual(await verify({ ...proof, extraToken: "PRIVATE_API_TOKEN", database: { ...proof.database, password: "PRIVATE_DB_PASSWORD" } } as typeof proof,
    { profile, cwd, source, environment: { CANNELE_SOURCE_DIR: "/pinned/source", CANNELE_STATE_DIR: "/private/session", CANNELE_VERCEL_GLOBAL_CONFIG: "../vercel-profile",
      GITHUB_TOKEN: "PRIVATE_API_TOKEN", GH_TOKEN: "PRIVATE_GH_TOKEN", VERCEL_TOKEN: "PRIVATE_VERCEL_TOKEN", AUTH_SECRET: "PRIVATE_APP_SECRET",
      CAKE_TEST_DATABASE_URL: "postgresql://PRIVATE_DB_PASSWORD@private.invalid/db", NODE_OPTIONS: "--require /untrusted.js",
      HTTPS_PROXY: "http://proxy.example:8080", NODE_EXTRA_CA_CERTS: "/public/ca.pem" } }), { cases });
  await assert.rejects(stat(temporary), { code: "ENOENT" });
});

test("invalid target, source, fixed alias and unsafe debug/TLS settings stop before browser or SDK access", async () => {
  let calls = 0;
  const verify = createCakeBrowserVerifier({ launcher: async () => { calls += 1; throw new Error("PRIVATE_PROVIDER_ERROR"); } });
  for (const [candidate, options] of [
    [{ ...proof, url: "https://attacker.invalid" }, { profile, cwd, source }],
    [{ ...proof, url: `${proof.url}/api` }, { profile, cwd, source }],
    [{ ...proof, urlKind: "fixed", url: "https://cake-qa2-fumin.vercel.app", aliasId: "alias_example" }, { profile, cwd, source }],
    [proof, { profile, cwd, source: { ...source, sourceSha: "b".repeat(40) } }],
    [proof, { profile, cwd, source, environment: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } }],
    [proof, { profile, cwd, source, environment: { DEBUG: "*" } }],
  ] as const) {
    await assert.rejects(verify(candidate as typeof proof, options), error => {
      assert.doesNotMatch(String(error), /PRIVATE_|attacker|https|api/); return true;
    });
  }
  assert.equal(calls, 0);
});

test("failed SDK children and malformed success files never create browser evidence and remove handoff files", async () => {
  for (const mode of ["failure", "invalid", "permissions"]) {
    let temporary = "";
    const verify = createCakeBrowserVerifier({ launcher: async () => ({ entry: "/pinned/cli.js", guardPath: "/pinned/guard.mjs" }),
      execute: async (_command, args) => {
        temporary = dirname(args.at(-1)!);
        if (mode !== "failure") await writeFile(args.at(-1)!, mode === "invalid" ? "PRIVATE_RAW_BODY" : JSON.stringify({ protocol: "cake-cannele-browser/v1", cases }), { mode: 0o644 });
        if (mode === "permissions") await chmod(args.at(-1)!, 0o644);
        return { status: mode === "failure" ? 1 : 0 };
      },
    });
    await assert.rejects(verify(proof, { profile, cwd, source, environment: {} }), error => {
      assert.doesNotMatch(String(error), /PRIVATE_|cli\.js|raw|token/i); return true;
    });
    await assert.rejects(stat(temporary), { code: "ENOENT" });
  }
});

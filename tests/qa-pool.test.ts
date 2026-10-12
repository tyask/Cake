import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyLedger, parseLedger, transition, type Lease } from "../lib/qa-pool";
import { databaseConnectionString } from "../lib/database-environment";
import { buildSteps } from "../scripts/vercel-build";

const lease: Lease = { state: "held", token: "00000000-0000-4000-8000-000000000001", owner: "tyask", pr: 34, sourceSha: "a".repeat(40), reservedAt: "2026-10-12T00:00:00Z" };
const env = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "qa1", AUTH_MODE: "test", AUTH_SECRET: "test", CAKE_TEST_DATABASE_URL: "postgresql://user:private@ep-test-pooler.ap-southeast-1.aws.neon.tech/cake", CAKE_QA_DATABASE_HOST: "ep-test.ap-southeast-1.aws.neon.tech" };

test("貸出はPRと完全SHAを保持し、失敗・再予約で既存貸出を上書きできない", () => {
  const original = emptyLedger();
  const held = transition(original, "qa1", "reserve", lease);
  assert.equal(original.slots.qa1, null);
  assert.deepEqual(held.slots.qa1, lease);
  assert.throws(() => transition(held, "qa1", "reserve", { ...lease, pr: 35 }), /使用中/);
  assert.equal(held.slots.qa2, null);
});

test("返却は所有token・返却準備・同じPRの停止記録を必要とする", () => {
  const held = transition(emptyLedger(), "qa1", "reserve", lease);
  const report = "https://github.com/tyask/Cake/pull/34#issuecomment-123";
  assert.throws(() => transition(held, "qa1", "drain", { token: "other" }), /token/);
  assert.throws(() => transition(held, "qa1", "release", { token: lease.token, report }), /返却準備/);
  const draining = transition(held, "qa1", "drain", { token: lease.token });
  assert.throws(() => transition(draining, "qa1", "reserve", lease), /使用中/);
  for (const invalid of [undefined, "https://github.com/tyask/Cake/pull/35#issuecomment-123", "https://example.com/report"]) {
    assert.throws(() => transition(draining, "qa1", "release", { token: lease.token, report: invalid }), /停止確認/);
  }
  const free = transition(draining, "qa1", "release", { token: lease.token, report });
  assert.equal(free.slots.qa1, null);
  assert.equal(free.lastRelease?.report, report);
  const nextLease = { ...lease, token: "00000000-0000-4000-8000-000000000002" };
  const next = transition(free, "qa1", "reserve", nextLease);
  assert.throws(() => transition(next, "qa1", "drain", { token: lease.token }), /token/);
});

test("壊れた台帳や未知の枠・短縮SHAを受け付けない", () => {
  for (const value of [{ version: 2, slots: {} }, { version: 1, slots: { qa1: null } }, { ...emptyLedger(), slots: { ...emptyLedger().slots, qa4: null } }, { ...emptyLedger(), slots: { ...emptyLedger().slots, qa1: { ...lease, sourceSha: "a123" } } }]) {
    assert.throws(() => parseLedger(JSON.stringify(value)));
  }
});

test("固定QAは承認済みendpointを照合し、DB処理・build前に不一致を止める", () => {
  assert.equal(databaseConnectionString(env), env.CAKE_TEST_DATABASE_URL);
  assert.deepEqual(buildSteps(env), ["db:setup", "db:seed:test", "build"]);
  for (const change of [{ CAKE_QA_DATABASE_HOST: undefined }, { CAKE_QA_DATABASE_HOST: `${env.CAKE_QA_DATABASE_HOST}/other` }, { CAKE_QA_DATABASE_HOST: "ep-other.ap-southeast-1.aws.neon.tech" }, { CAKE_TEST_DATABASE_URL: "postgresql://private@production.example.com/db" }, { DATABASE_URL: "postgresql://prod:private@ep-test.ap-southeast-1.aws.neon.tech/db" }, { CAKE_QA_SLOT: "qa2" }, { CAKE_QA_SLOT: "qa4" }]) {
    assert.throws(() => buildSteps({ ...env, ...change }), (error: unknown) => {
      assert.match(String(error), /QA枠のDB照合/);
      assert.doesNotMatch(String(error), /private|production\.example/);
      return true;
    });
  }
  assert.throws(() => databaseConnectionString({ ...env, VERCEL_ENV: "production", CAKE_QA_SLOT: "qa1", DATABASE_URL: env.CAKE_TEST_DATABASE_URL }), /QA枠のDB照合/);
  assert.equal(databaseConnectionString({ ...env, VERCEL_ENV: undefined, CAKE_QA_SLOT: "qa1", DATABASE_URL: env.CAKE_TEST_DATABASE_URL }), env.CAKE_TEST_DATABASE_URL);
});

test("自動デプロイのallowlistはmainとqa1/2/3だけで、スラッシュを含む枝もdenyする", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.git.deploymentEnabled, { "**": false, main: true, qa1: true, qa2: true, qa3: true });
});

test("setup/seedの直接起動でもQA endpoint未確認なら接続前に停止する", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createRequire } = await import("node:module");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const cwd = mkdtempSync(join(tmpdir(), "cake-qa-db-guard-"));
  try {
    for (const script of ["setup-db.mjs", "seed-test-users.ts"]) {
      const file = fileURLToPath(new URL(`../scripts/${script}`, import.meta.url));
      const result = spawnSync(process.execPath, [...(script.endsWith(".ts") ? ["--import", loader] : []), file], {
        cwd, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, ...env, NODE_ENV: "production", CAKE_QA_DATABASE_HOST: undefined,
          CAKE_QA_SLOT: undefined, DATABASE_URL: undefined, __NEXT_PROCESSED_ENV: undefined },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /QA枠のDB照合/);
      assert.doesNotMatch(result.stdout + result.stderr, /private|postgresql:\/\//);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

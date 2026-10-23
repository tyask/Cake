import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { setupDatabase } from "../../scripts/db/setup-db.mjs";
import { verifyMigrationScenarios } from "../../scripts/qa/db/migration-scenarios";

const directory = new URL("../../db/migrations/", import.meta.url);
const preview = {
  VERCEL_ENV: "preview", AUTH_MODE: "test", VERCEL_GIT_COMMIT_REF: "codex/migration-test", VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  CAKE_PREVIEW_REPOSITORY: "tyask/Cake", CAKE_PREVIEW_PHASE: "application", CAKE_PREVIEW_DATABASE_BRANCH_ID: "br-preview", CAKE_PREVIEW_PR: "34", CAKE_PREVIEW_GENERATION: "00000000-0000-4000-8000-000000000001",
  CAKE_PREVIEW_SOURCE_BRANCH: "codex/migration-test", CAKE_PREVIEW_SOURCE_SHA: "a".repeat(40),
  CAKE_TEST_DATABASE_URL: "postgresql://fixture:fixture@ep-preview.ap-southeast-1.aws.neon.tech/postgres",
  CAKE_PREVIEW_DATABASE_HOST_SHA256: createHash("sha256").update("ep-preview.ap-southeast-1.aws.neon.tech").digest("hex"),
  CAKE_PREVIEW_PRODUCTION_HOST_SHA256: createHash("sha256").update("ep-production.ap-southeast-1.aws.neon.tech").digest("hex"),
};

test("全適用済みのNeon形式/PG形式はPreview/Production/localとも本文0読込・2往復", async () => {
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  for (const environment of [preview, { VERCEL_ENV: "production", DATABASE_URL: "isolated-fixture" }, { DATABASE_URL: "isolated-fixture" }]) for (const pg of [false, true]) {
    let queries = 0;
    await setupDatabase(environment, { readMigration: async () => { assert.fail("適用済みの本文は読まない"); }, connect: () => ({ query: async statement => {
      queries++; const rows = statement.startsWith("SELECT name FROM") ? names.map(name => ({ name })) : [];
      return pg ? { rows } : rows;
    } }) }); assert.equal(queries, 2);
  }
});

test("履歴の応答不明は本文読込・migration実行へ進まない", async () => {
  for (const bad of [undefined, {}, null, [{ name: 1 }]]) {
    let queries = 0;
    await assert.rejects(setupDatabase({ DATABASE_URL: "isolated-fixture" }, { readMigration: async () => { assert.fail("本文を読まない"); },
      connect: () => ({ query: async () => ++queries === 2 ? bad : [] }) }), /適用履歴を確認できません/);
    assert.equal(queries, 2);
  }
});

test("既存Previewでも未適用のbaseline原文・bootstrapの変更は適用前に拒否する", async () => {
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  for (const missing of ["002_user_access.sql", "003_transaction_splits.sql"]) {
    let queries = 0; const reads: string[] = [];
    await assert.rejects(setupDatabase(preview, { readMigration: async name => { reads.push(name); return "-- changed baseline"; },
      connect: () => ({ query: async statement => { queries++; return statement.startsWith("SELECT name FROM") ? names.filter(name => name !== missing).map(name => ({ name })) : []; } }) }), /初期管理者SQL|承認済み/);
    assert.deepEqual(reads, [missing]); assert.equal(queries, 2);
  }
});

test("identity欠落と同じ文面でもSQLSTATE不一致・他のguard失敗では初回確保しない", async () => {
  for (const error of [Object.assign(new Error("Cake Preview DB identity is missing"), { code: "08006" }), Object.assign(new Error("Cake Preview DB identity mismatch"), { code: "P0001" })]) {
    let queries = 0;
    await assert.rejects(setupDatabase(preview, { readMigration: async () => { assert.fail("原文確認や初回確保へ進まない"); },
      connect: () => ({ query: async () => { queries++; throw error; } }) }), /空状態・PR・DB世代照合/);
    assert.equal(queries, 1);
  }
});

test("PGliteで新規・一部適用・全適用・失敗と再実行のIO/SQLと原子性を検証する", async t => {
  const sql = new PGlite(); t.after(() => sql.close());
  const report = await verifyMigrationScenarios(sql, async (name, run) => {
    let failure: unknown; await t.test(name, async () => { try { await run(); } catch (error) { failure = error; throw error; } }); if (failure) throw failure;
  });
  await mkdir('.cake', { recursive: true }); await writeFile('.cake/migrations-local.json', JSON.stringify(report, null, 2));
});

test("初回Previewは全原文を照合して確保し、同一世代の再実行では本文を読まない", async t => {
  const sql = new PGlite({ extensions: { pgcrypto } }); t.after(() => sql.close());
  const reads: string[] = [], statements: string[] = [];
  const options = { connect: () => ({ query: async (statement: string) => { statements.push(statement); return sql.query(statement); } }) };
  await assert.rejects(setupDatabase(preview, { ...options, readMigration: async name => { reads.push(name); return "-- changed baseline"; } }), /承認済み/);
  assert.equal(statements.length, 1);
  assert.deepEqual((await sql.query<{ marker: string | null; ledger: string | null }>("SELECT to_regclass('public.cake_preview_database_identity') AS marker,to_regclass('public.schema_migrations') AS ledger")).rows[0], { marker: null, ledger: null });
  reads.length = 0; statements.length = 0;
  const { readFile } = await import("node:fs/promises");
  await setupDatabase(preview, { ...options, readMigration: async name => { reads.push(name); return readFile(new URL(name, directory), "utf8"); } });
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  assert.deepEqual(reads, names); assert.equal(statements.length, names.length + 3);
  assert.equal((await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM app_users")).rows[0].count, 0);
  const before = (await sql.query("SELECT name,applied_at::text FROM schema_migrations ORDER BY name")).rows;
  statements.length = 0;
  await setupDatabase(preview, { ...options, readMigration: async () => { assert.fail("同一世代の適用済み原文は読まない"); } });
  assert.equal(statements.length, 2);
  assert.deepEqual((await sql.query("SELECT name,applied_at::text FROM schema_migrations ORDER BY name")).rows, before);
});

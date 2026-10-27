import { createHash } from 'node:crypto';
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardPreviewDatabase } from "../../lib/server/database/database-environment";
import { prepareMigration, setupDatabase } from "../../scripts/db/setup-db.mjs";
import { seedTestUsers, testSeedSql } from "../../scripts/db/seed-test-users";
import { findTestUser, QA_TEST_USERS, TEST_USERS } from "../../lib/shared/test-users";

const preview = {
  VERCEL_ENV: "preview", AUTH_MODE: "test", VERCEL_GIT_COMMIT_REF: "codex/feature", VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  CAKE_PREVIEW_REPOSITORY: "tyask/Cake", CAKE_PREVIEW_PHASE: "application", CAKE_PREVIEW_DATABASE_BRANCH_ID: "br-preview", CAKE_PREVIEW_PR: "34", CAKE_PREVIEW_GENERATION: "00000000-0000-4000-8000-000000000001",
  CAKE_PREVIEW_SOURCE_BRANCH: "codex/feature", CAKE_PREVIEW_SOURCE_SHA: "a".repeat(40),
  CAKE_TEST_DATABASE_URL: "postgresql://user:private@ep-preview-pooler.ap-southeast-1.aws.neon.tech/cake",
  CAKE_PREVIEW_DATABASE_HOST_SHA256: createHash('sha256').update('ep-preview.ap-southeast-1.aws.neon.tech').digest('hex'), CAKE_PREVIEW_PRODUCTION_HOST_SHA256: createHash('sha256').update('ep-production.ap-southeast-1.aws.neon.tech').digest('hex'),
};

test("空DB・PR identityの検査が失敗したらmigrationの作成・適用を開始しない", async () => {
  const queries: string[] = [];
  await assert.rejects(setupDatabase(preview, { connect: () => ({ query: async (statement) => {
    queries.push(statement);
    throw new Error("private data and postgresql://credentials@host/db");
  } }) }), (error: unknown) => {
    assert.match(String(error), /空状態・PR・DB世代照合/);
    assert.doesNotMatch(String(error), /private|postgresql:\/\//);
    return true;
  });
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0], /CREATE TABLE IF NOT EXISTS app_users/);
  assert.ok(queries[0].indexOf("RAISE EXCEPTION 'Cake Preview DB identity mismatch'") < queries[0].indexOf("CREATE TABLE IF NOT EXISTS schema_migrations"));
});

test("Neon endpoint未確認の初回provisionではsetupとseedがクライアントを生成しない", async () => {
  let clients = 0;
  const connect = () => { clients++; return { query: async () => [] }; };
  const environment = { ...preview, CAKE_PREVIEW_DATABASE_HOST_SHA256: undefined };
  await assert.rejects(setupDatabase(environment, { connect }), /PreviewとDBの照合/);
  await assert.rejects(seedTestUsers(environment, connect), /PreviewとDBの照合/);
  assert.equal(clients, 0);
});

test("固定fixture baseでも本番host比較が未確認・本番と同一ならsetupとseedの接続前に拒否する", async () => {
  let clients = 0;
  const connect = () => { clients++; return { query: async () => [] }; };
  for (const environment of [
    { ...preview, CAKE_PREVIEW_PRODUCTION_HOST_SHA256: undefined },
    { ...preview, CAKE_PREVIEW_PRODUCTION_HOST_SHA256: preview.CAKE_PREVIEW_DATABASE_HOST_SHA256 },
    { ...preview, CAKE_PREVIEW_PRODUCTION_HOST_SHA256: createHash('sha256').update('ep-preview.ap-southeast-1.aws.neon.tech').digest('hex') },
    { ...preview, DATABASE_URL: preview.CAKE_TEST_DATABASE_URL },
  ]) {
    await assert.rejects(setupDatabase(environment, { connect }), /PreviewとDBの照合/);
    await assert.rejects(seedTestUsers(environment, connect), /PreviewとDBの照合/);
  }
  assert.equal(clients, 0);
});

test("既知bootstrapをPreview SQLから完全除去し、本番SQLは元のまま適用する", async () => {
  const migration = readFileSync(new URL("../../db/migrations/002_user_access.sql", import.meta.url), "utf8");
  const production = prepareMigration("002_user_access.sql", migration, { VERCEL_ENV: "production" });
  const isolated = prepareMigration("002_user_access.sql", migration, preview);
  assert.equal(production === migration, true, "Production must preserve the already-applied migration verbatim");
  const bootstrap = migration.match(/^INSERT INTO app_users\b[\s\S]*?;[ \t]*(?=\r?$)/m)?.[0];
  assert.ok(bootstrap);
  const productionEmail = bootstrap.match(/VALUES \(gen_random_uuid\(\)::text, '([^']+)'/)?.[1];
  assert.ok(productionEmail);
  assert.equal(isolated.includes(productionEmail), false, "Preview SQL must omit the production bootstrap identity");
  assert.equal(readFileSync(new URL("../../scripts/db/setup-db.mjs", import.meta.url), "utf8").includes(productionEmail), false,
    "Setup must not duplicate the production bootstrap identity");
  assert.equal(isolated, migration.replace(bootstrap, ""));
  assert.doesNotMatch(isolated, /INSERT INTO app_users|gen_random_uuid\(\)::text|WHERE false/);
  assert.throws(() => prepareMigration("002_user_access.sql", migration.replace("'管理者'", "'変更されたbootstrap'"), preview), /初期管理者SQLを確認できません/);
  assert.throws(() => prepareMigration("002_user_access.sql", migration + migration, preview), /初期管理者SQLを確認できません/);
  assert.throws(() => prepareMigration("002_user_access.sql", `${migration}\n ${bootstrap}`, preview), /初期管理者SQLを確認できません/);
  assert.throws(() => prepareMigration("012_unknown.sql", "DO $cake_preview_guard$ BEGIN END $cake_preview_guard$;", preview), /SQL区切りが不正/);
  const statements: string[] = [];
  await setupDatabase(preview, { connect: () => ({ query: async (statement) => { statements.push(statement); return []; } }) });
  assert.equal(statements.some((statement) => statement.includes(productionEmail)), false,
    "Every SQL statement sent to Preview must omit the production bootstrap identity");
});

test("未知・変更・重複bootstrapは所有権の確保・台帳作成前に拒否する", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cake-preview-migration-"));
  const original = new URL("../../db/migrations/", import.meta.url);
  const names = readdirSync(original).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  try {
    for (const name of names) writeFileSync(join(directory, name), readFileSync(new URL(name, original), "utf8"));
    const migration = readFileSync(new URL("002_user_access.sql", original), "utf8");
    for (const statement of ["INSERT INTO app_users VALUES ('unknown');", migration.replace("'管理者'", "'changed'"), migration + migration]) {
      writeFileSync(join(directory, "002_user_access.sql"), statement);
      const queries: string[] = [];
      await assert.rejects(setupDatabase(preview, { migrationDirectory: directory, connect: () => ({ query: async (sql) => {
        queries.push(sql); throw Object.assign(new Error("Cake Preview DB identity is missing"), { code: "P0001" });
      } }) }), /初期管理者SQLを確認できません/);
      assert.equal(queries.length, 1, "Only the rolled-back missing-marker probe may run");
      assert.match(queries[0], /RAISE EXCEPTION 'Cake Preview DB identity is missing'/);
      assert.doesNotMatch(queries[0], /CREATE TABLE public.cake_preview_database_identity/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("承認済みmigration名は接続前、初回の原文は所有権の確保前に照合する", async () => {
  const original = new URL("../../db/migrations/", import.meta.url);
  const names = readdirSync(original).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  for (const variant of ["changed", "missing"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "cake-preview-migration-sources-"));
    let clients = 0, queries = 0;
    try {
      for (const name of names) {
        if (variant === "missing" && name === "011_recurring_payment_next_scheduled_on.sql") continue;
        const contents = readFileSync(new URL(name, original), "utf8");
        writeFileSync(join(directory, name), variant === "changed" && name === "001_initial.sql" ? `${contents}\n-- changed source\n` : contents);
      }
      await assert.rejects(setupDatabase(preview, { migrationDirectory: directory, connect: () => {
        clients++;
        return { query: async () => { queries++; throw Object.assign(new Error("Cake Preview DB identity is missing"), { code: "P0001" }); } };
      } }), /Previewの承認済み/);
      assert.equal(clients, variant === "changed" ? 1 : 0);
      assert.equal(queries, variant === "changed" ? 1 : 0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test("番号migrationはそれぞれidentity確認と適用履歴を同一transactionに置く", async () => {
  const queries: string[] = [];
  const names = readdirSync(new URL("../../db/migrations/", import.meta.url)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  await setupDatabase(preview, { connect: () => ({ query: async (statement) => { queries.push(statement); return []; } }) });
  assert.equal(names.length, 27);
  assert.equal(queries.length, names.length + 2);
  for (const [index, name] of names.entries()) {
    const statement = queries[index + 2];
    assert.match(statement, /Cake Preview DB identity mismatch/);
    assert.match(statement, /cake:schema-migrations/);
    assert.ok(statement.includes(`INSERT INTO schema_migrations (name) VALUES ('${name}')`));
    assert.equal((statement.match(/DO \$cake_preview_guard\$/g) ?? []).length, 1);
    assert.ok(statement.indexOf("Cake Preview DB identity mismatch") < statement.indexOf("INSERT INTO schema_migrations"));
  }
  assert.match(queries[2], /CREATE TABLE IF NOT EXISTS app_users/);
});

test("setupとseedの直接起動でもDB世代未確認なら接続前に秘密を表示せず停止する", () => {
  const directory = mkdtempSync(join(tmpdir(), "cake-preview-db-startup-"));
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  try {
    for (const name of ["setup-db.mjs", "seed-test-users.ts"]) {
      const file = fileURLToPath(new URL(`../../scripts/db/${name}`, import.meta.url));
      const result = spawnSync(process.execPath, [...(name.endsWith(".ts") ? ["--import", loader] : []), file], {
        cwd: directory, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, ...preview, NODE_ENV: "production", CAKE_PREVIEW_DATABASE_HOST_SHA256: undefined, DATABASE_URL: undefined, __NEXT_PROCESSED_ENV: undefined },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /PreviewとDBの照合/);
      assert.doesNotMatch(result.stdout + result.stderr, /private|postgresql:\/\//);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("seedは初回判定と固定sample全体を一回のtransactionで登録する", async () => {
  const queries: string[] = [];
  await seedTestUsers(preview, () => ({ query: async (statement) => { queries.push(statement); } }));
  assert.equal(queries.length, 1);
  assert.match(queries[0], /WHERE singleton\) IS NULL THEN/);
  assert.match(queries[0], /samples_seeded_at.*IS NOT NULL THEN\s+RETURN;/);
  assert.match(queries[0], /Cake Preview initial data is not empty/);
  assert.doesNotMatch(queries[0], /ON CONFLICT[^;]+DO UPDATE|UPDATE app_users|UPDATE workspaces|UPDATE workspace_members|TRUNCATE|DELETE FROM/);
  const updated = { ...preview, VERCEL_GIT_COMMIT_SHA: "b".repeat(40), CAKE_PREVIEW_SOURCE_SHA: "b".repeat(40) };
  assert.equal(testSeedSql(updated), queries[0]);
});

test("QA seedはA/B二人のみでA管理者・B非管理者と共有OWNER/MEMBERを登録する", () => {
  const statement = testSeedSql(preview);
  assert.equal((statement.match(/INSERT INTO app_users/g) ?? []).length, 2);
  assert.match(statement, /VALUES \('test-user-a', 'test-a@cake\.local', 'テストユーザーA', NULL, true, true\)/);
  assert.match(statement, /VALUES \('test-user-b', 'test-b@cake\.local', 'テストユーザーB', NULL, false, true\)/);
  assert.match(statement, /'test-user-a', 'OWNER', 1/);
  assert.match(statement, /'test-user-b', 'MEMBER', 1/);
  for (const user of TEST_USERS) assert.ok(statement.includes(user.email));
});

test("従来local seed・findTestUserは既存profileと非管理者を保つ", () => {
  const statement = testSeedSql({});
  for (const user of TEST_USERS) {
    assert.ok(statement.includes(user.email));
    assert.deepEqual(findTestUser(user.key), user);
  }
  assert.equal((statement.match(/NULL, false, true\)/g) ?? []).length, 2);
  assert.doesNotMatch(statement, /NULL, true, true\)/);
  assert.deepEqual(findTestUser("user-a", QA_TEST_USERS), QA_TEST_USERS[0]);
  assert.deepEqual(findTestUser("user-b", QA_TEST_USERS), QA_TEST_USERS[1]);
  assert.equal(findTestUser("unknown", QA_TEST_USERS), null);
});

test("QA identity未確認のseedはlegacy profileへfallbackせずクライアント作成前に拒否する", async () => {
  let clients = 0;
  await assert.rejects(seedTestUsers({ ...preview, CAKE_PREVIEW_GENERATION: undefined }, () => {
    clients++;
    return { query: async () => [] };
  }), /PreviewとDBの照合/);
  assert.equal(clients, 0);
});

test("Productionへのseed直接実行はDBクライアント生成前に拒否する", async () => {
  let clients = 0;
  await assert.rejects(seedTestUsers({ VERCEL_ENV: "production", DATABASE_URL: "production-url" }, () => {
    clients++;
    return { query: async () => [] };
  }), /Productionではテストデータを登録できません/);
  assert.equal(clients, 0);
});

test("Preview検査の権限・接続失敗を空DB扱いしない", async () => {
  let calls = 0;
  await assert.rejects(guardPreviewDatabase({ query: async () => { calls++; throw { code: "42501", message: "private" }; } }, preview, true), /空状態・PR・DB世代照合/);
  assert.equal(calls, 1);
});

// Run the real guard, migrations and seed in disposable in-memory PostgreSQL.
test("一時メモリPostgreSQLで空DB・厳密fixture base・同PR保持・Productionの実SQLを検証する", () => {
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const script = fileURLToPath(new URL("../../scripts/qa/db/verify-preview-database-safety.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", loader, script, "--pglite-module", process.env.CAKE_LOCAL_PGLITE_MODULE ?? createRequire(import.meta.url).resolve("@electric-sql/pglite")], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8", timeout: 120_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout || "Local memory SQL validation failed");
  const report = JSON.parse(result.stdout) as {
    engine: string; memoryDatabases: number; migrations: number; cases: number; outcomes: { name: string; result: string }[];
  };
  assert.equal(report.engine, "PGlite");
  assert.equal(report.migrations, 27);
  assert.equal(report.memoryDatabases, 4);
  assert.equal(report.cases, report.outcomes.length);
  assert.ok(report.cases > 23, "The original 23 SQL cases must be retained and extended");
  assert.ok(report.outcomes.every(({ result: outcome }) => outcome === "PASS"));
  for (const name of [
    "Empty DB claim and same identity reuse",
    "Fixture base with an extra user rejects",
    "Fixture base with a real email rejects",
    "Fixture base with a changed guard revision rejects",
    "Fixture base with extension-owned data rejects",
    "Approved fixture claim and caller failure roll back the new marker atomically",
    "Approved canonical fixture base claims a seeded Preview without repairing inherited rows",
    "A foreign Preview generation cannot claim the canonical fixture base with an existing marker",
    "Claimed fixture base keeps disable, demotion, renamed fixtures and financial edits on same PR setup and seed",
    "Production setup retains the original bootstrap and seed refuses before a client is created",
  ]) assert.ok(report.outcomes.some((outcome) => outcome.name === name), `Missing SQL scenario: ${name}`);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardPreviewDatabase } from "../lib/database-environment";
import { prepareMigration, setupDatabase } from "../scripts/setup-db.mjs";
import { seedTestUsers, testSeedSql } from "../scripts/seed-test-users";
import { findTestUser, QA_TEST_USERS, TEST_USERS } from "../lib/test-users";

const preview = {
  VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "codex/feature", VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  CAKE_QA_SLOT: "qa1", CAKE_QA_PR: "34", CAKE_QA_LEASE_TOKEN: "00000000-0000-4000-8000-000000000001",
  CAKE_QA_SOURCE_BRANCH: "codex/feature", CAKE_QA_SOURCE_SHA: "a".repeat(40),
  CAKE_TEST_DATABASE_URL: "postgresql://user:private@ep-preview-pooler.ap-southeast-1.aws.neon.tech/cake",
  CAKE_QA_DATABASE_HOST: "ep-preview.ap-southeast-1.aws.neon.tech", CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.ap-southeast-1.aws.neon.tech",
};

test("空DB・PR identityの検査が失敗したらmigrationの作成・適用を開始しない", async () => {
  const queries: string[] = [];
  await assert.rejects(setupDatabase(preview, { connect: () => ({ query: async (statement) => {
    queries.push(statement);
    throw new Error("private data and postgresql://credentials@host/db");
  } }) }), (error: unknown) => {
    assert.match(String(error), /空状態・PR・lease照合/);
    assert.doesNotMatch(String(error), /private|postgresql:\/\//);
    return true;
  });
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0], /CREATE TABLE IF NOT EXISTS schema_migrations|CREATE TABLE IF NOT EXISTS app_users/);
});

test("Neon endpoint未確認の初回provisionではsetupとseedがクライアントを生成しない", async () => {
  let clients = 0;
  const connect = () => { clients++; return { query: async () => [] }; };
  const environment = { ...preview, CAKE_QA_DATABASE_HOST: undefined };
  await assert.rejects(setupDatabase(environment, { connect }), /QA貸出とDBの照合/);
  await assert.rejects(seedTestUsers(environment, connect), /QA貸出とDBの照合/);
  assert.equal(clients, 0);
});

test("既知bootstrapをPreview SQLから完全除去し、本番SQLは元のまま適用する", async () => {
  const migration = readFileSync(new URL("../db/migrations/002_user_access.sql", import.meta.url), "utf8");
  const production = prepareMigration("002_user_access.sql", migration, { VERCEL_ENV: "production" });
  const isolated = prepareMigration("002_user_access.sql", migration, preview);
  assert.equal(production === migration, true, "Production must preserve the already-applied migration verbatim");
  const bootstrap = migration.match(/^INSERT INTO app_users\b[\s\S]*?;[ \t]*(?=\r?$)/m)?.[0];
  assert.ok(bootstrap);
  const productionEmail = bootstrap.match(/VALUES \(gen_random_uuid\(\)::text, '([^']+)'/)?.[1];
  assert.ok(productionEmail);
  assert.equal(isolated.includes(productionEmail), false, "Preview SQL must omit the production bootstrap identity");
  assert.equal(readFileSync(new URL("../scripts/setup-db.mjs", import.meta.url), "utf8").includes(productionEmail), false,
    "Setup must not duplicate the production bootstrap identity");
  assert.equal(isolated, migration.replace(bootstrap, ""));
  assert.doesNotMatch(isolated, /INSERT INTO app_users|gen_random_uuid\(\)::text|WHERE false/);
  assert.throws(() => prepareMigration("002_user_access.sql", migration.replace("'管理者'", "'変更されたbootstrap'"), preview), /初期管理者SQLを確認できません/);
  assert.throws(() => prepareMigration("002_user_access.sql", migration + migration, preview), /初期管理者SQLを確認できません/);
  assert.throws(() => prepareMigration("002_user_access.sql", `${migration}\n ${bootstrap}`, preview), /初期管理者SQLを確認できません/);
  assert.throws(() => prepareMigration("012_unknown.sql", "DO $cake_preview_guard$ BEGIN END $cake_preview_guard$;", preview), /SQL区切りが不正/);
  const statements: string[] = [];
  await setupDatabase(preview, { connect: () => ({ query: async (statement) => { statements.push(statement); } }) });
  assert.equal(statements.some((statement) => statement.includes(productionEmail)), false,
    "Every SQL statement sent to Preview must omit the production bootstrap identity");
});

test("未知・変更・重複bootstrapはDBクライアントの作成前に拒否する", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cake-preview-migration-"));
  let clients = 0;
  try {
    const migration = readFileSync(new URL("../db/migrations/002_user_access.sql", import.meta.url), "utf8");
    for (const statement of ["INSERT INTO app_users VALUES ('unknown');", migration.replace("'管理者'", "'changed'"), migration + migration]) {
      writeFileSync(join(directory, "002_user_access.sql"), statement);
      await assert.rejects(setupDatabase(preview, { migrationDirectory: directory, connect: () => {
        clients++;
        return { query: async () => [] };
      } }), /初期管理者SQLを確認できません/);
    }
    assert.equal(clients, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("番号migrationはそれぞれidentity確認と適用履歴を同一transactionに置く", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cake-preview-migration-"));
  const queries: string[] = [];
  try {
    writeFileSync(join(directory, "001_fixture.sql"), "CREATE TABLE fixture (id integer);");
    await setupDatabase(preview, { migrationDirectory: directory, connect: () => ({ query: async (statement) => { queries.push(statement); } }) });
    assert.equal(queries.length, 3);
    assert.match(queries[2], /Cake Preview DB identity mismatch/);
    assert.match(queries[2], /CREATE TABLE fixture/);
    assert.match(queries[2], /INSERT INTO schema_migrations/);
    assert.equal((queries[2].match(/DO \$cake_preview_guard\$/g) ?? []).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("setupとseedの直接起動でもlease未確認なら接続前に秘密を表示せず停止する", () => {
  const directory = mkdtempSync(join(tmpdir(), "cake-preview-db-startup-"));
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  try {
    for (const name of ["setup-db.mjs", "seed-test-users.ts"]) {
      const file = fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
      const result = spawnSync(process.execPath, [...(name.endsWith(".ts") ? ["--import", loader] : []), file], {
        cwd: directory, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, ...preview, NODE_ENV: "production", CAKE_QA_DATABASE_HOST: undefined, DATABASE_URL: undefined, __NEXT_PROCESSED_ENV: undefined },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /QA貸出とDBの照合/);
      assert.doesNotMatch(result.stdout + result.stderr, /private|postgresql:\/\//);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("seedは初回判定と固定sample全体を一回のtransactionで登録する", async () => {
  const queries: string[] = [];
  await seedTestUsers(preview, () => ({ query: async (statement) => { queries.push(statement); } }));
  assert.equal(queries.length, 1);
  assert.match(queries[0], /seeded_at.*IS NOT NULL THEN\s+RETURN;/);
  assert.match(queries[0], /Cake Preview initial data is not empty/);
  assert.doesNotMatch(queries[0], /ON CONFLICT[^;]+DO UPDATE|UPDATE app_users|UPDATE workspaces|UPDATE workspace_members|TRUNCATE|DELETE FROM/);
  const updated = { ...preview, VERCEL_GIT_COMMIT_SHA: "b".repeat(40), CAKE_QA_SOURCE_SHA: "b".repeat(40) };
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
  await assert.rejects(seedTestUsers({ ...preview, CAKE_QA_LEASE_TOKEN: undefined }, () => {
    clients++;
    return { query: async () => [] };
  }), /QA貸出とDBの照合/);
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
  await assert.rejects(guardPreviewDatabase({ query: async () => { calls++; throw { code: "42501", message: "private" }; } }, preview, true), /空状態・PR・lease照合/);
  assert.equal(calls, 1);
});

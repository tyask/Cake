import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import nextEnv from "@next/env";
import { neon } from "@neondatabase/serverless";

import { databaseConnectionString, previewDatabaseIdentity, previewDatabaseGuardSql } from "../lib/database-connection.mjs";
import { assertPreviewFixtureMigrationNames, assertPreviewFixtureMigrationSource } from "../lib/preview-fixture-base.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(here, "../db/migrations");

// Pin the already-applied production statement without duplicating its values.
// Its complete removal prevents production identity data entering Preview SQL.
const PRODUCTION_BOOTSTRAP_SHA256 = "e5fdd91acfc3b865f826c615f971743fcb9f2998615f46ef253548cfe3bf8bb9";

export function prepareMigration(name, migration, environment) {
  if (!/^\d+_[a-z0-9_]+\.sql$/.test(name)
    || ["$cake_migration$", "$cake_preview_guard$"].some((delimiter) => migration.includes(delimiter))) {
    throw new Error("マイグレーション名または予約済みSQL区切りが不正です。");
  }
  if (environment.VERCEL_ENV === "preview" && name === "002_user_access.sql") {
    const candidates = [...migration.matchAll(/^[ \t]*INSERT\s+INTO\s+(?:public\.)?app_users\b[\s\S]*?;[ \t]*(?=\r?$)/gmi)];
    if (candidates.length !== 1
      || createHash("sha256").update(candidates[0][0]).digest("hex") !== PRODUCTION_BOOTSTRAP_SHA256) {
      throw new Error("Previewの初期管理者SQLを確認できません。DB更新を停止しました。");
    }
    return migration.replace(candidates[0][0], "");
  }
  return migration;
}

export async function setupDatabase(environment, options = {}) {
  const connectionString = databaseConnectionString(environment);
  const directory = options.migrationDirectory ?? migrationDirectory;
  const names = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (environment.VERCEL_ENV === "preview") assertPreviewFixtureMigrationNames(names);
  const readMigration = options.readMigration ?? (name => readFile(resolve(directory, name), "utf8"));
  async function loadMigrations(selectedNames) {
    const migrations = [];
    for (const name of selectedNames) {
      const source = await readMigration(name);
      const migration = prepareMigration(name, source, environment);
      if (environment.VERCEL_ENV === "preview") assertPreviewFixtureMigrationSource(name, source);
      migrations.push({ name, sql: migration });
    }
    return migrations;
  }
  const sql = (options.connect ?? neon)(connectionString);
  const identity = previewDatabaseIdentity(environment);
  const statement = (body, initialize = false) => identity ? previewDatabaseGuardSql(identity, initialize, body)
    : `DO $cake_migration$ BEGIN ${body} END; $cake_migration$;`;
  const ledger = `
    PERFORM pg_advisory_xact_lock(hashtext('cake:schema-migrations'));
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
`;
  async function initializeLedger(claim = false) {
    try { await sql.query(statement(ledger, claim)); return true; }
    catch (error) {
      // A missing marker fails before the ledger body and rolls back the whole
      // probe. Only this exact error permits full source review and first claim.
      if (identity && !claim && error?.code === "P0001" && error.message === "Cake Preview DB identity is missing") return false;
      if (!identity) throw error;
      throw new Error("Preview DBの空状態・PR・DB世代照合を確認できません。DB更新・seedを停止しました。接続情報やDBエラー本文は表示しません。");
    }
  }
  let reviewed;
  if (!await initializeLedger()) {
    // Existing same-generation DBs trust their ledger. Unclaimed DBs must still
    // pass every original source hash/bootstrap check before any claim or DDL.
    reviewed = await loadMigrations(names);
    await initializeLedger(true);
  }
  const history = await sql.query("SELECT name FROM schema_migrations ORDER BY name");
  const rows = Array.isArray(history) ? history : history?.rows;
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.name !== "string")) {
    throw new Error("マイグレーションの適用履歴を確認できません。DB更新を停止しました。");
  }
  const applied = new Set(rows.map(row => row.name));
  const pending = names.filter(name => !applied.has(name));
  const migrations = reviewed ? reviewed.filter(({ name }) => !applied.has(name)) : await loadMigrations(pending);

  for (const { name, sql: migration } of migrations) {
    // Guard, SQL and migration ledger share one transaction. Locks protect
    // both identity and migrations against concurrent setup/seed processes.
    await sql.query(statement(`
      PERFORM pg_advisory_xact_lock(hashtext('cake:schema-migrations'));
      IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '${name}') THEN
        RETURN;
      END IF;
      ${migration}
      INSERT INTO schema_migrations (name) VALUES ('${name}');
`));
  }
}

async function main() {
  nextEnv.loadEnvConfig(process.cwd());
  try {
    await setupDatabase(process.env);
    console.log("Cakeのデータベースへ未適用のマイグレーションを適用しました。");
  } catch (error) {
    // Never print raw Neon errors, which can contain credentials or row data.
    console.error(error instanceof Error && /^(CAKE_TEST_DATABASE_URL|DATABASE_URL|PreviewとDB|Preview DB|Previewの初期管理者SQL|Previewの承認済み|マイグレーション名)/.test(error.message)
      ? error.message : "DB更新に失敗しました。接続情報・DBエラー本文は表示しません。");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

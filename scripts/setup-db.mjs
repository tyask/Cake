import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import nextEnv from "@next/env";
import { neon } from "@neondatabase/serverless";

import { databaseConnectionString, guardPreviewDatabase, previewDatabaseGuardSql } from "../lib/database-connection.mjs";

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
  // Validate every migration before constructing a client or claiming a DB.
  const connectionString = databaseConnectionString(environment);
  const directory = options.migrationDirectory ?? migrationDirectory;
  const names = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  const migrations = [];
  for (const name of names) {
    migrations.push({ name, sql: prepareMigration(name, await readFile(resolve(directory, name), "utf8"), environment) });
  }
  const sql = (options.connect ?? neon)(connectionString);
  const identity = await guardPreviewDatabase(sql, environment, true);
  const statement = (body) => identity ? previewDatabaseGuardSql(identity, false, body)
    : `DO $cake_migration$ BEGIN ${body} END; $cake_migration$;`;
  await sql.query(statement(`
    PERFORM pg_advisory_xact_lock(hashtext('cake:schema-migrations'));
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
`));

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
    console.error(error instanceof Error && /^(CAKE_TEST_DATABASE_URL|DATABASE_URL|QA貸出|Preview DB|Previewの初期管理者SQL|マイグレーション名)/.test(error.message)
      ? error.message : "DB更新に失敗しました。接続情報・DBエラー本文は表示しません。");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

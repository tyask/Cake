import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import nextEnv from "@next/env";
import { neon } from "@neondatabase/serverless";

nextEnv.loadEnvConfig(process.cwd());

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL を設定してください。");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(here, "../db/migrations");
const migrations = (await readdir(migrationDirectory))
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const sql = neon(connectionString);
await sql.query(`
  DO $cake_migration$
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('cake:schema-migrations'));
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  END;
  $cake_migration$;
`);

for (const name of migrations) {
  const migration = await readFile(resolve(migrationDirectory, name), "utf8");
  // A single DO statement makes the SQL and its ledger entry atomic, while the
  // lock also protects against two setup processes applying the same migration.
  if (migration.includes("$cake_migration$")) {
    throw new Error(`${name}: 予約済みのSQL区切り $cake_migration$ は使用できません。`);
  }
  await sql.query(`
    DO $cake_migration$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('cake:schema-migrations'));
      IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '${name}') THEN
        RETURN;
      END IF;
      ${migration}
      INSERT INTO schema_migrations (name) VALUES ('${name}');
    END;
    $cake_migration$;
  `);
}
console.log("Cakeのデータベースへ未適用のマイグレーションを適用しました。");

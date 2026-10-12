import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { databaseConnectionString, previewDatabaseIdentity, previewDatabaseGuardSql, type DatabaseQueryExecutor } from "../lib/database-environment";
import { TEST_USERS } from "../lib/test-users";
import { formatSeedError } from "./seed-error";

// @next/env marks its CommonJS exports as __esModule without a default export.
const { loadEnvConfig } = createRequire(import.meta.url)("@next/env") as typeof import("@next/env");

const TEST_SHARED_WORKSPACE = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "テスト共有家計",
} as const;

type SeedEnvironment = Readonly<Record<string, string | undefined>>;

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function testSeedSql(environment: SeedEnvironment): string {
  if (environment.VERCEL_ENV === "production") throw new Error("Productionではテストデータを登録できません。");
  const identity = previewDatabaseIdentity(environment);
  const [owner, member] = TEST_USERS;
  const workspace = literal(TEST_SHARED_WORKSPACE.id);
  const samples = `
    IF EXISTS (
      SELECT 1 FROM app_users WHERE
        (id = ${literal(owner.id)} AND email <> ${literal(owner.email)}) OR
        (id = ${literal(member.id)} AND email <> ${literal(member.email)}) OR
        (email = ${literal(owner.email)} AND id <> ${literal(owner.id)}) OR
        (email = ${literal(member.email)} AND id <> ${literal(member.id)})
    ) THEN
      RAISE EXCEPTION 'Cake test fixture identity mismatch';
    END IF;
    ${TEST_USERS.map((user) => `INSERT INTO app_users (id, email, name, image_url, is_admin, is_enabled)
      VALUES (${literal(user.id)}, ${literal(user.email)}, ${literal(user.name)}, NULL, false, true)
      ON CONFLICT (id) DO NOTHING;`).join("\n")}
    INSERT INTO workspaces (id, name, type, owner_user_id)
      VALUES (${workspace}::uuid, ${literal(TEST_SHARED_WORKSPACE.name)}, 'SHARED', ${literal(owner.id)})
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO workspace_members (workspace_id, user_id, role, weight)
      SELECT ${workspace}::uuid, ${literal(owner.id)}, 'OWNER', 1
      WHERE NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ${workspace}::uuid AND user_id = ${literal(owner.id)})
      ON CONFLICT (workspace_id, user_id) DO NOTHING;
    INSERT INTO workspace_members (workspace_id, user_id, role, weight)
      SELECT ${workspace}::uuid, ${literal(member.id)}, 'MEMBER', 1
      WHERE NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ${workspace}::uuid AND user_id = ${literal(member.id)})
      ON CONFLICT (workspace_id, user_id) DO NOTHING;`;
  if (!identity) return `DO $cake_test_seed$ BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('cake:test-seed'));
    ${samples}
  END; $cake_test_seed$;`;
  return previewDatabaseGuardSql(identity, false, `
    -- Rebuilding the same PR never rewrites samples or QA-entered data.
    IF (SELECT seeded_at FROM public.cake_preview_database_identity WHERE singleton) IS NOT NULL THEN
      RETURN;
    END IF;
    -- Initial setup must have produced only schema and migration metadata.
    -- Unknown tables and foreign schemas also fail closed, without deleting rows.
    FOR relation IN
      SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' AND c.relkind IN ('r', 'p', 'f')
        AND NOT (n.nspname = 'public' AND c.relname IN ('schema_migrations', 'app_user_access_guard', 'cake_preview_database_identity'))
      ORDER BY n.nspname, c.relname
    LOOP
      EXECUTE format('LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE', relation.schema_name, relation.table_name);
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', relation.schema_name, relation.table_name) INTO has_rows;
      IF has_rows THEN RAISE EXCEPTION 'Cake Preview initial data is not empty'; END IF;
    END LOOP;
    ${samples}
    UPDATE public.cake_preview_database_identity SET seeded_at = now() WHERE singleton;
  `);
}

export async function seedTestUsers(
  environment: SeedEnvironment,
  connect: (connectionString: string) => DatabaseQueryExecutor = neon,
): Promise<void> {
  const statement = testSeedSql(environment);
  const connectionString = databaseConnectionString(environment);
  // The guard, empty check, inserts and seed marker are one transaction.
  await connect(connectionString).query(statement);
}

async function main(): Promise<void> {
  let stage = "環境設定の読み込み";
  try {
    loadEnvConfig(process.cwd());
    stage = "DB設定の確認";
    // Validate synchronously before constructing the Neon client.
    databaseConnectionString(process.env);
    testSeedSql(process.env);
    stage = "DB接続の初期化";
    await seedTestUsers(process.env);
    console.log(`${TEST_USERS.length}人の固定テストユーザーと共有ワークスペースを確認しました。既存のQAデータは保持します。`);
  } catch (error) {
    console.error(stage === "DB設定の確認" && error instanceof Error ? error.message : formatSeedError(stage, error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

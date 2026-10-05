import { createRequire } from "node:module";
import { neon } from "@neondatabase/serverless";
import { TEST_USERS } from "../lib/test-users";
import { formatSeedError } from "./seed-error";

// @next/env marks its CommonJS exports as __esModule without a default export.
// Read the exports directly so native ESM and tsx's CommonJS transform agree.
const { loadEnvConfig } = createRequire(import.meta.url)("@next/env") as typeof import("@next/env");

const TEST_SHARED_WORKSPACE = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "テスト共有家計",
} as const;

let stage = "環境設定の読み込み";

async function main() {
  loadEnvConfig(process.cwd());

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL を設定してください。");
    process.exit(1);
  }

  stage = "DB接続の初期化";
  const sql = neon(connectionString);
  for (const user of TEST_USERS) {
    stage = `${user.name}の登録`;
    await sql`
      INSERT INTO app_users (id, email, name, image_url, is_admin, is_enabled)
      VALUES (${user.id}, ${user.email}, ${user.name}, NULL, false, true)
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        is_admin = false,
        is_enabled = true,
        updated_at = now()
    `;
  }

  const [owner, member] = TEST_USERS;

  stage = "共有ワークスペース・メンバーの登録";
  await sql.transaction([
    sql`
      INSERT INTO workspaces (id, name, type, owner_user_id)
      VALUES (${TEST_SHARED_WORKSPACE.id}::uuid, ${TEST_SHARED_WORKSPACE.name}, 'SHARED', ${owner.id})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        owner_user_id = EXCLUDED.owner_user_id,
        updated_at = now()
    `,
    sql`
      UPDATE workspace_members
      SET role = 'OWNER'
      WHERE workspace_id = ${TEST_SHARED_WORKSPACE.id}::uuid AND user_id = ${owner.id}
    `,
    sql`
      INSERT INTO workspace_members (workspace_id, user_id, role, weight)
      SELECT ${TEST_SHARED_WORKSPACE.id}::uuid, ${owner.id}, 'OWNER', 1
      WHERE NOT EXISTS (
        SELECT 1 FROM workspace_members
        WHERE workspace_id = ${TEST_SHARED_WORKSPACE.id}::uuid AND user_id = ${owner.id}
      )
    `,
    sql`
      UPDATE workspace_members
      SET role = 'MEMBER'
      WHERE workspace_id = ${TEST_SHARED_WORKSPACE.id}::uuid AND user_id = ${member.id}
    `,
    sql`
      INSERT INTO workspace_members (workspace_id, user_id, role, weight)
      SELECT ${TEST_SHARED_WORKSPACE.id}::uuid, ${member.id}, 'MEMBER', 1
      WHERE NOT EXISTS (
        SELECT 1 FROM workspace_members
        WHERE workspace_id = ${TEST_SHARED_WORKSPACE.id}::uuid AND user_id = ${member.id}
      )
    `,
  ]);

  console.log(
    `${TEST_USERS.length}人のテストユーザーと共有ワークスペース「${TEST_SHARED_WORKSPACE.name}」を登録しました。`,
  );
}

void main().catch((error: unknown) => {
  console.error(formatSeedError(stage, error));
  process.exitCode = 1;
});

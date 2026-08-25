import { loadEnvConfig } from "@next/env";
import { neon } from "@neondatabase/serverless";
import { TEST_USERS } from "../lib/test-users";

const TEST_SHARED_WORKSPACE = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "テスト共有家計",
} as const;

loadEnvConfig(process.cwd());

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL を設定してください。");
  process.exit(1);
}

const sql = neon(connectionString);
for (const user of TEST_USERS) {
  await sql`
    INSERT INTO app_users (id, email, name, image_url)
    VALUES (${user.id}, ${user.email}, ${user.name}, NULL)
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      updated_at = now()
  `;
}

const [owner, member] = TEST_USERS;

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
    SET role = 'OWNER', weight = 1
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
    SET role = 'MEMBER', weight = 1
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

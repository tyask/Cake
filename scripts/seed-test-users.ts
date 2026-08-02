import { loadEnvConfig } from "@next/env";
import { neon } from "@neondatabase/serverless";
import { TEST_USERS } from "../lib/test-users";

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

console.log(`${TEST_USERS.length}人のテストユーザーを登録しました。`);

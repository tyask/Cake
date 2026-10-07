import assert from "node:assert/strict";
import test from "node:test";
import { neonConfig } from "@neondatabase/serverless";
import { ensureTestUser, updateDisplayName, updateRegisteredProfile, UserAccessError } from "../lib/user-access";
import { PROFILE_NAME_MAX_LENGTH, profileNameSchema, updateProfileInputSchema } from "../lib/user-profile";
import type { AppUser } from "../lib/types";

const user: AppUser = { id: "internal-user-id", email: "user@example.test", name: "前の名前", imageUrl: null };

test("ユーザー名は前後空白を取り除き、1〜120文字を受け付ける", () => {
  assert.equal(profileNameSchema.parse("  ふたりの家計  "), "ふたりの家計");
  assert.equal(profileNameSchema.parse("あ".repeat(PROFILE_NAME_MAX_LENGTH)).length, PROFILE_NAME_MAX_LENGTH);
  for (const name of ["", "   ", "あ".repeat(PROFILE_NAME_MAX_LENGTH + 1), null, undefined, 123]) {
    assert.equal(profileNameSchema.safeParse(name).success, false);
  }
});

test("プロフィール更新では対象ユーザー・メール・管理者権限を指定できない", () => {
  const input = { action: "updateProfile", name: "新しい名前" };
  assert.deepEqual(updateProfileInputSchema.parse(input), input);
  for (const field of ["userId", "id", "email", "isAdmin", "isEnabled", "imageUrl", "workspaceId"]) {
    assert.equal(updateProfileInputSchema.safeParse({ ...input, [field]: "別の値" }).success, false, field);
  }
  assert.equal(updateProfileInputSchema.safeParse({ ...input, action: "other" }).success, false);
});

type CapturedQuery = { query: string; params: string[] };

async function withDatabaseRows(rows: string[][], run: (queries: CapturedQuery[]) => Promise<void>) {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousFetch = neonConfig.fetchFunction;
  process.env.DATABASE_URL = "postgresql://user:password@isolated.example.test/cake";
  const queries: CapturedQuery[] = [];
  neonConfig.fetchFunction = async (_url: string, options: RequestInit) => {
    queries.push(JSON.parse(String(options.body)) as CapturedQuery);
    return Response.json({
      fields: [
        { name: "id", dataTypeID: 25 }, { name: "email", dataTypeID: 25 }, { name: "name", dataTypeID: 25 },
        { name: "image_url", dataTypeID: 25 }, { name: "is_admin", dataTypeID: 16 }, { name: "is_enabled", dataTypeID: 16 },
      ],
      rows,
    });
  };
  try { await run(queries); } finally {
    neonConfig.fetchFunction = previousFetch;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
}

test("ユーザー名保存は認証ユーザーのID・メール・有効状態で限定し、保存したプロフィールを返す", async () => {
  await withDatabaseRows([[user.id, user.email, "新しい名前", "photo.png", "f", "t"]], async queries => {
    assert.deepEqual(await updateDisplayName(user, " 新しい名前 "), {
      id: user.id, email: user.email, name: "新しい名前", imageUrl: "photo.png", isAdmin: false,
    });
    assert.deepEqual(queries[0].params, ["新しい名前", user.id, user.email]);
    assert.match(queries[0].query, /WHERE id = \$2 AND email = \$3 AND is_enabled = true/);
  });
});

test("ログイン後に無効化または削除されたユーザーの名前は保存できない", async () => {
  await withDatabaseRows([], async queries => {
    await assert.rejects(updateDisplayName(user, "新しい名前"), error => error instanceof UserAccessError && error.status === 401);
    assert.equal(queries.length, 1);
  });
});

test("Googleプロフィール更新は画像だけ更新し、設定済みのユーザー名を上書きしない", async () => {
  await withDatabaseRows([[user.id, user.email, "新しい名前", "photo.png", "f", "t"]], async queries => {
    assert.equal(await updateRegisteredProfile({ ...user, name: "Googleの名前", imageUrl: "photo.png" }), true);
    assert.deepEqual(queries[0].params, ["photo.png", user.id, user.email]);
    assert.doesNotMatch(queries[0].query, /SET\s+name\s*=/);
  });
});

test("テストユーザーの再ログインも保存済みのユーザー名を上書きしない", async () => {
  await withDatabaseRows([["test-user-a", "test-a@cake.local", "新しい名前", "", "f", "t"]], async queries => {
    assert.equal(await ensureTestUser({ ...user, id: "test-user-a", email: "test-a@cake.local" }), true);
    const conflictUpdate = queries[0].query.split("ON CONFLICT (id) DO UPDATE SET")[1];
    assert.ok(conflictUpdate);
    assert.doesNotMatch(conflictUpdate, /\bname\s*=/);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { formatSeedError } from "../scripts/seed-error";

test("テスト利用者のメール重複では登録段階と制約名がわかる", () => {
  const output = formatSeedError("テストユーザーAの登録", {
    name: "NeonDbError", code: "23505", constraint: "app_users_email_key", table: "app_users",
    message: 'duplicate key value violates unique constraint "app_users_email_key"',
    detail: "Key (email)=(private@example.com) already exists.",
  });
  assert.match(output, /段階: テストユーザーAの登録/);
  assert.match(output, /SQLSTATE: 23505/);
  assert.match(output, /制約: app_users_email_key/);
  assert.match(output, /重複/);
  assert.doesNotMatch(output, /private@example\.com/);
});

test("既存メンバーによる上限違反を既知のトリガー文言から説明する", () => {
  const output = formatSeedError("共有ワークスペース・メンバーの登録", {
    code: "P0001", message: "共有ワークスペースは二人までです",
  });
  assert.match(output, /SQLSTATE: P0001/);
  assert.match(output, /既存メンバーが二人の上限/);
});

test("DB接続エラーは接続文字列とHTTP本文を出さずに識別できる", () => {
  const connectionString = "postgresql://username:password@private-db.example/cake";
  const network = formatSeedError("DB接続の初期化", {
    name: "NeonDbError", message: `Error connecting to database: ${connectionString}`,
    sourceError: { message: "fetch failed", cause: { code: "ECONNRESET" } },
  });
  assert.match(network, /接続エラー: ECONNRESET/);
  assert.doesNotMatch(network, /username|password|private-db/);
  const http = formatSeedError("テストユーザーAの登録", {
    message: `Server error (HTTP status 503): ${connectionString}`,
  });
  assert.match(http, /HTTPステータス: 503/);
  assert.doesNotMatch(http, /username|password|private-db/);
  const invalidUrl = formatSeedError("DB接続の初期化", {
    message: `Database connection string provided to neon() is not a valid URL: ${connectionString}`,
  });
  assert.match(invalidUrl, /DATABASE_URLの形式が不正/);
  assert.doesNotMatch(invalidUrl, /username|password|private-db/);
});

test("未知のエラー情報やSQLをログへ流さない", () => {
  const output = formatSeedError("テストユーザーAの登録", {
    code: "SECRET_TOKEN", constraint: "private_secret", table: "private_table", column: "private_column",
    message: "secret message", detail: "secret detail", stack: "secret stack", internalQuery: "secret sql",
    name: "secret name", sourceError: { code: "secret network code" },
  });
  assert.equal(output, "テストユーザーの登録に失敗しました。段階: テストユーザーAの登録");
  assert.doesNotMatch(output, /secret|private/i);
  for (const error of [undefined, null, "secret string"]) {
    assert.equal(formatSeedError("初期化", error), "テストユーザーの登録に失敗しました。段階: 初期化");
  }
});

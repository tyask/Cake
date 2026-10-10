import test from "node:test";
import assert from "node:assert/strict";
import { databaseConnectionString } from "../lib/database-environment";

test("Previewはブランチ専用DBを選び、本番・共通DBの接続情報を使わない", () => {
  assert.equal(databaseConnectionString({ VERCEL_ENV: "preview", CAKE_TEST_DATABASE_URL: "branch-db", DATABASE_URL: "production-db" }), "branch-db");
  for (const CAKE_TEST_DATABASE_URL of [undefined, "", "   ", "[SENSITIVE]"]) {
    assert.throws(() => databaseConnectionString({ VERCEL_ENV: "preview", CAKE_TEST_DATABASE_URL, DATABASE_URL: "production-db" }), /CAKE_TEST_DATABASE_URL/);
  }
});

test("Productionはテスト用の接続情報があっても本番DBを使う", () => {
  assert.equal(databaseConnectionString({ VERCEL_ENV: "production", CAKE_TEST_DATABASE_URL: "branch-db", DATABASE_URL: "production-db" }), "production-db");
  assert.throws(() => databaseConnectionString({ VERCEL_ENV: "production", CAKE_TEST_DATABASE_URL: "branch-db" }), /DATABASE_URL/);
});

test("ローカル・Developmentは対象worktreeで設定したDATABASE_URLを使う", () => {
  for (const VERCEL_ENV of [undefined, "development"]) {
    assert.equal(databaseConnectionString({ VERCEL_ENV, DATABASE_URL: "local-test-db", CAKE_TEST_DATABASE_URL: "branch-db" }), "local-test-db");
  }
});

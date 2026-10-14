import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { databaseConnectionString, previewDatabaseIdentity } from "../lib/database-environment";

const preview = {
  VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "codex/feature", VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  CAKE_QA_SLOT: "qa1", CAKE_QA_PR: "34", CAKE_QA_LEASE_TOKEN: "00000000-0000-4000-8000-000000000001",
  CAKE_QA_SOURCE_BRANCH: "codex/feature", CAKE_QA_SOURCE_SHA: "a".repeat(40),
  CAKE_TEST_DATABASE_URL: "postgresql://user:private@ep-preview-pooler.ap-southeast-1.aws.neon.tech/cake",
  CAKE_QA_DATABASE_HOST: "ep-preview.ap-southeast-1.aws.neon.tech", CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.ap-southeast-1.aws.neon.tech",
};

test("Previewはブランチ専用DBを選び、本番・共通DBの接続情報を使わない", () => {
  assert.equal(databaseConnectionString(preview), preview.CAKE_TEST_DATABASE_URL);
  for (const CAKE_TEST_DATABASE_URL of [undefined, "", "   ", "[SENSITIVE]"]) {
    assert.throws(() => databaseConnectionString({ ...preview, CAKE_TEST_DATABASE_URL, DATABASE_URL: "production-db" }), /CAKE_TEST_DATABASE_URL/);
  }
});

test("feature枝・PR・完全SHA・lease・本番DB比較情報の欠落と不一致は接続前に停止する", () => {
  for (const field of ["VERCEL_GIT_COMMIT_REF", "VERCEL_GIT_COMMIT_SHA", "CAKE_QA_SLOT", "CAKE_QA_PR", "CAKE_QA_LEASE_TOKEN", "CAKE_QA_SOURCE_BRANCH", "CAKE_QA_SOURCE_SHA", "CAKE_QA_DATABASE_HOST", "CAKE_QA_PRODUCTION_DATABASE_HOST"]) {
    assert.throws(() => databaseConnectionString({ ...preview, [field]: undefined }), /QA貸出とDBの照合/);
  }
  for (const changed of [
    { CAKE_QA_SLOT: "qa4" }, { CAKE_QA_PR: "0" }, { CAKE_QA_LEASE_TOKEN: "other" },
    { CAKE_QA_SOURCE_BRANCH: "codex/other" }, { CAKE_QA_SOURCE_SHA: "b".repeat(40) },
    { VERCEL_GIT_COMMIT_REF: "qa1", CAKE_QA_SOURCE_BRANCH: "qa1" },
    { VERCEL_GIT_COMMIT_REF: "main", CAKE_QA_SOURCE_BRANCH: "main" },
    { CAKE_QA_DATABASE_HOST: "ep-other.ap-southeast-1.aws.neon.tech" },
    { CAKE_QA_PRODUCTION_DATABASE_HOST: preview.CAKE_QA_DATABASE_HOST },
    { DATABASE_URL: "postgresql://production:private@ep-preview.ap-southeast-1.aws.neon.tech/other-db" },
    { CAKE_TEST_DATABASE_URL: "postgresql://private@production.example.com/db" },
    { CAKE_TEST_DATABASE_URL: "postgresql://user:private@ep-preview.ap-southeast-1.aws.neon.tech/db%24cake_preview_guard%24" },
  ]) {
    assert.throws(() => databaseConnectionString({ ...preview, ...changed }), (error: unknown) => {
      assert.match(String(error), /QA貸出とDBの照合/);
      assert.doesNotMatch(String(error), /private|production\.example|postgresql:\/\//);
      return true;
    });
  }
});

test("同PRの完全SHA更新はDB identityを変えず、別PRやleaseのidentityは変わる", () => {
  const initial = previewDatabaseIdentity(preview);
  assert.deepEqual(previewDatabaseIdentity({ ...preview, VERCEL_GIT_COMMIT_SHA: "b".repeat(40), CAKE_QA_SOURCE_SHA: "b".repeat(40) }), initial);
  assert.equal(initial?.databaseHost, preview.CAKE_QA_DATABASE_HOST);
  assert.notDeepEqual(previewDatabaseIdentity({ ...preview, CAKE_QA_PR: "35" }), initial);
  assert.notDeepEqual(previewDatabaseIdentity({ ...preview, CAKE_QA_LEASE_TOKEN: "00000000-0000-4000-8000-000000000002" }), initial);
});

test("ProductionへQA metadataを誤供給した場合は本番DBにも接続しない", () => {
  assert.throws(() => databaseConnectionString({ ...preview, VERCEL_ENV: "production", DATABASE_URL: "production-db" }), /QA貸出とDBの照合/);
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

test("Cloud/PCは本番hostを受け取らず検証済みfingerprintでDBを分離する", () => {
  const hash = (host: string) => createHash("sha256").update(host).digest("hex");
  const environment = { ...preview, CAKE_QA_PRODUCTION_DATABASE_HOST: undefined,
    CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: hash(preview.CAKE_QA_PRODUCTION_DATABASE_HOST) };
  assert.equal(databaseConnectionString(environment), preview.CAKE_TEST_DATABASE_URL);
  for (const digest of ["", "broken", hash(preview.CAKE_QA_DATABASE_HOST)]) {
    assert.throws(() => databaseConnectionString({ ...environment, CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: digest }), /QA貸出とDBの照合/);
  }
  assert.throws(() => databaseConnectionString({ ...environment, CAKE_QA_PRODUCTION_DATABASE_HOST: preview.CAKE_QA_DATABASE_HOST }), /QA貸出とDBの照合/);
  assert.throws(() => databaseConnectionString({ VERCEL_ENV: "production", DATABASE_URL: "production-db", CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: environment.CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256 }), /QA貸出とDBの照合/);
});

test("QA endpointは検証済みfingerprintで完全照合し、pooler表記を正規化する", () => {
  const hash = (host: string) => createHash("sha256").update(host).digest("hex");
  const environment = { ...preview, CAKE_QA_DATABASE_HOST: undefined,
    CAKE_QA_DATABASE_HOST_SHA256: hash(preview.CAKE_QA_DATABASE_HOST),
    CAKE_QA_PRODUCTION_DATABASE_HOST: undefined,
    CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: hash(preview.CAKE_QA_PRODUCTION_DATABASE_HOST) };
  assert.equal(databaseConnectionString(environment), preview.CAKE_TEST_DATABASE_URL);
  assert.deepEqual(previewDatabaseIdentity(environment), previewDatabaseIdentity(preview));
  assert.equal(databaseConnectionString({ ...environment, CAKE_TEST_DATABASE_URL: preview.CAKE_TEST_DATABASE_URL.replace("-pooler", "") }), preview.CAKE_TEST_DATABASE_URL.replace("-pooler", ""));
  assert.equal(databaseConnectionString({ ...preview, CAKE_QA_DATABASE_HOST_SHA256: environment.CAKE_QA_DATABASE_HOST_SHA256 }), preview.CAKE_TEST_DATABASE_URL);
});

test("QA host fingerprintの欠落・不正・本番一致・plain hostとの競合は接続前に拒否する", () => {
  const hash = (host: string) => createHash("sha256").update(host).digest("hex");
  const environment = { ...preview, CAKE_QA_DATABASE_HOST: undefined,
    CAKE_QA_DATABASE_HOST_SHA256: hash(preview.CAKE_QA_DATABASE_HOST),
    CAKE_QA_PRODUCTION_DATABASE_HOST: undefined,
    CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: hash(preview.CAKE_QA_PRODUCTION_DATABASE_HOST) };
  for (const change of [
    { CAKE_QA_DATABASE_HOST_SHA256: undefined }, { CAKE_QA_DATABASE_HOST_SHA256: "" },
    { CAKE_QA_DATABASE_HOST_SHA256: "broken" }, { CAKE_QA_DATABASE_HOST_SHA256: "a".repeat(63) },
    { CAKE_QA_DATABASE_HOST_SHA256: hash("ep-other.mock.aws.neon.tech") },
    { CAKE_QA_DATABASE_HOST_SHA256: environment.CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256 },
    { CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: environment.CAKE_QA_DATABASE_HOST_SHA256 },
    { CAKE_QA_DATABASE_HOST: "ep-other.mock.aws.neon.tech" }, { CAKE_QA_DATABASE_HOST: "" },
    { CAKE_QA_PRODUCTION_DATABASE_HOST: preview.CAKE_QA_DATABASE_HOST },
    { DATABASE_URL: preview.CAKE_TEST_DATABASE_URL },
    { CAKE_TEST_DATABASE_URL: "postgresql://user:private@ep-other.mock.aws.neon.tech/cake" },
  ]) assert.throws(() => databaseConnectionString({ ...environment, ...change }), (error: unknown) => {
    assert.match(String(error), /QA貸出とDBの照合/);
    assert.doesNotMatch(String(error), /private|postgresql|ep-other/);
    return true;
  });
  assert.throws(() => databaseConnectionString({ ...preview, CAKE_QA_DATABASE_HOST_SHA256: hash("ep-other.mock.aws.neon.tech") }), /QA貸出とDBの照合/);
  assert.throws(() => databaseConnectionString({ ...environment, CAKE_QA_DATABASE_HOST_SHA256: hash(preview.CAKE_QA_PRODUCTION_DATABASE_HOST),
    CAKE_TEST_DATABASE_URL: `postgresql://user:private@${preview.CAKE_QA_PRODUCTION_DATABASE_HOST}/cake` }), /QA貸出とDBの照合/);
});

test("Production・Developmentに新しいQA host fingerprintが残っていれば接続を拒否する", () => {
  const digest = createHash("sha256").update(preview.CAKE_QA_DATABASE_HOST).digest("hex");
  for (const VERCEL_ENV of ["production", "development", undefined]) {
    for (const CAKE_QA_DATABASE_HOST_SHA256 of [digest, ""]) {
      assert.throws(() => databaseConnectionString({ VERCEL_ENV, DATABASE_URL: "production-db", CAKE_QA_DATABASE_HOST_SHA256 }), /QA貸出とDBの照合/);
    }
  }
});

import { createHash } from 'node:crypto';
import test from "node:test";
import assert from "node:assert/strict";
import {
  activeTestUsers,
  canUseAdministratorRole,
  isActiveTestIdentity,
  isKnownTestIdentity,
} from "../../lib/server/auth/test-fixture-context";
import { QA_TEST_USERS, TEST_USERS } from "../../lib/shared/test-users";
import type { RegisteredUser } from "../../lib/shared/types";

type Environment = Readonly<Record<string, string | undefined>>;

// These values satisfy the metadata guard without constructing a DB client.
const qaEnvironment: Environment = Object.freeze({
  AUTH_MODE: "test",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "codex/fixture-context",
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  CAKE_PREVIEW_REPOSITORY: "tyask/Cake", CAKE_PREVIEW_PHASE: "application", CAKE_PREVIEW_DATABASE_BRANCH_ID: "br-preview",
  CAKE_PREVIEW_PR: "34",
  CAKE_PREVIEW_GENERATION: "00000000-0000-4000-8000-000000000001",
  CAKE_PREVIEW_SOURCE_BRANCH: "codex/fixture-context",
  CAKE_PREVIEW_SOURCE_SHA: "a".repeat(40),
  CAKE_TEST_DATABASE_URL: "postgresql://fixture:dummy@ep-fixture-preview-pooler.ap-southeast-1.aws.neon.tech/cake_fixture",
  CAKE_PREVIEW_DATABASE_HOST_SHA256: createHash('sha256').update('ep-fixture-preview.ap-southeast-1.aws.neon.tech').digest('hex'),
  CAKE_PREVIEW_PRODUCTION_HOST_SHA256: createHash('sha256').update('ep-fixture-production.ap-southeast-1.aws.neon.tech').digest('hex'),
});

function registeredUser(
  identity: { id: string; email: string; name: string },
  overrides: Partial<RegisteredUser> = {},
): RegisteredUser {
  return { ...identity, imageUrl: null, isAdmin: true, isEnabled: true, ...overrides };
}

const invalidQaEnvironments: ReadonlyArray<{ label: string; environment: Environment }> = [
  { label: "未guarded Preview", environment: { AUTH_MODE: "test", VERCEL_ENV: "preview" } },
  { label: "DB世代未確認", environment: { ...qaEnvironment, CAKE_PREVIEW_GENERATION: undefined } },
  { label: "feature枝の不一致", environment: { ...qaEnvironment, VERCEL_GIT_COMMIT_REF: "codex/other" } },
  { label: "SHAの不一致", environment: { ...qaEnvironment, VERCEL_GIT_COMMIT_SHA: "b".repeat(40) } },
  { label: "endpoint未確認", environment: { ...qaEnvironment, CAKE_PREVIEW_DATABASE_HOST_SHA256: undefined } },
  { label: "endpointの不一致", environment: { ...qaEnvironment, CAKE_PREVIEW_DATABASE_HOST_SHA256: createHash('sha256').update('ep-fixture-other.ap-southeast-1.aws.neon.tech').digest('hex') } },
  { label: "Production endpointとの同一性", environment: { ...qaEnvironment, CAKE_PREVIEW_PRODUCTION_HOST_SHA256: qaEnvironment.CAKE_PREVIEW_DATABASE_HOST_SHA256 } },
  { label: "本番hostの比較証拠なし", environment: { ...qaEnvironment, CAKE_PREVIEW_PRODUCTION_HOST_SHA256: undefined } },
  { label: "ローカルへのQA metadata混入", environment: { ...qaEnvironment, VERCEL_ENV: undefined } },
  { label: "ProductionへのQA metadata混入", environment: { ...qaEnvironment, VERCEL_ENV: "production" } },
];

test("QA profileは照合済みPreviewだけで選び、通常環境ではlegacy profileを保つ", () => {
  assert.strictEqual(activeTestUsers(qaEnvironment), QA_TEST_USERS);
  for (const environment of [{}, { AUTH_MODE: "test" }, { VERCEL_ENV: "production" }]) {
    assert.strictEqual(activeTestUsers(environment), TEST_USERS);
  }
  assert.deepEqual(QA_TEST_USERS.map(({ id, email, isAdmin }) => ({ id, email, isAdmin })), [
    { id: "test-user-a", email: "test-a@cake.local", isAdmin: true },
    { id: "test-user-b", email: "test-b@cake.local", isAdmin: false },
  ]);
  assert.deepEqual(TEST_USERS.map(({ id, email }) => ({ id, email })), [
    { id: "test-user-a", email: "test-a@cake.local" },
    { id: "test-user-b", email: "test-b@cake.local" },
  ]);
});

test("既知テスト判定は両profileのID/emailペアを保持し、メールの空白と大小文字を正規化する", () => {
  for (const user of [...TEST_USERS, ...QA_TEST_USERS]) {
    assert.equal(isKnownTestIdentity(user), true);
    assert.equal(isKnownTestIdentity({ id: user.id, email: `  ${user.email.toUpperCase()}  ` }), true);
  }
  for (const profile of [TEST_USERS, QA_TEST_USERS]) {
    assert.equal(isKnownTestIdentity({ id: profile[0].id, email: profile[1].email }), false);
    assert.equal(isKnownTestIdentity({ id: profile[1].id, email: profile[0].email }), false);
    assert.equal(isKnownTestIdentity({ id: "other-user", email: profile[0].email }), false);
    assert.equal(isKnownTestIdentity({ id: profile[0].id, email: "other@example.com" }), false);
    assert.equal(isKnownTestIdentity({ id: profile[0].id, email: `test-a+alias@${profile[0].email.split("@")[1]}` }), false);
  }
  for (const identity of [{}, { id: "test-user-a" }, { email: "test-a@example.com" }, { id: "test-user-a", email: null }]) {
    assert.equal(isKnownTestIdentity(identity), false);
  }
});

test("active identityは両環境の同一ID/emailを受け入れ、未知メールやA/Bの取り違えを拒否する", () => {
  for (const user of QA_TEST_USERS) {
    assert.equal(isActiveTestIdentity(user, qaEnvironment), true);
    assert.equal(isActiveTestIdentity({ id: user.id, email: ` ${user.email.toUpperCase()} ` }, qaEnvironment), true);
    assert.equal(isActiveTestIdentity(user, {}), true);
  }
  for (const user of TEST_USERS) {
    assert.equal(isActiveTestIdentity(user, {}), true);
    assert.equal(isActiveTestIdentity(user, qaEnvironment), true);
  }
  assert.equal(isActiveTestIdentity({ id: QA_TEST_USERS[0].id, email: QA_TEST_USERS[1].email }, qaEnvironment), false);
  assert.equal(isActiveTestIdentity({ id: QA_TEST_USERS[0].id, email: "wrong@example.com" }, qaEnvironment), false);
  assert.equal(isActiveTestIdentity({ id: "ordinary-user", email: "ordinary@example.com" }, qaEnvironment), false);
});

test("QA guard失敗はactive profileで例外を伝え、identityと管理者判定ではfail closedする", () => {
  for (const { label, environment } of invalidQaEnvironments) {
    assert.throws(() => activeTestUsers(environment), /PreviewとDBの照合/, label);
    for (const user of [...TEST_USERS, ...QA_TEST_USERS]) {
      assert.equal(isActiveTestIdentity(user, environment), false, label);
      assert.equal(canUseAdministratorRole(registeredUser(user), environment), false, label);
    }
  }
});

test("有効なQAテスト認証で現在のDB管理者フラグを持つAだけを管理者として許可する", () => {
  const qaA = registeredUser(QA_TEST_USERS[0]);
  assert.equal(canUseAdministratorRole(qaA, qaEnvironment), true);
  assert.equal(canUseAdministratorRole({ ...qaA, email: ` ${qaA.email.toUpperCase()} ` }, qaEnvironment), true);
  assert.equal(canUseAdministratorRole(registeredUser(QA_TEST_USERS[1]), qaEnvironment), false);
  for (const legacyUser of TEST_USERS) {
    assert.equal(canUseAdministratorRole(registeredUser(legacyUser), { AUTH_MODE: "test" }), false);
  }
  for (const current of [
    { ...qaA, isAdmin: false },
    { ...qaA, isEnabled: false },
    { ...qaA, isAdmin: false, isEnabled: false },
  ]) {
    assert.equal(canUseAdministratorRole(current, qaEnvironment), false);
  }
});

test("QA fixtureのDB管理者フラグだけではGoogle・ローカル・Productionへ権限を持ち越せない", () => {
  const environments: Environment[] = [
    { ...qaEnvironment, AUTH_MODE: "google" },
    { ...qaEnvironment, AUTH_MODE: undefined },
    {},
    { AUTH_MODE: "test" },
    { AUTH_MODE: "test", VERCEL_ENV: "production" },
    { AUTH_MODE: "google", VERCEL_ENV: "production" },
  ];
  for (const environment of environments) {
    for (const user of [...TEST_USERS, ...QA_TEST_USERS]) {
      assert.equal(canUseAdministratorRole(registeredUser(user), environment), false);
    }
  }
});

test("通常利用者の管理者権限は現在のDBフラグで判定し、無効化・降格で失効する", () => {
  const current = registeredUser({ id: "ordinary-admin", email: "admin@example.com", name: "通常管理者" });
  for (const environment of [{}, { AUTH_MODE: "google", VERCEL_ENV: "production" }, qaEnvironment]) {
    assert.equal(canUseAdministratorRole(current, environment), true);
    assert.equal(canUseAdministratorRole({ ...current, isAdmin: false }, environment), false);
    assert.equal(canUseAdministratorRole({ ...current, isEnabled: false }, environment), false);
  }
});

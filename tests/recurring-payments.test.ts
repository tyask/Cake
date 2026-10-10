import test from "node:test";
import assert from "node:assert/strict";
import {
  createRecurringPaymentService, isRecurringUserEligible, RecurringPaymentError,
  recurringPaymentConfigSchema, recurringPaymentMutationSchema, recurringPaymentRecord, recurringSplitWeights,
} from "../lib/recurring-payments";
import type { RecurringPaymentLog, RecurringPaymentStore } from "../lib/recurring-payments";
import type { RecurringPaymentConfig } from "../lib/recurring-payment-types";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const paymentId = "00000000-0000-4000-8000-000000000002";
const config: RecurringPaymentConfig = { dayOfMonth: 27, merchant: "家賃", method: "銀行振込", amountYen: 100000,
  actorUserId: "a", expenseClass: "SHARED", splitWeights: { a: 1, b: 1 }, memo: "共有の家賃" };
const row = (overrides: Record<string, unknown> = {}) => ({
  id: paymentId, workspace_id: workspaceId, state: "ACTIVE", start_on: "2026-10-10", active_from_month: "2026-10-01",
  revision: 1, authorized_by: "a", day_of_month: config.dayOfMonth, merchant: config.merchant, method: config.method,
  amount_yen: config.amountYen, actor_user_id: config.actorUserId, expense_class: config.expenseClass,
  split_weights: { ...config.splitWeights }, memo: config.memo, pending_config: null, pending_effective_month: null,
  blocked_reason: null, last_generated_month: null, ...overrides,
});
function fixture() {
  const calls = { list: 0, mutate: 0, candidates: 0, generated: [] as string[] };
  const store: RecurringPaymentStore = {
    async list() { calls.list++; return { authorized: true, payments: [row()], eligibleActorUserIds: ["a", "b"] }; },
    async mutate() { calls.mutate++; return { payment: row() }; },
    async candidates() { calls.candidates++; return [{ id: paymentId, workspaceId }]; },
    async generate(candidate) { calls.generated.push(candidate.id); return { status: "created" }; },
  };
  const service = createRecurringPaymentService(store, { testMode: () => false });
  return { calls, store, service };
}
const now = new Date("2026-10-10T00:00:00Z");

test("入力はactionごとに厳密で、readonly列・日時の上書きを拒否する", () => {
  const create = { action: "create", workspaceId, startOn: "2026-10-10", ...config };
  assert.equal(recurringPaymentMutationSchema.safeParse(create).success, true);
  for (const additional of [{ state: "ACTIVE" }, { authorizedById: "b" }, { lastGeneratedMonth: null }, { now: "2026-10-09" }]) {
    assert.equal(recurringPaymentMutationSchema.safeParse({ ...create, ...additional }).success, false);
  }
  assert.equal(recurringPaymentMutationSchema.safeParse({ action: "update", workspaceId, paymentId, expectedRevision: 1, ...config }).success, true);
  assert.equal(recurringPaymentMutationSchema.safeParse({ action: "update", workspaceId, paymentId, expectedRevision: 1, ...config, startOn: "2026-10-11" }).success, false);
  for (const action of ["pause", "resume", "archive"]) {
    assert.equal(recurringPaymentMutationSchema.safeParse({ action, workspaceId, paymentId, expectedRevision: 1 }).success, true);
    assert.equal(recurringPaymentMutationSchema.safeParse({ action, workspaceId, paymentId, expectedRevision: 1, amountYen: 100 }).success, false);
  }
});

test("日付・金額・日・文字数・割合の境界を検証する", () => {
  for (const change of [{ dayOfMonth: 0 }, { dayOfMonth: 32 }, { dayOfMonth: 1.1 }, { amountYen: 0 },
    { amountYen: 2_147_483_648 }, { amountYen: 1.1 }, { merchant: " " }, { method: " " }, { expenseClass: "OTHER" },
    { splitWeights: { a: 0 } }, { splitWeights: { a: -1 } }, { splitWeights: { a: 1.2 } },
    { memo: "a".repeat(2001) }]) assert.equal(recurringPaymentConfigSchema.safeParse({ ...config, ...change }).success, false, JSON.stringify(change));
  assert.equal(recurringPaymentConfigSchema.parse({ ...config, merchant: " 家賃 " }).merchant, "家賃");
  assert.equal(recurringPaymentMutationSchema.safeParse({ action: "create", workspaceId, startOn: "2026-02-29", ...config }).success, false);
});

test("現在設定と未来の変更を返し、期限を過ぎたpendingは読込だけで論理適用する", () => {
  const future = { ...config, dayOfMonth: 10, amountYen: 110000 };
  const raw = row({ pending_config: future, pending_effective_month: "2026-11-01" });
  const october = recurringPaymentRecord(raw, "2026-10-28");
  assert.equal(october.currentConfig.amountYen, 100000);
  assert.equal(october.pendingConfig?.amountYen, 110000);
  assert.equal(october.nextScheduledOn, "2026-11-10");
  const november = recurringPaymentRecord(raw, "2026-11-10");
  assert.equal(november.currentConfig.amountYen, 110000);
  assert.equal(november.pendingConfig, null);
  assert.equal(november.pendingEffectiveMonth, null);
  assert.equal(november.revision, 1);
  assert.equal(raw.pending_config, future);
});

test("割合は既存検証を再利用し、新参加者には0だけを補い保存値を変えない", () => {
  const saved = { ...config, splitWeights: { a: 1 } };
  assert.throws(() => recurringSplitWeights(saved, ["a", "b"]), RecurringPaymentError);
  assert.deepEqual(recurringSplitWeights(saved, ["a", "b"], true), { a: 1, b: 0 });
  assert.deepEqual(saved.splitWeights, { a: 1 });
  assert.throws(() => recurringSplitWeights({ ...saved, splitWeights: { a: 1, unknown: 1 } }, ["a", "b"], true), RecurringPaymentError);
  assert.deepEqual(recurringSplitWeights({ ...saved, expenseClass: "PERSONAL" }, ["a", "b"], true), { a: 1, b: 0 });
  assert.throws(() => recurringSplitWeights({ ...config, expenseClass: "PERSONAL" }, ["a", "b"]), RecurringPaymentError);
});

test("本番/通常認証と固定test identityの境界をID・メール・有効状態で判定する", () => {
  const normal = { id: "a", email: "a@example.com", isEnabled: true };
  const testing = { id: "test-user-a", email: "test-a@cake.local", isEnabled: true };
  assert.equal(isRecurringUserEligible(normal, false), true);
  assert.equal(isRecurringUserEligible(normal, true), false);
  assert.equal(isRecurringUserEligible(testing, true), true);
  assert.equal(isRecurringUserEligible(testing, false), false);
  for (const impostor of [{ ...normal, email: testing.email }, { ...testing, email: normal.email }, { ...testing, id: "test-user-b" }]) {
    assert.equal(isRecurringUserEligible(impostor, true), false);
    assert.equal(isRecurringUserEligible(impostor, false), false);
  }
  assert.equal(isRecurringUserEligible({ ...testing, isEnabled: false }, true), false);
  assert.equal(isRecurringUserEligible({ ...normal, isEnabled: false }, false), false);
});

test("作成時はサーバーの日本時間を基準に開始日の過去入力をDBより前に拒否する", async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.mutateRecurringPayment("a", { action: "create", workspaceId, startOn: "2026-10-09", ...config }, now),
    (error: unknown) => error instanceof RecurringPaymentError && error.status === 400);
  assert.equal(calls.mutate, 0);
  await service.mutateRecurringPayment("a", { action: "create", workspaceId, startOn: "2026-10-10", ...config }, now);
  assert.equal(calls.mutate, 1);
});

test("DB例外は固定のHTTPコードへ変換し、内部文言を漏らさない", async () => {
  const { service, store } = fixture();
  const expected = [["P0400", 400, "INPUT_INVALID"], ["P0403", 403, "FORBIDDEN"], ["P0404", 404, "NOT_FOUND"],
    ["P0409", 409, "REVISION_CONFLICT"], ["23505", 503, "DATABASE_UNAVAILABLE"]] as const;
  for (const [code, status, publicCode] of expected) {
    store.mutate = async () => { throw { code, message: "private SQL with credentials" }; };
    await assert.rejects(service.mutateRecurringPayment("a", { action: "pause", workspaceId, paymentId, expectedRevision: 1 }, now),
      (error: unknown) => error instanceof RecurringPaymentError && error.status === status && error.code === publicCode && !error.message.includes("private"));
  }
});

test("手動実行は所属・利用可否を先に確認し、不許可時は候補も生成も実行しない", async () => {
  const { service, store, calls } = fixture();
  store.list = async () => ({ authorized: false, payments: [], eligibleActorUserIds: [] });
  await assert.rejects(service.runRecurringPayments({ workspaceId, authorizedUserId: "other", now, logger: () => {} }),
    (error: unknown) => error instanceof RecurringPaymentError && error.status === 403);
  assert.equal(calls.candidates, 0);
  assert.deepEqual(calls.generated, []);
  await assert.rejects(service.runRecurringPayments({ authorizedUserId: "a", now, logger: () => {} }),
    (error: unknown) => error instanceof RecurringPaymentError && error.status === 400);
});

test("runnerは失敗をその呼出しで再試行せず、次の設定を処理して固定ログへ集計する", async () => {
  const { service, store, calls } = fixture();
  const logs: RecurringPaymentLog[] = [];
  store.candidates = async () => ["failed", "created", "skipped", "blocked"].map(id => ({ id, workspaceId }));
  store.generate = async candidate => {
    calls.generated.push(candidate.id);
    if (candidate.id === "failed") throw new Error("secret database text");
    return candidate.id === "blocked" ? { status: "blocked", errorCode: "ACTOR_UNAVAILABLE" } : { status: candidate.id as "created" | "skipped" };
  };
  const result = await service.runRecurringPayments({ now, logger: entry => logs.push(entry) });
  assert.deepEqual(calls.generated, ["failed", "created", "skipped", "blocked"]);
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.unprocessed, 0);
  assert.equal(logs[0].event, "recurring.run.started");
  assert.equal(logs.at(-1)?.event, "recurring.run.completed");
  assert.equal(JSON.stringify(logs).includes("secret"), false);
  assert.equal(JSON.stringify(logs).includes("家賃"), false);
  assert.equal(logs.find(entry => entry.recurringPaymentId === "failed")?.errorCode, "DATABASE_UNAVAILABLE");
});

test("時間制限に達したら新規処理を開始せず、残りを未処理件数・ログに残す", async () => {
  const { store, calls } = fixture();
  let clock = 0;
  store.candidates = async () => ["first", "second", "third"].map(id => ({ id, workspaceId }));
  store.generate = async candidate => { calls.generated.push(candidate.id); clock = 50; return { status: "created" }; };
  const service = createRecurringPaymentService(store, { testMode: () => false, monotonicNow: () => clock });
  const logs: RecurringPaymentLog[] = [];
  const result = await service.runRecurringPayments({ now, maxDurationMs: 50, logger: entry => logs.push(entry) });
  assert.deepEqual(calls.generated, ["first"]);
  assert.equal(result.unprocessed, 2);
  assert.equal(logs.filter(entry => entry.errorCode === "TIME_LIMIT").length, 2);
});

test("候補抽出失敗とログ失敗は秘密値を公開せず、成功済み処理を妨げない", async () => {
  const { service, store, calls } = fixture();
  await service.runRecurringPayments({ now, logger: () => { throw new Error("logger failure"); } });
  assert.equal(calls.generated.length, 1);
  store.candidates = async () => { throw new Error("secret"); };
  await assert.rejects(service.runRecurringPayments({ now, logger: () => {} }),
    (error: unknown) => error instanceof RecurringPaymentError && error.status === 503 && !error.message.includes("secret"));
});

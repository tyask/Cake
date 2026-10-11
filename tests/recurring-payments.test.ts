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
  id: paymentId, workspace_id: workspaceId, state: "ACTIVE",
  revision: 1, authorized_by: "a", day_of_month: config.dayOfMonth, merchant: config.merchant, method: config.method,
  amount_yen: config.amountYen, actor_user_id: config.actorUserId, expense_class: config.expenseClass,
  split_weights: { ...config.splitWeights }, memo: config.memo,
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
  const create = { action: "create", workspaceId, ...config };
  assert.equal(recurringPaymentMutationSchema.safeParse(create).success, true);
  for (const additional of [{ startOn: "2026-10-10" }, { activeFromMonth: "2026-11-01" }, { pendingConfig: config },
    { pendingEffectiveMonth: "2026-11-01" }, { effectiveMonth: "2026-11-01" }, { state: "ACTIVE" },
    { authorizedById: "b" }, { lastGeneratedMonth: null }, { now: "2026-10-09" }]) {
    assert.equal(recurringPaymentMutationSchema.safeParse({ ...create, ...additional }).success, false);
  }
  assert.equal(recurringPaymentMutationSchema.safeParse({ action: "update", workspaceId, paymentId, expectedRevision: 1, ...config }).success, true);
  assert.equal(recurringPaymentMutationSchema.safeParse({ action: "update", workspaceId, paymentId, expectedRevision: 1, ...config, startOn: "2026-10-11" }).success, false);
  for (const action of ["pause", "resume", "archive"]) {
    assert.equal(recurringPaymentMutationSchema.safeParse({ action, workspaceId, paymentId, expectedRevision: 1 }).success, true);
    assert.equal(recurringPaymentMutationSchema.safeParse({ action, workspaceId, paymentId, expectedRevision: 1, amountYen: 100 }).success, false);
  }
});

test("金額・日・文字数・割合の境界を検証する", () => {
  for (const change of [{ dayOfMonth: 0 }, { dayOfMonth: 32 }, { dayOfMonth: 1.1 }, { amountYen: 0 },
    { amountYen: 2_147_483_648 }, { amountYen: 1.1 }, { merchant: " " }, { method: " " }, { expenseClass: "OTHER" },
    { splitWeights: { a: 0 } }, { splitWeights: { a: -1 } }, { splitWeights: { a: 1.2 } },
    { memo: "a".repeat(2001) }]) assert.equal(recurringPaymentConfigSchema.safeParse({ ...config, ...change }).success, false, JSON.stringify(change));
  assert.equal(recurringPaymentConfigSchema.parse({ ...config, merchant: " 家賃 " }).merchant, "家賃");
});

test("現在設定だけから予定を返し、互換用の開始日・適用月はAPIへ公開しない", () => {
  const raw = row({ day_of_month: 10, amount_yen: 110000,
    start_on: "2027-12-28", active_from_month: "2027-12-01", pending_config: null, pending_effective_month: null });
  const saved = recurringPaymentRecord(raw, "2026-10-10");
  assert.equal(saved.currentConfig.amountYen, 110000);
  assert.equal(saved.nextScheduledOn, "2026-10-10");
  for (const removed of ["startOn", "activeFromMonth", "pendingConfig", "pendingEffectiveMonth", "effectiveMonth"]) {
    assert.equal(removed in saved, false, removed);
  }
  assert.equal(recurringPaymentRecord(raw, "2026-10-11").nextScheduledOn, "2026-11-10");
  assert.equal(raw.start_on, "2027-12-28");
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

test("作成は開始日を保持せず、日本時間の日付を次回予定の計算だけに使う", async () => {
  const { service, store } = fixture();
  const input = { action: "create", workspaceId, ...config, dayOfMonth: 10 };
  const times: string[] = [];
  store.mutate = async (_userId, input, _testMode, clock) => {
    assert.equal(input.action, "create");
    assert.equal("startOn" in input, false);
    assert.equal("activeFromMonth" in input, false);
    times.push(clock.toISOString());
    return { payment: row({ day_of_month: 10 }) };
  };
  const beforeMidnight = await service.mutateRecurringPayment("a", input, new Date("2026-10-10T14:59:59.999Z"));
  const afterMidnight = await service.mutateRecurringPayment("a", input, new Date("2026-10-10T15:00:00Z"));
  assert.deepEqual(times, ["2026-10-10T14:59:59.999Z", "2026-10-10T15:00:00.000Z"]);
  assert.equal(beforeMidnight.payment.nextScheduledOn, "2026-10-10");
  assert.equal(afterMidnight.payment.nextScheduledOn, "2026-11-10");
});

test("編集応答は保存した金額と日を即時反映し、適用月や変更予定を返さない", async () => {
  const { service, store } = fixture();
  const input = { action: "update", workspaceId, paymentId, expectedRevision: 1, ...config, dayOfMonth: 10, amountYen: 110000 };
  store.mutate = async (userId, savedInput, testMode, clock) => {
    assert.equal(userId, "a");
    assert.equal(testMode, false);
    assert.equal(clock, now);
    assert.deepEqual(savedInput, input);
    return { payment: row({ day_of_month: 10, amount_yen: 110000, revision: 2 }) };
  };
  const result = await service.mutateRecurringPayment("a", input, now);
  assert.equal(result.payment.currentConfig.amountYen, 110000);
  assert.equal(result.payment.currentConfig.dayOfMonth, 10);
  assert.equal(result.payment.nextScheduledOn, "2026-10-10");
  assert.equal(result.payment.revision, 2);
  assert.deepEqual(Object.keys(result), ["payment"]);
});

test("再開は当日未生成の予定を即時返し、登録済み月は次回を翌月にする", async () => {
  const { service, store } = fixture();
  let generatedMonth: string | null = null;
  store.mutate = async (_userId, input) => {
    assert.equal(input.action, "resume");
    return { payment: row({ day_of_month: 10, last_generated_month: generatedMonth }) };
  };
  const input = { action: "resume", workspaceId, paymentId, expectedRevision: 1 };
  assert.equal((await service.mutateRecurringPayment("a", input, now)).payment.nextScheduledOn, "2026-10-10");
  generatedMonth = "2026-10-01";
  assert.equal((await service.mutateRecurringPayment("a", input, now)).payment.nextScheduledOn, "2026-11-10");
});

test("作成で開始日を指定しても過去・現在・未来を問わず保存前に拒否する", async () => {
  const { service, calls } = fixture();
  for (const startOn of ["2026-10-09", "2026-10-10", "2026-12-28"]) {
    await assert.rejects(service.mutateRecurringPayment("a", { action: "create", workspaceId, startOn, ...config }, now),
      (error: unknown) => error instanceof RecurringPaymentError && error.status === 400 && error.code === "INPUT_INVALID");
  }
  assert.equal(calls.mutate, 0);
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

test("runnerは実行日時の秒・ミリ秒を保ち、候補抽出と全明細生成へ同じ時刻を渡す", async () => {
  const { service, store } = fixture();
  const executedAt = new Date("2026-10-27T09:23:45.678+09:00");
  const generatedTimes: string[] = [];
  const logs: RecurringPaymentLog[] = [];
  store.candidates = async (scope, testMode, candidateTime) => {
    assert.equal(scope, undefined);
    assert.equal(testMode, false);
    assert.equal(candidateTime.toISOString(), "2026-10-27T00:23:45.678Z");
    return [paymentId, "00000000-0000-4000-8000-000000000003"].map(id => ({ id, workspaceId }));
  };
  store.generate = async (candidate, testMode, generatedAt) => {
    assert.equal(candidate.workspaceId, workspaceId);
    assert.equal(testMode, false);
    generatedTimes.push(generatedAt.toISOString());
    return { status: "created" };
  };
  const result = await service.runRecurringPayments({ now: executedAt, logger: entry => logs.push(entry) });
  assert.equal(result.created, 2);
  assert.deepEqual(generatedTimes, ["2026-10-27T00:23:45.678Z", "2026-10-27T00:23:45.678Z"]);
  assert.deepEqual(logs.filter(entry => entry.event === "recurring.payment.completed").map(entry => entry.scheduledOn),
    ["2026-10-27", "2026-10-27"]);
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

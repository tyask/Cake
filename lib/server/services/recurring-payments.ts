import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RecurringPaymentError } from "../errors";
export { RecurringPaymentError } from "../errors";
import { isTestAuthEnabled } from "../auth/auth-mode";
import { validateSplitWeights } from "../../shared/expense-splits";
import { recurringPaymentConfigSchema, recurringPaymentMutationSchema, type RecurringPaymentMutation } from "../../shared/schemas/recurring-payment-schemas";
export { recurringPaymentConfigSchema, recurringPaymentMutationSchema } from "../../shared/schemas/recurring-payment-schemas";
export type { RecurringPaymentMutation } from "../../shared/schemas/recurring-payment-schemas";
import { isRecurringBlockedReason, recurringDatabaseState, recurringDatabaseBlockedReason, type RecurringLogErrorCode, type RecurringLogStatus } from "../../shared/recurring-payment-types";
import { TEST_USERS } from "../../shared/test-users";
import { jstToday, nextScheduledOn } from "../../shared/recurring-payment-calendar";
import type {
  RecurringPayment, RecurringPaymentConfig, RecurringPaymentMutationResult,
  RecurringPaymentRunResult, RecurringPaymentsResponse,
} from "../../shared/recurring-payment-types";

export function isRecurringUserEligible(user: { id: string; email: string; isEnabled: boolean }, testMode: boolean): boolean {
  if (!user.isEnabled) return false;
  const email = user.email.toLowerCase();
  return testMode
    ? TEST_USERS.some(testUser => testUser.id === user.id && testUser.email === email)
    : !TEST_USERS.some(testUser => testUser.id === user.id || testUser.email === email);
}

/** Match saved member keys, then reuse the normal transaction ratio validator. */
export function recurringSplitWeights(config: RecurringPaymentConfig, memberIds: readonly string[], completeMissing = false) {
  if (Object.keys(config.splitWeights).some(id => !memberIds.includes(id))) throw new RecurringPaymentError("負担割合の参加者が一致しません。", 400, "SPLIT_MEMBERS_INVALID");
  const weights = completeMissing
    ? Object.fromEntries(memberIds.map(id => [id, config.splitWeights[id] ?? 0])) : config.splitWeights;
  try {
    return validateSplitWeights(weights, memberIds, config.expenseClass, config.actorUserId);
  } catch {
    throw new RecurringPaymentError("負担割合を確認してください。", 400, "SPLIT_MEMBERS_INVALID");
  }
}

type Row = Record<string, unknown>;
const rowConfig = (row: Row): RecurringPaymentConfig => recurringPaymentConfigSchema.parse({
  dayOfMonth: Number(row.day_of_month), merchant: row.merchant, method: row.method, amountYen: Number(row.amount_yen),
  actorUserId: row.actor_user_id, expenseClass: row.expense_class, splitWeights: row.split_weights, memo: row.memo,
});

export function recurringPaymentRecord(row: Row, now: Date): RecurringPayment {
  const payment: RecurringPayment = {
    id: String(row.id), workspaceId: String(row.workspace_id), state: recurringDatabaseState(row.state),
    revision: Number(row.revision),
    authorizedById: String(row.authorized_by), currentConfig: rowConfig(row),
    nextScheduledOn: null,
    blockedReason: recurringDatabaseBlockedReason(row.blocked_reason),
  };
  payment.nextScheduledOn = nextScheduledOn(payment, now);
  return payment;
}

interface SavedMutation { payment: Row }
interface RecurringCandidate { id: string; workspaceId: string }
interface GenerationResult { status: "created" | "skipped" | "blocked"; errorCode?: string }
export interface RecurringPaymentStore {
  list(workspaceId: string, userId: string, testMode: boolean): Promise<{ authorized: boolean; payments: Row[]; eligibleActorUserIds: string[] }>;
  mutate(userId: string, input: RecurringPaymentMutation, testMode: boolean, now: Date): Promise<SavedMutation>;
  candidates(workspaceId: string | undefined, testMode: boolean, now: Date): Promise<RecurringCandidate[]>;
  generate(candidate: RecurringCandidate, testMode: boolean, now: Date): Promise<GenerationResult>;
}

function fixedServiceError(error: unknown): RecurringPaymentError {
  if (error instanceof RecurringPaymentError) return error;
  if (error instanceof z.ZodError) return new RecurringPaymentError("入力内容を確認してください。", 400, "INPUT_INVALID");
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "P0403") return new RecurringPaymentError("このワークスペースを操作する権限がありません。", 403, "FORBIDDEN");
  if (code === "P0404") return new RecurringPaymentError("定期支払いが見つかりません。", 404, "NOT_FOUND");
  if (code === "P0409") return new RecurringPaymentError("設定が変更されています。一覧を更新してもう一度操作してください。", 409, "REVISION_CONFLICT");
  if (code === "P0400") return new RecurringPaymentError("支払者・負担割合・入力内容を確認してください。", 400, "INPUT_INVALID");
  return new RecurringPaymentError("定期支払いの処理に失敗しました。時間をおいて再度お試しください。", 503, "DATABASE_UNAVAILABLE");
}

export interface RecurringPaymentLog {
  event: "recurring.run.started" | "recurring.payment.completed" | "recurring.run.completed";
  runId: string;
  timestamp: string;
  status: RecurringLogStatus;
  workspaceId?: string;
  recurringPaymentId?: string;
  scheduledOn?: string;
  errorCode?: RecurringLogErrorCode;
  durationMs?: number;
  counts?: Omit<RecurringPaymentRunResult, "runId">;
}
interface RunOptions {
  workspaceId?: string;
  authorizedUserId?: string;
  now?: Date;
  maxDurationMs?: number;
  logger?: (entry: RecurringPaymentLog) => void;
}
export function createRecurringPaymentService(store: RecurringPaymentStore, options: { testMode?: () => boolean; monotonicNow?: () => number } = {}) {
  const mode = options.testMode ?? isTestAuthEnabled;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  async function listRecurringPayments(workspaceId: string, userId: string, now: Date = new Date()): Promise<RecurringPaymentsResponse> {
    try {
      z.uuid().parse(workspaceId);
      const result = await store.list(workspaceId, userId, mode());
      if (!result.authorized) throw new RecurringPaymentError("このワークスペースを操作する権限がありません。", 403, "FORBIDDEN");
      const today = jstToday(now);
      return { payments: result.payments.map(row => recurringPaymentRecord(row, now)), eligibleActorUserIds: result.eligibleActorUserIds,
        today, now: now.toISOString() };
    } catch (error) { throw fixedServiceError(error); }
  }
  async function mutateRecurringPayment(userId: string, input: unknown, now: Date = new Date()): Promise<RecurringPaymentMutationResult> {
    try {
      const parsed = recurringPaymentMutationSchema.parse(input);
      const result = await store.mutate(userId, parsed, mode(), now);
      return { payment: recurringPaymentRecord(result.payment, now) };
    } catch (error) { throw fixedServiceError(error); }
  }
  async function runRecurringPayments(input: RunOptions = {}): Promise<RecurringPaymentRunResult> {
    const now = input.now ?? new Date();
    const testMode = mode();
    // The caller cannot use a privileged runner to operate another workspace.
    if (input.authorizedUserId) {
      if (!input.workspaceId) throw new RecurringPaymentError("ワークスペースを指定してください。", 400, "INPUT_INVALID");
      await listRecurringPayments(input.workspaceId, input.authorizedUserId, now);
    }
    const result: RecurringPaymentRunResult = { runId: randomUUID(), candidates: 0, created: 0, skipped: 0, failed: 0, unprocessed: 0 };
    const started = monotonicNow();
    const logger = input.logger ?? ((entry: RecurringPaymentLog) => {
      if (entry.status === "failed") console.error(JSON.stringify(entry)); else console.log(JSON.stringify(entry));
    });
    const log = (entry: Omit<RecurringPaymentLog, "runId" | "timestamp">) => {
      try { logger({ ...entry, runId: result.runId, timestamp: new Date().toISOString() }); } catch { /* Logging does not change database outcomes. */ }
    };
    log({ event: "recurring.run.started", status: "started" });
    let candidates: RecurringCandidate[];
    try { candidates = await store.candidates(input.workspaceId, testMode, now); }
    catch {
      log({ event: "recurring.run.completed", status: "failed", errorCode: "DATABASE_UNAVAILABLE", durationMs: Math.round(monotonicNow() - started) });
      throw new RecurringPaymentError("定期支払いの処理に失敗しました。", 503, "DATABASE_UNAVAILABLE");
    }
    result.candidates = candidates.length;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (monotonicNow() - started >= (input.maxDurationMs ?? 240_000)) {
        result.unprocessed = candidates.length - index;
        for (const remaining of candidates.slice(index)) log({ event: "recurring.payment.completed", status: "unprocessed",
          workspaceId: remaining.workspaceId, recurringPaymentId: remaining.id, scheduledOn: jstToday(now), errorCode: "TIME_LIMIT" });
        break;
      }
      const paymentStarted = monotonicNow();
      let status: RecurringLogStatus;
      let errorCode: RecurringLogErrorCode | undefined;
      try {
        const generated = await store.generate(candidate, testMode, now);
        if (generated.status === "created") { result.created++; status = "created"; }
        else if (generated.status === "skipped") { result.skipped++; status = "skipped"; }
        else { result.failed++; status = "failed"; errorCode = isRecurringBlockedReason(generated.errorCode)
          ? generated.errorCode : "DATABASE_UNAVAILABLE"; }
      } catch { result.failed++; status = "failed"; errorCode = "DATABASE_UNAVAILABLE"; }
      log({ event: "recurring.payment.completed", status, errorCode, workspaceId: candidate.workspaceId,
        recurringPaymentId: candidate.id, scheduledOn: jstToday(now), durationMs: Math.round(monotonicNow() - paymentStarted) });
    }
    const counts = { candidates: result.candidates, created: result.created, skipped: result.skipped,
      failed: result.failed, unprocessed: result.unprocessed };
    log({ event: "recurring.run.completed", status: result.failed || result.unprocessed ? "failed" : "completed",
      durationMs: Math.round(monotonicNow() - started), counts });
    return result;
  }
  return { listRecurringPayments, mutateRecurringPayment, runRecurringPayments };
}

export type RecurringPaymentService = ReturnType<typeof createRecurringPaymentService>;

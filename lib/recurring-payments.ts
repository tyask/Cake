import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { isTestAuthEnabled } from "./auth-mode";
import { validateSplitWeights } from "./expense-splits";
import { transactionMemoSchema } from "./transaction-memo";
import { TEST_USERS } from "./test-users";
import { configForMonth, jstToday, monthOf, nextScheduledOn } from "./recurring-payment-calendar";
import type {
  RecurringPayment, RecurringPaymentConfig, RecurringPaymentMutationResult,
  RecurringPaymentRunResult, RecurringPaymentsResponse,
} from "./recurring-payment-types";

const configShape = {
  dayOfMonth: z.number().int().min(1).max(31),
  merchant: z.string().trim().min(1).max(240),
  method: z.string().trim().min(1).max(120),
  amountYen: z.number().int().positive().max(2_147_483_647),
  actorUserId: z.string().min(1),
  expenseClass: z.enum(["PERSONAL", "SHARED"]),
  splitWeights: z.record(z.string().min(1), z.number().int().min(0).max(2_147_483_647))
    .refine(weights => Object.values(weights).some(weight => weight > 0), "割合は少なくとも一人を1以上にしてください。"),
  memo: transactionMemoSchema,
};
export const recurringPaymentConfigSchema = z.object(configShape).strict();
const identityShape = { workspaceId: z.uuid(), paymentId: z.uuid(), expectedRevision: z.number().int().positive().max(2_147_483_647) };
export const recurringPaymentMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), workspaceId: z.uuid(), ...configShape }).strict(),
  z.object({ action: z.literal("update"), ...identityShape, ...configShape }).strict(),
  z.object({ action: z.literal("pause"), ...identityShape }).strict(),
  z.object({ action: z.literal("resume"), ...identityShape }).strict(),
  z.object({ action: z.literal("archive"), ...identityShape }).strict(),
]);
export type RecurringPaymentMutation = z.infer<typeof recurringPaymentMutationSchema>;
type StoredRecurringPaymentMutation = Exclude<RecurringPaymentMutation, { action: "create" }>
  | (Extract<RecurringPaymentMutation, { action: "create" }> & { startOn: string });

export class RecurringPaymentError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = "RecurringPaymentError";
  }
}

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
const dateText = (value: unknown): string => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const nullableDate = (value: unknown): string | null => value == null ? null : dateText(value);
const rowConfig = (row: Row): RecurringPaymentConfig => recurringPaymentConfigSchema.parse({
  dayOfMonth: Number(row.day_of_month), merchant: row.merchant, method: row.method, amountYen: Number(row.amount_yen),
  actorUserId: row.actor_user_id, expenseClass: row.expense_class, splitWeights: row.split_weights, memo: row.memo,
});

/** Reads logically promote a due pending change without modifying the database. */
export function recurringPaymentRecord(row: Row, today: string): RecurringPayment {
  const payment: RecurringPayment = {
    id: String(row.id), workspaceId: String(row.workspace_id), state: row.state as RecurringPayment["state"],
    startOn: dateText(row.start_on), activeFromMonth: dateText(row.active_from_month), revision: Number(row.revision),
    authorizedById: String(row.authorized_by), currentConfig: rowConfig(row),
    pendingConfig: row.pending_config == null ? null : recurringPaymentConfigSchema.parse(row.pending_config),
    pendingEffectiveMonth: nullableDate(row.pending_effective_month), nextScheduledOn: null,
    blockedReason: row.blocked_reason == null ? null : String(row.blocked_reason), lastGeneratedMonth: nullableDate(row.last_generated_month),
  };
  const effective = configForMonth(payment, monthOf(today));
  if (effective === payment.pendingConfig) {
    payment.currentConfig = effective;
    payment.pendingConfig = null;
    payment.pendingEffectiveMonth = null;
  }
  payment.nextScheduledOn = nextScheduledOn(payment, today);
  return payment;
}

interface SavedMutation { payment: Row; effectiveMonth?: string }
interface RecurringCandidate { id: string; workspaceId: string }
interface GenerationResult { status: "created" | "skipped" | "blocked"; errorCode?: string }
export interface RecurringPaymentStore {
  list(workspaceId: string, userId: string, testMode: boolean): Promise<{ authorized: boolean; payments: Row[]; eligibleActorUserIds: string[] }>;
  mutate(userId: string, input: StoredRecurringPaymentMutation, testMode: boolean, now: Date): Promise<SavedMutation>;
  candidates(workspaceId: string | undefined, testMode: boolean, now: Date): Promise<RecurringCandidate[]>;
  generate(candidate: RecurringCandidate, testMode: boolean, now: Date): Promise<GenerationResult>;
}

const databaseStore: RecurringPaymentStore = {
  async list(workspaceId, userId, testMode) {
    const rows = await db()`
      WITH authorized AS (
        SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
        WHERE w.id = ${workspaceId}::uuid AND m.user_id = ${userId} AND cake_recurring_user_allowed(${userId},${testMode})
      )
      SELECT EXISTS(SELECT 1 FROM authorized) AS authorized,
        COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at,p.id) FROM recurring_payments p
          JOIN authorized a ON a.id = p.workspace_id WHERE p.state <> 'ARCHIVED'),'[]'::jsonb) AS payments,
        COALESCE((SELECT jsonb_agg(m.user_id ORDER BY m.user_id) FROM workspace_members m JOIN authorized a ON a.id = m.workspace_id
          WHERE cake_recurring_user_allowed(m.user_id,${testMode})),'[]'::jsonb) AS eligible_actor_user_ids
    `;
    const row = rows[0];
    if (!row) throw new Error("Unavailable result");
    return { authorized: row.authorized === true, payments: row.payments as Row[], eligibleActorUserIds: row.eligible_actor_user_ids as string[] };
  },
  async mutate(userId, input, testMode, now) {
    const config = input.action === "create" || input.action === "update"
      ? recurringPaymentConfigSchema.parse(Object.fromEntries(Object.keys(configShape).map(key => [key, input[key as keyof typeof input]]))) : null;
    const rows = await db()`SELECT cake_mutate_recurring_payment(
      ${input.workspaceId}::uuid,${userId},${input.action},${"paymentId" in input ? input.paymentId : null}::uuid,
      ${"expectedRevision" in input ? input.expectedRevision : null}::integer,${"startOn" in input ? input.startOn : null}::date,
      ${config ? JSON.stringify(config) : null}::jsonb,${testMode},${now.toISOString()}::timestamptz
    ) AS result`;
    if (!rows[0]?.result) throw new Error("Unavailable result");
    return rows[0].result as SavedMutation;
  },
  async candidates(workspaceId, testMode, now) {
    const today = jstToday(now);
    const thisMonth = monthOf(today);
    const rows = await db()`SELECT id,workspace_id FROM recurring_payments p
      WHERE state = 'ACTIVE' AND (${workspaceId ?? null}::uuid IS NULL OR workspace_id = ${workspaceId ?? null}::uuid)
        AND start_on <= ${today}::date AND active_from_month <= ${thisMonth}::date
        AND (last_generated_month IS NULL OR last_generated_month < ${thisMonth}::date)
        AND cake_recurring_scheduled_on(${thisMonth}::date,CASE WHEN pending_effective_month <= ${thisMonth}::date
          THEN (pending_config->>'dayOfMonth')::integer ELSE day_of_month END) = ${today}::date
        AND cake_recurring_identity_matches(authorized_by,${testMode})
      ORDER BY workspace_id,id`;
    return rows.map(row => ({ id: String(row.id), workspaceId: String(row.workspace_id) }));
  },
  async generate(candidate, testMode, now) {
    const rows = await db()`SELECT cake_generate_recurring_payment(${candidate.workspaceId}::uuid,${candidate.id}::uuid,
      ${testMode},${now.toISOString()}::timestamptz) AS result`;
    if (!rows[0]?.result) throw new Error("Unavailable result");
    return rows[0].result as GenerationResult;
  },
};

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
  status: string;
  workspaceId?: string;
  recurringPaymentId?: string;
  scheduledOn?: string;
  errorCode?: string;
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
const blockedCodes = new Set(["AUTHORIZER_UNAVAILABLE", "ACTOR_UNAVAILABLE", "SPLIT_MEMBERS_INVALID", "SPLIT_USER_UNAVAILABLE", "CONFIG_INVALID"]);

export function createRecurringPaymentService(store: RecurringPaymentStore, options: { testMode?: () => boolean; monotonicNow?: () => number } = {}) {
  const mode = options.testMode ?? isTestAuthEnabled;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  async function listRecurringPayments(workspaceId: string, userId: string, now: Date = new Date()): Promise<RecurringPaymentsResponse> {
    try {
      z.uuid().parse(workspaceId);
      const result = await store.list(workspaceId, userId, mode());
      if (!result.authorized) throw new RecurringPaymentError("このワークスペースを操作する権限がありません。", 403, "FORBIDDEN");
      const today = jstToday(now);
      return { payments: result.payments.map(row => recurringPaymentRecord(row, today)), eligibleActorUserIds: result.eligibleActorUserIds, today };
    } catch (error) { throw fixedServiceError(error); }
  }
  async function mutateRecurringPayment(userId: string, input: unknown, now: Date = new Date()): Promise<RecurringPaymentMutationResult> {
    try {
      const parsed = recurringPaymentMutationSchema.parse(input);
      const today = jstToday(now);
      // The date is internal metadata. Clients choose only the recurring day.
      const storedInput = parsed.action === "create" ? { ...parsed, startOn: today } : parsed;
      const result = await store.mutate(userId, storedInput, mode(), now);
      return { payment: recurringPaymentRecord(result.payment, today),
        ...(result.effectiveMonth ? { effectiveMonth: dateText(result.effectiveMonth) } : {}) };
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
      let status: string;
      let errorCode: string | undefined;
      try {
        const generated = await store.generate(candidate, testMode, now);
        if (generated.status === "created") { result.created++; status = "created"; }
        else if (generated.status === "skipped") { result.skipped++; status = "skipped"; }
        else { result.failed++; status = "failed"; errorCode = generated.errorCode && blockedCodes.has(generated.errorCode)
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

const defaultService = createRecurringPaymentService(databaseStore);
export const listRecurringPayments = defaultService.listRecurringPayments;
export const mutateRecurringPayment = defaultService.mutateRecurringPayment;
export const runRecurringPayments = defaultService.runRecurringPayments;

import type { RecurringPaymentConfig } from "./schemas/recurring-payment-schemas";
export type { RecurringPaymentConfig, RecurringPaymentMutation, RecurringPaymentMutationDraft } from "./schemas/recurring-payment-schemas";

export const recurringPaymentStates = ["ACTIVE", "PAUSED", "BLOCKED", "ARCHIVED"] as const;
export type RecurringPaymentState = typeof recurringPaymentStates[number];
export const recurringPaymentStateLabels = {
  ACTIVE: "有効", PAUSED: "停止中", BLOCKED: "要確認", ARCHIVED: "要確認",
} satisfies Record<RecurringPaymentState, string>;

export const recurringBlockedReasons = ["AUTHORIZER_UNAVAILABLE", "ACTOR_UNAVAILABLE", "SPLIT_MEMBERS_INVALID", "SPLIT_USER_UNAVAILABLE", "CONFIG_INVALID"] as const;
export type RecurringBlockedReason = typeof recurringBlockedReasons[number];
const blockedReasonLabels = {
  AUTHORIZER_UNAVAILABLE: "実行を承認した利用者が利用できなくなりました。",
  ACTOR_UNAVAILABLE: "支払者が利用できなくなりました。",
  SPLIT_MEMBERS_INVALID: "負担割合の参加者が一致しません。",
  SPLIT_USER_UNAVAILABLE: "費用を負担する利用者が利用できなくなりました。",
  CONFIG_INVALID: "定期支払いの設定を確認する必要があります。",
} satisfies Record<RecurringBlockedReason, string>;
export const isRecurringBlockedReason = (value: unknown): value is RecurringBlockedReason =>
  typeof value === "string" && Object.hasOwn(blockedReasonLabels, value);
export function blockedReasonLabel(reason: RecurringPayment["blockedReason"]): string {
  return isRecurringBlockedReason(reason) ? blockedReasonLabels[reason] : blockedReasonLabels.CONFIG_INVALID;
}
export function recurringPaymentStateLabel(state: RecurringPayment["state"]): string {
  return Object.hasOwn(recurringPaymentStateLabels, state)
    ? recurringPaymentStateLabels[state as RecurringPaymentState] : recurringPaymentStateLabels.BLOCKED;
}

// Unknown strings can enter a DTO only through the DB conversion boundary.
declare const unknownDatabaseValue: unique symbol;
type UnknownDatabaseValue = string & { readonly [unknownDatabaseValue]: true };
export function recurringDatabaseState(value: unknown): RecurringPayment["state"] {
  const state = String(value);
  return recurringPaymentStates.find(known => known === state) ?? state as UnknownDatabaseValue;
}
export function recurringDatabaseBlockedReason(value: unknown): RecurringPayment["blockedReason"] {
  if (value == null) return null;
  const reason = String(value);
  return isRecurringBlockedReason(reason) ? reason : reason as UnknownDatabaseValue;
}
export const recurringServiceErrorCodes = ["UNAUTHENTICATED", "INPUT_INVALID", "FORBIDDEN", "NOT_FOUND", "REVISION_CONFLICT", "DATABASE_UNAVAILABLE"] as const;
export type RecurringServiceErrorCode = typeof recurringServiceErrorCodes[number] | RecurringBlockedReason;
export type RecurringLogErrorCode = RecurringServiceErrorCode | "TIME_LIMIT";
export const recurringLogStatuses = ["started", "created", "skipped", "failed", "unprocessed", "completed"] as const;
export type RecurringLogStatus = typeof recurringLogStatuses[number];

export interface RecurringPayment {
  id: string;
  workspaceId: string;
  state: RecurringPaymentState | UnknownDatabaseValue;
  revision: number;
  authorizedById: string;
  currentConfig: RecurringPaymentConfig;
  nextScheduledOn: string | null;
  blockedReason: RecurringBlockedReason | UnknownDatabaseValue | null;
}

export interface RecurringPaymentsResponse {
  payments: RecurringPayment[];
  eligibleActorUserIds: string[];
  today: string;
  now: string;
}

export interface RecurringPaymentMutationResult {
  payment: RecurringPayment;
}

export interface RecurringPaymentRunResult {
  runId: string;
  candidates: number;
  created: number;
  skipped: number;
  failed: number;
  unprocessed: number;
}

import type { ExpenseClass, SplitWeights } from "./types";

export type RecurringPaymentState = "ACTIVE" | "PAUSED" | "BLOCKED" | "ARCHIVED";

export interface RecurringPaymentConfig {
  dayOfMonth: number;
  merchant: string;
  method: string;
  amountYen: number;
  actorUserId: string;
  expenseClass: ExpenseClass;
  splitWeights: SplitWeights;
  memo: string;
}

export interface RecurringPayment {
  id: string;
  workspaceId: string;
  state: RecurringPaymentState;
  revision: number;
  authorizedById: string;
  currentConfig: RecurringPaymentConfig;
  nextScheduledOn: string | null;
  blockedReason: string | null;
  lastGeneratedMonth: string | null;
}

export interface RecurringPaymentsResponse {
  payments: RecurringPayment[];
  eligibleActorUserIds: string[];
  today: string;
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

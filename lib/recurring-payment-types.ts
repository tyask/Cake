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
  startOn: string;
  activeFromMonth: string;
  revision: number;
  authorizedById: string;
  currentConfig: RecurringPaymentConfig;
  pendingConfig: RecurringPaymentConfig | null;
  pendingEffectiveMonth: string | null;
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
  effectiveMonth?: string;
}

export interface RecurringPaymentRunResult {
  runId: string;
  candidates: number;
  created: number;
  skipped: number;
  failed: number;
  unprocessed: number;
}

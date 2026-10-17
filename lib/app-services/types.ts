import type { AppActionInput } from "../app-input";
import type { ExpenseClass, SplitWeights, TransactionRecord } from "../types";

export type Action<K extends AppActionInput["action"]> = Extract<AppActionInput, { action: K }>;
export type TransactionSplit = { expenseClass: ExpenseClass; splitWeights: SplitWeights };
export type SettlementTransaction = Pick<TransactionRecord, "id" | "actorUserId" | "type" | "amountYen" | "expenseClass" | "splitWeights">;

import type { AppActionInput } from "../../shared/schemas/app-input";
import type { ExpenseClass, SplitWeights, TransactionRecord } from "../../shared/types";

export type Action<K extends AppActionInput["action"]> = Extract<AppActionInput, { action: K }>;
export type TransactionSplit = { expenseClass: ExpenseClass; splitWeights: SplitWeights };
export type SettlementTransaction = Pick<TransactionRecord, "id" | "actorUserId" | "type" | "amountYen" | "expenseClass" | "splitWeights">;

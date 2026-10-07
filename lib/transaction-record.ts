import type { SplitWeights, TransactionRecord } from "./types";

export function transactionRecord(row: Record<string, unknown>, actorName = String(row.actor_name ?? "")): TransactionRecord {
  return {
    id: String(row.id), occurredAt: new Date(String(row.occurred_at)).toISOString(),
    merchant: String(row.merchant), method: String(row.method), memo: String(row.memo ?? ""),
    type: row.type as TransactionRecord["type"], amountYen: Number(row.amount_yen),
    actorUserId: String(row.actor_user_id), actorName,
    expenseClass: row.expense_class as TransactionRecord["expenseClass"],
    splitWeights: row.split_weights as SplitWeights,
    settledAt: row.settled_at ? new Date(String(row.settled_at)).toISOString() : null,
    externalId: String(row.external_id), source: row.source as TransactionRecord["source"],
  };
}

import type { SplitWeights, TransactionRecord } from "./types";

function isoTimestamp(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

export function transactionRecord(row: Record<string, unknown>, actorName = String(row.actor_name ?? "")): TransactionRecord {
  return {
    id: String(row.id), occurredAt: isoTimestamp(row.occurred_at),
    merchant: String(row.merchant), method: String(row.method), memo: String(row.memo ?? ""),
    type: row.type as TransactionRecord["type"], amountYen: Number(row.amount_yen),
    actorUserId: String(row.actor_user_id), actorName,
    expenseClass: row.expense_class as TransactionRecord["expenseClass"],
    splitWeights: row.split_weights as SplitWeights,
    settledAt: row.settled_at ? isoTimestamp(row.settled_at) : null,
    externalId: String(row.external_id), source: row.source as TransactionRecord["source"],
    categoryId: row.category_id == null ? null : String(row.category_id),
    categoryConfirmed: row.category_confirmed === true,
  };
}

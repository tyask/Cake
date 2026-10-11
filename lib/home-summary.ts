import type { TransactionRecord } from "./types";

const japanMonth = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
});

/** The home indicator follows the Japanese calendar, including its year. */
export function currentMonthTransactions(transactions: readonly TransactionRecord[], now = new Date()): TransactionRecord[] {
  const month = japanMonth.format(now);
  return transactions.filter(item => japanMonth.format(new Date(item.occurredAt)) === month);
}

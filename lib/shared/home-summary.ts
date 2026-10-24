import type { TransactionRecord } from "./types";

const japanMonth = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
});

/** The home indicator follows the Japanese calendar, including its year. */
export function currentMonthTransactions(transactions: readonly TransactionRecord[], now = new Date()): TransactionRecord[] {
  const month = japanMonth.format(now);
  return transactions.filter(item => japanMonth.format(new Date(item.occurredAt)) === month);
}

/** Income and spending are stored as positive yen; cashflow is income minus spending. */
export function cashflowSummary(transactions: readonly Pick<TransactionRecord, "type" | "amountYen">[]) {
  let paymentTotal = BigInt(0);
  let receiptTotal = BigInt(0);
  for (const transaction of transactions) {
    if (transaction.type === "PAYMENT") paymentTotal += BigInt(transaction.amountYen);
    else receiptTotal += BigInt(transaction.amountYen);
  }
  return { paymentTotal, receiptTotal, balanceYen: receiptTotal - paymentTotal };
}

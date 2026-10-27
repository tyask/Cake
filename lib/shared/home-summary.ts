import { splitAmounts } from "./split-allocations";
import { isCalendarDate, jstToday } from "./recurring-payment-calendar";
import type { TransactionRecord, WorkspaceMember } from "./types";

export function homeMonth(now = new Date()): string { return jstToday(now).slice(0, 7); }

export function isHomeMonth(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value) && isCalendarDate(`${value}-01`);
}

/** Select the entire Japanese calendar month, including settled and future entries. */
export function transactionsInMonth(transactions: readonly TransactionRecord[], month: string): TransactionRecord[] {
  if (!isHomeMonth(month)) throw new RangeError("対象年月が不正です。");
  return transactions.filter(item => homeMonth(new Date(item.occurredAt)) === month);
}

/** The home indicator follows the Japanese calendar, including its year. */
export function currentMonthTransactions(transactions: readonly TransactionRecord[], now = new Date()): TransactionRecord[] {
  return transactionsInMonth(transactions, homeMonth(now));
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

/** Use the same per-transaction whole-yen allocation as the spending analytics. */
export function personalCashflowSummary(
  transactions: readonly TransactionRecord[],
  members: readonly Pick<WorkspaceMember, "id">[],
  userId: string,
) {
  return cashflowSummary(transactions
    .filter(item => item.expenseClass === "SHARED" || item.actorUserId === userId)
    .map(item => ({
      type: item.type,
      amountYen: item.expenseClass === "PERSONAL" ? item.amountYen
        : splitAmounts(item.amountYen, item.splitWeights, members)[userId] ?? 0,
    })));
}

/** Allocate each shared entry once so member columns and their total use identical whole yen. */
export function workspaceCashflowSummary(
  transactions: readonly TransactionRecord[], members: readonly Pick<WorkspaceMember, "id">[],
) {
  const people = new Map(members.map(member => [member.id, cashflowSummary([])]));
  for (const transaction of transactions) {
    const amounts = transaction.expenseClass === "PERSONAL"
      ? { [transaction.actorUserId]: transaction.amountYen }
      : splitAmounts(transaction.amountYen, transaction.splitWeights, members);
    for (const [id, amount] of Object.entries(amounts)) {
      const person = people.get(id);
      if (!person) continue;
      if (transaction.type === "RECEIPT") person.receiptTotal += BigInt(amount);
      else person.paymentTotal += BigInt(amount);
      person.balanceYen = person.receiptTotal - person.paymentTotal;
    }
  }
  const total = cashflowSummary([]);
  for (const person of people.values()) {
    total.receiptTotal += person.receiptTotal;
    total.paymentTotal += person.paymentTotal;
    total.balanceYen += person.balanceYen;
  }
  return { people, total };
}

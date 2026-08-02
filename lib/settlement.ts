import type { SettlementResult, TransactionRecord, WorkspaceMember } from "./types";

export function calculateSettlement(
  members: WorkspaceMember[],
  transactions: TransactionRecord[],
): SettlementResult | null {
  if (members.length !== 2) return null;

  const targetTransactions = transactions.filter(
    (item) => item.expenseClass === "SHARED" && !item.settledAt,
  );
  if (targetTransactions.length === 0) return null;

  const paymentTotal = targetTransactions
    .filter((item) => item.type === "PAYMENT")
    .reduce((total, item) => total + item.amountYen, 0);
  const receiptTotal = targetTransactions
    .filter((item) => item.type === "RECEIPT")
    .reduce((total, item) => total + item.amountYen, 0);
  const netTotal = paymentTotal - receiptTotal;
  const weightTotal = members[0].weight + members[1].weight;

  const firstTarget = Math.round((netTotal * members[0].weight) / weightTotal);
  const targets = [firstTarget, netTotal - firstTarget];
  const people = members.map((member, index) => {
    const own = targetTransactions.filter((item) => item.actorUserId === member.id);
    const payments = own
      .filter((item) => item.type === "PAYMENT")
      .reduce((total, item) => total + item.amountYen, 0);
    const receipts = own
      .filter((item) => item.type === "RECEIPT")
      .reduce((total, item) => total + item.amountYen, 0);
    const actual = payments - receipts;
    return {
      userId: member.id,
      name: member.name,
      weight: member.weight,
      payments,
      receipts,
      actual,
      target: targets[index],
      balance: actual - targets[index],
    };
  });

  const payer = people.find((person) => person.balance < 0) ?? null;
  const payee = people.find((person) => person.balance > 0) ?? null;

  return {
    transactionIds: targetTransactions.map((item) => item.id),
    paymentTotal,
    receiptTotal,
    netTotal,
    people,
    payerUserId: payer?.userId ?? null,
    payerName: payer?.name ?? null,
    payeeUserId: payee?.userId ?? null,
    payeeName: payee?.name ?? null,
    amountYen: payer ? Math.abs(payer.balance) : 0,
  };
}


import type { SettlementResult, TransactionRecord, WorkspaceMember } from "./types";
import { validateSplitWeights } from "./expense-splits";

function gcd(a: bigint, b: bigint): bigint {
  while (b !== BigInt(0)) [a, b] = [b, a % b];
  return a < BigInt(0) ? -a : a;
}

function addFraction(first: [bigint, bigint], second: [bigint, bigint]): [bigint, bigint] {
  const denominatorGcd = gcd(first[1], second[1]);
  const numerator = first[0] * (second[1] / denominatorGcd) + second[0] * (first[1] / denominatorGcd);
  const denominator = first[1] * (second[1] / denominatorGcd);
  const divisor = gcd(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}

/** Match Math.round, including negative halves, without binary floating-point drift. */
function roundFraction([numerator, denominator]: [bigint, bigint]): number {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return Number(quotient + (remainder * BigInt(2) >= denominator ? BigInt(1) : remainder * BigInt(-2) > denominator ? BigInt(-1) : BigInt(0)));
}

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
  const firstBurden = targetTransactions.reduce<[bigint, bigint]>((total, item) => {
    if (!members.some((member) => member.id === item.actorUserId)) {
      throw new Error("清算対象の明細に参加者以外の担当者が含まれています。");
    }
    if (!Number.isSafeInteger(item.amountYen) || item.amountYen <= 0) {
      throw new Error("清算対象の金額が不正です。");
    }
    const weights = validateSplitWeights(item.splitWeights, members);
    const signedAmount = BigInt(item.type === "PAYMENT" ? item.amountYen : -item.amountYen);
    return addFraction(total, [
      signedAmount * BigInt(weights[members[0].id]),
      BigInt(weights[members[0].id] + weights[members[1].id]),
    ]);
  }, [BigInt(0), BigInt(1)]);
  const firstTarget = roundFraction(firstBurden);
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

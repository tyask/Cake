import assert from "node:assert/strict";
import test from "node:test";
import { cashflowSummary, currentMonthTransactions, personalCashflowSummary } from "../../lib/shared/home-summary";
import type { TransactionRecord } from "../../lib/shared/types";

function transaction(id: string, occurredAt: string): TransactionRecord {
  return { id, occurredAt, merchant: "家賃", method: "銀行振込", memo: "", type: "PAYMENT", amountYen: 100000,
    actorUserId: "a", actorName: "A", expenseClass: "PERSONAL", splitWeights: { a: 1 }, settledAt: null,
    externalId: id, source: "MANUAL", categoryId: null, categoryConfirmed: false, categoryRevision: 0 };
}

test("home month excludes the same month in previous years", () => {
  const current = transaction("current", "2026-10-27T00:00:00+09:00");
  assert.deepEqual(currentMonthTransactions([transaction("old", "2025-10-27T00:00:00+09:00"), current,
    transaction("next", "2026-11-01T00:00:00+09:00")], new Date("2026-10-10T09:00:00+09:00")), [current]);
});

test("home month includes midnight Japan entries across UTC month and year boundaries", () => {
  const midnight = transaction("january", "2026-12-31T15:00:00Z");
  const december = transaction("december", "2026-12-31T14:59:59Z");
  assert.deepEqual(currentMonthTransactions([midnight, december], new Date("2026-12-31T15:00:01Z")), [midnight]);
});

test("今月の収支は個人・共有と清算状態を問わず、月全体の収入から支払いを引く", () => {
  const entries: TransactionRecord[] = [
    { ...transaction("salary", "2026-10-25T00:00:00+09:00"), type: "RECEIPT", amountYen: 300_000 },
    { ...transaction("rent", "2026-10-01T00:00:00+09:00"), amountYen: 100_000, expenseClass: "SHARED", splitWeights: { a: 1, b: 1 }, settledAt: "2026-10-02T00:00:00Z" },
    { ...transaction("food", "2026-10-10T00:00:00+09:00"), amountYen: 50_000 },
    { ...transaction("refund", "2026-10-12T00:00:00+09:00"), type: "RECEIPT", amountYen: 10_000, actorUserId: "b", actorName: "B", expenseClass: "SHARED", splitWeights: { a: 1, b: 1 } },
    { ...transaction("previous", "2026-09-30T23:59:59+09:00"), type: "RECEIPT", amountYen: 999_999 },
    { ...transaction("next", "2026-11-01T00:00:00+09:00"), amountYen: 999_999 },
  ];
  const now = new Date("2026-10-10T09:00:00+09:00");
  const month = currentMonthTransactions(entries, now);
  assert.deepEqual(cashflowSummary(month), {
    paymentTotal: BigInt(150_000), receiptTotal: BigInt(310_000), balanceYen: BigInt(160_000),
  });
  assert.deepEqual(cashflowSummary(month.map(item => ({ ...item, settledAt: "2026-10-31T00:00:00Z" }))), cashflowSummary(month));
});

test("支払いのみ・収入のみ・同額・明細なしの収支を正しい符号で計算する", () => {
  const payment = { type: "PAYMENT" as const, amountYen: 5_000 };
  const receipt = { type: "RECEIPT" as const, amountYen: 5_000 };
  assert.equal(cashflowSummary([payment]).balanceYen, BigInt(-5_000));
  assert.equal(cashflowSummary([receipt]).balanceYen, BigInt(5_000));
  assert.equal(cashflowSummary([payment, receipt]).balanceYen, BigInt(0));
  assert.deepEqual(cashflowSummary([]), { paymentTotal: BigInt(0), receiptTotal: BigInt(0), balanceYen: BigInt(0) });
});

test("未清算の共有収支は収入から支払いを引き、個人と清算済みを含めない", () => {
  const entries: TransactionRecord[] = [
    { ...transaction("shared-payment", "2026-09-01T00:00:00+09:00"), amountYen: 4_000, expenseClass: "SHARED" },
    { ...transaction("shared-income", "2026-10-01T00:00:00+09:00"), type: "RECEIPT", amountYen: 10_000, expenseClass: "SHARED" },
    { ...transaction("settled", "2026-10-01T00:00:00+09:00"), amountYen: 100_000, expenseClass: "SHARED", settledAt: "2026-10-02T00:00:00Z" },
    { ...transaction("personal", "2026-10-01T00:00:00+09:00"), type: "RECEIPT", amountYen: 100_000 },
  ];
  assert.deepEqual(cashflowSummary(entries.filter(item => item.expenseClass === "SHARED" && !item.settledAt)), {
    paymentTotal: BigInt(4_000), receiptTotal: BigInt(10_000), balanceYen: BigInt(6_000),
  });
});

test("自分の支出は立替額に依存せず共有費の本人負担と個人費を合算する", () => {
  const shared = { ...transaction("shared", "2026-10-01T00:00:00+09:00"),
    expenseClass: "SHARED" as const, splitWeights: { a: 3, b: 2 } };
  const entries = [shared,
    { ...transaction("personal", shared.occurredAt), amountYen: 20_000, splitWeights: { a: 1, b: 0 } },
    { ...transaction("hidden", shared.occurredAt), actorUserId: "b", amountYen: 99_999, splitWeights: { a: 0, b: 1 } },
  ];
  const members = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(personalCashflowSummary(entries, members, "a"), {
    paymentTotal: BigInt(80_000), receiptTotal: BigInt(0), balanceYen: BigInt(-80_000),
  });
  assert.deepEqual(personalCashflowSummary(entries.map(item => item.id === shared.id
    ? { ...item, actorUserId: "b", settledAt: "2026-10-02T00:00:00Z" } : item), members, "a"),
  personalCashflowSummary(entries, members, "a"));
  assert.deepEqual(personalCashflowSummary(entries, members, "b"), {
    paymentTotal: BigInt(139_999), receiptTotal: BigInt(0), balanceYen: BigInt(-139_999),
  });
});

test("共有の収入も保存割合で整数円配分し、個人収入と合わせて収支を計算する", () => {
  const members = [{ id: "a" }, { id: "b" }];
  const entries: TransactionRecord[] = [
    { ...transaction("shared", "2026-10-01T00:00:00+09:00"), expenseClass: "SHARED", amountYen: 101, splitWeights: { a: 1, b: 1 } },
    { ...transaction("refund", "2026-10-02T00:00:00+09:00"), type: "RECEIPT", expenseClass: "SHARED", actorUserId: "b", amountYen: 31, splitWeights: { a: 1, b: 1 } },
    { ...transaction("salary", "2026-10-03T00:00:00+09:00"), type: "RECEIPT", amountYen: 1_000, splitWeights: { a: 1, b: 0 } },
  ];
  assert.deepEqual(personalCashflowSummary(entries, members, "a"), { paymentTotal: BigInt(51), receiptTotal: BigInt(1_016), balanceYen: BigInt(965) });
  assert.deepEqual(personalCashflowSummary(entries, members, "b"), { paymentTotal: BigInt(50), receiptTotal: BigInt(15), balanceYen: BigInt(-35) });
  assert.deepEqual(personalCashflowSummary([], members, "a"), { paymentTotal: BigInt(0), receiptTotal: BigInt(0), balanceYen: BigInt(0) });
});

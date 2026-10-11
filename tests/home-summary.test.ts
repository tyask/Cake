import assert from "node:assert/strict";
import test from "node:test";
import { currentMonthTransactions } from "../lib/home-summary";
import type { TransactionRecord } from "../lib/types";

function transaction(id: string, occurredAt: string): TransactionRecord {
  return { id, occurredAt, merchant: "家賃", method: "銀行振込", memo: "", type: "PAYMENT", amountYen: 100000,
    actorUserId: "a", actorName: "A", expenseClass: "PERSONAL", splitWeights: { a: 1 }, settledAt: null,
    externalId: id, source: "MANUAL" };
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

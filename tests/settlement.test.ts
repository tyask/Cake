import test from "node:test";
import assert from "node:assert/strict";
import { calculateSettlement } from "../lib/settlement";
import type { TransactionRecord, WorkspaceMember } from "../lib/types";

const members: WorkspaceMember[] = [
  { id: "a", email: "a@example.com", name: "A", imageUrl: null, weight: 6, role: "OWNER" },
  { id: "b", email: "b@example.com", name: "B", imageUrl: null, weight: 4, role: "MEMBER" },
];

function transaction(overrides: Partial<TransactionRecord>): TransactionRecord {
  return {
    id: crypto.randomUUID(), occurredAt: new Date().toISOString(), merchant: "テスト", method: "現金",
    type: "PAYMENT", amountYen: 1, actorUserId: "a", actorName: "A", expenseClass: "SHARED",
    settledAt: null, externalId: crypto.randomUUID(), source: "MANUAL", ...overrides,
  };
}

test("Aが10000円支払い、Bが2000円受け取りならBからAへ5200円", () => {
  const result = calculateSettlement(members, [
    transaction({ amountYen: 10_000, actorUserId: "a" }),
    transaction({ type: "RECEIPT", amountYen: 2_000, actorUserId: "b", actorName: "B" }),
  ]);
  assert.ok(result);
  assert.equal(result.netTotal, 8_000);
  assert.equal(result.payerUserId, "b");
  assert.equal(result.payeeUserId, "a");
  assert.equal(result.amountYen, 5_200);
});

test("個人費と清算済み明細は計算から除外する", () => {
  const result = calculateSettlement(members, [
    transaction({ amountYen: 1_000, actorUserId: "a" }),
    transaction({ amountYen: 50_000, expenseClass: "PERSONAL" }),
    transaction({ amountYen: 50_000, settledAt: new Date().toISOString() }),
  ]);
  assert.ok(result);
  assert.equal(result.netTotal, 1_000);
  assert.equal(result.amountYen, 400);
});

test("端数はAを四捨五入し、Bを残額にする", () => {
  const result = calculateSettlement(members, [transaction({ amountYen: 101, actorUserId: "a" })]);
  assert.ok(result);
  assert.equal(result.people[0].target, 61);
  assert.equal(result.people[1].target, 40);
  assert.equal(result.amountYen, 40);
});


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
    splitWeights: { a: 6, b: 4 },
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

test("デフォルト割合を変更しても保存済み明細の清算額は変わらない", () => {
  const entries = [transaction({ amountYen: 1000 })];
  const updatedMembers = members.map((member) => ({ ...member, weight: 1 }));
  assert.deepEqual(calculateSettlement(updatedMembers, entries)?.people.map((person) => person.target), [600, 400]);
  assert.equal(calculateSettlement(updatedMembers, entries)?.amountYen, 400);
});

test("明細ごとに異なる割合を合算して清算する", () => {
  const result = calculateSettlement(members, [
    transaction({ amountYen: 1000, actorUserId: "a", splitWeights: { a: 1, b: 1 } }),
    transaction({ amountYen: 1000, actorUserId: "b", splitWeights: { a: 0, b: 1 } }),
  ]);
  assert.deepEqual(result?.people.map((person) => person.target), [500, 1500]);
  assert.equal(result?.payerUserId, "b");
  assert.equal(result?.amountYen, 500);
});

test("受け取りにも明細の割合を適用してそれぞれの負担から差し引く", () => {
  const result = calculateSettlement(members, [
    transaction({ amountYen: 1000, actorUserId: "a", splitWeights: { a: 3, b: 1 } }),
    transaction({ type: "RECEIPT", amountYen: 200, actorUserId: "b", splitWeights: { a: 1, b: 3 } }),
  ]);
  assert.deepEqual(result?.people.map((person) => person.target), [700, 100]);
  assert.equal(result?.netTotal, 800);
  assert.equal(result?.amountYen, 300);
});

test("共有費の1:0は支払者と異なる人が全額負担するケースも清算する", () => {
  const result = calculateSettlement(members, [transaction({ amountYen: 100, actorUserId: "b", splitWeights: { a: 1, b: 0 } })]);
  assert.equal(result?.payerUserId, "a");
  assert.equal(result?.payeeUserId, "b");
  assert.equal(result?.amountYen, 100);
});

test("異なる割合の端数は全明細の合計を一度だけ丸め、並び順に依存しない", () => {
  const entries = [
    transaction({ splitWeights: { a: 1, b: 9 } }),
    transaction({ splitWeights: { a: 2, b: 8 } }),
    transaction({ splitWeights: { a: 2, b: 8 } }),
  ];
  for (const ordered of [entries, [...entries].reverse()]) {
    const result = calculateSettlement(members, ordered);
    assert.deepEqual(result?.people.map((person) => person.target), [1, 2]);
    assert.equal(result?.amountYen, 2);
  }
});

test("受け取りの負の端数も四捨五入の規則に従い、合計の残額を相手に割り当てる", () => {
  const result = calculateSettlement(members, [
    transaction({ type: "RECEIPT", splitWeights: { a: 1, b: 9 } }),
    transaction({ type: "RECEIPT", splitWeights: { a: 2, b: 8 } }),
    transaction({ type: "RECEIPT", splitWeights: { a: 2, b: 8 } }),
  ]);
  assert.deepEqual(result?.people.map((person) => person.target), [0, -3]);
  assert.equal(result?.payerUserId, "a");
  assert.equal(result?.amountYen, 3);
});

test("清算対象の不正な割合と参加者以外の担当者を拒否する", () => {
  assert.throws(() => calculateSettlement(members, [transaction({ splitWeights: { a: 0, b: 0 } })]));
  assert.throws(() => calculateSettlement(members, [transaction({ splitWeights: { a: 1, other: 1 } })]));
  assert.throws(() => calculateSettlement(members, [transaction({ actorUserId: "other" })]));
});

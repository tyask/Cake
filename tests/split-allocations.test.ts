import assert from "node:assert/strict";
import test from "node:test";
import { changeSplitAmount, equalSplitWeights, splitAmounts } from "../lib/split-allocations";
import { calculateSettlement } from "../lib/settlement";
import type { TransactionRecord, WorkspaceMember } from "../lib/types";

const members: WorkspaceMember[] = [
  { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 6, role: "OWNER" },
  { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 4, role: "MEMBER" },
];

test("1:1は奇数円の表示端数を保存割合にせず、複数明細も正確に折半する", () => {
  const weights = equalSplitWeights(members);
  assert.deepEqual(weights, { a: 1, b: 1 });
  assert.deepEqual(splitAmounts(101, weights, members), { a: 51, b: 50 });
  const transactions: TransactionRecord[] = ["first", "second"].map((id) => ({
    id, occurredAt: "2026-10-11T00:00:00Z", merchant: "スーパー", method: "現金", type: "PAYMENT",
    amountYen: 101, actorUserId: "a", actorName: "A", expenseClass: "SHARED", splitWeights: weights,
    settledAt: null, externalId: id, source: "MANUAL", memo: "",
  }));
  const result = calculateSettlement(members, transactions)!;
  assert.deepEqual(result.people.map((person) => person.target), [101, 101]);
  assert.equal(result.amountYen, 101);
  assert.deepEqual(weights, { a: 1, b: 1 });
  assert.deepEqual(members.map((member) => member.weight), [6, 4]);
});

test("1:1は二人の異なる参加者がそろっている場合だけ設定できる", () => {
  for (const invalid of [[], [members[0]], [members[0], members[0]], [...members, { id: "c" }]]) {
    assert.throws(() => equalSplitWeights(invalid));
  }
});

test("割合から円へ切り替える際は奇数円の端数を配分して合計を保つ", () => {
  assert.deepEqual(splitAmounts(101, { a: 1, b: 1 }, members), { a: 51, b: 50 });
  assert.deepEqual(splitAmounts(101, { a: 1, b: 2 }, members), { a: 34, b: 67 });
  assert.deepEqual(splitAmounts(0, { a: 6, b: 4 }, members), { a: 0, b: 0 });
});

test("一人の金額を変更するともう一人の残額を求め、0円と全額も扱う", () => {
  const weights = { a: 6, b: 4 };
  assert.deepEqual(changeSplitAmount(1000, 250, "b", weights, members), { a: 750, b: 250 });
  assert.deepEqual(changeSplitAmount(1000, 0, "a", { a: 1, b: 0 }, members), { a: 0, b: 1000 });
  assert.deepEqual(changeSplitAmount(1000, 1000, "a", weights, members), { a: 1000, b: 0 });
  assert.deepEqual(weights, { a: 6, b: 4 });
});

test("割合の0.1%単位と大きな円金額も整数精度を保つ", () => {
  assert.deepEqual(changeSplitAmount(1000, 333, "a", { a: 1, b: 1 }, members), { a: 333, b: 667 });
  assert.deepEqual(splitAmounts(2_147_483_647, { a: 2_147_483_647, b: 2_147_483_646 }, members), { a: 1_073_741_824, b: 1_073_741_823 });
});

test("範囲外・小数円・参加者違い・不正な割合を拒否する", () => {
  for (const amount of [-1, 1001, 1.5, NaN]) {
    assert.throws(() => changeSplitAmount(1000, amount, "a", { a: 1, b: 1 }, members));
  }
  assert.throws(() => changeSplitAmount(1000, 500, "other", { a: 1, b: 1 }, members));
  assert.throws(() => splitAmounts(1000, { a: 0, b: 0 }, members));
});

test("円で指定した支払い分が既存の清算計算にも正確に反映される", () => {
  const transaction: TransactionRecord = {
    id: "amount-split", occurredAt: "2026-10-06T00:00:00Z", merchant: "スーパー", method: "現金", type: "PAYMENT", amountYen: 1001,
    actorUserId: "a", actorName: "A", expenseClass: "SHARED", splitWeights: changeSplitAmount(1001, 700, "a", { a: 1, b: 1 }, members),
    settledAt: null, externalId: "amount-split-test", source: "MANUAL", memo: "",
  };
  const result = calculateSettlement(members, [transaction])!;
  assert.deepEqual(result.people.map((person) => person.target), [700, 301]);
  assert.equal(result.amountYen, 301);
});

import test from "node:test";
import assert from "node:assert/strict";
import { defaultSplitWeights, personalSplitWeights, transactionDefaults, validateSplitWeights } from "../lib/expense-splits";
import type { DefaultRule } from "../lib/types";

const members = [{ id: "a", weight: 6 }, { id: "b", weight: 4 }];
const rule = (overrides: Partial<DefaultRule> = {}): DefaultRule => ({
  id: "rule", merchantContains: "スーパー", expenseClass: "SHARED", sortOrder: 0,
  splitWeights: null, enabled: true, ...overrides,
});

test("共有費はデフォルト割合をコピーし、0の割合も保持する", () => {
  const source = [{ id: "a", weight: 0 }, { id: "b", weight: 5 }];
  const weights = defaultSplitWeights(source);
  source[1].weight = 1;
  assert.deepEqual(weights, { a: 0, b: 5 });
});

test("個人費は担当者だけが1になり、担当者の変更に追従する", () => {
  assert.deepEqual(personalSplitWeights(members, "a"), { a: 1, b: 0 });
  assert.deepEqual(personalSplitWeights(members, "b"), { a: 0, b: 1 });
  assert.throws(() => personalSplitWeights(members, "other"));
});

test("一番上の一致ルールを採用し、順番を入れ替えると区分と割合が変わる", () => {
  const shared = rule({ id: "shared", sortOrder: 0, splitWeights: { a: 2, b: 3 } });
  const personal = rule({ id: "personal", merchantContains: "スーパー駅前", expenseClass: "PERSONAL", sortOrder: 1 });
  assert.deepEqual(transactionDefaults("スーパー駅前店", [personal, shared], members, "a"), {
    expenseClass: "SHARED", splitWeights: { a: 2, b: 3 },
  });
  assert.deepEqual(transactionDefaults("スーパー駅前店", [{ ...personal, sortOrder: 0 }, { ...shared, sortOrder: 1 }], members, "a"), {
    expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 },
  });
});

test("無効なルールは飛ばし、該当しない取引は担当者の個人費にする", () => {
  assert.deepEqual(transactionDefaults("スーパー", [rule({ enabled: false })], members, "b"), {
    expenseClass: "PERSONAL", splitWeights: { a: 0, b: 1 },
  });
  assert.deepEqual(transactionDefaults("薬局", [rule()], members, "b"), {
    expenseClass: "PERSONAL", splitWeights: { a: 0, b: 1 },
  });
});

test("ルールの共有割合を省略した場合はワークスペースのデフォルトをコピーする", () => {
  const snapshot = transactionDefaults("スーパー", [rule()], members, "a");
  assert.deepEqual(snapshot.splitWeights, { a: 6, b: 4 });
  snapshot.splitWeights.a = 1;
  assert.equal(members[0].weight, 6);
});

test("ルールの割合はコピーし、新しい参加者に未指定の割合は0にする", () => {
  const savedRule = rule({ splitWeights: { a: 3 } });
  const snapshot = transactionDefaults("スーパー", [savedRule], members, "b");
  assert.deepEqual(snapshot.splitWeights, { a: 3, b: 0 });
  snapshot.splitWeights.a = 9;
  assert.equal(savedRule.splitWeights?.a, 3);
});

test("個人費ルールの割合は登録者のIDによらず、明細の担当者を基準にする", () => {
  assert.deepEqual(transactionDefaults("スーパー", [rule({ expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } })], members, "b"), {
    expenseClass: "PERSONAL", splitWeights: { a: 0, b: 1 },
  });
});

test("割合は正確な参加者IDと整数、正の合計を必要とする", () => {
  for (const invalid of [null, [], { a: 1 }, { a: 1, b: 0, other: 1 }, { a: -1, b: 2 },
    { a: 0, b: 0 }, { a: 0.5, b: 1 }, { a: NaN, b: 1 }, { a: Infinity, b: 1 },
    { a: "1", b: 1 }, { a: 2_147_483_648, b: 1 }]) {
    assert.throws(() => validateSplitWeights(invalid, members));
  }
  assert.throws(() => validateSplitWeights({ a: 1 }, ["a", "a"]));
  assert.throws(() => validateSplitWeights({}, []));
  assert.deepEqual(validateSplitWeights({ a: 2_147_483_647, b: 0 }, ["a", "b"]), { a: 2_147_483_647, b: 0 });
});

test("個人費の保存時は担当者1、相手0の割合以外を拒否する", () => {
  assert.deepEqual(validateSplitWeights({ a: 0, b: 1 }, members, "PERSONAL", "b"), { a: 0, b: 1 });
  assert.throws(() => validateSplitWeights({ a: 1, b: 1 }, members, "PERSONAL", "b"));
  assert.throws(() => validateSplitWeights({ a: 1, b: 0 }, members, "PERSONAL", "b"));
  assert.throws(() => validateSplitWeights({ a: 0, b: 1 }, members, "PERSONAL", "other"));
});

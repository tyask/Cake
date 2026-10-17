import assert from "node:assert/strict";
import test from "node:test";
import { orderedWorkspaceRules } from "../lib/rule-order";
import type { DefaultRule } from "../lib/types";

const rule = (id: string): DefaultRule => ({ id, merchantContains: id, expenseClass: "SHARED", sortOrder: 0, splitWeights: null, enabled: true });

test("指定順に並べ、外部削除と未知IDを除外し、外部追加は取得順で末尾に残す", () => {
  const rules = [rule("a"), rule("b"), rule("new1"), rule("new2")];
  const override = ["removed", "b", "unknown", "a"];
  const ordered = orderedWorkspaceRules(rules, override);
  assert.deepEqual(ordered.map(item => item.id), ["b", "a", "new1", "new2"]);
  assert.equal(ordered[0], rules[1]);
  assert.deepEqual(rules.map(item => item.id), ["a", "b", "new1", "new2"]);
  assert.deepEqual(override, ["removed", "b", "unknown", "a"]);
});

test("重複した順序IDと取得IDを一度だけ表示し、最初の取得レコードを使う", () => {
  const first = rule("b");
  const rules = [rule("a"), first, { ...rule("b"), merchantContains: "duplicate" }];
  const ordered = orderedWorkspaceRules(rules, ["b", "b", "missing", "missing"]);
  assert.deepEqual(ordered.map(item => item.id), ["b", "a"]);
  assert.equal(ordered[0], first);
  assert.deepEqual(orderedWorkspaceRules(rules, null).map(item => item.id), ["a", "b"]);
  assert.deepEqual(orderedWorkspaceRules([], ["unknown"]), []);
});

test("楽観順序を解除すると最新取得順へ復元し、空の指定でも全件を保持する", () => {
  const rules = [rule("a"), rule("b"), rule("c")];
  assert.deepEqual(orderedWorkspaceRules(rules, ["c", "a", "b"]).map(item => item.id), ["c", "a", "b"]);
  assert.deepEqual(orderedWorkspaceRules(rules, null), rules);
  assert.deepEqual(orderedWorkspaceRules(rules, []), rules);
});

test("多数ルールを逆順に並べ、未知・重複IDで件数を増やさない", () => {
  const rules = Array.from({ length: 5000 }, (_, index) => rule(String(index)));
  const ids = rules.map(item => item.id).reverse();
  const ordered = orderedWorkspaceRules(rules, [...ids, ...ids, "unknown"]);
  assert.equal(ordered.length, 5000);
  assert.deepEqual(ordered.map(item => item.id), ids);
});

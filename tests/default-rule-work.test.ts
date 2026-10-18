import assert from "node:assert/strict";
import test from "node:test";
import { matchingDefaultRule } from "../lib/expense-splits";
import { parsePayPayCsv } from "../lib/paypay";
import { defaultRule } from "./fixtures/default-rule-cases";
import type { DefaultRule } from "../lib/types";

test("多数ルールとCSVでも並べ替えず、旧判定と一致して一回走査の処理量に収まる", (t) => {
  for (const [ruleCount, rowCount] of [[100, 10], [1000, 100]]) {
    // Deterministic, unsorted and tied priorities, overlapping matches and disabled rules.
    const rules = Array.from({ length: ruleCount }, (_, index) => defaultRule({
      id: String(index), sortOrder: (index * 37) % 91, enabled: index % 7 !== 0,
      merchantContains: `店舗${index % 53}`, expenseClass: index % 3 ? "SHARED" : "PERSONAL",
    }));
    const merchants = Array.from({ length: rowCount }, (_, index) => `駅前店舗${index % 67}支店`);
    let reads = 0;
    const measured = rules.map(rule => ({ ...rule, get sortOrder() { reads++; return rule.sortOrder; } }));
    const expected = merchants.map(merchant => [...measured].sort((a, b) => a.sortOrder - b.sortOrder)
      .find(rule => rule.enabled && merchant.includes(rule.merchantContains)));
    const oldReads = reads;
    reads = 0;
    const originalSort = Array.prototype.sort;
    let sortCalls = 0;
    Array.prototype.sort = function (compare) {
      sortCalls++;
      return originalSort.call(this, compare);
    };
    try {
      for (const [index, merchant] of merchants.entries()) {
        assert.equal(matchingDefaultRule(merchant, measured)?.id, expected[index]?.id);
      }
      const newReads = reads;
      assert.ok(newReads <= ruleCount * rowCount * 2);
      assert.ok(newReads < oldReads);
      const csv = ["取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号",
        ...merchants.map((merchant, index) => `2026/10/10 10:00:00,101,支払い,${merchant},現金,row-${index}`)].join("\n");
      const rows = parsePayPayCsv(csv, measured, new Set(), [
        { id: "a", weight: 6, email: "a@test", name: "A", imageUrl: null, role: "OWNER" },
        { id: "b", weight: 4, email: "b@test", name: "B", imageUrl: null, role: "MEMBER" },
      ], "b");
      assert.equal(rows.length, rowCount);
      rows.forEach((row, index) => {
        const rule: DefaultRule | undefined = expected[index];
        assert.equal(row.error, null);
        assert.equal(row.expenseClass, rule?.expenseClass ?? "SHARED");
        assert.deepEqual(row.splitWeights, !rule ? { a: 6, b: 4 }
          : rule.expenseClass === "PERSONAL" ? { a: 0, b: 1 } : { a: 1, b: 3 });
      });
      assert.equal(sortCalls, 0);
      t.diagnostic(`${ruleCount}ルール×${rowCount}行: sort ${rowCount}→0回、順位値の読取 ${oldReads}→${newReads}回（速度計測ではない）`);
    } finally {
      Array.prototype.sort = originalSort;
    }
  }
});

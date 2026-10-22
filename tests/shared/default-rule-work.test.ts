import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { prepareDefaultRuleMatcher } from "../../lib/shared/expense-splits";
import { parsePayPayCsv } from "../../lib/shared/paypay";
import { defaultRule } from "./fixtures/default-rule-cases";

test("多数ルールを一度だけ準備し、CSV全行と単件の判定で同じ結果を使う", t => {
  for (const [ruleCount, rowCount] of [[100, 10], [1000, 100]]) {
    const rules = Array.from({ length: ruleCount }, (_, index) => defaultRule({
      id: String(index), sortOrder: (index * 37) % 91, enabled: index % 7 !== 0,
      merchantContains: `店舗${index % 53}`, expenseClass: index % 3 ? "SHARED" : "PERSONAL",
    }));
    const merchants = Array.from({ length: rowCount }, (_, index) => `駅前店舗${index % 67}支店`);
    const expected = merchants.map(merchant => [...rules].sort((a, b) => a.sortOrder - b.sortOrder)
      .find(rule => rule.enabled && merchant.includes(rule.merchantContains)));
    let enabledReads = 0, priorityReads = 0;
    const measured = rules.map(rule => ({ ...rule,
      get enabled() { enabledReads++; return rule.enabled; },
      get sortOrder() { priorityReads++; return rule.sortOrder; },
    }));
    const matchRule = prepareDefaultRuleMatcher(measured);
    const preparationReads = priorityReads;
    assert.equal(enabledReads, ruleCount);
    assert.ok(preparationReads > 0);
    merchants.forEach((merchant, index) => assert.equal(matchRule(merchant)?.id, expected[index]?.id));
    assert.equal(enabledReads, ruleCount, "判定中は有効ルールを再抽出しない");
    assert.equal(priorityReads, preparationReads, "判定中はルールを再ソートしない");
    enabledReads = 0; priorityReads = 0;
    const csv = ["取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号",
      ...merchants.map((merchant, index) => `2026/10/10 10:00:00,101,支払い,${merchant},現金,row-${index}`)].join("\n");
    const rows = parsePayPayCsv(csv, measured, new Set(), [
      { id: "a", weight: 6, email: "a@test", name: "A", imageUrl: null, role: "OWNER" },
      { id: "b", weight: 4, email: "b@test", name: "B", imageUrl: null, role: "MEMBER" },
    ], "b");
    assert.equal(rows.length, rowCount);
    rows.forEach((row, index) => {
      const rule = expected[index];
      assert.equal(row.error, null);
      assert.equal(row.expenseClass, rule?.expenseClass ?? "SHARED");
      assert.deepEqual(row.splitWeights, !rule ? { a: 6, b: 4 }
        : rule.expenseClass === "PERSONAL" ? { a: 0, b: 1 } : { a: 1, b: 3 });
    });
    assert.equal(enabledReads, ruleCount, "CSVはファイルごとに一度だけ有効ルールを抽出する");
    assert.equal(priorityReads, preparationReads, "CSVはファイルごとに一度だけソートする");
    t.diagnostic(`${ruleCount}ルール×${rowCount}行: enabled参照 ${ruleCount * rowCount}→${enabledReads}回、ソートは準備時だけ（速度計測ではない）`);
  }
});

test("準備済み判定は同順位の入力順を維持し、最初の一致で停止する", () => {
  let checks = 0;
  const rules = [
    defaultRule({ id: "later", sortOrder: 3 }),
    defaultRule({ id: "first", sortOrder: 1 }),
    defaultRule({ id: "tied", sortOrder: 1 }),
  ].map(rule => Object.freeze({ ...rule, get merchantContains() { checks++; return rule.merchantContains; } }));
  const disabled = { ...defaultRule({ enabled: false, sortOrder: 0 }), get merchantContains(): string { throw new Error("無効ルールの照合"); } };
  const input = Object.freeze([disabled, ...rules]);
  const matchRule = prepareDefaultRuleMatcher(input);
  assert.equal(matchRule("駅前スーパー")?.id, "first");
  assert.equal(checks, 1);
  assert.equal(matchRule("未一致"), undefined);
  assert.equal(checks, 4);
  assert.deepEqual(input.map(rule => rule.id), [disabled.id, "later", "first", "tied"]);
});

test("ルール一覧の更新は再準備で反映し、別一覧の判定を共有しない", () => {
  const rules = [defaultRule({ id: "shared" })];
  const original = prepareDefaultRuleMatcher(rules);
  const updated = prepareDefaultRuleMatcher([{ ...rules[0], enabled: false }, defaultRule({ id: "personal", expenseClass: "PERSONAL" })]);
  assert.equal(original("スーパー")?.id, "shared");
  assert.equal(updated("スーパー")?.id, "personal");
  assert.equal(prepareDefaultRuleMatcher([])("スーパー"), undefined);
  assert.equal(original("スーパー")?.id, "shared");
});

test("前処理を含む処理量を全走査方式と比較し、上位一致で照合を早期終了する", async () => {
  const results = [];
  for (const scenario of ["上位一致", "下位一致", "一致なし"]) {
    const fixture = () => {
      const reads = { enabled: 0, priority: 0, substring: 0 };
      const rules = Array.from({ length: 1000 }, (_, i) => {
        const rank = (i * 337) % 1000;
        return { ...defaultRule({ id: String(rank) }),
          get enabled() { reads.enabled++; return rank % 5 !== 0; },
          get sortOrder() { reads.priority++; return rank; },
          get merchantContains() { reads.substring++; return `#r${String(rank).padStart(4, "0")}#`; },
        };
      });
      return { reads, rules };
    };
    const merchants = Array.from({ length: 100 }, () => scenario === "上位一致" ? "#r0001#" : scenario === "下位一致" ? "#r0999#" : "#none#");
    const scan = fixture();
    const expected = merchants.map(merchant => {
      let match: typeof scan.rules[number] | undefined;
      for (const rule of scan.rules) {
        if (rule.enabled && (!match || rule.sortOrder < match.sortOrder) && merchant.includes(rule.merchantContains)) match = rule;
      }
      return match?.id;
    });
    const prepared = fixture();
    const matchRule = prepareDefaultRuleMatcher(prepared.rules);
    assert.deepEqual(merchants.map(merchant => matchRule(merchant)?.id), expected);
    assert.equal(prepared.reads.enabled, 1000);
    assert.equal(scan.reads.enabled, 100000);
    assert.equal(prepared.reads.substring, scenario === "上位一致" ? 100 : 80000);
    results.push({ scenario, ruleCount: 1000, rowCount: 100, scan: scan.reads, prepared: prepared.reads, resultsEqual: true });
  }
  await mkdir('.cake', { recursive: true });
  await writeFile('.cake/matcher-work.json', JSON.stringify({ scope: "ローカルfixtureの処理回数。準備コストを含み、実環境の速度測定ではない。", results }, null, 2));
});

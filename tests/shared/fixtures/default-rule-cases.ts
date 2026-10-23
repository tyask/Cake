import type { DefaultRule, ExpenseClass, SplitWeights } from "../../../lib/shared/types";

export const ruleMembers = [{ id: "a", weight: 6 }, { id: "b", weight: 4 }];
export const defaultRule = (overrides: Partial<DefaultRule> = {}): DefaultRule => ({
  id: "shared", merchantContains: "スーパー", expenseClass: "SHARED", sortOrder: 2,
  splitWeights: { a: 1, b: 3 }, enabled: true, ...overrides,
});

type RuleCase = {
  name: string;
  merchant: string;
  rules: DefaultRule[];
  matchedId?: string;
  expenseClass: ExpenseClass;
  splitWeights: SplitWeights;
  bulkDefaults?: { expenseClass: ExpenseClass; splitWeights: SplitWeights };
};

// Shared by domain, CSV, recurring forms and the real bulk SQL. Bulk application
// retains its PERSONAL fallback; CSV/forms retain their SHARED fallback.
export const defaultRuleCases: RuleCase[] = [
  { name: "未整列の部分一致は最小順位を選び、無効な先頭を除外する", merchant: "駅前スーパー本店",
    rules: [defaultRule({ id: "later", sortOrder: 8, expenseClass: "PERSONAL" }),
      defaultRule({ id: "disabled", sortOrder: 0, enabled: false }), defaultRule()],
    matchedId: "shared", expenseClass: "SHARED", splitWeights: { a: 1, b: 3 } },
  { name: "同順位は入力先頭を選び、より具体的な部分一致を優先しない", merchant: "駅前スーパー本店",
    rules: [defaultRule({ id: "first", merchantContains: "スーパー", expenseClass: "PERSONAL", splitWeights: null }),
      defaultRule({ id: "specific", merchantContains: "スーパー本店" })],
    matchedId: "first", expenseClass: "PERSONAL", splitWeights: { a: 0, b: 1 } },
  { name: "先頭より低い順位値でも未一致なら既存の一致を保持する", merchant: "駅前スーパー本店",
    rules: [defaultRule(), defaultRule({ id: "other", sortOrder: 0, merchantContains: "薬局", expenseClass: "PERSONAL" })],
    matchedId: "shared", expenseClass: "SHARED", splitWeights: { a: 1, b: 3 } },
  { name: "ルール割合nullは現在のデフォルト割合を使う", merchant: "スーパー",
    rules: [defaultRule({ splitWeights: null })], matchedId: "shared", expenseClass: "SHARED", splitWeights: { a: 6, b: 4 } },
  { name: "保存割合にない新参加者は0を補う", merchant: "スーパー",
    rules: [defaultRule({ splitWeights: { a: 3 } })], matchedId: "shared", expenseClass: "SHARED", splitWeights: { a: 3, b: 0 } },
  { name: "未一致は共有費フォールバックと現在割合を使う", merchant: "薬局",
    rules: [defaultRule(), defaultRule({ id: "disabled", merchantContains: "薬局", enabled: false })],
    expenseClass: "SHARED", splitWeights: { a: 6, b: 4 },
    bulkDefaults: { expenseClass: "PERSONAL", splitWeights: { a: 0, b: 1 } } },
  { name: "空のルール一覧は共有費フォールバックと現在割合を使う", merchant: "スーパー",
    rules: [], expenseClass: "SHARED", splitWeights: { a: 6, b: 4 },
    bulkDefaults: { expenseClass: "PERSONAL", splitWeights: { a: 0, b: 1 } } },
  { name: "部分一致の%と_はワイルドカードとして扱わない", merchant: "店%_本店",
    rules: [defaultRule({ id: "literal", merchantContains: "%_" })], matchedId: "literal",
    expenseClass: "SHARED", splitWeights: { a: 1, b: 3 } },
  { name: "Unicodeの部分一致と0の保存割合を維持する", merchant: "駅前🍰支店",
    rules: [defaultRule({ id: "unicode", merchantContains: "🍰", splitWeights: { a: 0, b: 4 } })], matchedId: "unicode",
    expenseClass: "SHARED", splitWeights: { a: 0, b: 4 } },
];

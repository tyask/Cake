import type { DefaultRule, SplitWeights } from "./types";

export function defaultRuleRecord(row: Record<string, unknown>): DefaultRule {
  return {
    id: String(row.id ?? ""), merchantContains: String(row.merchant_contains ?? ""),
    expenseClass: String(row.expense_class ?? "") as DefaultRule["expenseClass"],
    sortOrder: Number(row.sort_order ?? 0), splitWeights: row.split_weights as SplitWeights | null,
    enabled: Boolean(row.enabled),
  };
}

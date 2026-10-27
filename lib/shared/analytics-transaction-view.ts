import { analyticsToday, type AnalyticsRange } from "./analytics";
import { ANALYTICS_UNCLASSIFIED_ID, analyticsRowCategoryId, type PreparedAnalyticsDataset } from "./analytics-view";
import { splitAmounts } from "./split-allocations";
import type { ExpenseClass, TransactionRecord } from "./types";

export type AnalyticsTransactionSelection = {
  rowId: string;
  depth: number | "all";
  categoryIds: string[] | null;
  memberIds: string[];
  expenseClasses: ExpenseClass[];
};

/** Keep the aggregate's category selection; allocate using the detail snapshot's member order. */
export function selectAnalyticsTransactions(
  transactions: TransactionRecord[], members: readonly { id: string }[], period: AnalyticsRange,
  prepared: PreparedAnalyticsDataset, selection: AnalyticsTransactionSelection,
) {
  const categoryIds = selection.categoryIds === null ? null : new Set(selection.categoryIds);
  const classes = new Set(selection.expenseClasses);
  const memberIds = new Set(selection.memberIds);
  const amounts = new Map<string, number>();
  const selected = transactions.filter(item => {
    if (item.type !== "PAYMENT") return false;
    const date = analyticsToday(new Date(item.occurredAt));
    if (date < period.from || date > period.to) return false;
    const categoryId = item.categoryId && prepared.categories.has(item.categoryId) ? item.categoryId : ANALYTICS_UNCLASSIFIED_ID;
    if (categoryIds !== null && !categoryIds.has(categoryId)) return false;
    if (analyticsRowCategoryId(prepared, item.categoryId, selection.depth) !== selection.rowId) return false;
    if (!classes.has(item.expenseClass)) return false;
    const amount = item.expenseClass === "PERSONAL"
      ? memberIds.has(item.actorUserId) ? item.amountYen : 0
      : Object.entries(splitAmounts(item.amountYen, item.splitWeights, members))
        .reduce((sum, [memberId, yen]) => sum + (memberIds.has(memberId) ? yen : 0), 0);
    if (amount === 0) return false;
    amounts.set(item.id, amount);
    return true;
  });
  return { transactions: selected, amountsYen: amounts,
    totalYen: selected.reduce((sum, item) => sum + BigInt(amounts.get(item.id)!), BigInt(0)) };
}

import { ANALYTICS_CHART_CATEGORY_LIMIT, analyticsChangeRate } from "./analytics";
import type { AnalyticsDataset, AnalyticsFilters, AnalyticsRow, AnalyticsView } from "./analytics";
import type { Category } from "./types";

export const ANALYTICS_UNCLASSIFIED_ID = "__unclassified__";
export const ANALYTICS_OTHERS_ID = "__others__";

type PreparedCategory = {
  category: Category;
  ancestors: string[];
  path: string;
  hasChildren: boolean;
  order: number;
};
type PreparedBucket = Omit<AnalyticsDataset["buckets"][number], "burdenYen"> & { burdenYen: bigint; monthIndex: number };
export type PreparedAnalyticsDataset = {
  months: string[];
  maxDepth: number;
  categories: ReadonlyMap<string, PreparedCategory>;
  buckets: readonly PreparedBucket[];
  receiptBuckets: readonly PreparedBucket[];
};

/** Prepare category paths and exact money only when a server dataset changes. */
export function prepareAnalyticsDataset(dataset: AnalyticsDataset): PreparedAnalyticsDataset {
  const byId = new Map(dataset.categories.map(category => [category.id, category]));
  const children = new Map<string | null, Category[]>();
  for (const category of dataset.categories) {
    const parentId = category.parentId && byId.has(category.parentId) ? category.parentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(category);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.sortOrder - b.sortOrder || compareIds(a.id, b.id));
  const categories = new Map<string, PreparedCategory>();
  const stack = (children.get(null) ?? []).slice().reverse().map(category => ({ category, ancestors: [] as string[], path: "" }));
  let maxDepth = 1;
  while (stack.length) {
    const { category, ancestors, path } = stack.pop()!;
    if (categories.has(category.id)) continue;
    const ownAncestors = [...ancestors, category.id];
    const ownPath = path ? `${path} › ${category.name}` : category.name;
    categories.set(category.id, { category, ancestors: ownAncestors, path: ownPath,
      hasChildren: (children.get(category.id)?.length ?? 0) > 0, order: categories.size });
    maxDepth = Math.max(maxDepth, ownAncestors.length);
    for (const child of (children.get(category.id) ?? []).slice().reverse()) stack.push({ category: child, ancestors: ownAncestors, path: ownPath });
  }

  const months: string[] = [];
  const [firstYear, firstMonth] = dataset.periods.trend.from.slice(0, 7).split("-").map(Number);
  const [lastYear, lastMonth] = dataset.periods.trend.to.slice(0, 7).split("-").map(Number);
  const firstIndex = firstYear * 12 + firstMonth - 1;
  const lastIndex = lastYear * 12 + lastMonth - 1;
  for (let index = firstIndex; index <= lastIndex; index++) {
    months.push(`${String(Math.floor(index / 12)).padStart(4, "0")}-${String(index % 12 + 1).padStart(2, "0")}`);
  }
  const monthIndexes = new Map(months.map((month, index) => [month, index]));
  const prepareBuckets = (buckets: AnalyticsDataset["buckets"]): PreparedBucket[] => buckets.map(bucket => {
    if (typeof bucket.burdenYen !== "string" || !/^(0|[1-9]\d*)$/.test(bucket.burdenYen)) {
      throw new Error("集計金額は非負の整数文字列で指定してください。");
    }
    return { ...bucket, categoryId: bucket.categoryId && categories.has(bucket.categoryId) ? bucket.categoryId : null,
      burdenYen: BigInt(bucket.burdenYen), monthIndex: monthIndexes.get(bucket.month) ?? -1 };
  });
  return { months, maxDepth, categories, buckets: prepareBuckets(dataset.buckets),
    receiptBuckets: prepareBuckets(dataset.receiptBuckets) };
}

function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function emptyRow(id: string, prepared: PreparedAnalyticsDataset, depth: number | "all"): AnalyticsRow {
  const item = prepared.categories.get(id);
  if (!item) return { id: ANALYTICS_UNCLASSIFIED_ID, name: "未分類", path: "未分類", label: "未分類", colorHex: "#94a3b8",
    currentYen: BigInt(0), comparisonYen: BigInt(0), monthlyYen: prepared.months.map(() => BigInt(0)) };
  const direct = item.hasChildren && (depth === "all" || item.ancestors.length < depth);
  const label = `${item.path}${direct ? "（直接設定）" : ""}${item.category.archivedAt ? "（使用停止）" : ""}`;
  return { id, name: item.category.name, path: item.path, label, colorHex: item.category.colorHex,
    currentYen: BigInt(0), comparisonYen: BigInt(0), monthlyYen: prepared.months.map(() => BigInt(0)) };
}
function rowMaximum(row: AnalyticsRow): bigint {
  return row.monthlyYen.reduce((largest, value) => value > largest ? value : largest,
    row.currentYen > row.comparisonYen ? row.currentYen : row.comparisonYen);
}
function addRow(target: AnalyticsRow, source: AnalyticsRow): void {
  target.currentYen += source.currentYen;
  target.comparisonYen += source.comparisonYen;
  for (let index = 0; index < target.monthlyYen.length; index++) target.monthlyYen[index] += source.monthlyYen[index];
}

/** Checkbox and category-depth changes combine server aggregates without another request. */
export function buildAnalyticsView(prepared: PreparedAnalyticsDataset, filters: AnalyticsFilters): AnalyticsView {
  if (filters.depth !== "all" && (!Number.isInteger(filters.depth) || filters.depth < 1)) {
    throw new Error("カテゴリの階層は1以上の整数で指定してください。");
  }
  const memberIds = new Set(filters.memberIds);
  const expenseClasses = new Set(filters.expenseClasses);
  const categoryIds = filters.categoryIds === undefined ? null : new Set(filters.categoryIds);
  const includesBucket = (bucket: PreparedBucket) => memberIds.has(bucket.memberId)
    && expenseClasses.has(bucket.expenseClass)
    && (categoryIds === null || categoryIds.has(bucket.categoryId ?? ANALYTICS_UNCLASSIFIED_ID));
  let incomeYen = BigInt(0), comparisonIncomeYen = BigInt(0);
  const monthlyIncomeYen = prepared.months.map(() => BigInt(0));
  for (const bucket of prepared.receiptBuckets) {
    if (!includesBucket(bucket)) continue;
    if (bucket.scope === "current") incomeYen += bucket.burdenYen;
    else if (bucket.scope === "comparison") comparisonIncomeYen += bucket.burdenYen;
    else if (bucket.monthIndex >= 0) monthlyIncomeYen[bucket.monthIndex] += bucket.burdenYen;
  }
  const grouped = new Map<string, AnalyticsRow>();
  for (const bucket of prepared.buckets) {
    if (!includesBucket(bucket) || bucket.burdenYen === BigInt(0)) continue;
    const source = bucket.categoryId ? prepared.categories.get(bucket.categoryId) : undefined;
    const id = source ? filters.depth === "all" ? source.category.id
      : source.ancestors[Math.min(filters.depth, source.ancestors.length) - 1] : ANALYTICS_UNCLASSIFIED_ID;
    let row = grouped.get(id);
    if (!row) {
      row = emptyRow(id, prepared, filters.depth);
      grouped.set(id, row);
    }
    if (bucket.scope === "current") row.currentYen += bucket.burdenYen;
    else if (bucket.scope === "comparison") row.comparisonYen += bucket.burdenYen;
    else if (bucket.monthIndex >= 0) row.monthlyYen[bucket.monthIndex] += bucket.burdenYen;
  }
  const rows = [...grouped.values()].filter(row => rowMaximum(row) > BigInt(0)).sort((a, b) => {
    if (a.id === ANALYTICS_UNCLASSIFIED_ID) return 1;
    if (b.id === ANALYTICS_UNCLASSIFIED_ID) return -1;
    const aRank = rowMaximum(a), bRank = rowMaximum(b);
    return aRank === bRank ? (prepared.categories.get(a.id)!.order - prepared.categories.get(b.id)!.order)
      : aRank > bRank ? -1 : 1;
  });
  const totalYen = rows.reduce((sum, row) => sum + row.currentYen, BigInt(0));
  const comparisonYen = rows.reduce((sum, row) => sum + row.comparisonYen, BigInt(0));
  const classified = rows.filter(row => row.id !== ANALYTICS_UNCLASSIFIED_ID);
  const chartRows = classified.slice(0, ANALYTICS_CHART_CATEGORY_LIMIT);
  const remaining = classified.slice(ANALYTICS_CHART_CATEGORY_LIMIT);
  if (remaining.length) {
    const others = { ...emptyRow(ANALYTICS_OTHERS_ID, prepared, filters.depth), id: ANALYTICS_OTHERS_ID,
      name: "その他", path: "その他", label: "その他", colorHex: "#cbd5e1" };
    for (const row of remaining) addRow(others, row);
    chartRows.push(others);
  }
  const unclassified = grouped.get(ANALYTICS_UNCLASSIFIED_ID);
  if (unclassified && rowMaximum(unclassified) > BigInt(0)) chartRows.push(unclassified);
  const cashflowMonths = prepared.months.map((month, index) => {
    const expenseYen = rows.reduce((sum, row) => sum + row.monthlyYen[index], BigInt(0));
    return { month, incomeYen: monthlyIncomeYen[index], expenseYen,
      balanceYen: monthlyIncomeYen[index] - expenseYen };
  });
  return { totalYen, comparisonYen, differenceYen: totalYen - comparisonYen,
    rate: analyticsChangeRate(totalYen, comparisonYen), months: [...prepared.months], rows, chartRows,
    cashflow: { incomeYen, expenseYen: totalYen, balanceYen: incomeYen - totalYen,
      comparisonIncomeYen, comparisonExpenseYen: comparisonYen,
      comparisonBalanceYen: comparisonIncomeYen - comparisonYen, months: cashflowMonths } };
}

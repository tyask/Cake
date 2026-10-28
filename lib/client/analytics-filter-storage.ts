import { analyticsQuerySchema, type AnalyticsQuery } from "../shared/analytics";
import { expenseClasses, type ExpenseClass } from "../shared/domain-values";

export type AnalyticsPeriod = Omit<Extract<AnalyticsQuery, { period: "month" }>, "workspaceId">
  | Omit<Extract<AnalyticsQuery, { period: "range" }>, "workspaceId">;

export type AnalyticsFilterState = {
  /** Null follows the current month until a period is explicitly applied. */
  period: AnalyticsPeriod | null;
  /** Null includes all current members; an empty array includes none. */
  memberIds: string[] | null;
  includeIncome: boolean;
  expenseClasses: ExpenseClass[];
  /** Null includes all current categories; an empty array includes none. */
  categoryIds: string[] | null;
  depth: number | "all";
};

export const defaultAnalyticsFilters: AnalyticsFilterState = {
  period: null,
  memberIds: null,
  includeIncome: true,
  expenseClasses: ["SHARED", "PERSONAL"],
  categoryIds: null,
  depth: 1,
};

export function analyticsFiltersStorageKey(userId: string, workspaceId: string): string {
  return `cake:analytics-filters:v1:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;
}

function stringIds(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0)
    ? [...new Set(value)] : null;
}

export function parseStoredAnalyticsFilters(raw: string | null, workspaceId: string): AnalyticsFilterState {
  if (raw === null) return defaultAnalyticsFilters;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaultAnalyticsFilters;
    const stored = parsed as Record<string, unknown>;
    let period: AnalyticsPeriod | null = null;
    if (typeof stored.period === "object" && stored.period !== null && !Array.isArray(stored.period)) {
      const query = analyticsQuerySchema.safeParse({ ...stored.period, workspaceId });
      if (query.success) {
        period = query.data.period === "month" ? { period: "month", month: query.data.month }
          : { period: "range", from: query.data.from, to: query.data.to };
      }
    }
    const classes = stored.expenseClasses;
    return {
      period,
      memberIds: stringIds(stored.memberIds),
      includeIncome: typeof stored.includeIncome === "boolean" ? stored.includeIncome : defaultAnalyticsFilters.includeIncome,
      expenseClasses: Array.isArray(classes) && classes.every(value => expenseClasses.includes(value))
        ? [...new Set(classes)] : defaultAnalyticsFilters.expenseClasses,
      categoryIds: stringIds(stored.categoryIds),
      depth: stored.depth === "all" || (typeof stored.depth === "number" && Number.isSafeInteger(stored.depth) && stored.depth >= 1)
        ? stored.depth : defaultAnalyticsFilters.depth,
    };
  } catch {
    return defaultAnalyticsFilters;
  }
}

export function readStoredAnalyticsFilters(storage: Pick<Storage, "getItem">, key: string, workspaceId: string): AnalyticsFilterState {
  try { return parseStoredAnalyticsFilters(storage.getItem(key), workspaceId); }
  catch { return defaultAnalyticsFilters; }
}

export function writeStoredAnalyticsFilters(storage: Pick<Storage, "setItem">, key: string, filters: AnalyticsFilterState): void {
  try { storage.setItem(key, JSON.stringify(filters)); }
  catch { /* Filters still work for this page when browser storage is unavailable. */ }
}

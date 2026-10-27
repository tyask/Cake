import { z } from "zod";
import { workspaceIdSchema } from "./schemas/domain-schemas";
import type { Category, ExpenseClass } from "./types";

export const ANALYTICS_TIME_ZONE = "Asia/Tokyo" as const;
export const ANALYTICS_MAX_MONTHS = 24;
export const ANALYTICS_TREND_MONTHS = 6;
export const ANALYTICS_CHART_CATEGORY_LIMIT = 8;
export const analyticsScopes = ["current", "comparison", "trend"] as const;
export type AnalyticsScope = typeof analyticsScopes[number];
export type AnalyticsRange = { from: string; to: string };
export type AnalyticsQuery = { workspaceId: string } & (
  { period: "month"; month: string } | { period: "range"; from: string; to: string }
);
export type AnalyticsBucket = {
  scope: AnalyticsScope;
  month: string;
  memberId: string;
  expenseClass: ExpenseClass;
  categoryId: string | null;
  burdenYen: string;
};
export type AnalyticsDataset = {
  workspaceId: string;
  snapshotAt: string;
  timeZone: typeof ANALYTICS_TIME_ZONE;
  periods: Record<AnalyticsScope, AnalyticsRange>;
  members: { id: string; name: string }[];
  categories: Category[];
  buckets: AnalyticsBucket[];
  receiptBuckets: AnalyticsBucket[];
};
export type AnalyticsFilters = {
  memberIds: string[];
  expenseClasses: ExpenseClass[];
  /** Income classes can be selected independently from expense classes. */
  incomeExpenseClasses?: ExpenseClass[];
  depth: number | "all";
  /** Exact assigned categories; omitted means all, while an empty array includes none. */
  categoryIds?: readonly string[];
};
export type AnalyticsRow = {
  id: string; name: string; path: string; label: string; colorHex: string;
  currentYen: bigint; comparisonYen: bigint; monthlyYen: bigint[];
};
export type AnalyticsCashflowMonth = {
  month: string;
  incomeYen: bigint;
  expenseYen: bigint;
  balanceYen: bigint;
};
export type AnalyticsCashflow = {
  incomeYen: bigint;
  expenseYen: bigint;
  balanceYen: bigint;
  comparisonIncomeYen: bigint;
  comparisonExpenseYen: bigint;
  comparisonBalanceYen: bigint;
  months: AnalyticsCashflowMonth[];
};
export type AnalyticsView = {
  totalYen: bigint; comparisonYen: bigint; differenceYen: bigint; rate: string | null;
  months: string[]; rows: AnalyticsRow[]; chartRows: AnalyticsRow[];
  cashflow: AnalyticsCashflow;
};

const DAY_MS = 86_400_000;
const japanDate = new Intl.DateTimeFormat("sv-SE", {
  timeZone: ANALYTICS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

export function analyticsToday(now = new Date()): string { return japanDate.format(now); }

function calendarDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = calendarDate(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateText(date: Date): string { return date.toISOString().slice(0, 10); }
function addDays(value: string, days: number): string { return dateText(new Date(calendarDate(value).getTime() + days * DAY_MS)); }
function monthIndex(value: string): number {
  const [year, month] = value.split("-").map(Number);
  return year * 12 + month - 1;
}
function shiftedMonth(value: string, offset: number): string {
  const date = calendarDate(`${value}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateText(date).slice(0, 7);
}
function monthEnd(value: string): string { return addDays(`${shiftedMonth(value, 1)}-01`, -1); }

const dateSchema = z.string().refine(isCalendarDate, "実在する日付をYYYY-MM-DDで指定してください。");
const monthSchema = z.string().refine(value => /^\d{4}-\d{2}$/.test(value) && isCalendarDate(`${value}-01`),
  "実在する月をYYYY-MMで指定してください。");
const queryShape = z.discriminatedUnion("period", [
  z.object({ workspaceId: workspaceIdSchema, period: z.literal("month"), month: monthSchema }).strict(),
  z.object({ workspaceId: workspaceIdSchema, period: z.literal("range"), from: dateSchema, to: dateSchema }).strict(),
]);

function querySchema(now: () => Date) {
  return queryShape.superRefine((query, context) => {
    const today = japanDate.format(now());
    if (query.period === "month") {
      if (query.month > today.slice(0, 7)) {
        context.addIssue({ code: "custom", path: ["month"], message: "未来の月は選択できません。" });
        return;
      }
      if (!isCalendarDate(`${query.month}-01`)) return;
    } else {
      if (!isCalendarDate(query.from) || !isCalendarDate(query.to)) return;
      if (query.from > query.to) {
        context.addIssue({ code: "custom", path: ["to"], message: "終了日は開始日以降にしてください。" });
        return;
      }
      if (query.to > today) {
        context.addIssue({ code: "custom", path: ["to"], message: "未来の日付は選択できません。" });
        return;
      }
      if (monthIndex(query.to) - monthIndex(query.from) + 1 > ANALYTICS_MAX_MONTHS) {
        context.addIssue({ code: "custom", path: ["to"], message: `期間は${ANALYTICS_MAX_MONTHS}暦月以内にしてください。` });
        return;
      }
    }
    const periods = calculatePeriods(query, today);
    if (Object.values(periods).some(period => !isCalendarDate(period.from) || !isCalendarDate(period.to))) {
      context.addIssue({ code: "custom", path: [query.period === "month" ? "month" : "from"],
        message: "比較期間と月次推移を含めて西暦1年以降になる期間を指定してください。" });
    }
  });
}

/** Uses the current Japanese date at parse time, including for long-lived server processes. */
export const analyticsQuerySchema = querySchema(() => new Date());
export function createAnalyticsQuerySchema(now: Date) { return querySchema(() => now); }

/** All ranges include both endpoints and follow the Japanese calendar. */
export function resolveAnalyticsPeriods(query: AnalyticsQuery, now = new Date()): Record<AnalyticsScope, AnalyticsRange> {
  const valid = createAnalyticsQuerySchema(now).parse(query);
  return calculatePeriods(valid, japanDate.format(now));
}

function calculatePeriods(valid: AnalyticsQuery, today: string): Record<AnalyticsScope, AnalyticsRange> {
  let current: AnalyticsRange;
  let comparison: AnalyticsRange;
  if (valid.period === "month") {
    const previousMonth = shiftedMonth(valid.month, -1);
    const currentMonth = valid.month === today.slice(0, 7);
    current = { from: `${valid.month}-01`, to: currentMonth ? today : monthEnd(valid.month) };
    comparison = { from: `${previousMonth}-01`, to: currentMonth
      ? `${previousMonth}-${String(Math.min(Number(today.slice(8)), Number(monthEnd(previousMonth).slice(8)))).padStart(2, "0")}`
      : monthEnd(previousMonth) };
  } else {
    current = { from: valid.from, to: valid.to };
    const days = (calendarDate(valid.to).getTime() - calendarDate(valid.from).getTime()) / DAY_MS + 1;
    comparison = { from: addDays(valid.from, -days), to: addDays(valid.from, -1) };
  }
  const endingMonth = current.to.slice(0, 7);
  const trend = { from: `${shiftedMonth(endingMonth, 1 - ANALYTICS_TREND_MONTHS)}-01`,
    to: endingMonth === today.slice(0, 7) ? today : monthEnd(endingMonth) };
  return { current, comparison, trend };
}

/** Percentage change is rounded once to one decimal without converting money to floating point. */
export function analyticsChangeRate(currentYen: bigint, comparisonYen: bigint): string | null {
  if (comparisonYen === BigInt(0)) return null;
  const difference = currentYen - comparisonYen;
  const absolute = difference < BigInt(0) ? -difference : difference;
  const tenths = (absolute * BigInt(1000) * BigInt(2) + comparisonYen) / (comparisonYen * BigInt(2));
  const sign = tenths === BigInt(0) ? "" : difference > BigInt(0) ? "+" : "-";
  return `${sign}${tenths / BigInt(10)}.${tenths % BigInt(10)}%`;
}

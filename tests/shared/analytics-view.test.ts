import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsView, prepareAnalyticsDataset, ANALYTICS_UNCLASSIFIED_ID, ANALYTICS_OTHERS_ID } from "../../lib/shared/analytics-view";
import type { AnalyticsBucket, AnalyticsDataset, AnalyticsFilters } from "../../lib/shared/analytics";
import { formatYen } from "../../lib/shared/display-formatters";
import type { Category } from "../../lib/shared/types";

function category(id: string, parentId: string | null = null, extra: Partial<Category> = {}): Category {
  return { id, parentId, revision: 1, name: id, colorHex: "#f97316", sortOrder: 0, archivedAt: null, ...extra };
}
function bucket(categoryId: string | null, burdenYen: string, extra: Partial<AnalyticsBucket> = {}): AnalyticsBucket {
  return { scope: "current", month: "2026-10", memberId: "a", expenseClass: "SHARED", categoryId, burdenYen, ...extra };
}
function dataset(buckets: AnalyticsBucket[], categories: Category[] = []): AnalyticsDataset {
  return { workspaceId: "11111111-1111-4111-8111-111111111111", snapshotAt: "2026-10-23T02:00:00.123Z", timeZone: "Asia/Tokyo",
    periods: { current: { from: "2026-10-01", to: "2026-10-23" }, comparison: { from: "2026-09-01", to: "2026-09-23" },
      trend: { from: "2026-05-01", to: "2026-10-23" } },
    members: [{ id: "a", name: "A" }, { id: "b", name: "B" }], categories, buckets };
}
const filters: AnalyticsFilters = { memberIds: ["a", "b"], expenseClasses: ["SHARED", "PERSONAL"], depth: 1 };

test("analytics filters compose all member and expense-class combinations from one prepared dataset", () => {
  const source = dataset([bucket(null, "501"), bucket(null, "500", { memberId: "b" }),
    bucket(null, "300", { expenseClass: "PERSONAL" }), bucket(null, "200", { memberId: "b", expenseClass: "PERSONAL" })]);
  const unchanged = JSON.stringify(source);
  const prepared = prepareAnalyticsDataset(source);
  assert.equal(buildAnalyticsView(prepared, filters).totalYen, BigInt(1501));
  assert.equal(buildAnalyticsView(prepared, { ...filters, memberIds: ["a"] }).totalYen, BigInt(801));
  assert.equal(buildAnalyticsView(prepared, { ...filters, memberIds: ["b"], expenseClasses: ["SHARED"] }).totalYen, BigInt(500));
  assert.equal(buildAnalyticsView(prepared, { ...filters, expenseClasses: ["PERSONAL"] }).totalYen, BigInt(500));
  assert.equal(buildAnalyticsView(prepared, { ...filters, memberIds: [] }).totalYen, BigInt(0));
  assert.deepEqual(buildAnalyticsView(prepared, { ...filters, expenseClasses: [] }).rows, []);
  assert.equal(JSON.stringify(source), unchanged);
  assert.equal(buildAnalyticsView(prepared, filters).totalYen, BigInt(1501));
});

test("arbitrary category depths preserve direct parent records, old-only groups, archive colors, and total", () => {
  const categories = [category("食費"), category("外食", "食費", { colorHex: "#16a34a" }), category("夕食", "外食"),
    category("旧費目", null, { archivedAt: "2026-10-01T00:00:00Z", colorHex: "#9333ea" })];
  const prepared = prepareAnalyticsDataset(dataset([bucket("食費", "10"), bucket("外食", "20"), bucket("夕食", "30"),
    bucket("旧費目", "80", { scope: "comparison", month: "2026-09" }), bucket(null, "5")], categories));
  assert.equal(prepared.maxDepth, 3);
  for (const depth of [1, 2, 3, "all"] as const) {
    const view = buildAnalyticsView(prepared, { ...filters, depth });
    assert.equal(view.totalYen, BigInt(65));
    assert.equal(view.comparisonYen, BigInt(80));
    assert.equal(view.differenceYen, -BigInt(15));
    const archived = view.rows.find(row => row.id === "旧費目")!;
    assert.equal(archived.currentYen, BigInt(0));
    assert.equal(archived.colorHex, "#9333ea");
    assert.equal(archived.label, "旧費目（使用停止）");
  }
  assert.equal(buildAnalyticsView(prepared, filters).rows.find(row => row.id === "食費")!.currentYen, BigInt(60));
  const depthTwo = buildAnalyticsView(prepared, { ...filters, depth: 2 });
  assert.equal(depthTwo.rows.find(row => row.id === "食費")!.label, "食費（直接設定）");
  assert.equal(depthTwo.rows.find(row => row.id === "外食")!.currentYen, BigInt(50));
  const all = buildAnalyticsView(prepared, { ...filters, depth: "all" });
  assert.equal(all.rows.find(row => row.id === "外食")!.label, "食費 › 外食（直接設定）");
  assert.equal(all.rows.find(row => row.id === "夕食")!.label, "食費 › 外食 › 夕食");
  assert.equal(all.rows.find(row => row.id === "外食")!.currentYen, BigInt(20));
});

test("analytics month series fill zero gaps and retain categories that only appear in the trend", () => {
  const prepared = prepareAnalyticsDataset(dataset([bucket("月次のみ", "70", { scope: "trend", month: "2026-07" }),
    bucket("月次のみ", "30", { scope: "trend", month: "2026-10", memberId: "b" })], [category("月次のみ")]));
  const view = buildAnalyticsView(prepared, filters);
  assert.deepEqual(view.months, ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(view.rows[0].monthlyYen, [BigInt(0), BigInt(0), BigInt(70), BigInt(0), BigInt(0), BigInt(30)]);
  assert.equal(view.totalYen, BigInt(0));
  assert.equal(view.rate, null);
});

test("chart top eight and others preserve all scopes and keep unclassified separate", () => {
  const categories = Array.from({ length: 11 }, (_, index) => category(`c${index}`, null, { sortOrder: index }));
  const buckets = categories.flatMap((item, index) => [bucket(item.id, String(index + 1)),
    bucket(item.id, String((index + 1) * 2), { scope: "comparison", month: "2026-09" }),
    bucket(item.id, String((index + 1) * 3), { scope: "trend", month: "2026-08" })]);
  const view = buildAnalyticsView(prepareAnalyticsDataset(dataset([...buckets, bucket(null, "999")], categories)), filters);
  assert.equal(view.rows.length, 12);
  assert.equal(view.chartRows.length, 10);
  assert.deepEqual(view.chartRows.slice(0, 8).map(row => row.id), ["c10", "c9", "c8", "c7", "c6", "c5", "c4", "c3"]);
  const others = view.chartRows.find(row => row.id === ANALYTICS_OTHERS_ID)!;
  assert.equal(others.currentYen, BigInt(6));
  assert.equal(others.comparisonYen, BigInt(12));
  assert.equal(others.monthlyYen[3], BigInt(18));
  assert.equal(view.chartRows.at(-1)!.id, ANALYTICS_UNCLASSIFIED_ID);
  for (const key of ["currentYen", "comparisonYen"] as const) {
    assert.equal(view.chartRows.reduce((sum, row) => sum + row[key], BigInt(0)), view.rows.reduce((sum, row) => sum + row[key], BigInt(0)));
  }
});

test("unknown category references remain unclassified and sorting ties use stable category order", () => {
  const prepared = prepareAnalyticsDataset(dataset([bucket("missing", "3"), bucket("b", "5"), bucket("a", "5")],
    [category("b", null, { sortOrder: 1 }), category("a")]));
  const view = buildAnalyticsView(prepared, filters);
  assert.deepEqual(view.rows.map(row => row.id), ["a", "b", ANALYTICS_UNCLASSIFIED_ID]);
  assert.equal(view.totalYen, BigInt(13));
  assert.throws(() => buildAnalyticsView(prepared, { ...filters, depth: 0 }));
});

test("analytics exact sums and currency formatting support amounts beyond safe Number integers", () => {
  const view = buildAnalyticsView(prepareAnalyticsDataset(dataset([bucket(null, "9007199254740993"), bucket(null, "10")])), filters);
  assert.equal(view.totalYen, BigInt("9007199254741003"));
  assert.equal(formatYen(view.totalYen), "￥9,007,199,254,741,003");
  assert.equal(formatYen(1234), "￥1,234");
  for (const amount of ["-1", "1.5", "1e3", "01", "", "NaN"]) {
    assert.throws(() => prepareAnalyticsDataset(dataset([bucket(null, amount)])), amount);
  }
  assert.throws(() => prepareAnalyticsDataset(dataset([bucket(null, 1 as unknown as string)])));
});

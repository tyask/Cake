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
function dataset(buckets: AnalyticsBucket[], categories: Category[] = [], receiptBuckets: AnalyticsBucket[] = []): AnalyticsDataset {
  return { workspaceId: "11111111-1111-4111-8111-111111111111", snapshotAt: "2026-10-23T02:00:00.123Z", timeZone: "Asia/Tokyo",
    periods: { current: { from: "2026-10-01", to: "2026-10-23" }, comparison: { from: "2026-09-01", to: "2026-09-23" },
      trend: { from: "2026-05-01", to: "2026-10-23" } },
    members: [{ id: "a", name: "A" }, { id: "b", name: "B" }], categories, buckets, receiptBuckets };
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

test("収入と支出は同じ対象者・区分で選択し、今回と比較期間の収支を別々に計算する", () => {
  const source = dataset([
    bucket(null, "501"), bucket(null, "500", { memberId: "b" }),
    bucket(null, "300", { expenseClass: "PERSONAL" }), bucket(null, "200", { memberId: "b", expenseClass: "PERSONAL" }),
    bucket(null, "50", { scope: "comparison", month: "2026-09" }),
    bucket(null, "30", { scope: "comparison", month: "2026-09", memberId: "b", expenseClass: "PERSONAL" }),
  ], [], [
    bucket(null, "801"), bucket(null, "800", { memberId: "b" }),
    bucket(null, "1000", { expenseClass: "PERSONAL" }), bucket(null, "2000", { memberId: "b", expenseClass: "PERSONAL" }),
    bucket(null, "200", { scope: "comparison", month: "2026-09" }),
    bucket(null, "100", { scope: "comparison", month: "2026-09", memberId: "b", expenseClass: "PERSONAL" }),
  ]);
  const unchanged = JSON.stringify(source), prepared = prepareAnalyticsDataset(source);
  const cases = [
    { memberIds: ["a", "b"], expenseClasses: ["SHARED", "PERSONAL"], amounts: [4601, 1501, 300, 80] },
    { memberIds: ["a"], expenseClasses: ["SHARED", "PERSONAL"], amounts: [1801, 801, 200, 50] },
    { memberIds: ["b"], expenseClasses: ["SHARED", "PERSONAL"], amounts: [2800, 700, 100, 30] },
    { memberIds: ["a", "b"], expenseClasses: ["SHARED"], amounts: [1601, 1001, 200, 50] },
    { memberIds: ["a", "b"], expenseClasses: ["PERSONAL"], amounts: [3000, 500, 100, 30] },
    { memberIds: ["b"], expenseClasses: ["SHARED"], amounts: [800, 500, 0, 0] },
    { memberIds: ["a"], expenseClasses: ["PERSONAL"], amounts: [1000, 300, 0, 0] },
    { memberIds: [], expenseClasses: ["SHARED", "PERSONAL"], amounts: [0, 0, 0, 0] },
    { memberIds: ["a", "b"], expenseClasses: [], amounts: [0, 0, 0, 0] },
  ] satisfies { memberIds: string[]; expenseClasses: AnalyticsFilters["expenseClasses"]; amounts: number[] }[];
  for (const { amounts, ...selected } of cases) {
    const [income, expense, comparisonIncome, comparisonExpense] = amounts.map(BigInt);
    const view = buildAnalyticsView(prepared, { ...filters, ...selected });
    assert.deepEqual(view.cashflow, {
      incomeYen: income, expenseYen: expense, balanceYen: income - expense,
      comparisonIncomeYen: comparisonIncome, comparisonExpenseYen: comparisonExpense,
      comparisonBalanceYen: comparisonIncome - comparisonExpense,
      months: view.months.map(month => ({ month, incomeYen: BigInt(0), expenseYen: BigInt(0), balanceYen: BigInt(0) })),
    }, JSON.stringify(selected));
    assert.equal(view.cashflow.expenseYen, view.totalYen);
    assert.equal(view.cashflow.comparisonExpenseYen, view.comparisonYen);
  }
  assert.equal(JSON.stringify(source), unchanged);
});

test("収支の月次は欠損月を0で補完し、重複する期間scopeを二重計上しない", () => {
  const source = dataset([
    bucket(null, "101"), bucket(null, "101", { scope: "trend" }),
    bucket(null, "250", { scope: "trend", month: "2026-07" }),
    bucket(null, "40", { scope: "comparison", month: "2026-09" }),
  ], [], [
    bucket(null, "301"), bucket(null, "301", { scope: "trend" }),
    bucket(null, "200", { scope: "trend", month: "2026-05" }),
    bucket(null, "100", { scope: "trend", month: "2026-07" }),
    bucket(null, "120", { scope: "comparison", month: "2026-09" }),
  ]);
  const view = buildAnalyticsView(prepareAnalyticsDataset(source), filters);
  assert.equal(view.cashflow.incomeYen, BigInt(301));
  assert.equal(view.cashflow.balanceYen, BigInt(200));
  assert.equal(view.cashflow.comparisonBalanceYen, BigInt(80));
  assert.deepEqual(view.cashflow.months, [
    { month: "2026-05", incomeYen: BigInt(200), expenseYen: BigInt(0), balanceYen: BigInt(200) },
    { month: "2026-06", incomeYen: BigInt(0), expenseYen: BigInt(0), balanceYen: BigInt(0) },
    { month: "2026-07", incomeYen: BigInt(100), expenseYen: BigInt(250), balanceYen: -BigInt(150) },
    { month: "2026-08", incomeYen: BigInt(0), expenseYen: BigInt(0), balanceYen: BigInt(0) },
    { month: "2026-09", incomeYen: BigInt(0), expenseYen: BigInt(0), balanceYen: BigInt(0) },
    { month: "2026-10", incomeYen: BigInt(301), expenseYen: BigInt(101), balanceYen: BigInt(200) },
  ]);
  // The selected period and the six-month trend are different ranges.
  assert.notEqual(view.cashflow.months.reduce((sum, month) => sum + month.incomeYen, BigInt(0)), view.cashflow.incomeYen);
});

test("収入だけ・支出だけ・空の家計でも月次と収支を表示でき、収入を支出カテゴリへ混ぜない", () => {
  for (const { payments, receipts, expected } of [
    { payments: [], receipts: [bucket("給与", "300"), bucket("給与", "300", { scope: "trend" })], expected: [300, 0, 300] },
    { payments: [bucket(null, "200"), bucket(null, "200", { scope: "trend" })], receipts: [], expected: [0, 200, -200] },
    { payments: [], receipts: [], expected: [0, 0, 0] },
  ]) {
    const view = buildAnalyticsView(prepareAnalyticsDataset(dataset(payments, [category("給与")], receipts)), filters);
    assert.deepEqual([view.cashflow.incomeYen, view.cashflow.expenseYen, view.cashflow.balanceYen], expected.map(BigInt));
    const lastMonth = view.cashflow.months.at(-1)!;
    assert.deepEqual([lastMonth.incomeYen, lastMonth.expenseYen, lastMonth.balanceYen], expected.map(BigInt));
    assert.equal(view.cashflow.months.length, 6);
    assert.ok(!view.rows.some(row => row.id === "給与"));
    if (!payments.length) assert.deepEqual(view.chartRows, []);
  }
});

test("収入のカテゴリ・階層変更で収支は変化せず、巨大整数の相殺差額も正確に保つ", () => {
  const large = "9007199254740993";
  const source = dataset([
    bucket("子", large), bucket("親", "2"),
    bucket(null, large, { scope: "comparison", month: "2026-09" }),
    bucket("子", large, { scope: "trend" }), bucket("親", "2", { scope: "trend" }),
  ], [category("親"), category("子", "親")], [
    bucket("missing", large), bucket("子", "3"),
    bucket(null, "9007199254740992", { scope: "comparison", month: "2026-09" }),
    bucket("missing", large, { scope: "trend" }), bucket("子", "3", { scope: "trend" }),
  ]);
  const prepared = prepareAnalyticsDataset(source);
  for (const depth of [1, 2, "all"] as const) {
    const { cashflow } = buildAnalyticsView(prepared, { ...filters, depth });
    assert.equal(cashflow.incomeYen, BigInt("9007199254740996"));
    assert.equal(cashflow.expenseYen, BigInt("9007199254740995"));
    assert.equal(cashflow.balanceYen, BigInt(1));
    assert.equal(cashflow.comparisonBalanceYen, -BigInt(1));
    assert.equal(cashflow.months.at(-1)!.balanceYen, BigInt(1));
    assert.equal(formatYen(cashflow.incomeYen), "￥9,007,199,254,740,996");
  }
});

test("保存済みの1円配分を再配分せず、参加者ごとの収支を合計して全員の収支に一致させる", () => {
  const source = dataset([bucket(null, "1"), bucket(null, "0", { memberId: "b" })], [],
    [bucket(null, "0"), bucket(null, "1", { memberId: "b" })]);
  const prepared = prepareAnalyticsDataset(source);
  const a = buildAnalyticsView(prepared, { ...filters, memberIds: ["a"] }).cashflow;
  const b = buildAnalyticsView(prepared, { ...filters, memberIds: ["b"] }).cashflow;
  const all = buildAnalyticsView(prepared, filters).cashflow;
  assert.equal(a.balanceYen, -BigInt(1));
  assert.equal(b.balanceYen, BigInt(1));
  assert.equal(all.balanceYen, BigInt(0));
  assert.equal(a.incomeYen + b.incomeYen, all.incomeYen);
  assert.equal(a.expenseYen + b.expenseYen, all.expenseYen);
  assert.equal(a.balanceYen + b.balanceYen, all.balanceYen);
});

test("収入の集約金額にも非負の整数文字列だけを許可する", () => {
  for (const amount of ["-1", "1.5", "1e3", "01", "", "NaN"]) {
    assert.throws(() => prepareAnalyticsDataset(dataset([], [], [bucket(null, amount)])), /非負の整数文字列/, amount);
  }
  assert.throws(() => prepareAnalyticsDataset(dataset([], [], [bucket(null, 1 as unknown as string)])), /非負の整数文字列/);
});

test("カテゴリ選択は元の設定先に適用し、表示階層を変えても選択額を変えない", () => {
  const prepared = prepareAnalyticsDataset(dataset([
    bucket("親", "10"), bucket("子", "20"), bucket("孫", "30"), bucket("兄弟", "40"), bucket(null, "7"),
  ], [category("親"), category("子", "親"), category("孫", "子"), category("兄弟", "親")]));
  for (const depth of [1, 2, "all"] as const) {
    const child = buildAnalyticsView(prepared, { ...filters, categoryIds: ["子"], depth });
    assert.equal(child.totalYen, BigInt(20), "親に集約する場合も、親自身や孫の明細は混ぜない");
    assert.equal(child.rows.length, 1);
    const parent = buildAnalyticsView(prepared, { ...filters, categoryIds: ["親"], depth });
    assert.equal(parent.totalYen, BigInt(10), "親への直接設定だけも選択できる");
    assert.equal(buildAnalyticsView(prepared, { ...filters, categoryIds: ["親", "子", "孫"], depth }).totalYen,
      BigInt(60), "親と子孫のIDを選んでも明細を二重計上しない");
  }
});

test("カテゴリの選択は対象者・区分と組み合わせ、当期・比較期・月次の収入と支出へ同じように適用する", () => {
  const payments = [bucket("対象", "80"), bucket("対象", "20", { expenseClass: "PERSONAL" }),
    bucket("対象", "40", { memberId: "b" }), bucket("対象外", "200")];
  const receipts = [bucket("対象", "300"), bucket("対象", "50", { expenseClass: "PERSONAL" }),
    bucket("対象", "100", { memberId: "b" }), bucket("対象外", "500")];
  const inEachScope = (buckets: AnalyticsBucket[]) => buckets.flatMap(item => [
    item, { ...item, scope: "comparison" as const, month: "2026-09" },
    { ...item, scope: "trend" as const, month: "2026-07" },
  ]);
  const prepared = prepareAnalyticsDataset(dataset(inEachScope(payments), [category("対象"), category("対象外")], inEachScope(receipts)));
  const cases = [
    { memberIds: ["a", "b"], expenseClasses: ["SHARED", "PERSONAL"], income: 450, expense: 140 },
    { memberIds: ["a"], expenseClasses: ["SHARED", "PERSONAL"], income: 350, expense: 100 },
    { memberIds: ["a", "b"], expenseClasses: ["SHARED"], income: 400, expense: 120 },
    { memberIds: ["a"], expenseClasses: ["PERSONAL"], income: 50, expense: 20 },
  ] satisfies { memberIds: string[]; expenseClasses: AnalyticsFilters["expenseClasses"]; income: number; expense: number }[];
  for (const { income, expense, ...selected } of cases) {
    const view = buildAnalyticsView(prepared, { ...filters, ...selected, categoryIds: ["対象"] });
    assert.equal(view.cashflow.incomeYen, BigInt(income));
    assert.equal(view.totalYen, BigInt(expense));
    assert.equal(view.cashflow.balanceYen, BigInt(income - expense));
    assert.equal(view.cashflow.comparisonIncomeYen, BigInt(income));
    assert.equal(view.comparisonYen, BigInt(expense));
    assert.equal(view.differenceYen, BigInt(0));
    assert.deepEqual(view.cashflow.months[2], { month: "2026-07", incomeYen: BigInt(income),
      expenseYen: BigInt(expense), balanceYen: BigInt(income - expense) });
    assert.ok(view.cashflow.months.filter(month => month.month !== "2026-07")
      .every(month => month.incomeYen === BigInt(0) && month.expenseYen === BigInt(0)));
    assert.deepEqual(view.rows.map(row => row.id), ["対象"]);
  }
});

test("未分類の選択は削除済み参照も含み、分類済みの明細とは切り分ける", () => {
  const prepared = prepareAnalyticsDataset(dataset([
    bucket(null, "4"), bucket("削除済み", "6"), bucket("分類済み", "11"),
    bucket("削除済み", "7", { scope: "comparison", month: "2026-09" }),
    bucket(null, "8", { scope: "trend", month: "2026-08" }),
  ], [category("分類済み")], [
    bucket(null, "100"), bucket("削除済み", "200"), bucket("分類済み", "300"),
    bucket("削除済み", "70", { scope: "comparison", month: "2026-09" }),
    bucket(null, "80", { scope: "trend", month: "2026-08" }),
  ]));
  const unclassified = buildAnalyticsView(prepared, { ...filters, categoryIds: [ANALYTICS_UNCLASSIFIED_ID] });
  assert.equal(unclassified.totalYen, BigInt(10));
  assert.equal(unclassified.cashflow.incomeYen, BigInt(300));
  assert.equal(unclassified.comparisonYen, BigInt(7));
  assert.equal(unclassified.cashflow.comparisonIncomeYen, BigInt(70));
  assert.deepEqual(unclassified.rows.map(row => row.id), [ANALYTICS_UNCLASSIFIED_ID]);
  assert.deepEqual(unclassified.cashflow.months[3], { month: "2026-08", incomeYen: BigInt(80),
    expenseYen: BigInt(8), balanceYen: BigInt(72) });
  const classified = buildAnalyticsView(prepared, { ...filters, categoryIds: ["分類済み"] });
  assert.equal(classified.totalYen, BigInt(11));
  assert.equal(classified.cashflow.incomeYen, BigInt(300));
});

test("収入だけの使用停止カテゴリも選択でき、支出グラフへ収入を混ぜない", () => {
  const prepared = prepareAnalyticsDataset(dataset([bucket("支出", "123")], [category("支出"),
    category("給与", null, { archivedAt: "2026-10-01T00:00:00Z" })], [
    bucket("給与", "500"), bucket("給与", "500", { scope: "trend" }),
  ]));
  const view = buildAnalyticsView(prepared, { ...filters, categoryIds: ["給与"] });
  assert.equal(view.cashflow.incomeYen, BigInt(500));
  assert.equal(view.cashflow.balanceYen, BigInt(500));
  assert.equal(view.totalYen, BigInt(0));
  assert.equal(view.cashflow.months.at(-1)!.balanceYen, BigInt(500));
  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.chartRows, []);
});

test("全カテゴリの既定値と空の選択を区別し、選択を戻しても入力や準備済みデータを変更しない", () => {
  const source = dataset([bucket("食費", "3"), bucket(null, "2")], [category("食費")], [bucket("食費", "10")]);
  const unchanged = JSON.stringify(source), prepared = prepareAnalyticsDataset(source);
  const all = buildAnalyticsView(prepared, filters);
  const categoryIds = Object.freeze(["食費", ANALYTICS_UNCLASSIFIED_ID, "食費"]);
  assert.deepEqual(buildAnalyticsView(prepared, { ...filters, categoryIds }), all, "重複IDも合計を重複させない");
  for (const categoryIds of [[], ["存在しないID"]]) {
    const empty = buildAnalyticsView(prepared, { ...filters, categoryIds });
    assert.equal(empty.totalYen, BigInt(0));
    assert.equal(empty.comparisonYen, BigInt(0));
    assert.equal(empty.cashflow.incomeYen, BigInt(0));
    assert.equal(empty.cashflow.comparisonIncomeYen, BigInt(0));
    assert.equal(empty.rate, null);
    assert.deepEqual(empty.rows, []);
    assert.deepEqual(empty.chartRows, []);
    assert.equal(empty.cashflow.months.length, 6);
    assert.ok(empty.cashflow.months.every(month => month.incomeYen === BigInt(0)
      && month.expenseYen === BigInt(0) && month.balanceYen === BigInt(0)));
  }
  assert.deepEqual(buildAnalyticsView(prepared, filters), all);
  assert.equal(JSON.stringify(source), unchanged);
  assert.deepEqual(categoryIds, ["食費", ANALYTICS_UNCLASSIFIED_ID, "食費"]);
});

test("選択後の上位8件とその他を再計算し、巨大整数を含む合計と差額を正確に維持する", () => {
  const categories = Array.from({ length: 11 }, (_, index) => category(`c${index}`, null, { sortOrder: index }));
  const exact = "9007199254740993";
  const payments = categories.flatMap((item, index) => [bucket(item.id, index === 0 ? exact : String(index + 1)),
    bucket(item.id, index === 0 ? exact : String((index + 1) * 2), { scope: "comparison", month: "2026-09" }),
    bucket(item.id, index === 0 ? exact : String((index + 1) * 3), { scope: "trend" })]);
  const prepared = prepareAnalyticsDataset(dataset([...payments, bucket(null, "100")], categories, [bucket("c0", "9007199254740994")]));
  const categoryIds = categories.slice(0, 10).map(item => item.id);
  const view = buildAnalyticsView(prepared, { ...filters, categoryIds });
  assert.equal(view.totalYen, BigInt(exact) + BigInt(54));
  assert.equal(view.comparisonYen, BigInt(exact) + BigInt(108));
  assert.equal(view.differenceYen, -BigInt(54));
  assert.equal(view.cashflow.balanceYen, -BigInt(53));
  assert.equal(view.chartRows.length, 9);
  assert.equal(view.chartRows[0].id, "c0");
  assert.ok(!view.rows.some(row => row.id === "c10" || row.id === ANALYTICS_UNCLASSIFIED_ID));
  const others = view.chartRows.find(row => row.id === ANALYTICS_OTHERS_ID)!;
  assert.equal(others.currentYen, BigInt(5));
  assert.equal(others.comparisonYen, BigInt(10));
  assert.equal(others.monthlyYen.at(-1), BigInt(15));
  for (const key of ["currentYen", "comparisonYen"] as const) {
    assert.equal(view.chartRows.reduce((sum, row) => sum + row[key], BigInt(0)), view.rows.reduce((sum, row) => sum + row[key], BigInt(0)));
  }
  assert.equal(view.chartRows.reduce((sum, row) => sum + row.monthlyYen.at(-1)!, BigInt(0)), BigInt(exact) + BigInt(162));
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsFiltersStorageKey, defaultAnalyticsFilters, parseStoredAnalyticsFilters,
  readStoredAnalyticsFilters, writeStoredAnalyticsFilters, type AnalyticsFilterState,
} from "../../lib/client/analytics-filter-storage";

const workspaceId = "11111111-1111-4111-8111-111111111111";
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
}

test("集計保存キーはユーザー・家計・区切り文字を区別する", () => {
  assert.equal(analyticsFiltersStorageKey("user", "workspace"), "cake:analytics-filters:v1:user:workspace");
  const keys = [["user", "workspace"], ["other", "workspace"], ["user", "other"], ["a:b", "c"], ["a", "b:c"], ["a%3Ab", "c"]]
    .map(([user, workspace]) => analyticsFiltersStorageKey(user, workspace));
  assert.equal(new Set(keys).size, keys.length);
});

test("未保存・壊れたJSON・オブジェクト以外は全員・全カテゴリ・全内容を初期選択する", () => {
  for (const raw of [null, "", "{", "null", "true", "123", '"filters"', "[]"]) {
    assert.equal(parseStoredAnalyticsFilters(raw, workspaceId), defaultAnalyticsFilters);
  }
  assert.equal(defaultAnalyticsFilters.memberIds, null);
  assert.equal(defaultAnalyticsFilters.period, null);
  assert.equal(defaultAnalyticsFilters.categoryIds, null);
});

test("表示対象・確定期間・区分・カテゴリ・階層をユーザーと家計別に保存復元する", () => {
  const storage = memoryStorage(), key = analyticsFiltersStorageKey("a", workspaceId);
  const filters: AnalyticsFilterState = {
    period: { period: "range", from: "2026-01-01", to: "2026-01-31" },
    memberIds: ["b"], includeIncome: false, expenseClasses: ["PERSONAL"], categoryIds: ["food", "unclassified"], depth: "all",
  };
  writeStoredAnalyticsFilters(storage, key, filters);
  assert.deepEqual(readStoredAnalyticsFilters(storage, key, workspaceId), filters);
  assert.equal(readStoredAnalyticsFilters(storage, analyticsFiltersStorageKey("b", workspaceId), workspaceId), defaultAnalyticsFilters);
  assert.equal(readStoredAnalyticsFilters(storage, analyticsFiltersStorageKey("a", "other"), "other"), defaultAnalyticsFilters);
  const month: AnalyticsFilterState = { ...filters, period: { period: "month", month: "2026-01" }, depth: 3 };
  writeStoredAnalyticsFilters(storage, key, month);
  assert.deepEqual(readStoredAnalyticsFilters(storage, key, workspaceId), month);
});

test("全解除と初期全選択を区別し、重複IDを取り除く", () => {
  assert.deepEqual(parseStoredAnalyticsFilters(JSON.stringify({ memberIds: [], expenseClasses: [], categoryIds: [], includeIncome: false }), workspaceId), {
    ...defaultAnalyticsFilters, memberIds: [], expenseClasses: [], categoryIds: [], includeIncome: false,
  });
  assert.deepEqual(parseStoredAnalyticsFilters(JSON.stringify({ memberIds: ["a", "a"], expenseClasses: ["SHARED", "SHARED"], categoryIds: ["food", "food"] }), workspaceId), {
    ...defaultAnalyticsFilters, memberIds: ["a"], expenseClasses: ["SHARED"], categoryIds: ["food"],
  });
});

test("無効な条件は項目ごとに初期値へ戻し、有効な条件を残す", () => {
  for (const depth of [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(parseStoredAnalyticsFilters(JSON.stringify({ memberIds: ["a", 1], includeIncome: "false", expenseClasses: ["UNKNOWN"], categoryIds: [null], depth }), workspaceId), defaultAnalyticsFilters);
  }
  assert.deepEqual(parseStoredAnalyticsFilters(JSON.stringify({ memberIds: 1, categoryIds: {}, includeIncome: false, depth: "all", unknown: true }), workspaceId), {
    ...defaultAnalyticsFilters, includeIncome: false, depth: "all",
  });
});

test("不正・未来・長過ぎる保存期間を採用せず、他のフィルタは復元する", () => {
  for (const period of [
    { period: "month", month: "" }, { period: "month", month: "2026-13" }, { period: "month", month: "9999-12" },
    { period: "range", from: "2026-02-30", to: "2026-03-01" },
    { period: "range", from: "2026-02-02", to: "2026-02-01" },
    { period: "range", from: "2020-01-01", to: "2026-01-01" },
    { period: "range", from: "9999-12-01", to: "9999-12-31" },
    [], null, "2026-01", { period: "month", month: "2026-01", unknown: true },
  ]) {
    assert.deepEqual(parseStoredAnalyticsFilters(JSON.stringify({ period, memberIds: ["b"] }), workspaceId), {
      ...defaultAnalyticsFilters, memberIds: ["b"],
    });
  }
});

test("保存済みperiodのworkspaceIdでは現在の家計を置き換えない", () => {
  const result = parseStoredAnalyticsFilters(JSON.stringify({ period: { period: "month", month: "2026-01", workspaceId: "other" } }), workspaceId);
  assert.deepEqual(result.period, { period: "month", month: "2026-01" });
});

test("ストレージの読取拒否・保存拒否・容量不足でも例外を出さない", () => {
  assert.equal(readStoredAnalyticsFilters({ getItem() { throw new Error("SecurityError"); } }, "blocked", workspaceId), defaultAnalyticsFilters);
  assert.doesNotThrow(() => writeStoredAnalyticsFilters({ setItem() { throw new Error("QuotaExceededError"); } }, "blocked", defaultAnalyticsFilters));
});

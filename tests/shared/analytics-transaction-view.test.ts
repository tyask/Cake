import assert from "node:assert/strict";
import test from "node:test";
import { prepareAnalyticsDataset } from "../../lib/shared/analytics-view";
import { selectAnalyticsTransactions, type AnalyticsTransactionSelection } from "../../lib/shared/analytics-transaction-view";
import type { AnalyticsDataset } from "../../lib/shared/analytics";
import type { TransactionRecord } from "../../lib/shared/types";

const period = { from: "2026-10-01", to: "2026-10-31" };
const members = [{ id: "b", name: "B" }, { id: "a", name: "A" }];
const prepared = prepareAnalyticsDataset({
  workspaceId: "w", snapshotAt: "2026-10-26T00:00:00Z", timeZone: "Asia/Tokyo", members,
  periods: { current: period, comparison: period, trend: period }, buckets: [], receiptBuckets: [],
  categories: [
    { id: "food", parentId: null, name: "食費", colorHex: "#123456", sortOrder: 0, revision: 1, archivedAt: null },
    { id: "shop", parentId: "food", name: "食材", colorHex: "#123456", sortOrder: 0, revision: 1, archivedAt: null },
  ],
} satisfies AnalyticsDataset);
const payment = (id: string, patch: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id, occurredAt: "2026-10-01T00:00:00Z", merchant: id, method: "現金", memo: "", type: "PAYMENT", amountYen: 1,
  actorUserId: "a", actorName: "A", expenseClass: "SHARED", splitWeights: { a: 1, b: 1 }, settledAt: null,
  externalId: id, source: "MANUAL", categoryId: "shop", categoryConfirmed: true, categoryRevision: 1, ...patch,
});
const selection: AnalyticsTransactionSelection = {
  rowId: "food", depth: 1, categoryIds: null, memberIds: ["b"], expenseClasses: ["SHARED", "PERSONAL"],
};

test("明細も集計と同じ参加者順の余り円を配分し、個別配分0円を除外する", () => {
  const entries = [payment("tie"), payment("unequal", { amountYen: 2147483647, splitWeights: { a: 1, b: 2 } })];
  const original = structuredClone(entries);
  const result = selectAnalyticsTransactions(entries, members, period, prepared, selection);
  assert.deepEqual(result.transactions.map(item => item.id), ["tie", "unequal"]);
  assert.deepEqual([...result.amountsYen], [["tie", 1], ["unequal", 1431655765]]);
  assert.equal(result.totalYen, BigInt(1431655766));
  const noShare = selectAnalyticsTransactions([entries[0]], members, period, prepared, { ...selection, memberIds: ["a"] });
  assert.deepEqual(noShare.transactions, []);
  assert.equal(noShare.amountsYen.size, 0);
  const shared = selectAnalyticsTransactions(entries, members, period, prepared, { ...selection, memberIds: ["a", "b"], expenseClasses: ["SHARED"] });
  assert.deepEqual([...shared.amountsYen], [["tie", 1], ["unequal", 2147483647]]);
  assert.equal(shared.totalYen, BigInt(2147483648));
  assert.deepEqual(entries, original, "配分後の表示金額を作っても保存済みの取引全額・割合は変更しない");
  assert.equal(result.transactions[1], entries[1], "表示値は元のTransactionRecordとは別に持つ");
});

test("親集約・直接設定・選択カテゴリとJST境界を維持し、収入と未選択ユーザーの個人費を除く", () => {
  const entries = [
    payment("start", { occurredAt: "2026-09-30T15:00:00Z" }),
    payment("before", { occurredAt: "2026-09-30T14:59:59.999Z" }),
    payment("end", { occurredAt: "2026-10-31T14:59:59.999Z", settledAt: "2026-10-25T00:00:00Z" }),
    payment("after", { occurredAt: "2026-10-31T15:00:00Z" }),
    payment("direct", { categoryId: "food" }),
    payment("receipt", { type: "RECEIPT" }),
    payment("private", { expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } }),
  ];
  const selected = (changes: Partial<AnalyticsTransactionSelection> = {}) => selectAnalyticsTransactions(entries, members, period, prepared, { ...selection, ...changes }).transactions.map(item => item.id);
  assert.deepEqual(selected(), ["start", "end", "direct"]);
  assert.deepEqual(selected({ depth: "all" }), ["direct"]);
  assert.deepEqual(selected({ categoryIds: ["shop"] }), ["start", "end"]);
  assert.deepEqual(selected({ expenseClasses: ["PERSONAL"] }), []);
  assert.deepEqual(selected({ memberIds: ["a", "b"], expenseClasses: ["SHARED"] }), ["start", "end", "direct"]);
});


test("選択ユーザーの個人費は全額、共有費は整数円の配分合計を表示し、複数選択でも二重計上しない", () => {
  const entries = [
    payment("shared", { amountYen: 101 }),
    payment("a-personal", { amountYen: 70, expenseClass: "PERSONAL", splitWeights: { a: 0, b: 1 } }),
    payment("b-personal", { actorUserId: "b", amountYen: 90, expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } }),
  ];
  const one = selectAnalyticsTransactions(entries, members, period, prepared, selection);
  assert.deepEqual([...one.amountsYen], [["shared", 51], ["b-personal", 90]]);
  assert.equal(one.totalYen, BigInt(141));
  const both = selectAnalyticsTransactions(entries, members, period, prepared, { ...selection, memberIds: ["a", "b", "b"] });
  assert.deepEqual([...both.amountsYen], [["shared", 101], ["a-personal", 70], ["b-personal", 90]]);
  assert.equal(both.totalYen, BigInt(261));
  const noUsers = selectAnalyticsTransactions(entries, members, period, prepared, { ...selection, memberIds: [] });
  assert.equal(noUsers.totalYen, BigInt(0));
  assert.deepEqual(noUsers.transactions, []);
  const noExpenses = selectAnalyticsTransactions(entries, members, period, prepared, { ...selection, expenseClasses: [] });
  assert.deepEqual(noExpenses.transactions, []);
});

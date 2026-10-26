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
  rowId: "food", depth: 1, categoryIds: null, viewMode: "self", selfClasses: ["SHARED", "PERSONAL"], currentUserId: "b",
};

test("明細も集計と同じ参加者順の余り円を配分し、個別配分0円を除外する", () => {
  const entries = [payment("tie"), payment("unequal", { amountYen: 2147483647, splitWeights: { a: 1, b: 2 } })];
  const result = selectAnalyticsTransactions(entries, members, period, prepared, selection);
  assert.deepEqual(result.transactions.map(item => item.id), ["tie", "unequal"]);
  assert.equal(result.totalYen, BigInt(1431655766));
  assert.deepEqual(selectAnalyticsTransactions([entries[0]], members, period, prepared, { ...selection, currentUserId: "a" }).transactions, []);
});

test("親集約・直接設定・選択カテゴリとJST境界を維持し、収入と相手個人を除く", () => {
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
  assert.deepEqual(selected({ selfClasses: ["PERSONAL"] }), []);
  assert.deepEqual(selected({ viewMode: "shared" }), ["start", "end", "direct"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { transactionListView } from "../lib/transaction-list";
import type { TransactionRecord } from "../lib/types";

const item = (id: string, settledAt: string | null = null): TransactionRecord => ({
  id, occurredAt: "2026-10-06T00:00:00Z", merchant: id, method: "現金", type: "PAYMENT",
  amountYen: 100, actorUserId: "a", actorName: "A", expenseClass: "SHARED", splitWeights: { a: 1 },
  settledAt, externalId: id, source: "MANUAL", categoryId: null, categoryConfirmed: false, categoryRevision: 0, memo: "",
});
const empty = new Set<string>();

test("編集・保存失敗とメモ編集中の条件外行を保持し、判定は各明細で一回だけ行う", () => {
  const items = [item("match"), item("draft"), item("error"), item("memo", "2026-10-07T00:00:00Z"), item("hidden")];
  const evaluated: string[] = [];
  const view = transactionListView(items, record => { evaluated.push(record.id); return record.id === "match"; },
    new Set(["draft", "error", "removed"]), new Set(["memo"]), new Set(["match", "hidden", "memo", "removed"]));
  assert.deepEqual(evaluated, items.map(record => record.id));
  assert.deepEqual(view.visible.map(record => record.id), ["match", "draft", "error", "memo"]);
  assert.deepEqual([...view.outsideFilterIds], ["draft", "error", "memo"]);
  assert.deepEqual(view.visibleEditable.map(record => record.id), ["match", "draft", "error"]);
  assert.deepEqual(view.checkedIds, ["match", "hidden"]);
  assert.equal(view.hiddenCheckedCount, 1);
  assert.equal(view.selectionChecked, false);
});

test("表示0件でも非表示選択の全解除を有効にし、外部削除・清算済みを操作対象にしない", () => {
  const selected = new Set(["hidden", "removed", "settled"]);
  const items = [item("hidden"), item("settled", "2026-10-07T00:00:00Z")];
  const view = transactionListView(items, () => false, empty, empty, selected);
  assert.equal(view.visible.length, 0);
  assert.deepEqual(view.checkedIds, ["hidden"]);
  assert.equal(view.hiddenCheckedCount, 1);
  assert.equal(view.selectionChecked, true);
  const deleted = transactionListView([], () => true, empty, empty, selected);
  assert.equal(deleted.selectionChecked, false);
  assert.deepEqual(deleted.checkedIds, []);
  assert.deepEqual([...selected], ["hidden", "removed", "settled"]);
});

test("表示中の未清算全件だけで全選択を判定し、絞り込み解除で元の選択を復元する", () => {
  const items = [item("visible"), item("hidden"), item("settled", "2026-10-07T00:00:00Z")];
  const selected = new Set(["visible", "hidden"]);
  const filtered = transactionListView(items, record => record.id !== "hidden", empty, empty, selected);
  assert.equal(filtered.selectionChecked, true);
  assert.equal(filtered.hiddenCheckedCount, 1);
  const restored = transactionListView(items, () => true, empty, empty, selected);
  assert.equal(restored.selectionChecked, true);
  assert.equal(restored.hiddenCheckedCount, 0);
  assert.deepEqual(restored.checkedIds, ["visible", "hidden"]);
});

test("多数明細の非表示選択数を数え、外部追加も最新の表示に含める", () => {
  const items = Array.from({ length: 5000 }, (_, index) => item(String(index)));
  const selected = new Set(items.map(record => record.id));
  const visible = new Set(items.slice(0, 2500).map(record => record.id));
  const view = transactionListView([...items, item("new")], record => visible.has(record.id) || record.id === "new", empty, empty, selected);
  assert.equal(view.visible.length, 2501);
  assert.equal(view.checkedIds.length, 5000);
  assert.equal(view.hiddenCheckedCount, 2500);
  assert.equal(view.selectionChecked, false);
});

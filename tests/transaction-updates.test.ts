import assert from "node:assert/strict";
import test from "node:test";
import { applyTransactionUpdate } from "../lib/transaction-updates";
import { transactionRecord } from "../lib/transaction-record";
import { calculateSettlement } from "../lib/settlement";
import type { BootstrapData, TransactionRecord } from "../lib/types";

const item: TransactionRecord = {
  id: "one", occurredAt: "2026-10-06T00:00:00Z", merchant: "スーパー", method: "現金", memo: "レシートあり",
  type: "PAYMENT", amountYen: 1000, actorUserId: "a", actorName: "A", expenseClass: "SHARED",
  splitWeights: { a: 1, b: 1 }, settledAt: null, externalId: "test", source: "MANUAL",
};
function bootstrap(): BootstrapData {
  const members = [
    { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 1, role: "OWNER" as const },
    { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 1, role: "MEMBER" as const },
  ];
  const workspace = { id: "workspace", name: "家計", type: "SHARED" as const, ownerUserId: "a", memberCount: 2 };
  return {
    user: members[0], workspaces: [workspace], pendingInvitations: [],
    selected: { workspace, members, transactions: [item], rules: [], settlementHistory: [], settlement: calculateSettlement(members, [item]) },
  };
}

test("金額・支払者・割合の確定値で対象行と清算額を更新し、元の状態を変更しない", () => {
  const data = bootstrap();
  const saved = { ...item, amountYen: 2000, actorUserId: "b", actorName: "B", splitWeights: { a: 3, b: 1 } };
  const next = applyTransactionUpdate(data, "workspace", { transaction: saved });
  assert.deepEqual(next.selected!.transactions, [saved]);
  assert.deepEqual(next.selected!.settlement, calculateSettlement(data.selected!.members, [saved]));
  assert.equal(next.selected!.settlement!.amountYen, 1500);
  assert.equal(data.selected!.transactions[0].amountYen, 1000);
  assert.strictEqual(next.pendingInvitations, data.pendingInvitations);
});

test("日時を変更した行と新規明細を並べ替え、同じIDを重複追加しない", () => {
  let data = bootstrap();
  const older = { ...item, id: "two", occurredAt: "2026-10-05T00:00:00Z" };
  data = applyTransactionUpdate(data, "workspace", { transaction: older });
  assert.deepEqual(data.selected!.transactions.map(item => item.id), ["one", "two"]);
  data = applyTransactionUpdate(data, "workspace", { transaction: { ...older, occurredAt: "2026-10-07T00:00:00Z" } });
  assert.deepEqual(data.selected!.transactions.map(item => item.id), ["two", "one"]);
});

test("清算後のメモだけを変更すると、清算情報・金額・他の明細を保持する", () => {
  const data = bootstrap();
  data.selected!.transactions = [item, { ...item, id: "settled", settledAt: "2026-10-07T00:00:00Z" }];
  const next = applyTransactionUpdate(data, "workspace", { transactionId: "settled", memo: "追記\n確認済み" });
  assert.strictEqual(next.selected!.settlement, data.selected!.settlement);
  assert.strictEqual(next.selected!.transactions[0], item);
  assert.equal(next.selected!.transactions[1].settledAt, "2026-10-07T00:00:00Z");
  assert.equal(next.selected!.transactions[1].amountYen, 1000);
  assert.equal(next.selected!.transactions[1].memo, "追記\n確認済み");
});

test("以前のワークスペースの保存結果は現在の画面に反映しない", () => {
  const data = bootstrap();
  assert.strictEqual(applyTransactionUpdate(data, "other", { transaction: item }), data);
  assert.strictEqual(applyTransactionUpdate({ ...data, selected: null }, "workspace", { transaction: item }).selected, null);
});

test("DBの確定値から応答を作り、メモ・日時精度を保持して監査用データは含めない", () => {
  const result = transactionRecord({
    id: "one", occurred_at: "2026-10-06T09:00:00.123+09:00", merchant: "スーパー", method: "現金",
    memo: "記録", type: "PAYMENT", amount_yen: 1000, actor_user_id: "a", expense_class: "SHARED",
    split_weights: { a: 1, b: 1 }, settled_at: null, external_id: "test", source: "MANUAL", created_by: "audit",
  }, "A");
  assert.deepEqual(result, { ...item, occurredAt: "2026-10-06T00:00:00.123Z", memo: "記録" });
  assert.equal("created_by" in result, false);
});

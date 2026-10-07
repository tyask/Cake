import assert from "node:assert/strict";
import test from "node:test";
import { transactionMemoInputSchema, transactionMemoSchema } from "../lib/transaction-memo";
import { transactionValues } from "../lib/transaction-editing";
import { calculateSettlement } from "../lib/settlement";
import type { TransactionRecord, WorkspaceMember } from "../lib/types";

const input = {
  action: "saveTransactionMemo",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  transactionId: "00000000-0000-4000-8000-000000000002",
  memo: "立替分\n領収書あり",
};

test("メモは空文字で削除でき、改行・空白を保持し、2000文字まで保存する", () => {
  for (const value of ["", "  立替分\n確認済み  ", "あ".repeat(2000)]) assert.equal(transactionMemoSchema.parse(value), value);
  assert.throws(() => transactionMemoSchema.parse("あ".repeat(2001)));
  for (const value of [null, undefined, 100]) assert.throws(() => transactionMemoSchema.parse(value));
});

test("専用の更新リクエストはメモ以外の取引項目と不正なIDを拒否する", () => {
  assert.deepEqual(transactionMemoInputSchema.parse(input), input);
  for (const field of ["amountYen", "splitWeights", "settledAt", "actorUserId", "merchant", "type"]) {
    assert.throws(() => transactionMemoInputSchema.parse({ ...input, [field]: "変更" }), field);
  }
  assert.throws(() => transactionMemoInputSchema.parse({ ...input, workspaceId: "" }));
  assert.throws(() => transactionMemoInputSchema.parse({ ...input, transactionId: "invalid" }));
});

test("清算後にメモが変わっても取引値と清算計算は変わらない", () => {
  const members: WorkspaceMember[] = [
    { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 1, role: "OWNER" },
    { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 1, role: "MEMBER" },
  ];
  const item: TransactionRecord = {
    id: input.transactionId, occurredAt: "2026-10-06T00:00:00Z", merchant: "スーパー", method: "現金",
    type: "PAYMENT", amountYen: 1001, actorUserId: "a", actorName: "A", expenseClass: "SHARED",
    splitWeights: { a: 1, b: 1 }, settledAt: "2026-10-07T00:00:00Z", externalId: "memo-test", source: "MANUAL", memo: "",
  };
  const edited = { ...item, memo: input.memo };
  assert.deepEqual(transactionValues(edited), transactionValues(item));
  assert.deepEqual(calculateSettlement(members, [edited]), calculateSettlement(members, [item]));
  assert.equal(edited.settledAt, item.settledAt);
});

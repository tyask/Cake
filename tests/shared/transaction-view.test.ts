import assert from "node:assert/strict";
import test from "node:test";
import { transactionMatchesView, transactionViewQuerySchema, transactionViewSelectionSchema } from "../../lib/shared/transaction-view";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("明細の月条件は暦月全体の下限・上限・未来月を受け付ける", () => {
  for (const month of ["0001-01", "0001-02", "2024-02", "2026-10", "2099-01", "9999-12"]) {
    assert.equal(transactionViewQuerySchema.safeParse({ workspaceId, mode: "month", month }).success, true, month);
  }
  for (const month of ["0000-01", "10000-01", "2026-00", "2026-13", "2026-1", "26-01", "2026-10-01", "", " 2026-10"]) {
    assert.equal(transactionViewQuerySchema.safeParse({ workspaceId, mode: "month", month }).success, false, month);
  }
});

test("未精算条件は月指定なしで利用でき、不正な取得条件を拒否する", () => {
  assert.equal(transactionViewQuerySchema.safeParse({ workspaceId, mode: "unsettled" }).success, true);
  assert.equal(transactionViewQuerySchema.safeParse({ workspaceId, mode: "unsettled", month: "2026-10" }).success, true);
  assert.equal(transactionViewQuerySchema.safeParse({ workspaceId, mode: "unsettled", month: "ignored" }).success, true);
  for (const input of [{}, { workspaceId, mode: "month" }, { workspaceId, mode: "all" },
    { workspaceId: "other", mode: "unsettled" }, { workspaceId, mode: "month", month: "2026-10", userId: "other" },
    { workspaceId, mode: "unsettled", expenseClass: "PERSONAL" }]) {
    assert.equal(transactionViewQuerySchema.safeParse(input).success, false, JSON.stringify(input));
  }
});

test("表示選択は未精算でも最後の有効な月を保持する", () => {
  assert.deepEqual(transactionViewSelectionSchema.parse({ mode: "unsettled", month: "2026-10" }),
    { mode: "unsettled", month: "2026-10" });
  for (const input of [{ mode: "unsettled" }, { mode: "month", month: "2026-13" },
    { mode: "all", month: "2026-10" }, { mode: "month", month: "2026-10", userId: "b" }]) {
    assert.equal(transactionViewSelectionSchema.safeParse(input).success, false);
  }
});

test("表示判定は日本時間の月全体と、全期間の未清算共有明細を区別する", () => {
  const item = { occurredAt: "2026-09-30T15:00:00Z", expenseClass: "SHARED" as const, settledAt: null };
  const month = { mode: "month" as const, month: "2026-10" };
  const unsettled = { mode: "unsettled" as const, month: "2026-10" };
  assert.equal(transactionMatchesView(item, month), true);
  assert.equal(transactionMatchesView({ ...item, occurredAt: "2026-09-30T14:59:59.999Z" }, month), false);
  assert.equal(transactionMatchesView({ ...item, occurredAt: "2026-10-31T14:59:59.999Z" }, month), true);
  assert.equal(transactionMatchesView({ ...item, occurredAt: "2026-10-31T15:00:00Z" }, month), false);
  assert.equal(transactionMatchesView({ ...item, expenseClass: "PERSONAL", settledAt: "2026-10-01T00:00:00Z" }, month), true);
  assert.equal(transactionMatchesView({ ...item, occurredAt: "2099-01-01T00:00:00Z" }, unsettled), true);
  assert.equal(transactionMatchesView({ ...item, expenseClass: "PERSONAL" }, unsettled), false);
  assert.equal(transactionMatchesView({ ...item, settledAt: "2026-10-01T00:00:00Z" }, unsettled), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultTransactionViewSelection, parseStoredTransactionView, readStoredTransactionView,
  transactionViewStorageKey, writeStoredTransactionView,
} from "../../lib/client/transaction-view-storage";

const now = new Date("2026-10-31T15:00:00Z");
const fallback = { mode: "month", month: "2026-11" };

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
}

test("初期月は日本時間で判定する", () => {
  assert.deepEqual(defaultTransactionViewSelection(new Date("2026-10-31T14:59:59.999Z")), { mode: "month", month: "2026-10" });
  assert.deepEqual(defaultTransactionViewSelection(now), fallback);
});

test("保存キーはユーザー・ワークスペースと区切り文字を区別する", () => {
  assert.equal(transactionViewStorageKey("user", "workspace"), "cake:transaction-view:v1:user:workspace");
  const keys = [["a", "b"], ["c", "b"], ["a", "c"], ["a:b", "c"], ["a", "b:c"], ["a%3Ab", "c"]]
    .map(([userId, workspaceId]) => transactionViewStorageKey(userId, workspaceId));
  assert.equal(new Set(keys).size, keys.length);
});

test("モードと最後の選択月をまとめて復元し、境界年月も保持する", () => {
  for (const mode of ["month", "unsettled"] as const) {
    for (const month of ["0001-01", "2024-02", "2026-11", "9999-12"]) {
      assert.deepEqual(parseStoredTransactionView(JSON.stringify({ mode, month }), now), { mode, month });
    }
  }
});

test("欠落・不正・破損した保存値は月単位の当月へ戻す", () => {
  for (const raw of [null, "", "{", "null", "true", "123", '"month"', "[]", "{}",
    '{"mode":"month"}', '{"mode":"all","month":"2026-10"}',
    '{"mode":"month","month":"0000-01"}', '{"mode":"month","month":"2026-00"}',
    '{"mode":"month","month":"2026-13"}', '{"mode":"month","month":"2026-1"}',
    '{"mode":"unsettled","month":null}', '{"mode":"unsettled","month":"2026-10","unknown":true}']) {
    assert.deepEqual(parseStoredTransactionView(raw, now), fallback, String(raw));
  }
});

test("ユーザー・ワークスペースごとの月とモードを独立して保存・再読込する", () => {
  const storage = memoryStorage();
  const mine = transactionViewStorageKey("user", "workspace");
  const otherWorkspace = transactionViewStorageKey("user", "other");
  const otherUser = transactionViewStorageKey("other", "workspace");
  writeStoredTransactionView(storage, mine, { mode: "unsettled", month: "2026-09" });
  writeStoredTransactionView(storage, otherWorkspace, { mode: "month", month: "2026-08" });
  assert.deepEqual(readStoredTransactionView(storage, mine, now), { mode: "unsettled", month: "2026-09" });
  assert.deepEqual(readStoredTransactionView(storage, otherWorkspace, now), { mode: "month", month: "2026-08" });
  assert.deepEqual(readStoredTransactionView(storage, otherUser, now), fallback);
});

test("保存領域の読込拒否・容量不足でも例外を外へ出さない", () => {
  assert.deepEqual(readStoredTransactionView({ getItem() { throw new Error("SecurityError"); } }, "key", now), fallback);
  assert.doesNotThrow(() => writeStoredTransactionView({ setItem() { throw new Error("QuotaExceededError"); } }, "key", { mode: "unsettled", month: "2026-09" }));
});

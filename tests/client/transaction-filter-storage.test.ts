import assert from "node:assert/strict";
import test from "node:test";
import {
  parseStoredTransactionFilters,
  readStoredTransactionFilters,
  transactionFiltersStorageKey,
  writeStoredTransactionFilters,
} from "../../lib/client/transaction-filter-storage";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
}

test("保存キーはバージョン、ユーザー、ワークスペースを区別し、区切り文字も衝突しない", () => {
  assert.equal(transactionFiltersStorageKey("user", "workspace"), "cake:transaction-filters:v1:user:workspace");
  const keys = [
    transactionFiltersStorageKey("user", "workspace"),
    transactionFiltersStorageKey("other-user", "workspace"),
    transactionFiltersStorageKey("user", "other-workspace"),
    transactionFiltersStorageKey("a:b", "c"),
    transactionFiltersStorageKey("a", "b:c"),
    transactionFiltersStorageKey("a%3Ab", "c"),
  ];
  assert.equal(new Set(keys).size, keys.length);
});

test("壊れたJSONとオブジェクト以外の保存値はフィルタなしとして読む", () => {
  for (const raw of [null, "", "{", "null", "true", "123", '"merchant"', '[["merchant"]]']) {
    assert.deepEqual(parseStoredTransactionFilters(raw), {});
  }
});

test("既知の列の文字列配列だけを復元し、無効な列があっても有効な列は残す", () => {
  const raw = JSON.stringify({
    merchant: ["スーパー", "カフェ"],
    method: ["現金", 123],
    amountYen: "1000",
    actorUserId: null,
    occurredAt: { value: "2026-10-10" },
    expenseClass: [true],
    unknownColumn: ["値"],
    settlement: ["PENDING"],
    __proto__: ["ignored"],
  });
  assert.deepEqual(parseStoredTransactionFilters(raw), {
    merchant: ["スーパー", "カフェ"],
    settlement: ["PENDING"],
  });
});

test("0件の選択と空白メモの選択を保持する", () => {
  assert.deepEqual(parseStoredTransactionFilters('{"merchant":[],"memo":[""]}'), { merchant: [], memo: [""] });
});

test("ユーザーとワークスペースごとに保存、復元し、全解除で保存値を削除する", () => {
  const storage = memoryStorage();
  const key = transactionFiltersStorageKey("user", "workspace");
  const otherUserKey = transactionFiltersStorageKey("other-user", "workspace");
  const otherWorkspaceKey = transactionFiltersStorageKey("user", "other-workspace");
  const filters = { merchant: ["スーパー"], memo: [""], settlement: [] };

  writeStoredTransactionFilters(storage, key, filters);
  writeStoredTransactionFilters(storage, otherWorkspaceKey, { method: ["カード"] });
  assert.deepEqual(readStoredTransactionFilters(storage, key), filters);
  assert.deepEqual(readStoredTransactionFilters(storage, otherUserKey), {});
  assert.deepEqual(readStoredTransactionFilters(storage, otherWorkspaceKey), { method: ["カード"] });

  writeStoredTransactionFilters(storage, key, {});
  assert.equal(storage.getItem(key), null);
  assert.deepEqual(readStoredTransactionFilters(storage, key), {});
  assert.deepEqual(readStoredTransactionFilters(storage, otherWorkspaceKey), { method: ["カード"] });
});

test("破損した保存値、保存拒否、容量不足、削除拒否で画面を中断しない", () => {
  const storage = memoryStorage();
  storage.setItem("corrupt", "invalid-json");
  assert.deepEqual(readStoredTransactionFilters(storage, "corrupt"), {});

  assert.deepEqual(readStoredTransactionFilters({ getItem() { throw new Error("SecurityError"); } }, "blocked"), {});
  const unavailable = {
    setItem() { throw new Error("QuotaExceededError"); },
    removeItem() { throw new Error("SecurityError"); },
  };
  assert.doesNotThrow(() => writeStoredTransactionFilters(unavailable, "blocked", { merchant: ["スーパー"] }));
  assert.doesNotThrow(() => writeStoredTransactionFilters(unavailable, "blocked", {}));
});


test("旧金額フィルタは同額の支払いと収入の両方を復元する", () => {
  assert.deepEqual(parseStoredTransactionFilters(JSON.stringify({ amountYen: ["1000", "PAYMENT:2000"], merchant: ["店舗"], type: ["RECEIPT"] })), {
    amountYen: ["PAYMENT:1000", "RECEIPT:1000", "PAYMENT:2000"], merchant: ["店舗"], type: ["RECEIPT"],
  });
  const storage = memoryStorage();
  const filters = { amountYen: ["PAYMENT:1000", "RECEIPT:1000"], type: ["RECEIPT"] };
  writeStoredTransactionFilters(storage, "signed", filters);
  assert.deepEqual(readStoredTransactionFilters(storage, "signed"), filters);
});

test("カテゴリIDと未分類を他の条件と一緒に復元し、個別解除・全解除を保存する", () => {
  const storage = memoryStorage();
  const key = transactionFiltersStorageKey("user", "workspace");
  const filters = { category: ["food", "vegetables", ""], merchant: ["スーパー"] };
  writeStoredTransactionFilters(storage, key, filters);
  assert.deepEqual(readStoredTransactionFilters(storage, key), filters);
  assert.deepEqual(parseStoredTransactionFilters('{"category":[],"memo":[""]}'), { category: [], memo: [""] });
  assert.deepEqual(parseStoredTransactionFilters('{"category":["food",null],"method":["現金"]}'), { method: ["現金"] });

  writeStoredTransactionFilters(storage, key, { merchant: filters.merchant });
  assert.deepEqual(readStoredTransactionFilters(storage, key), { merchant: ["スーパー"] });
  writeStoredTransactionFilters(storage, key, {});
  assert.equal(storage.getItem(key), null);
  assert.deepEqual(readStoredTransactionFilters(storage, key), {});
});

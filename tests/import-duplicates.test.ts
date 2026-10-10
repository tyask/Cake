import assert from "node:assert/strict";
import test from "node:test";
import { applyPayPayDuplicateChecks, importDuplicateCheckSchema, PAYPAY_KEY_CONFLICT_ERROR } from "../lib/import-duplicates";
import { parsePayPayCsv } from "../lib/paypay";

function rows() {
  return parsePayPayCsv("取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n2026/10/10 14:30:00,500,支払い,店舗,PayPay残高,abc", [], new Set());
}

test("登録済みの同じキー・金額・取引先は再選択できない", () => {
  const original = rows();
  const snapshot = structuredClone(original);
  const checked = applyPayPayDuplicateChecks(original, [{ ...original[0], source: "PAYPAY" }]);
  assert.equal(checked[0].duplicate, true);
  assert.equal(checked[0].selected, false);
  assert.equal(checked[0].error, null);
  assert.deepEqual(original, snapshot);
});

test("登録済みの同じキーで内容が違えば重複扱いで隠さず衝突を表示する", () => {
  const original = rows();
  for (const change of [{ amountYen: 600 }, { merchant: "別店舗" }, { source: "MANUAL" }]) {
    const checked = applyPayPayDuplicateChecks(original, [{ ...original[0], source: "PAYPAY", ...change }]);
    assert.equal(checked[0].duplicate, false);
    assert.equal(checked[0].selected, false);
    assert.equal(checked[0].error, PAYPAY_KEY_CONFLICT_ERROR);
  }
});

test("同じ番号でも日時が違う登録済みキーは取り込みを妨げない", () => {
  const original = rows();
  const checked = applyPayPayDuplicateChecks(original, [{ ...original[0], externalId: "PayPay_20261011143000_abc", source: "PAYPAY" }]);
  assert.equal(checked[0].selected, true);
  assert.equal(checked[0].duplicate, false);
});

test("重複確認は接頭辞を含む最大長と最大2000件の制限を受け入れる", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const maxId = "PayPay_20261010143000_" + "1".repeat(160);
  assert.equal(importDuplicateCheckSchema.safeParse({ workspaceId, externalIds: [maxId] }).success, true);
  assert.equal(importDuplicateCheckSchema.safeParse({ workspaceId, externalIds: [maxId + "1"] }).success, false);
  assert.equal(importDuplicateCheckSchema.safeParse({ workspaceId, externalIds: Array(2000).fill(maxId) }).success, true);
  assert.equal(importDuplicateCheckSchema.safeParse({ workspaceId, externalIds: Array(2001).fill(maxId) }).success, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { normalizePayPayExternalId, payPayDateToIso, payPayExternalId } from "../lib/paypay-id";

test("CSVの日本時間を14桁にし、番号の先頭ゼロを保持する", () => {
  const iso = payPayDateToIso(" 2026/10/10 14:30:05 ");
  assert.equal(iso, "2026-10-10T05:30:05.000Z");
  assert.equal(payPayExternalId(iso, " 000123 "), "PayPay_20261010143005_000123");
  assert.equal(payPayExternalId("2026-10-10T14:30:05+09:00", "000123"), "PayPay_20261010143005_000123");
});

test("日本時間の日付境界と閏日を保持する", () => {
  for (const [csvDate, iso, id] of [
    ["2026/01/01 00:00:00", "2025-12-31T15:00:00.000Z", "PayPay_20260101000000_abc"],
    ["2024/02/29 23:59:59", "2024-02-29T14:59:59.000Z", "PayPay_20240229235959_abc"],
  ]) {
    assert.equal(payPayDateToIso(csvDate), iso);
    assert.equal(payPayExternalId(iso, "abc"), id);
  }
});

test("存在しない日時を補正せずに拒否する", () => {
  for (const date of ["2026/02/29 12:00:00", "2026/04/31 12:00:00", "2026/10/10 24:00:00", "2026/10/10 12:00:60", "2026/10/10 12:00", ""]) {
    assert.throws(() => payPayDateToIso(date), /日時形式が不正/);
  }
});

test("保存時は旧形式の番号を正規化し、新形式は日時一致を確認する", () => {
  const iso = "2026-10-10T05:30:00.000Z";
  const id = "PayPay_20261010143000_000123";
  assert.equal(normalizePayPayExternalId(iso, " 000123 "), id);
  assert.equal(normalizePayPayExternalId(iso, id), id);
  assert.throws(() => normalizePayPayExternalId(iso, "PayPay_20261010143001_000123"), /取引日時と取引IDが一致しません/);
});

test("番号の上限は接頭辞と14桁日時を加えた後も保存できる", () => {
  const iso = "2026-10-10T05:30:00.000Z";
  const id = payPayExternalId(iso, "1".repeat(160));
  assert.equal(id.length, 182);
  assert.equal(normalizePayPayExternalId(iso, id), id);
  assert.throws(() => payPayExternalId(iso, "1".repeat(161)), /160文字以内/);
  assert.throws(() => payPayExternalId(iso, " "), /取引番号がありません/);
});

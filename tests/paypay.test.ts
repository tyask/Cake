import test from "node:test";
import assert from "node:assert/strict";
import { parsePayPayCsv, payPayDateToIso } from "../lib/paypay";
import type { WorkspaceMember } from "../lib/types";

const members: WorkspaceMember[] = [
  { id: "a", email: "a@example.com", name: "A", imageUrl: null, weight: 6, role: "OWNER" },
  { id: "b", email: "b@example.com", name: "B", imageUrl: null, weight: 4, role: "MEMBER" },
];

test("サンプルCSVから支払い行だけを抽出する", () => {
  const csv = [
    "\uFEFF取引日,出金金額（円）,入金金額（円）,取引内容,取引先,取引方法,取引番号",
    ' 2026/07/15 20:01:44 ,"1,200",-,支払い,サンプルスーパー,PayPay残高,payment-1',
    "2026/07/14 09:00:00,500,-,支払い,サンプルカフェ,PayPayポイント,payment-2",
    "2026/07/13 10:00:00,-,300,受け取り,サンプル利用者,PayPay残高,receipt-1",
    "2026/07/12 10:00:00,100,-,送る,サンプル利用者,PayPay残高,transfer-1",
    "2026/07/11 10:00:00,200,-,ポイント運用,PayPayポイント運用,PayPayポイント,points-1",
  ].join("\n");
  const rows = parsePayPayCsv(csv, [], new Set());
  assert.deepEqual(rows.map((row) => row.externalId), ["payment-1", "payment-2"]);
  assert.deepEqual(rows.map((row) => row.amountYen), [1200, 500]);
  assert.ok(rows.every((row) => row.amountYen > 0));
  assert.ok(rows.every((row) => !row.error));
  assert.ok(rows.every((row) => row.occurredAt === row.occurredAt.trim()));
  assert.equal(payPayDateToIso(rows[0].occurredAt), "2026-07-15T11:01:44.000Z");
});

test("取引先の部分一致ルールは上の順番を採用し、割合も適用する", () => {
  const csv = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n2026/07/15 20:00:00,500,支払い,ヨークフーズ早稲田店,現金,abc";
  const rows = parsePayPayCsv(csv, [
    { id: "1", merchantContains: "ヨーク", expenseClass: "SHARED", sortOrder: 0, splitWeights: { a: 1, b: 3 }, enabled: true },
    { id: "2", merchantContains: "ヨークフーズ", expenseClass: "PERSONAL", sortOrder: 1, splitWeights: null, enabled: true },
  ], new Set(), members, "a");
  assert.equal(rows[0].expenseClass, "SHARED");
  assert.deepEqual(rows[0].splitWeights, { a: 1, b: 3 });
});

test("CSVの個人費は選んだ取引担当者の1:0でプレビューする", () => {
  const csv = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n2026/07/15 20:00:00,500,支払い,店舗,現金,abc";
  const rows = parsePayPayCsv(csv, [], new Set(), members, "b");
  assert.deepEqual(rows[0].splitWeights, { a: 0, b: 1 });
});

test("既存取引IDは選択不可にする", () => {
  const csv = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n2026/07/15 20:00:00,500,支払い,店舗,現金,abc";
  const rows = parsePayPayCsv(csv, [], new Set(["abc"]));
  assert.equal(rows[0].duplicate, true);
  assert.equal(rows[0].selected, false);
});

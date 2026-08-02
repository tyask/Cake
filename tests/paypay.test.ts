import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parsePayPayCsv, payPayDateToIso } from "../lib/paypay";

test("サンプルCSVから支払い行だけを抽出する", async () => {
  const csv = await readFile(new URL("../data/Transactions_20260701-20260715.csv", import.meta.url), "utf8");
  const rows = parsePayPayCsv(csv, [], new Set());
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.amountYen > 0));
  assert.ok(rows.every((row) => !row.error));
  assert.ok(rows.every((row) => row.occurredAt === row.occurredAt.trim()));
  assert.equal(payPayDateToIso(rows[0].occurredAt), "2026-07-15T11:01:44.000Z");
  assert.ok(!rows.some((row) => row.merchant === "山本幸奈"));
  assert.ok(!rows.some((row) => row.merchant === "PayPayポイント運用"));
});

test("取引先の部分一致ルールは優先順位の小さいものを採用する", () => {
  const csv = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n2026/07/15 20:00:00,500,支払い,ヨークフーズ早稲田店,現金,abc";
  const rows = parsePayPayCsv(csv, [
    { id: "1", merchantContains: "ヨーク", expenseClass: "SHARED", priority: 10, enabled: true },
    { id: "2", merchantContains: "ヨークフーズ", expenseClass: "PERSONAL", priority: 20, enabled: true },
  ], new Set());
  assert.equal(rows[0].expenseClass, "SHARED");
});

test("既存取引IDは選択不可にする", () => {
  const csv = "取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n2026/07/15 20:00:00,500,支払い,店舗,現金,abc";
  const rows = parsePayPayCsv(csv, [], new Set(["abc"]));
  assert.equal(rows[0].duplicate, true);
  assert.equal(rows[0].selected, false);
});

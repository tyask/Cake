import assert from "node:assert/strict";
import test from "node:test";
import { sortTransactions } from "../../lib/shared/transaction-sort";
import type { TransactionColumn } from "../../lib/shared/transaction-filters";
import type { TransactionRecord, WorkspaceMember } from "../../lib/shared/types";

const members: WorkspaceMember[] = [
  { id: "a", name: "参加者2", email: "a@example.test", imageUrl: null, weight: 1, role: "OWNER" },
  { id: "b", name: "参加者10", email: "b@example.test", imageUrl: null, weight: 1, role: "MEMBER" },
  { id: "c", name: "参加者3", email: "c@example.test", imageUrl: null, weight: 1, role: "MEMBER" },
];

const record = (id: string, values: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id, occurredAt: "2026-10-06T23:15:00.125Z", merchant: "店舗", method: "現金", memo: "",
  type: "PAYMENT", amountYen: 100, actorUserId: "a", actorName: "以前の名前", expenseClass: "SHARED",
  splitWeights: { a: 1, b: 1, c: 0 }, settledAt: null, externalId: id, source: "MANUAL",
  categoryId: null, categoryConfirmed: false, categoryRevision: 0, ...values,
});

function assertOrder(column: TransactionColumn, items: readonly TransactionRecord[], asc: string[], desc: string[]) {
  assert.deepEqual(sortTransactions(items, { column, direction: "asc" }, members).map(item => item.id), asc);
  assert.deepEqual(sortTransactions(items, { column, direction: "desc" }, members).map(item => item.id), desc);
}

test("日時はタイムゾーン表記ではなくミリ秒までの時刻順にし、同時刻の順を維持する", () => {
  const items = [
    record("later", { occurredAt: "2026-10-07T08:15:00.126+09:00" }),
    record("same-z"),
    record("earlier", { occurredAt: "2026-10-07T08:14:59.999+09:00" }),
    record("same-offset", { occurredAt: "2026-10-07T08:15:00.125+09:00" }),
  ];
  assertOrder("occurredAt", items, ["earlier", "same-z", "same-offset", "later"], ["later", "same-z", "same-offset", "earlier"]);
});

test("金額は支払いを負・収入を正の数値として並べ、0円の同値順も維持する", () => {
  const items = [
    record("receipt-large", { type: "RECEIPT", amountYen: 2147483647 }),
    record("payment-small", { amountYen: 20 }),
    record("payment-zero", { amountYen: 0 }),
    record("payment-large", { amountYen: 2147483647 }),
    record("receipt-small", { type: "RECEIPT", amountYen: 20 }),
    record("receipt-zero", { type: "RECEIPT", amountYen: 0 }),
  ];
  assertOrder("amountYen", items,
    ["payment-large", "payment-small", "payment-zero", "receipt-zero", "receipt-small", "receipt-large"],
    ["receipt-large", "receipt-small", "payment-zero", "receipt-zero", "payment-small", "payment-large"]);
});

for (const column of ["merchant", "method", "memo"] as const) {
  test(`${column}は日本語の数字を含む文字列を自然順に並べ、同じ値の順を維持する`, () => {
    const items = [
      record("ten", { [column]: "店舗10" }),
      record("two-first", { [column]: "店舗2" }),
      record("one", { [column]: "店舗1" }),
      record("two-second", { [column]: "店舗2" }),
    ];
    assertOrder(column, items, ["one", "two-first", "two-second", "ten"], ["ten", "two-first", "two-second", "one"]);
  });
}

test("担当者はIDや明細に残る古い名前ではなく参加者の表示名で並べる", () => {
  const items = [
    record("ten", { actorUserId: "b", actorName: "参加者1" }),
    record("fallback", { actorUserId: "removed", actorName: "参加者3" }),
    record("two", { actorUserId: "a", actorName: "参加者99" }),
    record("three", { actorUserId: "c", actorName: "参加者0" }),
  ];
  assertOrder("actorUserId", items, ["two", "fallback", "three", "ten"], ["ten", "fallback", "three", "two"]);
});

test("種別・区分・清算状態は画面の日本語ラベル順に並べる", () => {
  assertOrder("type", [record("receipt", { type: "RECEIPT" }), record("payment")], ["payment", "receipt"], ["receipt", "payment"]);
  assertOrder("expenseClass", [record("personal", { expenseClass: "PERSONAL" }), record("shared")], ["shared", "personal"], ["personal", "shared"]);
  const states = [
    record("pending"),
    record("personal", { expenseClass: "PERSONAL" }),
    record("settled", { settledAt: "2026-10-08T00:00:00Z" }),
    record("settled-personal", { expenseClass: "PERSONAL", settledAt: "2026-10-08T00:00:00Z" }),
  ];
  assertOrder("settlement", states, ["settled", "settled-personal", "personal", "pending"], ["pending", "personal", "settled", "settled-personal"]);
});

test("カテゴリはIDではなく階層全体の表示名・使用停止・未分類で比較する", () => {
  const categories = new Map([
    ["z", { label: "あ分類 › 項目2", archived: false }],
    ["y", { label: "あ分類 › 項目2", archived: true }],
    ["x", { label: "あ分類 › 項目10", archived: false }],
    ["a", { label: "か分類 › 項目2", archived: false }],
  ]);
  const items = [
    record("unavailable", { categoryId: "missing" }),
    record("other-parent", { categoryId: "a" }),
    record("ten", { categoryId: "x" }),
    record("unclassified"),
    record("archived", { categoryId: "y" }),
    record("two", { categoryId: "z" }),
  ];
  assert.deepEqual(sortTransactions(items, { column: "category", direction: "asc" }, members, categories).map(item => item.id),
    ["two", "archived", "ten", "other-parent", "unclassified", "unavailable"]);
  assert.deepEqual(sortTransactions(items, { column: "category", direction: "desc" }, members, categories).map(item => item.id),
    ["unavailable", "unclassified", "other-parent", "ten", "archived", "two"]);
  assert.deepEqual(sortTransactions(items, { column: "category", direction: "asc" }, members).map(item => item.id),
    ["unclassified", "unavailable", "other-parent", "ten", "archived", "two"], "カテゴリ情報がないIDは同じ利用不可ラベルとして元順に残す");
});

test("割合はメンバー表示順の数値で比較し、重みの単位が異なる同じ割合は同値とする", () => {
  const items = [
    record("all", { splitWeights: { a: 1, b: 0, c: 0 } }),
    record("half", { splitWeights: { a: 1, b: 1, c: 0 } }),
    record("ten", { splitWeights: { a: 1, b: 9, c: 0 } }),
    record("same-first-more-second", { splitWeights: { a: 1, b: 1, c: 8 } }),
    record("equivalent-half", { splitWeights: { a: 50, b: 50, c: 0 } }),
    record("same-first-less-second", { splitWeights: { a: 1, b: 0, c: 9 } }),
  ];
  assertOrder("splitWeights", items,
    ["same-first-less-second", "same-first-more-second", "ten", "half", "equivalent-half", "all"],
    ["all", "half", "equivalent-half", "ten", "same-first-more-second", "same-first-less-second"]);
  assert.deepEqual(sortTransactions(items, { column: "splitWeights", direction: "asc" }, [...members].reverse()).map(item => item.id),
    ["all", "half", "equivalent-half", "ten", "same-first-more-second", "same-first-less-second"], "参加者の表示順が変われば比較する割合の優先順も変わる");
});

test("空一覧を処理でき、ソートは入力の明細・配列・割合を変更しない", () => {
  const items = Object.freeze([
    Object.freeze(record("two", { merchant: "店舗2", splitWeights: Object.freeze({ a: 1, b: 1, c: 0 }) })),
    Object.freeze(record("one", { merchant: "店舗1", splitWeights: Object.freeze({ a: 0, b: 1, c: 0 }) })),
  ]);
  const before = JSON.stringify(items);
  const sorted = sortTransactions(items, { column: "merchant", direction: "asc" }, members);
  assert.deepEqual(sorted.map(item => item.id), ["one", "two"]);
  sortTransactions(items, { column: "splitWeights", direction: "desc" }, members);
  assert.equal(JSON.stringify(items), before);
  assert.notEqual(sorted, items);
  assert.equal(sorted[0], items[1]);
  assert.deepEqual(sortTransactions([], { column: "splitWeights", direction: "asc" }, []), []);
});

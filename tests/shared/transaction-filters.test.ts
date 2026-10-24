import assert from "node:assert/strict";
import test from "node:test";
import { createTransactionFilterMatcher, transactionFilterOptions, transactionFilterValue } from "../../lib/shared/transaction-filters";
import type { TransactionFilters } from "../../lib/shared/transaction-filters";
import type { TransactionRecord, WorkspaceMember } from "../../lib/shared/types";

const members: WorkspaceMember[] = [
  { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 1, role: "OWNER" },
  { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 1, role: "MEMBER" },
];
const matchesTransactionFilters = (item: TransactionRecord, filters: TransactionFilters, people: WorkspaceMember[]) => createTransactionFilterMatcher(filters, people)(item);
const base: TransactionRecord = {
  id: "one", occurredAt: "2026-10-06T23:15:00.125Z", merchant: "スーパー", method: "現金",
  type: "PAYMENT", amountYen: 1001, actorUserId: "a", actorName: "A", expenseClass: "SHARED",
  splitWeights: { a: 6, b: 4 }, settledAt: null, externalId: "filter-test", source: "MANUAL", categoryId: null, categoryConfirmed: false, categoryRevision: 0, memo: "",
};

test("同じ列はOR、複数列はANDで照合し、空の選択は0件になる", () => {
  assert.equal(matchesTransactionFilters(base, {}, members), true);
  assert.equal(matchesTransactionFilters(base, { merchant: ["カフェ", "スーパー"], method: ["現金"] }, members), true);
  assert.equal(matchesTransactionFilters(base, { merchant: ["スーパー"], method: ["カード"] }, members), false);
  assert.equal(matchesTransactionFilters(base, { merchant: [] }, members), false);
});

test("重複した値を集約して件数を表示し、金額は数値順になる", () => {
  const items = [base, { ...base, id: "two", amountYen: 20 }, { ...base, id: "three", amountYen: 100 }];
  assert.deepEqual(transactionFilterOptions(items, "merchant", members), [{ value: "スーパー", label: "スーパー", count: 3 }]);
  assert.deepEqual(transactionFilterOptions(items, "amountYen", members).map(option => option.value), ["PAYMENT:1001", "PAYMENT:100", "PAYMENT:20"]);
});

test("支払者はIDで照合し、日時はJSTの秒とミリ秒を保持する", () => {
  const sameNames = members.map(member => ({ ...member, name: "同じ名前" }));
  assert.equal(matchesTransactionFilters(base, { actorUserId: ["b"] }, sameNames), false);
  assert.equal(transactionFilterValue(base, "occurredAt", members).label, "2026-10-07 08:15:00.125");
});

test("割合入力と円入力の同じ分担をまとめ、参加者の順番を保つ", () => {
  const amounts = { ...base, id: "two", amountYen: 1000, splitWeights: { a: 600, b: 400 } };
  assert.deepEqual(transactionFilterOptions([base, amounts], "splitWeights", members),
    [{ value: "[600,400]", label: "60% / 40%", count: 2 }]);
});

test("清算済み、未清算、個人費の対象外を区別する", () => {
  assert.equal(transactionFilterValue(base, "settlement", members).label, "未清算");
  assert.equal(transactionFilterValue({ ...base, expenseClass: "PERSONAL" }, "settlement", members).label, "対象外");
  assert.equal(transactionFilterValue({ ...base, settledAt: "2026-10-07T00:00:00Z" }, "settlement", members).label, "清算済み");
});

test("候補の件数は現在表示中の明細だけを数え、非表示の値は0件で残す", () => {
  const items = [
    base,
    { ...base, id: "two", method: "カード" },
    { ...base, id: "three", merchant: "カフェ", method: "カード" },
  ];
  const visible = items.filter(item => matchesTransactionFilters(item, { merchant: ["スーパー"], method: ["現金"] }, members));
  assert.deepEqual(transactionFilterOptions(items, "method", members, visible), [
    { value: "カード", label: "カード", count: 0 },
    { value: "現金", label: "現金", count: 1 },
  ]);
  assert.deepEqual(transactionFilterOptions(items, "merchant", members, visible), [
    { value: "カフェ", label: "カフェ", count: 0 },
    { value: "スーパー", label: "スーパー", count: 1 },
  ]);
  assert.ok(transactionFilterOptions(items, "merchant", members, []).every(option => option.count === 0));
});

test("メモは改行を含む値と空白を区別し、清算済みの明細も絞り込める", () => {
  const item = { ...base, memo: "立替分\n確認済み", settledAt: "2026-10-07T00:00:00Z" };
  assert.equal(matchesTransactionFilters(item, { memo: [item.memo] }, members), true);
  assert.equal(matchesTransactionFilters(item, { memo: [""] }, members), false);
  assert.deepEqual(transactionFilterOptions([base, item], "memo", members).find(option => option.value === ""),
    { value: "", label: "（空白）", count: 1 });
});


test("多数候補を一度準備して再利用し、保存用配列は変更しない", () => {
  const values = Array.from({ length: 5000 }, (_, index) => `店舗${index}`);
  values.push("スーパー", "スーパー");
  const filters = { merchant: values, method: ["現金"] };
  const before = JSON.stringify(filters);
  const matches = createTransactionFilterMatcher(filters, members);
  const items = Array.from({ length: 5000 }, (_, index) => ({ ...base, id: String(index), merchant: `店舗${index}` }));
  assert.equal(items.filter(matches).length, 5000);
  assert.equal(matches(base), true);
  assert.equal(matches({ ...base, merchant: "候補外" }), false);
  assert.equal(matches({ ...base, method: "カード" }), false);
  assert.equal(JSON.stringify(filters), before);
  const changed = createTransactionFilterMatcher({ ...filters, merchant: [] }, members);
  assert.equal(changed(base), false);
  assert.equal(matches(base), true);
});


test("同額の支払いと収入は別候補になり種別と金額で絞り込める", () => {
  const receipt = { ...base, id: "receipt", type: "RECEIPT" as const };
  const options = transactionFilterOptions([base, receipt], "amountYen", members);
  assert.deepEqual(options.map(option => option.value), ["PAYMENT:1001", "RECEIPT:1001"]);
  assert.match(options[0].label, /^−/);
  assert.match(options[1].label, /^\+/);
  assert.equal(matchesTransactionFilters(base, { amountYen: ["PAYMENT:1001"] }, members), true);
  assert.equal(matchesTransactionFilters(receipt, { amountYen: ["PAYMENT:1001"] }, members), false);
  assert.equal(matchesTransactionFilters(receipt, { type: ["RECEIPT"] }, members), true);
  assert.equal(matchesTransactionFilters(base, { type: ["RECEIPT"] }, members), false);
  assert.equal(transactionFilterValue(receipt, "type", members).label, "収入");
});

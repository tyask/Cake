import test from "node:test";
import assert from "node:assert/strict";
import {
  transactionActorPatch, transactionDateInput, transactionDateToIso,
  transactionExpensePatch, transactionValues, validateTransactionValues, type TransactionValues,
} from "../lib/transaction-editing";
import type { TransactionRecord, WorkspaceMember } from "../lib/types";

const members: WorkspaceMember[] = [
  { id: "a", name: "A", email: "a@example.com", imageUrl: null, weight: 6, role: "OWNER" },
  { id: "b", name: "B", email: "b@example.com", imageUrl: null, weight: 4, role: "MEMBER" },
];
const record: TransactionRecord = {
  id: "transaction", occurredAt: "2026-10-05T09:15:37.123Z", merchant: "スーパー",
  method: "PayPay", type: "PAYMENT", amountYen: 1234, actorUserId: "a", actorName: "A",
  expenseClass: "SHARED", splitWeights: { a: 2, b: 3 }, settledAt: null,
  externalId: "paypay-reference", source: "PAYPAY",
};

test("一覧の日時はJSTで表示し、日付をまたいでも秒・ミリ秒を保持する", () => {
  assert.equal(transactionDateInput(record.occurredAt), "2026-10-05T18:15:37.123");
  assert.equal(transactionDateToIso(transactionDateInput(record.occurredAt)), record.occurredAt);
  assert.equal(transactionDateInput("2026-10-05T16:01:42.000Z"), "2026-10-06T01:01:42");
  assert.equal(transactionDateToIso("2026-10-06T01:01:42"), "2026-10-05T16:01:42.000Z");
  assert.equal(transactionDateToIso("2026-10-05T18:15"), "2026-10-05T09:15:00.000Z");
  assert.equal(transactionDateToIso("2026-10-05T18:15:37.1"), "2026-10-05T09:15:37.100Z");
});

test("存在しない日付や時刻を拒否し、うるう年の日付は保存できる", () => {
  for (const invalid of ["", "2023-02-29T12:00", "2024-02-30T12:00", "2026-13-01T12:00",
    "2026-10-05T24:00", "2026-10-05T12:60", "2026-10-05T12:00:60", "2026-10-05", "invalid"]) {
    assert.throws(() => transactionDateToIso(invalid), invalid);
  }
  assert.equal(transactionDateToIso("2024-02-29T12:34:56.789"), "2024-02-29T03:34:56.789Z");
  assert.throws(() => transactionDateInput("invalid"));
});

test("別の項目を編集しても元の日時と明細固有の割合を変えない", () => {
  const draft = transactionValues(record);
  draft.merchant = " 新しい取引先 ";
  draft.method = " 現金 ";
  const saved = validateTransactionValues(draft, members);
  assert.equal(saved.occurredAt, record.occurredAt);
  assert.equal(saved.merchant, "新しい取引先");
  assert.equal(saved.method, "現金");
  assert.deepEqual(saved.splitWeights, { a: 2, b: 3 });
  saved.splitWeights.a = 99;
  assert.deepEqual(record.splitWeights, { a: 2, b: 3 });
  assert.deepEqual(draft.splitWeights, { a: 2, b: 3 });
});

test("区分を変えると個人費は担当者1、共有費は現在のデフォルトになる", () => {
  const values = { ...transactionValues(record), actorUserId: "b" };
  const personal = { ...values, ...transactionExpensePatch(values, "PERSONAL", members) };
  assert.deepEqual(personal.splitWeights, { a: 0, b: 1 });
  assert.deepEqual(transactionExpensePatch(personal, "SHARED", members).splitWeights, { a: 6, b: 4 });
  assert.deepEqual(transactionExpensePatch(values, "SHARED", members).splitWeights, { a: 2, b: 3 });
  assert.deepEqual(record.splitWeights, { a: 2, b: 3 });
});

test("担当者を変えたとき個人費の割合だけ追従し、共有費の割合は保持する", () => {
  const values = transactionValues(record);
  assert.deepEqual(transactionActorPatch(values, "b", members), { actorUserId: "b", splitWeights: { a: 2, b: 3 } });
  const personal = { ...values, ...transactionExpensePatch(values, "PERSONAL", members) };
  assert.deepEqual(transactionActorPatch(personal, "b", members), { actorUserId: "b", splitWeights: { a: 0, b: 1 } });
  assert.throws(() => transactionActorPatch(values, "outsider", members));
});

test("未確定の不正入力は保存せず、金額・日時・担当者・割合を検証する", () => {
  const values = transactionValues(record);
  const invalidPatches: Partial<TransactionValues>[] = [
    { merchant: " " }, { method: "" }, { amountYen: 0 }, { amountYen: 1.5 },
    { amountYen: NaN }, { amountYen: 2_147_483_648 }, { occurredAt: "2026-02-30T12:00:00Z" },
    { occurredAt: "" }, { actorUserId: "outsider" }, { splitWeights: { a: 0, b: 0 } },
    { splitWeights: { a: 1 } }, { expenseClass: "PERSONAL" as const, splitWeights: { a: 2, b: 3 } },
  ];
  for (const patch of invalidPatches) assert.throws(() => validateTransactionValues({ ...values, ...patch }, members));
  assert.equal(validateTransactionValues({ ...values, amountYen: 2_147_483_647 }, members).amountYen, 2_147_483_647);
});

import assert from "node:assert/strict";
import test from "node:test";
import { appActionInputSchema, parseAppActionInput, type AppActionInput } from "../../lib/shared/schemas/app-input";
import { amountYenSchema, bootstrapScopeSchema, expenseClassSchema, merchantSchema, methodSchema, transactionSourceSchema, transactionTypeSchema, workspaceRoleSchema, workspaceTypeSchema } from "../../lib/shared/schemas/domain-schemas";
import { bootstrapScopes, expenseClasses, expenseClassLabels, transactionSources, transactionTypes, workspaceRoles, workspaceTypes } from "../../lib/shared/domain-values";
import { recurringPaymentConfigSchema, recurringPaymentMutationSchema } from "../../lib/shared/schemas/recurring-payment-schemas";
import { validateTransactionValues, type TransactionValues } from "../../lib/shared/transaction-editing";
import { validateSplitWeights } from "../../lib/shared/expense-splits";
import { parsePayPayCsv } from "../../lib/shared/paypay";
import type { WorkspaceMember } from "../../lib/shared/types";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const transactionId = "00000000-0000-4000-8000-000000000002";
const members: WorkspaceMember[] = [
  { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 1, role: "OWNER" },
  { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 1, role: "MEMBER" },
];
const values: TransactionValues = {
  occurredAt: "2026-10-18T00:00:00.123Z", merchant: "店舗", method: "現金", type: "PAYMENT",
  amountYen: 101, actorUserId: "a", expenseClass: "SHARED", splitWeights: { a: 1, b: 1 },
};
const fields = { merchant: values.merchant, method: values.method, amountYen: values.amountYen,
  actorUserId: values.actorUserId, expenseClass: values.expenseClass, splitWeights: values.splitWeights };
const config = { ...fields, dayOfMonth: 27, memo: "" };
const imported = { ...fields, occurredAt: values.occurredAt, externalId: "paypay-test" };
const save = { action: "saveTransaction", workspaceId, ...values };
const bulk = { action: "bulkImport", workspaceId, fileName: "sample.csv", totalRows: 1, items: [imported] };
const csv = (amount: number, merchant = "店舗", method = "現金") =>
  `取引日,出金金額（円）,取引内容,取引先,取引方法,取引番号\n2026/10/18 09:00:00,${amount},支払い,${merchant},${method},boundary-test`;

test("CSVのカテゴリは通常保存と同じUUID/nullを受け付け、旧APIの省略互換を保持する", () => {
  for (const categoryId of [undefined, null, transactionId]) {
    const parsed = parseAppActionInput({ ...bulk, items: [{ ...imported, categoryId, categoryConfirmed: false }] });
    assert.equal(parsed.action, "bulkImport");
    if (parsed.action === "bulkImport") {
      assert.equal(parsed.items[0].categoryId, categoryId);
      assert.equal("categoryConfirmed" in parsed.items[0], false, "確認状態はクライアントから受け付けない");
    }
  }
  for (const categoryId of ["", "invalid", 1, {}, []]) {
    assert.equal(appActionInputSchema.safeParse({ ...bulk, items: [{ ...imported, categoryId }] }).success, false);
  }
});

test("共有分類の全値をschemaが受け付け、未知値を拒否する", () => {
  for (const [schema, values] of [
    [workspaceTypeSchema, workspaceTypes], [expenseClassSchema, expenseClasses], [transactionTypeSchema, transactionTypes],
    [transactionSourceSchema, transactionSources], [workspaceRoleSchema, workspaceRoles], [bootstrapScopeSchema, bootstrapScopes],
  ] as const) {
    for (const value of values) assert.equal(schema.safeParse(value).success, true);
    assert.equal(schema.safeParse("UNKNOWN").success, false);
  }
  assert.deepEqual(expenseClasses.map(value => expenseClassLabels[value]), ["個人", "共有"]);
});

for (const amount of [0, 1, 2_147_483_647, 2_147_483_648]) {
  test(`金額${amount}の可否が通常保存・CSV API/プレビュー・編集・定期支払いで一致する`, () => {
    const valid = amount === 1 || amount === 2_147_483_647;
    assert.equal(amountYenSchema.safeParse(amount).success, valid);
    assert.equal(appActionInputSchema.safeParse({ ...save, amountYen: amount }).success, valid);
    assert.equal(appActionInputSchema.safeParse({ ...bulk, items: [{ ...imported, amountYen: amount }] }).success, valid);
    assert.equal(recurringPaymentConfigSchema.safeParse({ ...config, amountYen: amount }).success, valid);
    assert.equal(parsePayPayCsv(csv(amount), [], new Set(), members, "a")[0].error === null, valid);
    if (valid) assert.equal(validateTransactionValues({ ...values, amountYen: amount }, members).amountYen, amount);
    else assert.throws(() => validateTransactionValues({ ...values, amountYen: amount }, members), /金額/);
  });
}

test("金額の非整数・文字列・NaN・無限大を受け付けない", () => {
  for (const amount of [-1, 1.5, "100", NaN, Infinity, null, undefined]) {
    assert.equal(amountYenSchema.safeParse(amount).success, false);
    assert.equal(appActionInputSchema.safeParse({ ...save, amountYen: amount }).success, false);
  }
});

test("文字数上限とtrimを保存・取込・編集・定期支払いで共有する", () => {
  for (const [key, limit, schema] of [["merchant", 240, merchantSchema], ["method", 120, methodSchema]] as const) {
    const exact = "あ".repeat(limit), overflow = exact + "あ";
    assert.equal(schema.parse(` ${exact} `), exact);
    for (const value of ["", " ", overflow]) {
      assert.equal(appActionInputSchema.safeParse({ ...save, [key]: value }).success, false);
      assert.equal(appActionInputSchema.safeParse({ ...bulk, items: [{ ...imported, [key]: value }] }).success, false);
      assert.equal(recurringPaymentConfigSchema.safeParse({ ...config, [key]: value }).success, false);
      assert.throws(() => validateTransactionValues({ ...values, [key]: value }, members));
    }
    assert.equal(appActionInputSchema.safeParse({ ...save, [key]: exact }).success, true);
    assert.equal(parsePayPayCsv(csv(100, key === "merchant" ? exact : "店舗", key === "method" ? exact : "現金"), [], new Set(), members, "a")[0].error, null);
    const row = parsePayPayCsv(csv(100, key === "merchant" ? overflow : "店舗", key === "method" ? overflow : "現金"), [], new Set(), members, "a")[0];
    assert.equal(row.selected, false);
    assert.match(row.error!, /文字以内/);
  }
  assert.equal(parsePayPayCsv(csv(100, "店舗", ""), [], new Set(), members, "a")[0].method, "PayPay");
});

test("整数割合の境界を共有し、全員0・参加者不一致・個人費の比率を既存ドメイン検証で拒否する", () => {
  for (const weight of [0, 1, 2_147_483_647, -1, 1.1, 2_147_483_648]) {
    const splitWeights = { a: 1, b: weight };
    const valid = Number.isInteger(weight) && weight >= 0 && weight <= 2_147_483_647;
    assert.equal(appActionInputSchema.safeParse({ ...save, splitWeights }).success, valid);
    assert.equal(recurringPaymentConfigSchema.safeParse({ ...config, splitWeights }).success, valid);
    if (valid) assert.deepEqual(validateSplitWeights(splitWeights, members), splitWeights);
    else assert.throws(() => validateSplitWeights(splitWeights, members));
  }
  for (const splitWeights of [{ a: 0, b: 0 }, { a: 1 }, { a: 1, foreign: 1 }]) assert.throws(() => validateSplitWeights(splitWeights, members));
  assert.throws(() => validateSplitWeights({ a: 1, b: 1 }, members, "PERSONAL", "a"));
  assert.deepEqual(validateSplitWeights({ a: 1, b: 0 }, members, "PERSONAL", "a"), { a: 1, b: 0 });
});

test("全actionの入力を判別し、各actionに必要なpayloadがなければ拒否する", () => {
  const rule = { workspaceId, merchantContains: "スーパー", expenseClass: "SHARED" as const };
  const inputs = {
    updateProfile: { action: "updateProfile", name: "名前" },
    createWorkspace: { action: "createWorkspace", name: "家計", type: "SHARED" },
    updateWorkspace: { action: "updateWorkspace", workspaceId, name: "家計" },
    deleteWorkspace: { action: "deleteWorkspace", workspaceId, confirmationName: "家計" },
    createInvite: { action: "createInvite", workspaceId, email: "b@example.test" },
    acceptInvite: { action: "acceptInvite", token: "a".repeat(64) },
    updateWeights: { action: "updateWeights", workspaceId, weights: [{ userId: "a", weight: 1 }] },
    saveTransactionMemo: { action: "saveTransactionMemo", workspaceId, transactionId, memo: "" },
    createCategory: { action: "createCategory", workspaceId, parentId: null, name: "食費", colorHex: "#f97316" },
    updateCategory: { action: "updateCategory", workspaceId, categoryId: transactionId, name: "食品", colorHex: "#f97316" },
    archiveCategory: { action: "archiveCategory", workspaceId, categoryId: transactionId },
    deleteCategory: { action: "deleteCategory", workspaceId, categoryId: transactionId },
    moveCategory: { action: "moveCategory", workspaceId, categoryId: transactionId, parentId: null, beforeCategoryId: null },
    saveTransactionCategory: { action: "saveTransactionCategory", workspaceId, transactionId, categoryId: null },
    saveTransaction: { ...save, action: "saveTransaction" },
    deleteTransaction: { action: "deleteTransaction", workspaceId, transactionId },
    deleteTransactions: { action: "deleteTransactions", workspaceId, transactionIds: [transactionId] },
    applyTransactionRules: { action: "applyTransactionRules", workspaceId, transactionIds: [transactionId] },
    createRule: { action: "createRule", ...rule },
    updateRule: { action: "updateRule", ...rule, ruleId: transactionId },
    reorderRules: { action: "reorderRules", workspaceId, ruleIds: [] },
    deleteRule: { action: "deleteRule", workspaceId, ruleId: transactionId },
    deleteRules: { action: "deleteRules", workspaceId, ruleIds: [transactionId] },
    bulkImport: { ...bulk, action: "bulkImport" },
    completeSettlement: { action: "completeSettlement", workspaceId },
  } satisfies Record<AppActionInput["action"], AppActionInput>;
  for (const input of Object.values(inputs)) {
    assert.deepEqual(appActionInputSchema.parse(input), input);
    assert.equal(appActionInputSchema.safeParse({ action: input.action }).success, false);
  }
  assert.equal(appActionInputSchema.safeParse({ action: "createInvite", workspaceId, transactionId }).success, false);
  assert.equal(appActionInputSchema.safeParse({ action: "unknown", workspaceId }).success, false);
  assert.throws(() => parseAppActionInput({ action: "unknown" }), { message: "未対応の操作です: unknown" });
});

test("既存の省略・nullとstrip/strictの違い、メモ専用保存を維持する", () => {
  const withoutSplit = Object.fromEntries(Object.entries(save).filter(([key]) => key !== "expenseClass" && key !== "splitWeights"));
  assert.deepEqual(appActionInputSchema.parse({ ...withoutSplit, future: "ignored" }), withoutSplit);
  assert.equal(appActionInputSchema.safeParse({ ...withoutSplit, transactionId }).success, true);
  assert.equal(appActionInputSchema.safeParse({ ...save, memo: "初回メモ" }).success, true);
  assert.equal(appActionInputSchema.safeParse({ ...save, transactionId, memo: "更新メモ" }).success, false);
  for (const splitWeights of [undefined, null, { a: 1, b: 0 }]) {
    assert.equal(appActionInputSchema.safeParse({ action: "createRule", workspaceId, merchantContains: "店舗", expenseClass: "SHARED", splitWeights }).success, true);
  }
  for (const input of [
    { action: "updateProfile", name: "名前", isAdmin: true },
    { action: "saveTransactionMemo", workspaceId, transactionId, memo: "", merchant: "店舗" },
  ]) assert.equal(appActionInputSchema.safeParse(input).success, false);
  assert.equal(recurringPaymentMutationSchema.safeParse({ action: "create", workspaceId, ...config, future: "rejected" }).success, false);
  assert.equal(recurringPaymentMutationSchema.safeParse({ action: "update", workspaceId, ...config }).success, false);
  assert.equal(recurringPaymentMutationSchema.safeParse({ action: "pause", workspaceId, paymentId: transactionId, expectedRevision: 1, ...config }).success, false);
});

test("選択IDの大小文字と既存の重複・空配列ポリシーを維持する", () => {
  const id = "abcdef00-0000-4000-8000-000000000001";
  assert.equal(appActionInputSchema.safeParse({ action: "deleteTransactions", workspaceId, transactionIds: [id, id.toUpperCase()] }).success, false);
  assert.equal(appActionInputSchema.safeParse({ action: "deleteRules", workspaceId, ruleIds: [id, id] }).success, false);
  assert.equal(appActionInputSchema.safeParse({ action: "deleteRules", workspaceId, ruleIds: [id, id.toUpperCase()] }).success, true);
  assert.equal(appActionInputSchema.safeParse({ action: "deleteTransactions", workspaceId, transactionIds: [] }).success, false);
  assert.equal(appActionInputSchema.safeParse({ action: "reorderRules", workspaceId, ruleIds: [] }).success, true);
});


test("CSVのメモは2000文字・空文字・改行を受け付け、省略互換を保ち不正入力を拒否する", () => {
  for (const memo of [undefined, "", "  メモ\n2行目  ", "あ".repeat(2000)]) {
    const parsed = parseAppActionInput({ ...bulk, items: [{ ...imported, memo }] });
    assert.equal(parsed.action, "bulkImport");
    if (parsed.action === "bulkImport") assert.equal(parsed.items[0].memo, memo);
  }
  for (const memo of [null, 1, {}, "あ".repeat(2001)]) {
    assert.equal(appActionInputSchema.safeParse({ ...bulk, items: [{ ...imported, memo }] }).success, false);
  }
});

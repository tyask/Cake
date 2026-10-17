import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createAppService } from "../lib/app-service";
import type { AppStore } from "../lib/app-store";
import { parseAppActionInput } from "../lib/app-input";
import type { AppUser, BootstrapData, DefaultRule, TransactionRecord } from "../lib/types";

const user: AppUser = { id: "a", email: "a@example.com", name: "A", imageUrl: null };
const workspaceId = "00000000-0000-4000-8000-000000000001";
const transactionId = "00000000-0000-4000-8000-000000000002";
const ruleId = "00000000-0000-4000-8000-000000000003";
const members = [{ id: "a", weight: 1, name: "A" }, { id: "b", weight: 3, name: "B" }];
const rule: DefaultRule = { id: ruleId, merchantContains: "店", expenseClass: "SHARED", splitWeights: { a: 2, b: 1 }, sortOrder: 0, enabled: false };
const save = { action: "saveTransaction", workspaceId, occurredAt: "2026-10-10T00:00:00Z", merchant: "店", method: "現金", type: "PAYMENT", amountYen: 300, actorUserId: "a" };

function fixture(overrides: Partial<AppStore> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const methods: Partial<AppStore> = {
    requireWorkspaceMember: async () => ({ id: workspaceId, name: "QA", type: "SHARED" }),
    splitContext: async () => ({ members, rules: [rule] }),
    ...overrides,
  };
  const store = new Proxy({} as AppStore, {
    get: (_, key: keyof AppStore) => async (...args: unknown[]) => {
      calls.push({ name: key, args });
      const method = methods[key];
      assert.ok(method, `予期しないstore呼出: ${key}`);
      return Reflect.apply(method, methods, args);
    },
  });
  const service = createAppService(store);
  return { calls, execute: (input: unknown) => service.execute(user, parseAppActionInput(input)) };
}

function savedRow() {
  return { id: transactionId, occurred_at: new Date("2026-10-10T00:00:00Z"), merchant: "店", method: "現金", type: "PAYMENT", amount_yen: 300,
    actor_user_id: "a", expense_class: "SHARED", split_weights: { a: 5, b: 2 }, settled_at: null, external_id: "manual_id", source: "MANUAL", memo: "保存メモ" };
}

test("所属が必要な全16操作は拒否後に読取・書込へ進まない", async () => {
  const inputs = [
    { action: "updateWorkspace", name: "QA" }, { action: "deleteWorkspace", confirmationName: "QA" }, { action: "createInvite", email: "b@example.com" },
    { action: "updateWeights", weights: [{ userId: "a", weight: 1 }] }, { ...save },
    { action: "saveTransactionMemo", transactionId, memo: "memo" }, { action: "deleteTransaction", transactionId },
    { action: "deleteTransactions", transactionIds: [transactionId] }, { action: "applyTransactionRules", transactionIds: [transactionId] },
    { action: "createRule", merchantContains: "店", expenseClass: "SHARED" }, { action: "updateRule", ruleId, merchantContains: "店", expenseClass: "SHARED" },
    { action: "reorderRules", ruleIds: [ruleId] }, { action: "deleteRule", ruleId }, { action: "deleteRules", ruleIds: [ruleId] },
    { action: "bulkImport", fileName: "qa.csv", totalRows: 0, items: [] }, { action: "completeSettlement" },
  ];
  assert.equal(inputs.length, 16);
  for (const input of inputs) {
    const f = fixture({ requireWorkspaceMember: async () => { throw new Error("所属なし"); } });
    await assert.rejects(f.execute({ workspaceId, ...input }), /所属なし/);
    assert.deepEqual(f.calls, [{ name: "requireWorkspaceMember", args: [workspaceId, user.id] }]);
  }
});

test("通常保存はDB確定値のDTOと担当者名を返し、個人費既定を維持する", async () => {
  const f = fixture({ insertTransaction: async () => savedRow() });
  const result = await f.execute(save);
  assert.deepEqual(result, { ok: true, transaction: {
    id: transactionId, occurredAt: "2026-10-10T00:00:00.000Z", merchant: "店", method: "現金", type: "PAYMENT", amountYen: 300,
    actorUserId: "a", actorName: "A", expenseClass: "SHARED", splitWeights: { a: 5, b: 2 }, settledAt: null, externalId: "manual_id", source: "MANUAL", memo: "保存メモ",
  } });
  assert.deepEqual(f.calls[2].args[2], { expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } });
  assert.match(String(f.calls[2].args[3]), /^[a-f0-9-]{36}$/);
});

test("更新で割合省略時は保存済み共有割合を継承し、明示割合では以前の明細を取得しない", async () => {
  const f = fixture({ previousTransaction: async () => ({ expense_class: "SHARED", actor_user_id: "a", split_weights: { a: 5, b: 2 } }), updateTransaction: async () => savedRow() });
  await f.execute({ ...save, transactionId });
  assert.deepEqual(f.calls.map(call => call.name), ["requireWorkspaceMember", "splitContext", "previousTransaction", "updateTransaction"]);
  assert.deepEqual(f.calls[3].args[2], { expenseClass: "SHARED", splitWeights: { a: 5, b: 2 } });
  f.calls.length = 0;
  await f.execute({ ...save, transactionId, expenseClass: "SHARED", splitWeights: { a: 1, b: 4 } });
  assert.deepEqual(f.calls.map(call => call.name), ["requireWorkspaceMember", "splitContext", "updateTransaction"]);
  assert.deepEqual(f.calls[2].args[2], { expenseClass: "SHARED", splitWeights: { a: 1, b: 4 } });
});

test("担当者変更した個人費は旧担当者の割合を継承せず、不参加担当者は保存前に拒否する", async () => {
  const f = fixture({ previousTransaction: async () => ({ expense_class: "PERSONAL", actor_user_id: "b", split_weights: { a: 0, b: 1 } }), updateTransaction: async () => savedRow() });
  await f.execute({ ...save, transactionId });
  assert.deepEqual(f.calls[3].args[2], { expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } });
  const invalid = fixture();
  await assert.rejects(invalid.execute({ ...save, actorUserId: "outsider" }), /参加していません/);
  assert.equal(invalid.calls.length, 2);
});

test("清算済み/消失明細の更新・削除失敗と、清算済みでも可能なメモ更新の応答を維持する", async () => {
  const f = fixture({ previousTransaction: async () => undefined, updateTransaction: async () => undefined, deleteTransaction: async () => false, saveTransactionMemo: async () => ({ id: transactionId, memo: "変更" }) });
  await assert.rejects(f.execute({ ...save, transactionId }), /清算済み、または存在しない明細は編集できません/);
  await assert.rejects(f.execute({ action: "deleteTransaction", workspaceId, transactionId }), /清算済み、または存在しない明細は削除できません/);
  assert.deepEqual(await f.execute({ action: "saveTransactionMemo", workspaceId, transactionId, memo: "変更" }), { ok: true, transactionId, memo: "変更" });
});

test("ルール更新は同分類で省略した割合とenabledを保持し、対象消失を拒否する", async () => {
  const f = fixture({ updateRule: async () => true });
  assert.deepEqual(await f.execute({ action: "updateRule", workspaceId, ruleId, merchantContains: "新店", expenseClass: "SHARED" }), { ok: true });
  assert.deepEqual(f.calls[2].args[1], rule.splitWeights);
  assert.equal((f.calls[2].args[2] as DefaultRule).enabled, false);
  const missing = fixture({ splitContext: async () => ({ members, rules: [] }) });
  await assert.rejects(missing.execute({ action: "updateRule", workspaceId, ruleId, merchantContains: "店", expenseClass: "SHARED" }), /ルールがありません/);
  const gone = fixture({ updateRule: async () => false });
  await assert.rejects(gone.execute({ action: "updateRule", workspaceId, ruleId, merchantContains: "店", expenseClass: "SHARED" }), /ルールがありません/);
});

test("個人費ルールの明示割合と一括削除の不足対象を拒否し、存在しない単独削除は成功する", async () => {
  const f = fixture({ ruleTargets: async () => [], deleteRule: async () => {} });
  await assert.rejects(f.execute({ action: "createRule", workspaceId, merchantContains: "店", expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } }), /個人費ルールの割合/);
  await assert.rejects(f.execute({ action: "deleteRules", workspaceId, ruleIds: [ruleId] }), /選択したルールが見つかりません/);
  assert.deepEqual(await f.execute({ action: "deleteRule", workspaceId, ruleId }), { ok: true });
  assert.ok(!f.calls.some(call => call.name === "deleteRules"));
});

test("取込は共有費既定・有効ルールを使い、保存された件数を返す", async () => {
  const f = fixture({ persistPayPayImport: async () => ({ imported: 1, skipped: 2 }) });
  const item = { occurredAt: save.occurredAt, merchant: "店", method: "PayPay", amountYen: 300, actorUserId: "a", externalId: "123" };
  assert.deepEqual(await f.execute({ action: "bulkImport", workspaceId, fileName: "qa.csv", totalRows: 3, items: [item] }), { ok: true, imported: 1, skipped: 2 });
  const persisted = f.calls[2].args[0] as { userId: string; items: unknown[] };
  assert.equal(persisted.userId, user.id);
  assert.deepEqual(persisted.items, [{ ...item, expenseClass: "SHARED", splitWeights: { a: 1, b: 3 } }]);
});

test("招待は正規化メールとtokenハッシュのみ保存し、承認は宛先と人数を確認する", async () => {
  const f = fixture({ memberCount: async () => [{ count: 1 }], createInvite: async () => {}, findInvite: async () => [{ id: ruleId, workspace_id: workspaceId, email: "A@EXAMPLE.COM" }], acceptInvite: async () => {} });
  const result = await f.execute({ action: "createInvite", workspaceId, email: "b@example.com" }) as unknown as { invitePath: string };
  const token = result.invitePath.split("/").pop()!;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(f.calls[2].args[2], createHash("sha256").update(token).digest("hex"));
  assert.deepEqual(await f.execute({ action: "acceptInvite", token }), { ok: true, workspaceId });
  const wrong = fixture({ findInvite: async () => [{ email: "someone@example.com" }] });
  await assert.rejects(wrong.execute({ action: "acceptInvite", token }), /別のメールアドレス/);
  assert.deepEqual(wrong.calls.map(call => call.name), ["findInvite"]);
  const full = fixture({ memberCount: async () => [{ count: 2 }] });
  await assert.rejects(full.execute({ action: "createInvite", workspaceId, email: "b@example.com" }), /二人まで/);
  await assert.rejects(full.execute({ action: "createInvite", workspaceId, email: user.email }), /自分自身/);
});

test("workspace削除名の不一致とデフォルト割合の重複参加者を更新前に拒否する", async () => {
  const f = fixture({ memberIds: async () => [{ user_id: "a" }, { user_id: "b" }] });
  await assert.rejects(f.execute({ action: "deleteWorkspace", workspaceId, confirmationName: "別名" }), /一致しません/);
  await assert.rejects(f.execute({ action: "updateWeights", workspaceId, weights: [{ userId: "a", weight: 1 }, { userId: "a", weight: 1 }] }), /重複/);
  assert.ok(f.calls.every(call => ["requireWorkspaceMember", "memberIds"].includes(call.name)));
});

test("清算は最新bootstrapを再取得し、対象だけをID順に固定して保存する", async () => {
  const transaction = { id: transactionId, actorUserId: "a", type: "PAYMENT", amountYen: 300, expenseClass: "SHARED", splitWeights: { a: 1, b: 1 } } as unknown as TransactionRecord;
  const second = { ...transaction, id: ruleId };
  const settlement = { transactionIds: [ruleId, transactionId], amountYen: 150, people: [] };
  const latest = { selected: { transactions: [second, { ...transaction, id: workspaceId }, transaction], settlement } } as unknown as BootstrapData;
  const f = fixture({ bootstrap: (async () => latest) as AppStore["bootstrap"], completeSettlement: async () => {} });
  assert.deepEqual(await f.execute({ action: "completeSettlement", workspaceId }), { ok: true });
  assert.deepEqual(f.calls.map(call => call.name), ["requireWorkspaceMember", "bootstrap", "completeSettlement"]);
  assert.deepEqual(f.calls[1].args, [user, workspaceId]);
  assert.deepEqual(f.calls[2].args[4], [transaction, second]);
  assert.deepEqual(f.calls[2].args[5], { ...settlement, transactions: [transaction, second] });
  const empty = fixture({ bootstrap: (async () => ({ user, workspaces: [], pendingInvitations: [], selected: null })) as AppStore["bootstrap"] });
  await assert.rejects(empty.execute({ action: "completeSettlement", workspaceId }), /清算対象の明細がありません/);
});

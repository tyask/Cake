import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createAppService } from "../lib/app-service";
import type { AppStore } from "../lib/app-store";
import { parseAppActionInput } from "../lib/app-input";
import type { AppUser, DefaultRule } from "../lib/types";
import { resolveTransactionSplit } from "../lib/app-services/splits";

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
    splitMembers: async () => members,
    splitRules: async () => [rule],
    ruleForUpdate: async () => rule,
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
    const f = fixture({ requireWorkspaceMember: async () => { throw new Error("所属なし"); }, settlementContext: async () => { throw new Error("所属なし"); } });
    await assert.rejects(f.execute({ workspaceId, ...input }), /所属なし/);
    assert.deepEqual(f.calls, [{ name: input.action === "completeSettlement" ? "settlementContext" : "requireWorkspaceMember", args: [workspaceId, user.id] }]);
  }
});

test("通常保存はDB確定値のDTOと担当者名を返し、個人費既定を維持する", async () => {
  const f = fixture({ insertTransaction: async () => savedRow() });
  const result = await f.execute(save);
  assert.deepEqual(result, { ok: true, transaction: {
    id: transactionId, occurredAt: "2026-10-10T00:00:00.000Z", merchant: "店", method: "現金", type: "PAYMENT", amountYen: 300,
    actorUserId: "a", actorName: "A", expenseClass: "SHARED", splitWeights: { a: 5, b: 2 }, settledAt: null, externalId: "manual_id", source: "MANUAL", categoryId: null, categoryConfirmed: false, categoryRevision: 0, memo: "保存メモ",
  } });
  assert.deepEqual(f.calls[3].args[2], { expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } });
  assert.match(String(f.calls[3].args[3]), /^[a-f0-9-]{36}$/);
});

test("更新で割合省略時は保存済み共有割合を継承し、明示割合では以前の明細を取得しない", async () => {
  const f = fixture({ previousTransaction: async () => ({ expense_class: "SHARED", actor_user_id: "a", split_weights: { a: 5, b: 2 } }), updateTransaction: async () => savedRow() });
  await f.execute({ ...save, transactionId });
  assert.deepEqual(f.calls.map(call => call.name), ["requireWorkspaceMember", "previousTransaction", "splitMembers", "updateTransaction"]);
  assert.deepEqual(f.calls[3].args[2], { expenseClass: "SHARED", splitWeights: { a: 5, b: 2 } });
  f.calls.length = 0;
  await f.execute({ ...save, transactionId, expenseClass: "SHARED", splitWeights: { a: 1, b: 4 } });
  assert.deepEqual(f.calls.map(call => call.name), ["requireWorkspaceMember", "splitMembers", "updateTransaction"]);
  assert.deepEqual(f.calls[2].args[2], { expenseClass: "SHARED", splitWeights: { a: 1, b: 4 } });
});

test("担当者変更した個人費は旧担当者の割合を継承せず、不参加担当者は保存前に拒否する", async () => {
  const f = fixture({ previousTransaction: async () => ({ expense_class: "PERSONAL", actor_user_id: "b", split_weights: { a: 0, b: 1 } }), updateTransaction: async () => savedRow() });
  await f.execute({ ...save, transactionId });
  assert.deepEqual(f.calls[3].args[2], { expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } });
  const invalid = fixture();
  await assert.rejects(invalid.execute({ ...save, actorUserId: "outsider" }), /参加していません/);
  assert.equal(invalid.calls.length, 3);
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
  assert.deepEqual(f.calls[3].args[1], rule.splitWeights);
  assert.equal((f.calls[3].args[2] as DefaultRule).enabled, false);
  const missing = fixture({ ruleForUpdate: async () => null });
  await assert.rejects(missing.execute({ action: "updateRule", workspaceId, ruleId, merchantContains: "店", expenseClass: "SHARED" }), /ルールがありません/);
  const gone = fixture({ updateRule: async () => false });
  await assert.rejects(gone.execute({ action: "updateRule", workspaceId, ruleId, merchantContains: "店", expenseClass: "SHARED" }), /ルールがありません/);
});

test("単件・複数ルール削除は所属確認後に同じstoreへ渡し、応答と全件必須の違いを保つ", async () => {
  const f = fixture({ deleteRules: async () => 1 });
  assert.deepEqual(await f.execute({ action: "deleteRule", workspaceId, ruleId }), { ok: true });
  assert.deepEqual(f.calls, [
    { name: "requireWorkspaceMember", args: [workspaceId, user.id] },
    { name: "deleteRules", args: [workspaceId, user.id, [ruleId], false] },
  ]);
  f.calls.length = 0;
  assert.deepEqual(await f.execute({ action: "deleteRules", workspaceId, ruleIds: [ruleId] }), { ok: true, deleted: 1 });
  assert.deepEqual(f.calls, [
    { name: "requireWorkspaceMember", args: [workspaceId, user.id] },
    { name: "deleteRules", args: [workspaceId, user.id, [ruleId], true] },
  ]);
});

test("個人費ルールの明示割合と一括削除のDB失敗を拒否し、存在しない単独削除は成功する", async () => {
  const f = fixture({ deleteRules: async (_workspaceId, _userId, _ids, requireAll) => {
    if (requireAll) throw new Error("選択したルールが見つかりません。画面を更新して選び直してください。");
    return 0;
  } });
  await assert.rejects(f.execute({ action: "createRule", workspaceId, merchantContains: "店", expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } }), /個人費ルールの割合/);
  await assert.rejects(f.execute({ action: "deleteRules", workspaceId, ruleIds: [ruleId] }), /選択したルールが見つかりません/);
  assert.deepEqual(await f.execute({ action: "deleteRule", workspaceId, ruleId }), { ok: true });
  assert.equal(f.calls.filter(call => call.name === "deleteRules").length, 2);
});

test("取込は共有費既定・有効ルールを使い、保存された件数を返す", async () => {
  const f = fixture({ persistPayPayImport: async () => ({ imported: 1, skipped: 2 }) });
  const item = { occurredAt: save.occurredAt, merchant: "店", method: "PayPay", amountYen: 300, actorUserId: "a", externalId: "123" };
  assert.deepEqual(await f.execute({ action: "bulkImport", workspaceId, fileName: "qa.csv", totalRows: 3, items: [item] }), { ok: true, imported: 1, skipped: 2 });
  const persisted = f.calls[3].args[0] as { userId: string; items: unknown[] };
  assert.equal(persisted.userId, user.id);
  assert.deepEqual(persisted.items, [{ ...item, expenseClass: "SHARED", splitWeights: { a: 1, b: 3 } }]);
});

test("一括取込はルールを一度だけ準備し、単件登録も同じ優先順・割合で判定する", async () => {
  let enabledReads = 0;
  const rules = [{ ...rule, enabled: false, sortOrder: 0 }, { ...rule, expenseClass: "PERSONAL" as const, enabled: true, sortOrder: 2 }, { ...rule, enabled: true, sortOrder: 1 }]
    .map(rule => ({ ...rule, get enabled() { enabledReads++; return rule.enabled; } }));
  const f = fixture({ splitRules: async () => rules, persistPayPayImport: async () => ({ imported: 3, skipped: 0 }), insertTransaction: async () => savedRow() });
  const items = Array.from({ length: 3 }, (_, i) => ({ occurredAt: save.occurredAt, merchant: "店", method: "PayPay", amountYen: 300, actorUserId: "a", externalId: String(i) }));
  await f.execute({ action: "bulkImport", workspaceId, fileName: "qa.csv", totalRows: 3, items });
  const stored = f.calls.at(-1)!.args[0] as { items: { expenseClass: string; splitWeights: unknown }[] };
  assert.equal(enabledReads, rules.length);
  for (const item of stored.items) {
    assert.equal(item.expenseClass, "SHARED");
    assert.deepEqual(item.splitWeights, { a: 2, b: 1 });
  }
  await f.execute(save);
  assert.deepEqual(f.calls.at(-1)!.args[2], { expenseClass: "SHARED", splitWeights: stored.items[0].splitWeights });
  assert.equal(enabledReads, rules.length * 2, "単件もリクエストごとに最新の一覧から準備する");
});

test("全明細の区分・割合が明示された取込ではルールの準備も省略する", async () => {
  const unused = { ...rule, get enabled(): never { throw new Error("不要なルール準備"); } };
  const f = fixture({ splitRules: async () => [unused], persistPayPayImport: async () => ({ imported: 1, skipped: 0 }) });
  await f.execute({ action: "bulkImport", workspaceId, fileName: "qa.csv", totalRows: 1,
    items: [{ occurredAt: save.occurredAt, merchant: "店", method: "PayPay", amountYen: 300, actorUserId: "a", externalId: "123", expenseClass: "SHARED", splitWeights: { a: 1, b: 3 } }] });
  const saved = f.calls.at(-1)!.args[0] as { items: { splitWeights: unknown }[] };
  assert.deepEqual(saved.items[0].splitWeights, { a: 1, b: 3 });
});

const activeRule: DefaultRule = { ...rule, enabled: true };
const savedShared = { expense_class: "SHARED", actor_user_id: "a", split_weights: { a: 5, b: 2 } };
const savedPersonal = { expense_class: "PERSONAL", actor_user_id: "a", split_weights: { a: 1, b: 0 } };
const splitCases = [
  { name: "新規の区分・割合省略は一致ルール", input: {}, expected: ["SHARED", { a: 2, b: 1 }], rules: true },
  { name: "区分だけ省略した明示割合も区分のルールが必要", input: { splitWeights: { a: 1, b: 4 } }, expected: ["SHARED", { a: 1, b: 4 }], rules: true },
  { name: "共有費の割合省略は一致ルール", input: { expenseClass: "SHARED" }, expected: ["SHARED", { a: 2, b: 1 }], rules: true },
  { name: "共有費の区分・割合明示", input: { expenseClass: "SHARED", splitWeights: { a: 1, b: 4 } }, expected: ["SHARED", { a: 1, b: 4 }], rules: false },
  { name: "個人費の割合省略", input: { expenseClass: "PERSONAL" }, expected: ["PERSONAL", { a: 1, b: 0 }], rules: false },
  { name: "個人費の区分・割合明示", input: { expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } }, expected: ["PERSONAL", { a: 1, b: 0 }], rules: false },
  { name: "保存済み共有費の区分・割合を継承", input: { transactionId }, previous: savedShared, expected: ["SHARED", { a: 5, b: 2 }], rules: false },
  { name: "保存済み共有費は担当者変更でも割合を継承", input: { transactionId, actorUserId: "b" }, previous: savedShared, expected: ["SHARED", { a: 5, b: 2 }], rules: false },
  { name: "保存済み個人費の区分・割合を継承", input: { transactionId }, previous: savedPersonal, expected: ["PERSONAL", { a: 1, b: 0 }], rules: false },
  { name: "個人費の担当者変更で割合を再生成", input: { transactionId, actorUserId: "b" }, previous: savedPersonal, expected: ["PERSONAL", { a: 0, b: 1 }], rules: false },
  { name: "共有費から個人費への変更で割合を再生成", input: { transactionId, expenseClass: "PERSONAL" }, previous: savedShared, expected: ["PERSONAL", { a: 1, b: 0 }], rules: false },
  { name: "個人費から共有費への変更はルール割合", input: { transactionId, expenseClass: "SHARED" }, previous: savedPersonal, expected: ["SHARED", { a: 2, b: 1 }], rules: true },
  { name: "既存でも割合明示・区分省略は前回値を読まずルール区分", input: { transactionId, splitWeights: { a: 4, b: 1 } }, expected: ["SHARED", { a: 4, b: 1 }], rules: true },
];
for (const scenario of splitCases) test(`割合取得の省略条件と保存値: ${scenario.name}`, async () => {
  const f = fixture({ splitRules: async () => [activeRule], previousTransaction: async () => scenario.previous, insertTransaction: async () => savedRow(), updateTransaction: async () => savedRow() });
  await f.execute({ ...save, ...scenario.input });
  const writes = f.calls.filter(call => ["insertTransaction", "updateTransaction"].includes(call.name));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args[2], { expenseClass: scenario.expected[0], splitWeights: scenario.expected[1] });
  assert.equal(f.calls.filter(call => call.name === "splitRules").length, Number(scenario.rules));
  assert.deepEqual(f.calls[0], { name: "requireWorkspaceMember", args: [workspaceId, user.id] });
  assert.equal(f.calls.filter(call => call.name === "splitMembers").length, 1);
});

test("明示値で確定する経路ではルールの参照・判定をせず参加者と割合を検証する", async () => {
  const context = { members, get matchRule(): never { throw new Error("不要なルール参照"); } };
  assert.deepEqual(resolveTransactionSplit({ merchant: "店", actorUserId: "a", expenseClass: "PERSONAL" }, context), { expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } });
  assert.deepEqual(resolveTransactionSplit({ merchant: "店", actorUserId: "a", expenseClass: "SHARED", splitWeights: { a: 2, b: 1 } }, context), { expenseClass: "SHARED", splitWeights: { a: 2, b: 1 } });
  for (const input of [{ actorUserId: "outsider", splitWeights: { a: 1, b: 1 } }, { actorUserId: "a", splitWeights: { a: 1, outsider: 1 } }, { actorUserId: "a", splitWeights: { a: 0, b: 0 } }]) {
    const f = fixture();
    await assert.rejects(f.execute({ ...save, expenseClass: "SHARED", ...input }), /参加していません|参加者が一致|少なくとも/);
    assert.deepEqual(f.calls.map(call => call.name), ["requireWorkspaceMember", "splitMembers"]);
  }
  const f = fixture();
  assert.throws(() => f.execute({ ...save, splitWeights: null }));
  assert.equal(f.calls.length, 0);
});

test("省略値は有効・部分一致・優先順を維持し、明示共有費では個人費ルールよりworkspace割合を使う", async () => {
  const rules: DefaultRule[] = [{ ...activeRule, id: "later", sortOrder: 2 }, { ...activeRule, id: "first", merchantContains: "店", sortOrder: 1, splitWeights: { a: 3, b: 2 } }, { ...rule, sortOrder: 0 }];
  const f = fixture({ splitRules: async () => rules, insertTransaction: async () => savedRow() });
  await f.execute({ ...save, merchant: "支店の店" });
  assert.deepEqual(f.calls.at(-1)!.args[2], { expenseClass: "SHARED", splitWeights: { a: 3, b: 2 } });
  const personal = fixture({ splitRules: async () => [{ ...activeRule, expenseClass: "PERSONAL", splitWeights: null }], insertTransaction: async () => savedRow() });
  await personal.execute({ ...save, expenseClass: "SHARED" });
  assert.deepEqual(personal.calls.at(-1)!.args[2], { expenseClass: "SHARED", splitWeights: { a: 1, b: 3 } });
});

for (const action of ["createRule", "updateRule"]) for (const scenario of [
  { name: "共有割合省略", expenseClass: "SHARED", expected: action === "updateRule" ? rule.splitWeights : null },
  { name: "共有割合null", expenseClass: "SHARED", splitWeights: null, expected: null },
  { name: "共有割合明示", expenseClass: "SHARED", splitWeights: { a: 4, b: 1 }, expected: { a: 4, b: 1 } },
  { name: "個人費へ変更", expenseClass: "PERSONAL", expected: null },
  { name: "個人費null", expenseClass: "PERSONAL", splitWeights: null, expected: null },
]) test(`ルールの限定取得と割合補完: ${action} ${scenario.name}`, async () => {
  const f = fixture({ createRule: async () => {}, updateRule: async () => true });
  await f.execute({ action, workspaceId, ruleId, merchantContains: "店", ...scenario });
  assert.ok(!f.calls.some(call => call.name === "splitRules"));
  const write = f.calls.at(-1)!;
  assert.equal(write.name, action);
  assert.deepEqual(write.args[action === "createRule" ? 2 : 1], scenario.expected);
  if (action === "updateRule") {
    assert.deepEqual(f.calls[2], { name: "ruleForUpdate", args: [workspaceId, ruleId] });
    assert.equal((write.args[2] as DefaultRule).enabled, false);
  } else assert.deepEqual(f.calls.map(call => call.name), ["requireWorkspaceMember", "splitMembers", "createRule"]);
});

test("ルールの未知参加者と個人費の明示割合を保存前に拒否する", async () => {
  for (const action of ["createRule", "updateRule"]) for (const input of [
    { expenseClass: "SHARED", splitWeights: { a: 1, outsider: 1 } },
    { expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } },
  ]) {
    const f = fixture();
    await assert.rejects(f.execute({ action, workspaceId, ruleId, merchantContains: "店", ...input }), /参加者が一致|個人費ルール/);
    assert.ok(!f.calls.some(call => call.name === "createRule" || call.name === "updateRule" || call.name === "splitRules"));
  }
});

test("ルール更新は共有割合nullの継承と個人費から共有費への変更・enabled明示を維持する", async () => {
  for (const previous of [{ ...rule, splitWeights: null }, { ...rule, expenseClass: "PERSONAL" as const, splitWeights: null }]) {
    const f = fixture({ ruleForUpdate: async () => previous, updateRule: async () => true });
    await f.execute({ action: "updateRule", workspaceId, ruleId, merchantContains: "店", expenseClass: "SHARED", enabled: true });
    const write = f.calls.at(-1)!;
    assert.equal(write.args[1], null);
    assert.equal((write.args[0] as { enabled: boolean }).enabled, true);
    assert.equal((write.args[2] as { enabled: boolean }).enabled, false);
  }
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

test("清算は専用contextから既存計算を再利用し、対象だけをID順に固定する", async () => {
  const transaction = { id: transactionId, actorUserId: "a", type: "PAYMENT" as const, amountYen: 300, expenseClass: "SHARED" as const, splitWeights: { a: 1, b: 1 }, settledAt: null };
  const second = { ...transaction, id: ruleId };
  const excluded = { ...transaction, id: workspaceId, expenseClass: "PERSONAL" as const };
  const f = fixture({ settlementContext: async () => ({ workspaceType: "SHARED", members, transactions: [second, excluded, transaction] }), completeSettlement: async () => {} });
  assert.deepEqual(await f.execute({ action: "completeSettlement", workspaceId }), { ok: true });
  assert.deepEqual(f.calls.map(call => call.name), ["settlementContext", "completeSettlement"]);
  assert.deepEqual(f.calls[0].args, [workspaceId, user.id]);
  const expected = [transaction, second].map(({ id, actorUserId, type, amountYen, expenseClass, splitWeights }) => ({ id, actorUserId, type, amountYen, expenseClass, splitWeights }));
  assert.deepEqual(f.calls[1].args[4], expected);
  const result = f.calls[1].args[3];
  assert.deepEqual(f.calls[1].args[5], { ...result as object, transactions: expected });
  const empty = fixture({ settlementContext: async () => ({ workspaceType: "SHARED", members, transactions: [] }) });
  await assert.rejects(empty.execute({ action: "completeSettlement", workspaceId }), /清算対象の明細がありません/);
  const personal = fixture({ settlementContext: async () => ({ workspaceType: "PERSONAL", members, transactions: [transaction] }) });
  await assert.rejects(personal.execute({ action: "completeSettlement", workspaceId }), /清算対象の明細がありません/);
});

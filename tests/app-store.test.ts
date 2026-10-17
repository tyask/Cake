import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { neonConfig } from "@neondatabase/serverless";
import { appHandlers } from "../lib/app-handlers";
import { createAppService } from "../lib/app-service";
import { createAppStore } from "../lib/app-store";
import { findSessionUser } from "../lib/user-access";
import { defaultRuleRecord } from "../lib/default-rule-record";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const transactionId = "00000000-0000-4000-8000-000000000002";
const ruleId = "00000000-0000-4000-8000-000000000003";
const user = { id: "a", email: "a@example.com", name: "A", imageUrl: null };
const memberRows = [{ user_id: "a", id: "a", weight: 1, name: "A", email: user.email, role: "OWNER" }, { user_id: "b", id: "b", weight: 1, name: "B", email: "b@example.com", role: "MEMBER" }];
const ruleRow = { id: ruleId, merchant_contains: "店", expense_class: "SHARED", sort_order: 0, split_weights: { a: 1, b: 1 }, enabled: true };
const transaction = { id: transactionId, occurred_at: "2026-10-10T00:00:00Z", merchant: "店", method: "現金", type: "PAYMENT", amount_yen: 300, actor_user_id: "a", actor_name: "A", expense_class: "SHARED", split_weights: { a: 1, b: 1 }, memo: "メモ", external_id: "manual_fixture", source: "MANUAL", settled_at: null };
type Row = Record<string, unknown>;
type Query = { query: string; params: unknown[] };
type Trip = { queries: Query[]; transaction: boolean };

function encoded(rows: Row[]) {
  const fields = Object.entries(rows[0] ?? {}).map(([name, value]) => ({ name, dataTypeID: typeof value === "boolean" ? 16 : value && typeof value === "object" ? 3802 : 25 }));
  return { fields, rows: rows.map(row => fields.map(({ name, dataTypeID }) => row[name] == null ? null : dataTypeID === 16 ? row[name] ? "t" : "f" : dataTypeID === 3802 ? JSON.stringify(row[name]) : String(row[name]))) };
}

function fixture(t: TestContext, options: { forbidden?: boolean; fail?: boolean; rules?: Row[] } = {}) {
  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  process.env.DATABASE_URL = "postgresql://user:password@mock.neon.tech/app_service_test";
  process.env.DB_QUERY_LOG = "off";
  t.after(() => {
    neonConfig.fetchFunction = previous.fetch;
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
    if (previous.logging === undefined) delete process.env.DB_QUERY_LOG; else process.env.DB_QUERY_LOG = previous.logging;
  });
  const trips: Trip[] = [];
  function rows(query: string, params: unknown[] = []): Row[] {
    if (/WITH authorized AS/.test(query)) return [{ authorized: !options.forbidden, workspace_type: "SHARED", members: memberRows, transactions: [{ id: transactionId, actorUserId: "a", type: "PAYMENT", amountYen: 300, expenseClass: "SHARED", splitWeights: { a: 1, b: 1 } }] }];
    if (/WITH\s+my_workspaces AS/.test(query)) return [{
      workspaces: [{ id: workspaceId, name: "QA", type: "SHARED", owner_user_id: "a", member_count: 2 }], selected_workspace_id: workspaceId,
      members: memberRows, rules: [ruleRow], transactions: [transaction], pending_invitations: [], settlement_history: [],
    }];
    if (/SELECT \* FROM app_users|UPDATE app_users SET name/.test(query)) return [{ id: user.id, email: user.email, name: user.name, image_url: null, is_enabled: true, is_admin: false }];
    if (/SELECT w.id, w.name, w.type, w.owner_user_id/.test(query)) return options.forbidden ? [] : [{ id: workspaceId, name: "QA", type: "SHARED" }];
    if (/COUNT\(\*\)::int AS count/.test(query)) return [{ count: 1 }];
    if (/SELECT id, workspace_id, email FROM invitations/.test(query)) return [{ id: ruleId, workspace_id: workspaceId, email: user.email }];
    if (/SELECT wm.user_id|SELECT user_id FROM workspace_members/.test(query)) return memberRows;
    if (/SELECT id, merchant_contains/.test(query)) return options.rules ?? [ruleRow];
    if (/SELECT expense_class.*FROM default_rules/.test(query)) return (options.rules ?? [ruleRow])
      .filter(row => (row.workspace_id ?? workspaceId) === params[0] && row.id === params[1])
      .map(row => ({ expense_class: row.expense_class, split_weights: row.split_weights, enabled: row.enabled }));
    if (/SELECT expense_class/.test(query)) return [transaction];
    if (/cake_bulk_transactions/.test(query)) return [{ result: { affected: 1, transactions: [{ id: transactionId, occurredAt: "2026-10-10T00:00:00+00:00" }] } }];
    if (/RETURNING imported_rows, skipped_rows/.test(query)) return [{ imported_rows: 1, skipped_rows: 0 }];
    if (/RETURNING id, memo/.test(query)) return [{ id: transactionId, memo: "メモ" }];
    if (/RETURNING \*/.test(query)) return [transaction];
    if (/RETURNING id|SELECT id FROM default_rules/.test(query)) return [{ id: ruleId }];
    return [];
  }
  neonConfig.fetchFunction = async (url: RequestInfo | URL, init: RequestInit) => {
    assert.ok(new URL(String(url)).hostname.endsWith(".neon.tech"));
    assert.equal(new Headers(init.headers).get("Neon-Connection-String"), process.env.DATABASE_URL);
    const body = JSON.parse(String(init.body)) as Query & { queries?: Query[] };
    const queries = body.queries ?? [body];
    trips.push({ queries, transaction: Boolean(body.queries) });
    if (options.fail) return new Response(JSON.stringify({ message: "fixture database failure", code: "P0001" }), { status: 400 });
    const result = body.queries ? { results: queries.map(query => encoded(rows(query.query, query.params))) } : encoded(rows(body.query, body.params));
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const handlers = appHandlers({ currentUser: async () => user, ...createAppService(createAppStore()) });
  return { trips, handlers, post: (body: unknown) => handlers.POST(new Request("https://cake.example/api/app", { method: "POST", body: JSON.stringify(body) })) };
}

const save = { action: "saveTransaction", workspaceId, occurredAt: "2026-10-10T00:00:00Z", merchant: "店", method: "現金", type: "PAYMENT", amountYen: 300, actorUserId: "a" };
const cases: { input: Row; counts: number[]; transactions?: number[]; result?: Row }[] = [
  { input: { action: "updateProfile", name: "A" }, counts: [1], result: { ok: true, user: { ...user, isAdmin: false } } },
  { input: { action: "createWorkspace", name: "QA", type: "SHARED" }, counts: [2], transactions: [0] },
  { input: { action: "updateWorkspace", workspaceId, name: "QA" }, counts: [1, 1] },
  { input: { action: "deleteWorkspace", workspaceId, confirmationName: "QA" }, counts: [1, 1] },
  { input: { action: "createInvite", workspaceId, email: "b@example.com" }, counts: [1, 1, 1] },
  { input: { action: "acceptInvite", token: "a".repeat(64) }, counts: [1, 1, 2], transactions: [2], result: { ok: true, workspaceId } },
  { input: { action: "updateWeights", workspaceId, weights: [{ userId: "a", weight: 1 }, { userId: "b", weight: 1 }] }, counts: [1, 1, 3], transactions: [2] },
  { input: save, counts: [1, 1, 1, 2], transactions: [3] },
  { input: { ...save, transactionId }, counts: [1, 1, 1, 2], transactions: [3] },
  { input: { ...save, transactionId, splitWeights: { a: 1, b: 0 } }, counts: [1, 1, 1, 2], transactions: [3] },
  { input: { action: "saveTransactionMemo", workspaceId, transactionId, memo: "メモ" }, counts: [1, 2], transactions: [1], result: { ok: true, transactionId, memo: "メモ" } },
  { input: { action: "deleteTransaction", workspaceId, transactionId }, counts: [1, 2], transactions: [1] },
  { input: { action: "deleteTransactions", workspaceId, transactionIds: [transactionId] }, counts: [1, 1], result: { ok: true, deleted: 1 } },
  { input: { action: "applyTransactionRules", workspaceId, transactionIds: [transactionId] }, counts: [1, 1], result: { ok: true, applied: 1, appliedTransactions: [{ id: transactionId, occurredAt: "2026-10-10T00:00:00.000Z" }] } },
  { input: { action: "createRule", workspaceId, merchantContains: "店", expenseClass: "SHARED" }, counts: [1, 1, 2], transactions: [2] },
  { input: { action: "updateRule", workspaceId, ruleId, merchantContains: "店", expenseClass: "SHARED" }, counts: [1, 1, 1, 2], transactions: [3] },
  { input: { action: "reorderRules", workspaceId, ruleIds: [ruleId] }, counts: [1, 1] },
  { input: { action: "deleteRule", workspaceId, ruleId }, counts: [1, 3], transactions: [1] },
  { input: { action: "deleteRules", workspaceId, ruleIds: [ruleId] }, counts: [1, 1, 3], transactions: [2], result: { ok: true, deleted: 1 } },
  { input: { action: "bulkImport", workspaceId, fileName: "qa.csv", totalRows: 1, items: [{ occurredAt: save.occurredAt, merchant: "店", method: "PayPay", amountYen: 300, actorUserId: "a", externalId: "123" }] }, counts: [1, 1, 1, 4], transactions: [3], result: { ok: true, imported: 1, skipped: 0 } },
  { input: { action: "completeSettlement", workspaceId }, counts: [1, 4], transactions: [1] },
];

for (const [index, scenario] of cases.entries()) {
  test(`全19操作のSQL往復・Transaction境界・成功応答: ${index + 1} ${scenario.input.action}`, async (t) => {
    const f = fixture(t);
    const response = await f.post(scenario.input);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    if (scenario.result) assert.deepEqual(body, scenario.result);
    assert.deepEqual(f.trips.map(trip => trip.queries.length), scenario.counts);
    assert.deepEqual(f.trips.flatMap((trip, i) => trip.transaction ? [i] : []), scenario.transactions ?? []);
    if (scenario.input.action === "saveTransaction") {
      const write = f.trips.at(-1)!;
      assert.match(write.queries[0].query, /UPDATE workspaces/);
      assert.match(write.queries[1].query, scenario.input.transactionId ? /AND settled_at IS NULL\s+RETURNING \*/ : /'MANUAL'/);
      assert.equal(body.transaction.id, transactionId);
    }
    if (scenario.input.action === "completeSettlement") {
      const queries = f.trips[1].queries;
      assert.match(queries[0].query, /cake_assert_settlement_snapshot/);
      assert.match(queries[1].query, /INSERT INTO settlements/);
      assert.match(queries[2].query, /INSERT INTO settlement_transactions/);
      assert.match(queries[2].query, /jsonb_array_elements_text/);
      assert.match(f.trips[0].queries[0].query, /WITH authorized AS/);
      assert.doesNotMatch(f.trips[0].queries[0].query, /default_rules|invitations|settlements|my_workspaces/);
      assert.match(queries[3].query, /UPDATE transactions SET settled_at/);
      assert.deepEqual(JSON.parse(String(queries[0].params[2])), [{ id: transactionId, actorUserId: "a", type: "PAYMENT", amountYen: 300, expenseClass: "SHARED", splitWeights: { a: 1, b: 1 } }]);
    }
    if (scenario.input.action === "updateProfile") {
      assert.match(f.trips[0].queries[0].query, /WHERE id = \$\d+ AND email = \$\d+ AND is_enabled = true/);
    }
  });
}

test("通常bootstrapの利用可否確認1SQLと集約1SQL・共通ルールDTOを保つ", async (t) => {
  const f = fixture(t);
  const handlers = appHandlers({ currentUser: async () => findSessionUser(user.id, user.email), ...createAppService(createAppStore()) });
  for (const scope of ["full", "metadata"]) {
    f.trips.length = 0;
    const response = await handlers.GET(new Request(`https://cake.example/api/app?workspaceId=${workspaceId}&scope=${scope}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.selected.rules, [defaultRuleRecord(ruleRow)]);
    assert.deepEqual(f.trips.map(trip => trip.queries.length), [1, 1]);
    assert.match(f.trips[0].queries[0].query, /is_enabled = true/);
    assert.match(f.trips[1].queries[0].query, /my_workspaces AS/);
    if (scope === "metadata") assert.doesNotMatch(f.trips[1].queries[0].query, /FROM transactions|FROM settlements/);
  }
});

test("DB上の非所属は所属SELECT一回で止まり、DB失敗もHTTP400の既存形式へ伝える", async (t) => {
  const f = fixture(t, { forbidden: true });
  const response = await f.post(save);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "このワークスペースを操作する権限がありません。" });
  assert.equal(f.trips.length, 1);
});

test("SQL実行失敗を成功JSONに変換しない", async (t) => {
  const f = fixture(t, { fail: true });
  const response = await f.post({ action: "createWorkspace", name: "QA", type: "SHARED" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "fixture database failure" });
  assert.equal(f.trips.length, 1);
});

test("ルール作成は参加者だけ、更新はworkspaceとIDで限定した3項目だけを取得する", async t => {
  const manyRules = Array.from({ length: 1000 }, (_, i) => ({ ...ruleRow, id: i === 0 ? ruleId : `rule-${i}`, sort_order: i }));
  const f = fixture(t, { rules: manyRules });
  const store = createAppStore();
  const selected = await store.ruleForUpdate(workspaceId, ruleId);
  assert.deepEqual(selected, { expenseClass: "SHARED", splitWeights: { a: 1, b: 1 }, enabled: true });
  assert.ok(Buffer.byteLength(JSON.stringify(selected)) < Buffer.byteLength(JSON.stringify(manyRules)) / 100);
  assert.equal(f.trips.length, 1);
  assert.match(f.trips[0].queries[0].query, /SELECT expense_class, split_weights, enabled FROM default_rules WHERE workspace_id = \$1::uuid AND id = \$2::uuid/);
  assert.deepEqual(f.trips[0].queries[0].params, [workspaceId, ruleId]);
  assert.equal(await store.ruleForUpdate(workspaceId, transactionId), null);
  assert.equal(await store.ruleForUpdate(transactionId, ruleId), null);
  f.trips.length = 0;
  assert.equal((await f.post({ action: "createRule", workspaceId, merchantContains: "店", expenseClass: "SHARED" })).status, 200);
  const reads = f.trips.filter(trip => !trip.transaction).flatMap(trip => trip.queries);
  assert.equal(reads.length, 2);
  assert.ok(reads.every(query => !query.query.includes("default_rules")));
  assert.match(reads[1].query, /SELECT wm.user_id, wm.weight, u.name/);
});

test("明示値と保存済み割合の保存はルールSELECTを省き、省略値・CSVは必要なルールを取得する", async t => {
  const f = fixture(t);
  for (const [input, ruleReads] of [
    [{ ...save, expenseClass: "PERSONAL" }, 0],
    [{ ...save, expenseClass: "SHARED", splitWeights: { a: 1, b: 1 } }, 0],
    [{ ...save, transactionId }, 0],
    [{ ...save, splitWeights: { a: 1, b: 1 } }, 1],
    [{ ...save, expenseClass: "SHARED" }, 1],
    [save, 1],
    [{ action: "bulkImport", workspaceId, fileName: "qa.csv", totalRows: 1, items: [{ occurredAt: save.occurredAt, merchant: "店", method: "PayPay", amountYen: 300, actorUserId: "a", externalId: "123" }] }, 1],
  ] as const) {
    f.trips.length = 0;
    const response = await f.post(input);
    assert.equal(response.status, 200);
    const rules = f.trips.filter(trip => !trip.transaction).flatMap(trip => trip.queries).filter(query => query.query.includes("FROM default_rules"));
    assert.equal(rules.length, ruleReads);
    if (ruleReads) assert.deepEqual(rules[0].params, [workspaceId]);
  }
});

test("別workspaceまたは不存在のルール更新は対象SELECT後に書き込まない", async t => {
  const f = fixture(t, { rules: [{ ...ruleRow, workspace_id: transactionId }] });
  for (const id of [ruleId, transactionId]) {
    f.trips.length = 0;
    const response = await f.post({ action: "updateRule", workspaceId, ruleId: id, merchantContains: "店", expenseClass: "SHARED" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "このワークスペースにルールがありません。" });
    assert.equal(f.trips.length, 3);
    assert.ok(f.trips.every(trip => !trip.transaction));
  }
});

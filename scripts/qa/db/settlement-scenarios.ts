import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SqlTemplate, type NeonQueryFunction, type NeonQueryPromise, type ParameterizedQuery } from "@neondatabase/serverless";
import { createSettlementStore } from "../../../lib/server/stores/settlement-store";
import { calculateSettlement } from "../../../lib/shared/settlement";
import type { SettlementContext } from "../../../lib/shared/settlement";
import type { AppUser, SettlementResult } from "../../../lib/shared/types";

type Sql = NeonQueryFunction<false, false>;
type Query = NeonQueryPromise<false, false>;
type Baseline = { query: string; params: string[]; workspaceId: string };
export type SettlementDbReport = { cases: { name: string; seconds: number }[]; measurements: Record<string, unknown>[]; workspaceIds: string[]; cleanup: Record<string, number>; seconds: number };
export function parameterized(query: Query): ParameterizedQuery {
  return query.queryData instanceof SqlTemplate ? query.queryData.toParameterizedQuery() : query.queryData;
}

// Reproduce the previous application's 2+2N write shape only for before/after measurement.
function legacyQueries(sql: Sql, workspaceId: string, user: AppUser, result: SettlementResult, expected: unknown) {
  const settlementId = randomUUID();
  return [
    sql`SELECT cake_assert_settlement_snapshot(${workspaceId}::uuid,${user.id},${JSON.stringify(expected)}::jsonb)`,
    sql`INSERT INTO settlements(id,workspace_id,payer_user_id,payee_user_id,amount_yen,weight_snapshot,calculation_snapshot,completed_by)
      VALUES (${settlementId}::uuid,${workspaceId}::uuid,${result.payerUserId},${result.payeeUserId},${result.amountYen},
        ${JSON.stringify(result.people.map(p => ({ userId: p.userId, weight: p.weight })))}::jsonb,${JSON.stringify({ ...result, transactions: expected })}::jsonb,${user.id})`,
    ...result.transactionIds.map(id => sql`INSERT INTO settlement_transactions(settlement_id,transaction_id) VALUES (${settlementId}::uuid,${id}::uuid)`),
    ...result.transactionIds.map(id => sql`UPDATE transactions SET settled_at=now(),updated_by=${user.id},updated_at=now() WHERE id=${id}::uuid AND workspace_id=${workspaceId}::uuid AND settled_at IS NULL`),
  ];
}
function explainPlan(rows: Record<string, unknown>[]) {
  const plan = (rows[0]["QUERY PLAN"] as Record<string, unknown>[])[0];
  return { planningMs: Number(plan["Planning Time"]), executionMs: Number(plan["Execution Time"]) };
}
function explainWrites(sql: Sql, stats: Record<string, number>) {
  return new Proxy(sql, {
    get(target, property) {
      if (property !== "transaction") return Reflect.get(target, property);
      return async (queries: Query[]) => {
        stats.sqlCount = queries.length;
        stats.sqlTextBytes = queries.reduce((sum, q) => sum + Buffer.byteLength(parameterized(q).query), 0);
        const start = performance.now();
        const plans = await target.transaction(queries.map(q => {
          const statement = parameterized(q);
          return target.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.query}`, statement.params);
        }));
        stats.wallMs = performance.now() - start;
        stats.planningMs = 0; stats.executionMs = 0;
        for (const rows of plans) { const plan = explainPlan(rows); stats.planningMs += plan.planningMs; stats.executionMs += plan.executionMs; }
        return plans;
      };
    }
  });
}

/** Only caller-created workspace IDs are written/deleted. Users and schema remain untouched. */
export async function verifySettlementScenarios(sql: Sql, user: AppUser, otherUserId: string, options: {
  prefix: string; baseline?: Baseline; sizes?: number[];
  runCase?: (name: string, run: () => Promise<void>) => Promise<void>;
}): Promise<SettlementDbReport> {
  const started = performance.now();
  const report: SettlementDbReport = { cases: [], measurements: [], workspaceIds: [], cleanup: {}, seconds: 0 };
  const marker = options.prefix;
  assert.ok(marker.length <= 60 && marker.startsWith("verify-settlement-"));
  if (options.baseline) {
    assert.match(options.baseline.query, /^\s*WITH\s+my_workspaces\s+AS\b/);
    assert.doesNotMatch(options.baseline.query, /;|\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/);
    assert.ok(options.baseline.params.includes(user.id) && options.baseline.params.includes(user.email.toLowerCase()));
  }
  const observed: ParameterizedQuery[] = [];
  const tracked = new Proxy(sql, {
    apply(target, thisArg, argumentsList) {
      const query = Reflect.apply(target, thisArg, argumentsList) as Query;
      observed.push(parameterized(query)); return query;
    }
  });
  const store = createSettlementStore(() => tracked);
  async function check(name: string, run: () => Promise<void>) {
    const at = performance.now();
    if (options.runCase) await options.runCase(name, run); else await run();
    report.cases.push({ name, seconds: (performance.now() - at) / 1000 });
  }
  async function workspace() {
    const id = randomUUID(); report.workspaceIds.push(id);
    await sql.transaction([
      sql`INSERT INTO workspaces(id,name,type,owner_user_id) VALUES (${id}::uuid,${marker},'SHARED',${user.id})`,
      sql`INSERT INTO workspace_members(workspace_id,user_id,role,weight) VALUES (${id}::uuid,${user.id},'OWNER',6),(${id}::uuid,${otherUserId},'MEMBER',4)`,
    ]);
    return id;
  }
  async function insert(id: string, count = 1, extras = false, zero = false) {
    const rows = Array.from({ length: count }, (_, i) => ({
      id: randomUUID(), actor: i % 3 === 0 ? otherUserId : user.id,
      type: i % 4 === 0 ? "RECEIPT" : "PAYMENT", amount: zero ? 100 : 101 + i % 11,
      weights: i % 2 === 0 ? { [user.id]: 1, [otherUserId]: 2 } : { [user.id]: 1, [otherUserId]: 1 },
    }));
    if (zero) {
      rows[0].actor = user.id; rows[0].type = "PAYMENT";
      rows[1].actor = user.id; rows[1].type = "RECEIPT";
      rows[1].weights = { ...rows[0].weights };
    }
    await sql`
      INSERT INTO transactions(id,workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,expense_class,split_weights,external_id,source,created_by,updated_by,memo)
      SELECT r.id::uuid,${id}::uuid,TIMESTAMPTZ '2026-10-18 00:00:00+00' + r.position * interval '1 second',
        ${marker},'QA',r.type,r.amount,r.actor,'SHARED',r.weights,r.id,'MANUAL',${user.id},${user.id},repeat('検証',256)
      FROM jsonb_to_recordset(${JSON.stringify(rows.map((row, position) => ({ ...row, position })))}::jsonb)
        AS r(id text,actor text,type text,amount integer,weights jsonb,position integer)
    `;
    if (extras) await sql`
      INSERT INTO transactions(workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,expense_class,split_weights,external_id,source,created_by,updated_by,settled_at,memo)
      SELECT ${id}::uuid,now(),${marker},'QA','PAYMENT',100,${user.id},kind,
        CASE WHEN kind='PERSONAL' THEN ${JSON.stringify({ [user.id]: 1, [otherUserId]: 0 })}::jsonb ELSE ${JSON.stringify({ [user.id]: 1, [otherUserId]: 1 })}::jsonb END,
        gen_random_uuid()::text,'MANUAL',${user.id},${user.id},CASE WHEN kind='SHARED' THEN now() ELSE NULL END,repeat('対象外',128)
      FROM generate_series(1,${count}) n CROSS JOIN (VALUES ('PERSONAL'),('SHARED')) kinds(kind)
    `;
    return rows.map(row => row.id);
  }
  function snapshot(context: SettlementContext) {
    const result = calculateSettlement(context.members, context.transactions);
    assert.ok(result);
    const ids = new Set(result.transactionIds);
    const expected = context.transactions.filter(t => ids.has(t.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(({ id, actorUserId, type, amountYen, expenseClass, splitWeights }) => ({ id, actorUserId, type, amountYen, expenseClass, splitWeights }));
    return { result, expected, calculation: { ...result, transactions: expected } };
  }
  async function save(id: string, captured: ReturnType<typeof snapshot>, override?: SettlementResult) {
    await store.completeSettlement({ action: "completeSettlement", workspaceId: id }, user, randomUUID(), override ?? captured.result, captured.expected, captured.calculation);
  }
  async function state(id: string) {
    return (await sql`SELECT jsonb_build_object(
      'workspace',(SELECT to_jsonb(w) FROM workspaces w WHERE id=${id}::uuid),
      'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY user_id) FROM workspace_members m WHERE workspace_id=${id}::uuid),
      'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM transactions t WHERE workspace_id=${id}::uuid),
      'settlements',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM settlements s WHERE workspace_id=${id}::uuid),
      'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY transaction_id) FROM settlement_transactions l JOIN settlements s ON s.id=l.settlement_id WHERE s.workspace_id=${id}::uuid)
    ) AS state`)[0].state;
  }
  async function unchangedFailure(id: string, operation: () => Promise<void>) {
    const before = await state(id); await assert.rejects(operation); assert.deepEqual(await state(id), before);
  }
  try {
    await check("専用取得の認可・最小項目・個人費/清算済み除外・既存計算との一致", async () => {
      const id = await workspace(), ids = await insert(id, 7, true);
      observed.length = 0;
      const context = await store.settlementContext(id, user.id);
      assert.equal(observed.length, 1);
      assert.doesNotMatch(observed[0].query, /default_rules|invitations|settlement_history|my_workspaces|memo|merchant|method/);
      assert.deepEqual(context.transactions.map(t => t.id).sort(), ids.sort());
      assert.deepEqual(Object.keys(context.members[0]).sort(), ["id", "name", "weight"]);
      assert.deepEqual(Object.keys(context.transactions[0]).sort(), ["actorUserId", "amountYen", "expenseClass", "id", "settledAt", "splitWeights", "type"]);
      const full = await sql`SELECT t.*,u.name AS actor_name FROM transactions t JOIN app_users u ON u.id=t.actor_user_id WHERE workspace_id=${id}::uuid ORDER BY occurred_at DESC,created_at DESC`;
      const legacyTransactions = full.map(t => ({ id: String(t.id), actorUserId: String(t.actor_user_id), type: t.type, amountYen: Number(t.amount_yen), expenseClass: t.expense_class, splitWeights: t.split_weights, settledAt: t.settled_at })) as SettlementContext["transactions"];
      assert.deepEqual(calculateSettlement(context.members, context.transactions), calculateSettlement(context.members, legacyTransactions));
      await assert.rejects(store.settlementContext(id, `${marker}-outsider`), /権限がありません/);
      await assert.rejects(store.settlementContext(randomUUID(), user.id), /権限がありません/);
    });
    await check("支払い/受け取り・保存割合・最後一度の丸め・確定Snapshotの保存", async () => {
      const id = await workspace(); await insert(id, 7, true);
      const captured = snapshot(await store.settlementContext(id, user.id));
      observed.length = 0; await save(id, captured); assert.equal(observed.length, 4);
      const saved = (await sql`SELECT calculation_snapshot,weight_snapshot FROM settlements WHERE workspace_id=${id}::uuid`)[0];
      assert.deepEqual(saved.calculation_snapshot, captured.calculation);
      assert.deepEqual(saved.weight_snapshot, captured.result.people.map(p => ({ userId: p.userId, weight: p.weight })));
      assert.equal(Number((await sql`SELECT COUNT(*)::int AS count FROM transactions WHERE workspace_id=${id}::uuid AND settled_at IS NULL AND expense_class='SHARED'`)[0].count), 0);
      assert.equal(Number((await sql`SELECT COUNT(*)::int AS count FROM transactions WHERE workspace_id=${id}::uuid AND expense_class='PERSONAL' AND settled_at IS NULL`)[0].count), 7);
    });
    await check("メモ・取引先・日時だけの変更は計算Snapshotを無効にしない", async () => {
      const id = await workspace(); await insert(id, 2);
      const captured = snapshot(await store.settlementContext(id, user.id));
      await sql`UPDATE transactions SET memo='メモだけ変更',merchant='取引先だけ変更',occurred_at=occurred_at+interval '1 minute' WHERE workspace_id=${id}::uuid`;
      await save(id, captured);
      assert.equal((await store.settlementContext(id, user.id)).transactions.length, 0);
    });
    await check("ゼロ円清算の履歴と全対象の清算済み更新", async () => {
      const id = await workspace(); await insert(id, 2, false, true);
      const captured = snapshot(await store.settlementContext(id, user.id));
      assert.equal(captured.result.amountYen, 0); assert.equal(captured.result.payerUserId, null); assert.equal(captured.result.payeeUserId, null);
      await save(id, captured);
      assert.equal(Number((await sql`SELECT amount_yen FROM settlements WHERE workspace_id=${id}::uuid`)[0].amount_yen), 0);
      assert.equal((await store.settlementContext(id, user.id)).transactions.length, 0);
    });
    const mutations = [
      ["金額編集", (id: string, tx: string) => sql`UPDATE transactions SET amount_yen=amount_yen+1 WHERE workspace_id=${id}::uuid AND id=${tx}::uuid`],
      ["保存割合編集", (id: string, tx: string) => sql`UPDATE transactions SET split_weights=${JSON.stringify({ [user.id]: 3, [otherUserId]: 1 })}::jsonb WHERE workspace_id=${id}::uuid AND id=${tx}::uuid`],
      ["費用区分変更", (id: string, tx: string) => sql`UPDATE transactions SET expense_class='PERSONAL' WHERE workspace_id=${id}::uuid AND id=${tx}::uuid`],
      ["担当者変更", (id: string, tx: string) => sql`UPDATE transactions SET actor_user_id=${user.id} WHERE workspace_id=${id}::uuid AND id=${tx}::uuid`],
      ["支払い種別変更", (id: string, tx: string) => sql`UPDATE transactions SET type='PAYMENT' WHERE workspace_id=${id}::uuid AND id=${tx}::uuid`],
      ["対象削除", (id: string, tx: string) => sql`DELETE FROM transactions WHERE workspace_id=${id}::uuid AND id=${tx}::uuid`],
    ] as const;
    for (const [label, mutate] of mutations) await check(`取得後の${label}を検出し書込み全体をrollback`, async () => {
      const id = await workspace(), [tx] = await insert(id);
      const captured = snapshot(await store.settlementContext(id, user.id)); await mutate(id, tx);
      await unchangedFailure(id, () => save(id, captured));
    });
    await check("取得後の共有明細追加を検出し書込み全体をrollback", async () => {
      const id = await workspace(); await insert(id);
      const captured = snapshot(await store.settlementContext(id, user.id)); await insert(id);
      await unchangedFailure(id, () => save(id, captured));
    });
    await check("取得後の所属削除は最新の認可で拒否し全体rollback", async () => {
      const id = await workspace(); await insert(id);
      const captured = snapshot(await store.settlementContext(id, user.id));
      await sql`DELETE FROM workspace_members WHERE workspace_id=${id}::uuid AND user_id=${user.id}`;
      await unchangedFailure(id, () => save(id, captured));
    });
    await check("先行清算後の古いSnapshotと二重清算は履歴/関連を増やさない", async () => {
      const id = await workspace(); await insert(id, 2);
      const captured = snapshot(await store.settlementContext(id, user.id)); await save(id, captured);
      await unchangedFailure(id, () => save(id, captured));
    });
    await check("並列清算はworkspaceロックで一件だけ成功する", async () => {
      const id = await workspace(); await insert(id, 2);
      const captured = snapshot(await store.settlementContext(id, user.id));
      const results = await Promise.allSettled([save(id, captured), save(id, captured)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
      assert.equal(Number((await sql`SELECT COUNT(*)::int AS count FROM settlements WHERE workspace_id=${id}::uuid`)[0].count), 1);
    });
    await check("関連INSERTの一意制約違反では先行履歴INSERTとworkspace更新もrollback", async () => {
      const id = await workspace(), [tx] = await insert(id);
      const captured = snapshot(await store.settlementContext(id, user.id));
      await unchangedFailure(id, () => save(id, captured, { ...captured.result, transactionIds: [tx, tx] }));
    });
    for (const count of options.sizes ?? [1, 1000]) await check(`${count}件の清算も更新SQLは固定4本`, async () => {
      const id = await workspace(); await insert(id, count, true);
      const context = await store.settlementContext(id, user.id), captured = snapshot(context);
      const contextQuery = observed.at(-1)!;
      const read: Record<string, unknown> = {};
      if (options.baseline) {
        const oldParams = options.baseline.params.map(p => p === options.baseline!.workspaceId ? id : p);
        const oldRows = await sql.query(options.baseline.query, oldParams);
        const newRows = await sql.query(contextQuery.query, contextQuery.params);
        const oldPlan = explainPlan(await sql.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${options.baseline.query}`, oldParams));
        const newPlan = explainPlan(await sql.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${contextQuery.query}`, contextQuery.params));
        read.legacy = { transactionCount: (oldRows[0].transactions as unknown[]).length, jsonBytes: Buffer.byteLength(JSON.stringify(oldRows)), ...oldPlan };
        read.current = { transactionCount: (newRows[0].transactions as unknown[]).length, jsonBytes: Buffer.byteLength(JSON.stringify(newRows)), ...newPlan };
      }
      observed.length = 0;
      const current: Record<string, number> = {}, legacy: Record<string, number> = {};
      await createSettlementStore(() => explainWrites(tracked, current)).completeSettlement({ action: "completeSettlement", workspaceId: id }, user, randomUUID(), captured.result, captured.expected, captured.calculation);
      assert.equal(current.sqlCount, 4);
      assert.equal(Number((await sql`SELECT COUNT(*)::int AS count FROM settlement_transactions l JOIN settlements s ON s.id=l.settlement_id WHERE s.workspace_id=${id}::uuid`)[0].count), count);
      const oldId = await workspace(); await insert(oldId, count, true);
      const oldCaptured = snapshot(await store.settlementContext(oldId, user.id));
      await explainWrites(sql, legacy).transaction(legacyQueries(sql, oldId, user, oldCaptured.result, oldCaptured.expected));
      assert.equal(legacy.sqlCount, 2 + 2 * count);
      assert.equal(Number((await sql`SELECT COUNT(*)::int AS count FROM settlement_transactions l JOIN settlements s ON s.id=l.settlement_id WHERE s.workspace_id=${oldId}::uuid`)[0].count), count);
      report.measurements.push({ count, current, legacy, read });
    });
  } finally {
    // Workspace IDs are generated above, and the marker/owner must still match.
    for (const id of report.workspaceIds) await sql`
      WITH owned AS (SELECT id FROM workspaces WHERE id=${id}::uuid AND name=${marker} AND owner_user_id=${user.id}),
      removed_links AS (DELETE FROM settlement_transactions WHERE settlement_id IN (SELECT id FROM settlements WHERE workspace_id IN (SELECT id FROM owned)) RETURNING settlement_id)
      DELETE FROM workspaces WHERE id IN (SELECT id FROM owned) AND (SELECT COUNT(*) FROM removed_links)>=0
    `;
    for (const table of ["workspaces", "workspace_members", "transactions", "settlements", "default_rules", "invitations", "import_batches"]) {
      const column = table === 'workspaces' ? 'id' : 'workspace_id';
      const rows = await sql.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column}=ANY(ARRAY(SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb)))`, [JSON.stringify(report.workspaceIds)]);
      report.cleanup[table] = Number(rows[0].count); assert.equal(report.cleanup[table], 0, table);
    }
    const links = await sql`SELECT COUNT(*)::int AS count FROM settlement_transactions l LEFT JOIN settlements s ON s.id=l.settlement_id WHERE s.id IS NULL`;
    assert.equal(Number(links[0].count), 0);
    report.seconds = (performance.now() - started) / 1000;
  }
  return report;
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defaultRuleRecord } from "../lib/default-rule-record";
import { prepareDefaultRuleMatcher, transactionDefaults } from "../lib/expense-splits";
import type { DefaultRule } from "../lib/types";
import { defaultRuleCases, ruleMembers } from "../tests/fixtures/default-rule-cases";

export type BulkRuleDatabase = { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
export type BulkRuleResult = { affected: number; transactions?: { id: string; merchant: string; actorUserId: string; expenseClass: string; splitWeights: Record<string, number>; amountYen: number; type: string; occurredAt: string }[] };
export type BulkRuleOptions = { prefix: string; runCase?: (name: string, run: () => Promise<void>) => Promise<void> };

/** The caller supplies fixture users a/b. All writes are restricted to new IDs. */
export async function createBulkRuleFixture(sql: BulkRuleDatabase, prefix: string) {
  assert.ok(prefix.startsWith("verify-bulk-rules-") && prefix.length <= 80);
  const workspaceId = randomUUID(), foreignWorkspaceId = randomUUID();
  const workspaceIds = [workspaceId, foreignWorkspaceId];
  async function cleanup() {
    await sql.query(`WITH links AS (DELETE FROM settlement_transactions WHERE settlement_id IN
      (SELECT id FROM settlements WHERE workspace_id IN ($1::uuid,$2::uuid)) RETURNING settlement_id)
      DELETE FROM workspaces WHERE id IN ($1::uuid,$2::uuid) AND name=$3 AND owner_user_id='a' AND (SELECT count(*) FROM links)>=0`, [...workspaceIds, prefix]);
    const counts: Record<string, number> = {};
    for (const table of ["workspaces", "workspace_members", "default_rules", "transactions", "settlements"]) {
      const column = table === "workspaces" ? "id" : "workspace_id";
      counts[table] = Number((await sql.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${column} IN ($1::uuid,$2::uuid)`, workspaceIds)).rows[0].count);
      assert.equal(counts[table], 0);
    }
    return counts;
  }
  try {
    for (const id of workspaceIds) {
      await sql.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1::uuid,$2,'SHARED','a')", [id, prefix]);
      await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role,weight) VALUES ($1::uuid,'a','OWNER',6),($1::uuid,'b','MEMBER',4)", [id]);
    }
  } catch (error) { await cleanup(); throw error; }
  async function reset() {
    await sql.query("DELETE FROM settlement_transactions WHERE settlement_id IN (SELECT id FROM settlements WHERE workspace_id=$1::uuid)", [workspaceId]);
    await sql.query("DELETE FROM settlements WHERE workspace_id=$1::uuid", [workspaceId]);
    await sql.query("DELETE FROM transactions WHERE workspace_id=$1::uuid", [workspaceId]);
    await sql.query("DELETE FROM default_rules WHERE workspace_id=$1::uuid", [workspaceId]);
  }
  async function rules() {
    return (await sql.query("SELECT * FROM default_rules WHERE workspace_id=$1::uuid ORDER BY sort_order,created_at,id", [workspaceId])).rows.map(defaultRuleRecord);
  }
  async function setRules(values: readonly DefaultRule[]) {
    await sql.query("DELETE FROM default_rules WHERE workspace_id=$1::uuid", [workspaceId]);
    for (const [i, r] of values.entries()) await sql.query(`INSERT INTO default_rules(id,workspace_id,merchant_contains,expense_class,sort_order,enabled,split_weights,created_by,created_at)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb,'a',$8::timestamptz)`,
    [randomUUID(), workspaceId, r.merchantContains, r.expenseClass, r.sortOrder, r.enabled, r.splitWeights == null ? null : JSON.stringify(r.splitWeights), new Date(Date.UTC(2026, 9, 18, 0, 0, i)).toISOString()]);
    return rules();
  }
  async function insert(values: { merchant: string; actorUserId: string; type?: string; amountYen?: number }[], targetWorkspace = workspaceId) {
    assert.ok(workspaceIds.includes(targetWorkspace));
    const rows = values.map(value => ({ id: randomUUID(), type: "PAYMENT", amountYen: 101, ...value }));
    await sql.query(`INSERT INTO transactions(id,workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,expense_class,split_weights,external_id,created_by,updated_by,memo)
      SELECT r.id,$1::uuid,'2026-10-18T00:00:00.123456Z',r.merchant,'QA',r.type,r."amountYen",r."actorUserId",'SHARED','{"a":1,"b":1}'::jsonb,'qa_'||r.id::text,'a','a','fixture'
      FROM jsonb_to_recordset($2::jsonb) AS r(id uuid,merchant text,"actorUserId" text,type text,"amountYen" integer)`, [targetWorkspace, JSON.stringify(rows)]);
    return rows.map(row => String(row.id));
  }
  async function apply(ids: (string | null)[], operation = "APPLY_RULES", client = sql, actor = "a", fn = "cake_bulk_transactions") {
    assert.ok(["cake_bulk_transactions", "fixture_legacy_bulk_transactions"].includes(fn));
    return (await client.query(`SELECT ${fn}($1::uuid,$2,ARRAY(SELECT value::uuid FROM jsonb_array_elements_text($3::jsonb)),$4) AS result`, [workspaceId, actor, JSON.stringify(ids), operation])).rows[0].result as BulkRuleResult;
  }
  async function snapshot() {
    return (await sql.query(`SELECT jsonb_build_object(
      'workspace',(SELECT to_jsonb(w) FROM workspaces w WHERE id=$1::uuid),
      'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM transactions t WHERE workspace_id=$1::uuid),
      'settlements',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM settlements s WHERE workspace_id=$1::uuid)
    ) AS snapshot`, [workspaceId])).rows[0].snapshot;
  }
  return { sql, workspaceId, foreignWorkspaceId, workspaceIds, cleanup, reset, rules, setRules, insert, apply, snapshot };
}

export async function verifyBulkRuleScenarios(sql: BulkRuleDatabase, options: BulkRuleOptions) {
  const started = performance.now(), f = await createBulkRuleFixture(sql, options.prefix);
  const report = { cases: [] as { name: string; seconds: number }[], workspaceIds: f.workspaceIds, cleanup: {} as Record<string, number>, seconds: 0 };
  async function check(name: string, run: () => Promise<void>) {
    const at = performance.now(); if (options.runCase) await options.runCase(name, run); else await run();
    report.cases.push({ name, seconds: (performance.now() - at) / 1000 });
  }
  async function rejected(run: () => Promise<unknown>, pattern: RegExp) {
    const before = await f.snapshot(); await assert.rejects(run(), pattern); assert.deepEqual(await f.snapshot(), before);
  }
  const sampleRule: DefaultRule = { id: "rule", merchantContains: "スーパー", expenseClass: "SHARED", sortOrder: 0, splitWeights: { a: 1, b: 3 }, enabled: true };
  try {
    const foreignIds = await f.insert([{ merchant: "foreign", actorUserId: "a" }], f.foreignWorkspaceId);
    const foreignBefore = (await sql.query("SELECT to_jsonb(t) AS row FROM transactions t WHERE workspace_id=$1::uuid", [f.foreignWorkspaceId])).rows;
    for (const fixture of defaultRuleCases) await check(`TS/SQL一致: ${fixture.name}`, async () => {
      await f.reset(); const savedRules = await f.setRules(fixture.rules);
      const ids = await f.insert([{ merchant: fixture.merchant, actorUserId: "b" }]);
      const expected = fixture.bulkDefaults ?? { expenseClass: fixture.expenseClass, splitWeights: fixture.splitWeights };
      assert.deepEqual(transactionDefaults(fixture.merchant, prepareDefaultRuleMatcher(savedRules), ruleMembers, "b"), expected);
      const result = await f.apply(ids), row = result.transactions![0];
      assert.equal(result.affected, 1); assert.equal(row.expenseClass, expected.expenseClass); assert.deepEqual(row.splitWeights, expected.splitWeights);
      assert.equal(row.merchant, fixture.merchant); assert.equal(row.type, "PAYMENT"); assert.equal(row.amountYen, 101);
      assert.equal(new Date(row.occurredAt).toISOString(), "2026-10-18T00:00:00.123Z");
      const stored = (await sql.query("SELECT expense_class,split_weights,updated_by,memo,method FROM transactions WHERE id=$1::uuid", ids)).rows[0];
      assert.deepEqual(stored, { expense_class: row.expenseClass, split_weights: row.splitWeights, updated_by: "a", memo: "fixture", method: "QA" });
    });
    await check("最大5000件を一括更新し、交互の支払者・受取明細・確定DTOのID順を維持する", async () => {
      await f.reset(); const rules = await f.setRules([sampleRule]);
      const values = Array.from({ length: 5000 }, (_, i) => ({ merchant: i % 3 ? "スーパー本店" : "未一致", actorUserId: i % 2 ? "a" : "b", type: i % 4 ? "PAYMENT" : "RECEIPT", amountYen: 101 + i % 3 }));
      const ids = await f.insert(values), result = await f.apply([...ids].reverse());
      assert.equal(result.affected, 5000); assert.equal(result.transactions!.length, 5000);
      assert.deepEqual(result.transactions!.map(t => t.id), [...ids].sort());
      const matchRule = prepareDefaultRuleMatcher(rules);
      const expected = new Map(ids.map((id, i) => [id, { ...values[i], ...transactionDefaults(values[i].merchant, matchRule, ruleMembers, values[i].actorUserId) }]));
      for (const row of result.transactions!) { const e = expected.get(row.id)!; for (const key of ["merchant", "actorUserId", "type", "amountYen", "expenseClass", "splitWeights"] as const) assert.deepEqual(row[key], e[key]); }
    });
    await check("未選択・無効・下位の不正割合は参照せず、選択された不正割合だけ全件中止する", async () => {
      for (const bad of ["1", true, {}, -1, 0.5, 2147483648, 0]) {
        await f.reset(); await f.setRules([sampleRule]);
        await sql.query("INSERT INTO default_rules(workspace_id,merchant_contains,expense_class,sort_order,split_weights,created_by) VALUES ($1::uuid,'不正','SHARED',1,$2::jsonb,'a')", [f.workspaceId, JSON.stringify({ a: bad, b: bad === 0 ? 0 : 1 })]);
        await sql.query("INSERT INTO default_rules(workspace_id,merchant_contains,expense_class,sort_order,split_weights,created_by) VALUES ($1::uuid,'スーパー','SHARED',2,$2::jsonb,'a')", [f.workspaceId, JSON.stringify({ a: bad, b: bad === 0 ? 0 : 1 })]);
        const ids = await f.insert([{ merchant: "スーパー", actorUserId: "a" }, { merchant: "不正", actorUserId: "b" }]);
        assert.equal((await f.apply([ids[0]])).affected, 1);
        await rejected(() => f.apply(ids), /共有費ルールの割合が不正/);
        await sql.query("UPDATE default_rules SET enabled=false WHERE workspace_id=$1::uuid AND merchant_contains='不正'", [f.workspaceId]);
        assert.equal((await f.apply(ids)).transactions!.find(t => t.id === ids[1])!.expenseClass, "PERSONAL");
      }
    });
    await check("null割合要素は0、不要な参加者キーは除外し、既定割合0:0は拒否する", async () => {
      await f.reset(); await f.setRules([sampleRule]);
      const ids = await f.insert([{ merchant: "スーパー", actorUserId: "b" }]);
      await sql.query("UPDATE default_rules SET split_weights=$2::jsonb WHERE workspace_id=$1::uuid", [f.workspaceId, JSON.stringify({ a: null, b: 2, old: "ignored" })]);
      assert.deepEqual((await f.apply(ids)).transactions![0].splitWeights, { a: 0, b: 2 });
      await sql.query("UPDATE default_rules SET split_weights=NULL WHERE workspace_id=$1::uuid", [f.workspaceId]);
      await sql.query("UPDATE workspace_members SET weight=0 WHERE workspace_id=$1::uuid", [f.workspaceId]);
      await rejected(() => f.apply(ids), /共有費ルールの割合が不正/);
      await sql.query("UPDATE workspace_members SET weight=CASE user_id WHEN 'a' THEN 6 ELSE 4 END WHERE workspace_id=$1::uuid", [f.workspaceId]);
    });
    await check("清算済み・不存在・他workspaceの混在は全件を中止する", async () => {
      await f.reset(); await f.setRules([sampleRule]); const ids = await f.insert([{ merchant: "スーパー", actorUserId: "a" }, { merchant: "スーパー", actorUserId: "b" }]);
      await rejected(() => f.apply([ids[0], randomUUID()]), /選択した明細が見つかりません/);
      await rejected(() => f.apply([ids[0], foreignIds[0]]), /選択した明細が見つかりません/);
      await sql.query("UPDATE transactions SET settled_at=now() WHERE id=$1::uuid", [ids[1]]);
      await rejected(() => f.apply(ids), /清算済みの明細は一括操作できません/);
    });
    await check("入力境界・最新所属・非参加担当者を拒否し、DELETEの既存応答を維持する", async () => {
      await f.reset(); const ids = await f.insert([{ merchant: "スーパー", actorUserId: "a" }]);
      for (const invalid of [[], [ids[0], ids[0].toUpperCase()], [null], Array.from({ length: 5001 }, () => randomUUID())]) await rejected(() => f.apply(invalid), /操作する明細を重複せずに/);
      await rejected(() => f.apply(ids, "UNKNOWN"), /未対応の明細操作/);
      await rejected(() => f.apply(ids, "APPLY_RULES", sql, "outsider"), /権限がありません/);
      await sql.query("DELETE FROM workspace_members WHERE workspace_id=$1::uuid AND user_id='a'", [f.workspaceId]);
      await rejected(() => f.apply(ids, "APPLY_RULES", sql, "b"), /取引担当者がワークスペースに参加していません/);
      assert.deepEqual(await f.apply(ids, "DELETE", sql, "b"), { affected: 1 });
      await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role,weight) VALUES ($1::uuid,'a','OWNER',6)", [f.workspaceId]);
    });
    await check("後続失敗は一括更新とworkspace時刻を全てrollbackする", async () => {
      await f.reset(); await f.setRules([sampleRule]); const ids = await f.insert([{ merchant: "スーパー", actorUserId: "a" }, { merchant: "スーパー", actorUserId: "b" }]), before = await f.snapshot();
      await sql.query("BEGIN"); try { await f.apply(ids); await assert.rejects(sql.query("SELECT 1/0"), /division by zero/); } finally { await sql.query("ROLLBACK"); }
      assert.deepEqual(await f.snapshot(), before);
    });
    assert.deepEqual((await sql.query("SELECT to_jsonb(t) AS row FROM transactions t WHERE workspace_id=$1::uuid", [f.foreignWorkspaceId])).rows, foreignBefore);
  } finally { report.cleanup = await f.cleanup(); report.seconds = (performance.now() - started) / 1000; }
  return report;
}

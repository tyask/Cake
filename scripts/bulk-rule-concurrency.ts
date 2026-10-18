import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createBulkRuleFixture, type BulkRuleDatabase, type BulkRuleOptions } from "./bulk-rule-scenarios";

/** Two independent PostgreSQL backends are required; observe real blocking PIDs. */
export async function verifyBulkRuleConcurrency(first: BulkRuleDatabase, second: BulkRuleDatabase, options: BulkRuleOptions) {
  const f = await createBulkRuleFixture(first, options.prefix), started = performance.now();
  const report = { cases: [] as { name: string; lockWaitObserved: boolean }[], workspaceIds: f.workspaceIds, cleanup: {} as Record<string, number>, seconds: 0 };
  const firstPid = Number((await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid), secondPid = Number((await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid); assert.notEqual(firstPid, secondPid);
  async function check(name: string, run: () => Promise<void>) { if (options.runCase) await options.runCase(name, run); else await run(); report.cases.push({ name, lockWaitObserved: true }); }
  async function begin() { await first.query("BEGIN"); await first.query("UPDATE workspaces SET updated_at=now() WHERE id=$1::uuid", [f.workspaceId]); }
  async function setup() {
    await f.reset(); await f.setRules([{ id: "r", merchantContains: "スーパー", expenseClass: "SHARED", sortOrder: 0, enabled: true, splitWeights: { a: 1, b: 3 } }]);
    return f.insert([{ merchant: "スーパー", actorUserId: "b" }, { merchant: "スーパー", actorUserId: "a" }]);
  }
  async function competing<T>(run: () => Promise<T>) {
    const pending = run().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
      let blocked = false; const deadline = performance.now() + 10_000;
      do { blocked = (await first.query("SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked", [firstPid, secondPid])).rows[0].blocked === true; if (!blocked) await new Promise(resolve => setTimeout(resolve, 40)); } while (!blocked && performance.now() < deadline);
      assert.ok(blocked); await first.query("COMMIT"); return await pending;
    } finally { await first.query("ROLLBACK"); await pending; }
  }
  const snapshot = async () => (await first.query(`SELECT jsonb_agg(jsonb_build_object('id',id,'actorUserId',actor_user_id,'type',type,'amountYen',amount_yen,'expenseClass',expense_class,'splitWeights',split_weights) ORDER BY id) AS snapshot
    FROM transactions WHERE workspace_id=$1::uuid AND expense_class='SHARED' AND settled_at IS NULL`, [f.workspaceId])).rows[0].snapshot;
  try {
    await check("先行編集のロック待機後に最新の取引先でルール適用する", async () => {
      const ids = await setup(); await begin();
      await first.query("UPDATE transactions SET merchant='未一致',amount_yen=103 WHERE id=$1::uuid", [ids[0]]);
      const r = await competing(() => f.apply(ids, "APPLY_RULES", second, "b")); assert.equal(r.error, undefined);
      const row = r.value!.transactions!.find(t => t.id === ids[0])!; assert.equal(row.merchant, "未一致"); assert.equal(row.amountYen, 103); assert.equal(row.expenseClass, "PERSONAL"); assert.deepEqual(row.splitWeights, { a: 0, b: 1 });
    });
    await check("先行清算のロック待機後は清算済み混在を全件中止する", async () => {
      const ids = await setup(), expected = await snapshot(), settlementId = randomUUID(); await begin();
      await first.query("SELECT cake_assert_settlement_snapshot($1::uuid,'a',$2::jsonb)", [f.workspaceId, JSON.stringify(expected)]);
      await first.query("INSERT INTO settlements(id,workspace_id,amount_yen,weight_snapshot,calculation_snapshot,completed_by) VALUES ($1::uuid,$2::uuid,0,'{}','{}','a')", [settlementId, f.workspaceId]);
      await first.query("INSERT INTO settlement_transactions(settlement_id,transaction_id) VALUES ($1::uuid,$2::uuid)", [settlementId, ids[0]]);
      await first.query("UPDATE transactions SET settled_at=now() WHERE id=$1::uuid", [ids[0]]);
      const r = await competing(() => f.apply(ids, "APPLY_RULES", second)); assert.match(String(r.error?.message), /清算済みの明細は一括操作できません/);
      const rows = (await first.query("SELECT split_weights FROM transactions WHERE workspace_id=$1::uuid", [f.workspaceId])).rows; assert.ok(rows.every(r => JSON.stringify(r.split_weights) === JSON.stringify({ a: 1, b: 1 })));
    });
    await check("一括適用の確定DTOは後続の同時編集前のロック下の値を返す", async () => {
      const ids = await setup(); await begin(); const acknowledged = await f.apply(ids);
      const r = await competing(async () => {
        await second.query("BEGIN"); try { await second.query("UPDATE workspaces SET updated_at=now() WHERE id=$1::uuid", [f.workspaceId]); await second.query("UPDATE transactions SET merchant='後続編集' WHERE id=$1::uuid", [ids[0]]); await second.query("COMMIT"); } catch (error) { await second.query("ROLLBACK"); throw error; }
      }); assert.equal(r.error, undefined); assert.equal(acknowledged.transactions!.find(t => t.id === ids[0])!.merchant, "スーパー");
      const row = (await first.query("SELECT merchant,split_weights FROM transactions WHERE id=$1::uuid", [ids[0]])).rows[0]; assert.deepEqual(row, { merchant: "後続編集", split_weights: { a: 1, b: 3 } });
    });
    await check("一括適用を待つ古い清算Snapshotは確定値との差分を拒否する", async () => {
      const ids = await setup(), expected = await snapshot(); await begin(); await f.apply(ids);
      const r = await competing(() => second.query("SELECT cake_assert_settlement_snapshot($1::uuid,'b',$2::jsonb)", [f.workspaceId, JSON.stringify(expected)])); assert.match(String(r.error?.message), /清算対象の明細が変わりました/);
      assert.equal(Number((await first.query("SELECT count(*)::int AS count FROM settlements WHERE workspace_id=$1::uuid", [f.workspaceId])).rows[0].count), 0);
    });
  } finally { await first.query("ROLLBACK"); await second.query("ROLLBACK"); report.cleanup = await f.cleanup(); report.seconds = (performance.now() - started) / 1000; }
  return report;
}

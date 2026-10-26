import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { merchantNormalizationCases, verifyMerchantNormalizationScenarios } from "../../scripts/qa/db/merchant-normalization-scenarios";

const directory = new URL("../../db/migrations/", import.meta.url);
const migrationName = "019_merchant_normalization.sql";
const migration = () => readFile(new URL(migrationName, directory), "utf8");

async function beforeMigration() {
  const sql = new PGlite({ extensions: { pgcrypto } });
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql") && name < "019").sort()) {
    await sql.exec(await readFile(new URL(name, directory), "utf8"));
  }
  await sql.exec(`INSERT INTO app_users(id,email,name,is_enabled,is_admin) VALUES
    ('test-user-a','test-a@cake.local','A',true,true),('test-user-b','test-b@cake.local','B',true,false)`);
  return sql;
}

test("取引先正規化のmigrationと全保存経路の実SQL", async t => {
  const sql = await beforeMigration(); t.after(() => sql.close());

  await t.test("019途中の失敗は生成列・関数・indexと既存行を一緒にrollbackする", async () => {
    const before = (await sql.query("SELECT count(*)::int AS n FROM transactions")).rows;
    await sql.exec("BEGIN");
    try {
      await sql.exec(await migration());
      await assert.rejects(sql.query("SELECT 1/0"), { code: "22012" });
    } finally { await sql.exec("ROLLBACK"); }
    assert.deepEqual((await sql.query("SELECT count(*)::int AS n FROM transactions")).rows, before);
    assert.equal((await sql.query<{ function: string | null }>("SELECT to_regprocedure('cake_normalize_merchant(text)') AS function")).rows[0].function, null);
    assert.equal((await sql.query<{ index: string | null }>("SELECT to_regclass('transactions_workspace_merchant_normalized_idx') AS index")).rows[0].index, null);
    assert.equal((await sql.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='transactions' AND column_name='merchant_normalized'")).rows[0].n, 0);
  });

  await t.test("019は既存全source・清算済み・カテゴリをbackfillし、全ての既存列と関連行を保持する", async () => {
    const workspace = randomUUID(), category = randomUUID();
    await sql.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1,'既存家計','SHARED','test-user-a')", [workspace]);
    await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'test-user-a','OWNER'),($1,'test-user-b','MEMBER')", [workspace]);
    await sql.query("INSERT INTO categories(id,workspace_id,name,color_hex,sort_order,created_by,updated_by) VALUES ($1,$2,'食費','#f97316',0,'test-user-a','test-user-a')", [category, workspace]);
    for (const [index, [merchant, expected]] of merchantNormalizationCases.entries()) {
      await sql.query(`INSERT INTO transactions(workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,
        expense_class,split_weights,external_id,source,created_by,updated_by,category_id,category_confirmed,memo,settled_at,created_at,updated_at)
        VALUES ($1,'2026-10-10T00:00:00.123456Z',$2,'現金',$3,100,'test-user-a','SHARED',
          '{"test-user-a":1,"test-user-b":1}',$4,$5,'test-user-a','test-user-a',$6,false,$7,$8,
          '2026-10-01T00:00:00.123456Z','2026-10-02T00:00:00.654321Z')`,
      [workspace, merchant, index % 2 ? "PAYMENT" : "RECEIPT", `legacy-${index}`, ["MANUAL", "PAYPAY", "RECURRING"][index % 3],
        index % 2 ? category : null, expected, index % 2 ? "2026-10-11T00:00:00.654321Z" : null]);
    }
    const snapshot = async (withNormalization: boolean) => {
      const tables = (await sql.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
      const output: Record<string, unknown> = {};
      for (const { tablename } of tables) {
        output[tablename] = (await sql.query<{ data: unknown }>(`SELECT COALESCE(jsonb_agg(${tablename === "transactions" && withNormalization
          ? "to_jsonb(t)-'merchant_normalized'" : "to_jsonb(t)"} ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM ${tablename} t`)).rows[0].data;
      }
      return output;
    };
    const before = await snapshot(false);
    await sql.exec(await migration());
    assert.deepEqual(await snapshot(true), before);
    const rows = (await sql.query<{ valid: boolean; n: number }>("SELECT bool_and(merchant_normalized=memo) AS valid,count(*)::int AS n FROM transactions")).rows;
    assert.deepEqual(rows, [{ valid: true, n: merchantNormalizationCases.length }]);
    const column = (await sql.query(`SELECT a.attgenerated,a.attnotnull,c.collname
      FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_collation c ON c.oid=a.attcollation WHERE n.nspname='public' AND t.relname='transactions' AND a.attname='merchant_normalized'`)).rows;
    assert.deepEqual(column, [{ attgenerated: "s", attnotnull: true, collname: "C" }]);
    const fn = (await sql.query("SELECT provolatile,proisstrict,proparallel FROM pg_proc WHERE oid='cake_normalize_merchant(text)'::regprocedure")).rows;
    assert.deepEqual(fn, [{ provolatile: "i", proisstrict: true, proparallel: "s" }]);
  });

  await t.test("取引先の正規化は全保存経路・旧版互換・最大2000件・完全一致・cleanupを保証する", async t => {
    // The migration/backfill assertions above use the historical 018 schema.
    // Current store SQL below must run against every subsequent migration.
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql") && name > migrationName).sort()) {
      await sql.exec(await readFile(new URL(name, directory), "utf8"));
    }
    const report = await verifyMerchantNormalizationScenarios(sql, {
      actorA: "test-user-a", actorB: "test-user-b", prefix: "verify-merchant-local",
      runCase: async (name, run) => {
        let failure: unknown;
        await t.test(name, async () => { try { await run(); } catch (error) { failure = error; throw error; } });
        if (failure) throw failure;
      },
    });
    assert.equal(report.success, true); assert.equal(report.cases.length, 7);
    assert.deepEqual(report.failures, []);
    assert.ok(report.cases.every(value => value.status === "passed"));
    assert.ok(Object.values(report.cleanup).every(value => value === 0));
    assert.deepEqual(report.sqlContract, { manual: 2, csv: 4, maximumCsvRows: 2000 });
  });

  await t.test("初期化・rollback・削除・残存照合の失敗でも意図した全IDと安全な結果を返す", async () => {
    let memberships = 0, rollbacks = 0;
    const secret = "private-business-row-postgresql://credentials-raw-sql";
    const fail = (code: string) => { throw Object.assign(new Error(secret), { code }); };
    const client = { query: async (statement: string, params?: unknown[]) => {
      if (statement.startsWith("INSERT INTO workspace_members") && ++memberships === 2) fail("23514");
      if (statement === "ROLLBACK" && ++rollbacks === 1) fail("08006");
      if (statement.startsWith("DELETE FROM workspaces")) fail("42501");
      if (statement.startsWith("SELECT count(*)::int AS n FROM transactions WHERE")) fail("08006");
      return sql.query<Record<string, unknown>>(statement, params);
    } };
    const report = await verifyMerchantNormalizationScenarios(client, {
      actorA: "test-user-a", actorB: "test-user-b", prefix: "verify-merchant-failure",
    });
    try {
      assert.equal(report.success, false); assert.equal(report.ownedWorkspaceIds.length, 3);
      assert.equal(new Set(report.ownedWorkspaceIds).size, 3); assert.deepEqual(report.cases, []);
      assert.deepEqual(report.cleanup, { workspaces: 1, workspace_members: 2, transactions: -1,
        import_batches: 0, categories: 0, recurring_payments: 0 });
      for (const [stage, code] of [["setup", "23514"], ["rollback", "08006"], ["cleanup-delete", "42501"], ["cleanup-count", "08006"]]) {
        assert.ok(report.failures.some(value => value.stage === stage && value.code === code));
      }
      assert.ok(report.failures.some(value => value.stage === "cleanup-residual" && value.table === "workspaces"));
      assert.ok(report.failures.some(value => value.stage === "cleanup-count" && value.table === "transactions"));
      assert.ok(!JSON.stringify(report).includes(secret));
      assert.ok(rollbacks >= 2, "終了時もrollbackを試みて独立した残存確認へ進む");
    } finally {
      await sql.query("DELETE FROM workspaces WHERE id=ANY($1::uuid[]) AND name='verify-merchant-failure' AND owner_user_id='test-user-a'", [report.ownedWorkspaceIds]);
    }
    assert.equal((await sql.query<{ n: number }>("SELECT count(*)::int AS n FROM workspaces WHERE id=ANY($1::uuid[])", [report.ownedWorkspaceIds])).rows[0].n, 0);
  });
});

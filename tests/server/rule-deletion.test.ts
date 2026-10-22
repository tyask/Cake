import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { verifyRuleDeletionScenarios } from "../../scripts/qa/db/rule-deletion-scenarios";

test("単件・複数の実削除SQL、認可、再採番、互換性、rollbackを一時PostgreSQLで検証する", async t => {
  const sql = new PGlite({ extensions: { pgcrypto } });
  t.after(() => sql.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) await sql.exec(await readFile(new URL(file, directory), "utf8"));
  await sql.exec("INSERT INTO app_users(id,email,name) VALUES ('rule-test','rule@example.test','A')");
  const report = await verifyRuleDeletionScenarios(sql, "rule-test", {
    prefix: "verify-rule-deletion-local",
    runCase: async (name, run) => {
      let failure: unknown;
      await t.test(name, async () => { try { await run(); } catch (error) { failure = error; throw error; } });
      if (failure) throw failure;
    },
  });
  assert.equal(report.cases.length, 11);
  await mkdir(".cake", { recursive: true });
  await writeFile(".cake/rule-deletion-local.json", JSON.stringify({ engine: "PGlite", ...report }, null, 2));
});

test("再採番中の制約違反では先行したDELETEとworkspace更新も取り消す", async t => {
  const sql = new PGlite({ extensions: { pgcrypto } });
  t.after(() => sql.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) await sql.exec(await readFile(new URL(file, directory), "utf8"));
  await sql.exec(`INSERT INTO app_users(id,email,name) VALUES ('rule-test','rule@example.test','A');
    INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ('00000000-0000-4000-8000-000000000001','rollback','SHARED','rule-test');
    INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ('00000000-0000-4000-8000-000000000001','rule-test','OWNER');
    INSERT INTO default_rules(id,workspace_id,merchant_contains,expense_class,sort_order,created_by) VALUES
      ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','削除対象','SHARED',0,'rule-test'),
      ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','再採番失敗','SHARED',1,'rule-test');
    ALTER TABLE default_rules ADD CONSTRAINT fixture_rank_failure CHECK (merchant_contains <> '再採番失敗' OR sort_order > 0);`);
  const snapshot = () => sql.query(`SELECT jsonb_build_object('workspace',(SELECT to_jsonb(w) FROM workspaces w),
    'rules',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM default_rules r)) AS snapshot`);
  const before = await snapshot();
  await assert.rejects(sql.query(`SELECT cake_delete_default_rules('00000000-0000-4000-8000-000000000001','rule-test',
    ARRAY['00000000-0000-4000-8000-000000000002'::uuid],true)`), /fixture_rank_failure/);
  assert.deepEqual((await snapshot()).rows, before.rows);
});

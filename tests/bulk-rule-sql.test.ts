import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { createBulkRuleFixture, verifyBulkRuleScenarios } from "../scripts/bulk-rule-scenarios";

test("一括ルール適用の実SQLと共通TS fixture、最大5000件、全件rollbackを比較する", async t => {
  const sql = new PGlite({ extensions: { pgcrypto } }); t.after(() => sql.close());
  const directory = new URL("../db/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter(n => n.endsWith(".sql")).sort()) await sql.exec(await readFile(new URL(file, directory), "utf8"));
  await sql.exec("INSERT INTO app_users(id,email,name) VALUES ('a','a@example.test','A'),('b','b@example.test','B')");
  const report = await verifyBulkRuleScenarios(sql, { prefix: "verify-bulk-rules-local", runCase: async (name, run) => {
    let failure: unknown; await t.test(name, async () => { try { await run(); } catch (error) { failure = error; throw error; } }); if (failure) throw failure;
  } });
  assert.ok(report.cases.length >= 15);
  await t.test("集合UPDATE中の制約違反でも全選択・workspace時刻をrollbackする", async () => {
    const fixture = await createBulkRuleFixture(sql, "verify-bulk-rules-constraint");
    try {
      await fixture.setRules([{ id: "r", merchantContains: "スーパー", expenseClass: "SHARED", enabled: true, sortOrder: 0, splitWeights: { a: 1, b: 3 } }]);
      const ids = await fixture.insert([{ merchant: "スーパー", actorUserId: "a" }, { merchant: "スーパー失敗", actorUserId: "b" }]);
      await sql.exec("ALTER TABLE transactions ADD CONSTRAINT fixture_bulk_failure CHECK (merchant <> 'スーパー失敗' OR split_weights = '{\"a\":1,\"b\":1}'::jsonb)");
      const before = await fixture.snapshot();
      await assert.rejects(fixture.apply(ids), /fixture_bulk_failure/);
      assert.deepEqual(await fixture.snapshot(), before);
      await sql.exec("ALTER TABLE transactions DROP CONSTRAINT fixture_bulk_failure");
    } finally { await fixture.cleanup(); }
  });
  await mkdir('.cake', { recursive: true }); await writeFile('.cake/bulk-rules-local.json', JSON.stringify({ engine: 'PGlite', ...report }, null, 2));
});

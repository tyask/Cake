import assert from "node:assert/strict";
import { createBulkRuleFixture, type BulkRuleDatabase, type BulkRuleResult } from "./bulk-rule-scenarios";
import { prepareDefaultRuleMatcher, transactionDefaults } from "../lib/expense-splits";
import { ruleMembers } from "../tests/fixtures/default-rule-cases";
import type { DefaultRule } from "../lib/types";

/** Only an isolated QA database with pg_stat_statements and the legacy fixture function. */
export async function benchmarkBulkRules(sql: BulkRuleDatabase) {
  const f = await createBulkRuleFixture(sql, "verify-bulk-rules-benchmark");
  const report = { conditions: { sizes: [100, 5000], rules: 100, samplesPerVariant: 5, transport: "local PostgreSQL session; one function SELECT per variant", reset: "Each call runs in a rolled-back transaction; VACUUM ANALYZE before each sample; alternating variant order; one warmup each" }, measurements: [] as Record<string, unknown>[], cleanup: {} as Record<string, number> };
  try {
    for (const size of report.conditions.sizes) {
      await f.reset();
      const rules: DefaultRule[] = Array.from({ length: 100 }, (_, i) => ({ id: String(i), merchantContains: `unused-${i}`, expenseClass: "SHARED", sortOrder: i, splitWeights: { a: 1, b: 3 }, enabled: true }));
      Object.assign(rules[0], { merchantContains: "スーパー", expenseClass: "PERSONAL", enabled: false });
      Object.assign(rules[1], { merchantContains: "スーパー" });
      Object.assign(rules[2], { merchantContains: "個人", expenseClass: "PERSONAL", splitWeights: null });
      Object.assign(rules[3], { merchantContains: "標準", splitWeights: null });
      const saved = await f.setRules(rules), match = prepareDefaultRuleMatcher(saved);
      const values = Array.from({ length: size }, (_, i) => ({ merchant: ["スーパー本店", "個人", "標準", "未一致"][i % 4], actorUserId: i % 2 ? "a" : "b" }));
      const ids = await f.insert(values), expected = new Map(ids.map((id, i) => [id, transactionDefaults(values[i].merchant, match, ruleMembers, values[i].actorUserId)]));
      for (const fn of ["fixture_legacy_bulk_transactions", "cake_bulk_transactions"]) {
        await sql.query("BEGIN"); try { await f.apply(ids, "APPLY_RULES", sql, "a", fn); } finally { await sql.query("ROLLBACK"); }
      }
      const samples: Record<string, unknown>[] = []; let baseline: BulkRuleResult | undefined;
      for (let iteration = 0; iteration < report.conditions.samplesPerVariant; iteration++) for (const fn of iteration % 2 ? ["cake_bulk_transactions", "fixture_legacy_bulk_transactions"] : ["fixture_legacy_bulk_transactions", "cake_bulk_transactions"]) {
        await sql.query("VACUUM (ANALYZE) transactions");
        await sql.query("VACUUM (ANALYZE) workspaces");
        await sql.query("SELECT pg_stat_statements_reset()");
        await sql.query("BEGIN");
        try {
          const start = performance.now(), result = await f.apply(ids, "APPLY_RULES", sql, "a", fn), wallMs = performance.now() - start;
          if (!baseline) baseline = result; else assert.deepEqual(result, baseline);
          for (const row of result.transactions!) { const e = expected.get(row.id)!; assert.equal(row.expenseClass, e.expenseClass); assert.deepEqual(row.splitWeights, e.splitWeights); }
          const stats = (await sql.query("SELECT query,calls,total_exec_time FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows;
          const normalized = stats.map(row => ({ text: String(row.query).replace(/\s+/g, " "), calls: Number(row.calls), ms: Number(row.total_exec_time) }));
          const top = normalized.find(r => r.text.startsWith(`SELECT ${fn}(`)); assert.ok(top); assert.equal(top.calls, 1);
          const allMemberAggregations = normalized.filter(r => /jsonb_object_agg\(user_id,/.test(r.text) && /FROM workspace_members WHERE workspace_id/.test(r.text)).reduce((n, r) => n + r.calls, 0);
          const memberAggregations = normalized.filter(r => /^SELECT jsonb_object_agg\(user_id, (?:CASE WHEN next_class|weight\))/.test(r.text)).reduce((n, r) => n + r.calls, 0);
          const transactionUpdates = normalized.filter(r => /^UPDATE transactions(?: t)? SET expense_class/.test(r.text)).reduce((n, r) => n + r.calls, 0);
          assert.equal(memberAggregations, fn === "cake_bulk_transactions" ? 1 : size);
          assert.equal(transactionUpdates, fn === "cake_bulk_transactions" ? 1 : size);
          samples.push({ variant: fn === "cake_bulk_transactions" ? "current" : "legacy004", iteration: iteration + 1, wallMs, dbExecutionMs: top.ms, memberAggregations, compatibilityTriggerAggregations: allMemberAggregations - memberAggregations, allMemberAggregations, transactionUpdates, functionSelects: top.calls });
        } finally { await sql.query("ROLLBACK"); }
      }
      const median = (variant: string) => (samples.filter(s => s.variant === variant).map(s => Number(s.dbExecutionMs)).sort((a, b) => a - b))[Math.floor(report.conditions.samplesPerVariant / 2)];
      const legacyMedianMs = median("legacy004"), currentMedianMs = median("current");
      report.measurements.push({ size, samples, resultsEqual: true, legacyMedianMs, currentMedianMs, reductionPercent: 100 * (legacyMedianMs - currentMedianMs) / legacyMedianMs });
    }
  } finally { report.cleanup = await f.cleanup(); }
  return report;
}

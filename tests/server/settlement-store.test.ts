import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neon, neonConfig } from "@neondatabase/serverless";
import { getBootstrap } from "../../lib/server/stores/repository";
import { verifySettlementScenarios } from "../../scripts/qa/db/settlement-scenarios";

test("清算専用storeの実SQL・競合rollback・処理量を一時PostgreSQLで検証する", async t => {
  const memory = new PGlite({ extensions: { pgcrypto } }); t.after(() => memory.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) await memory.exec(await readFile(new URL(name, directory), 'utf8'));
  await memory.exec("INSERT INTO app_users(id,email,name) VALUES ('test-user-a','test-a@cake.local','A'),('test-user-b','test-b@cake.local','B')");
  const fixtureUrl = "postgresql://fixture:fixture@mock.neon.tech/settlement_test";
  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  process.env.DATABASE_URL = fixtureUrl; process.env.DB_QUERY_LOG = "off";
  t.after(() => {
    neonConfig.fetchFunction = previous.fetch;
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
    if (previous.logging === undefined) delete process.env.DB_QUERY_LOG; else process.env.DB_QUERY_LOG = previous.logging;
  });
  const requests: { query: string; params: string[] }[] = [];
  function encode(result: Awaited<ReturnType<typeof memory.query>>) {
    return {
      fields: result.fields, rows: result.rows.map(row => result.fields.map(field => {
        const value = (row as Record<string, unknown>)[field.name];
        if (value == null) return null;
        if (field.dataTypeID === 16) return value ? 't' : 'f';
        if (field.dataTypeID === 3802 || field.dataTypeID === 114) return JSON.stringify(value);
        return value instanceof Date ? value.toISOString().replace('T', ' ').replace('Z', '+00') : String(value);
      }))
    };
  }
  neonConfig.fetchFunction = async (url: RequestInfo | URL, init: RequestInit) => {
    assert.ok(new URL(String(url)).hostname.endsWith('.neon.tech'));
    assert.equal(new Headers(init.headers).get('Neon-Connection-String'), fixtureUrl);
    const body = JSON.parse(String(init.body)) as { query: string; params: string[]; queries?: { query: string; params: string[] }[] };
    try {
      if (body.queries) {
        const results = await memory.transaction(async tx => {
          const results = []; for (const query of body.queries!) results.push(encode(await tx.query(query.query, query.params))); return results;
        });
        return new Response(JSON.stringify({ results }), { status: 200 });
      }
      requests.push(body);
      return new Response(JSON.stringify(encode(await memory.query(body.query, body.params))), { status: 200 });
    } catch (error) { return new Response(JSON.stringify({ message: (error as Error).message, code: (error as { code: string }).code }), { status: 400 }); }
  };
  const sql = neon(fixtureUrl), user = { id: 'test-user-a', email: 'test-a@cake.local', name: 'A', imageUrl: null };
  const baselineId = '00000000-0000-4000-8000-000000000099';
  await sql.transaction([
    sql`INSERT INTO workspaces(id,name,type,owner_user_id) VALUES (${baselineId}::uuid,'ベンチマーク基準','SHARED',${user.id})`,
    sql`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (${baselineId}::uuid,${user.id},'OWNER')`,
  ]);
  await getBootstrap(user, baselineId);
  const baseline = { ...requests.find(q => /WITH\s+my_workspaces AS/.test(q.query))!, workspaceId: baselineId };
  assert.ok(baseline.query); assert.doesNotMatch(baseline.query, /\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
  await mkdir('.cake', { recursive: true });
  await writeFile('.cake/settlement-baseline-query.json', JSON.stringify(baseline, null, 2));
  try {
    const report = await verifySettlementScenarios(sql, user, 'test-user-b', {
      prefix: `verify-settlement-local-${Date.now()}`, baseline,
      runCase: async (name, run) => {
        let failure: unknown;
        await t.test(name, async () => { try { await run(); } catch (error) { failure = error; throw error; } });
        if (failure) throw failure;
      },
    });
    assert.equal(report.measurements.length, 2);
    const large = report.measurements[1] as { read: { legacy: { jsonBytes: number }; current: { jsonBytes: number } } };
    assert.ok(large.read.current.jsonBytes < large.read.legacy.jsonBytes / 2);
    await writeFile('.cake/settlement-db-local.json', JSON.stringify({ engine: 'PGlite', ...report }, null, 2));
  } finally { await sql`DELETE FROM workspaces WHERE id=${baselineId}::uuid`; }
});

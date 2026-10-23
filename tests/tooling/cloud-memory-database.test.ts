import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { neon, neonConfig, types } from "@neondatabase/serverless";
import { cloudMemoryDatabase } from "../../lib/server/database/cloud-memory";
import {
  CLOUD_DATABASE_CONNECTION_STRING, MAX_MEMORY_DATABASE_BODY_BYTES, startMemoryDatabase,
} from "../../scripts/cloud/memory-database";

test("CloudメモリDBはVercel環境では初期化を開始しない", async () => {
  for (const environment of [{ VERCEL: "1" }, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "production" }, { VERCEL: "" }]) {
    await assert.rejects(startMemoryDatabase(environment), /Vercel環境/);
  }
});

test("Cloudの単一PGlite DBは実Neon HTTP clientとmigration・seed・型・Transactionを共有する", async t => {
  const memory = await startMemoryDatabase({});
  t.after(() => memory.close());
  assert.equal(memory.connectionString, CLOUD_DATABASE_CONNECTION_STRING);
  const url = new URL(memory.url);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(Number(url.port) > 0);
  assert.match(url.pathname, /^\/sql\/[a-f0-9]{48}$/);
  const previous = { endpoint: neonConfig.fetchEndpoint, fetch: neonConfig.fetchFunction };
  t.after(() => { neonConfig.fetchEndpoint = previous.endpoint; neonConfig.fetchFunction = previous.fetch; });
  const sql = cloudMemoryDatabase({
    CAKE_CLOUD_MODE: "memory", NODE_ENV: "development", AUTH_MODE: "test",
    DATABASE_URL: memory.connectionString, CAKE_MEMORY_DATABASE_URL: memory.url,
  });
  assert.ok(sql);
  const headers = { "Content-Type": "application/json", "Neon-Connection-String": memory.connectionString };

  await t.test("全migrationを適用し、本番bootstrapなしでA/Bと共有サンプルを初期化する", async () => {
    const names = (await readdir(new URL("../../db/migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort();
    assert.deepEqual((await sql`SELECT name FROM schema_migrations ORDER BY name`).map(row => row.name), names);
    assert.deepEqual(await sql`SELECT id,is_admin,is_enabled FROM app_users ORDER BY id`, [
      { id: "test-user-a", is_admin: false, is_enabled: true },
      { id: "test-user-b", is_admin: false, is_enabled: true },
    ]);
    assert.deepEqual(await sql`SELECT (SELECT count(*)::int FROM workspaces) AS workspaces,
      (SELECT count(*)::int FROM workspace_members) AS members,
      (SELECT count(*)::int FROM categories) AS categories,
      (SELECT count(*)::int FROM transactions) AS transactions,
      to_regclass('cake_preview_database_identity')::text AS preview_marker`, [
      { workspaces: 1, members: 2, categories: 10, transactions: 8, preview_marker: null },
    ]);
    assert.deepEqual(await sql`SELECT cake_normalize_merchant('　ＡＢＣ  食品　') AS merchant`, [{ merchant: "abc 食品" }]);
  });

  await t.test("Postgres textの配列・JSON・真偽値・日時・数値・byteaを二重変換しない", async () => {
    const timestamp = "2026-10-23T01:02:03.123456Z";
    const result = await sql`SELECT ${true}::boolean AS enabled, ${JSON.stringify({ nested: [true, null, "日本語"] })}::jsonb AS document,
      ${["a,b", 'a"b', "日本語", null]}::text[] AS names, ${timestamp}::timestamptz AS moment,
      ${"9007199254740993.125"}::numeric AS amount, NULL::text AS absent, ${Buffer.from([0, 255, 127])}::bytea AS bytes`;
    assert.deepEqual(result, [{
      enabled: true, document: { nested: [true, null, "日本語"] }, names: ["a,b", 'a"b', "日本語", null],
      moment: new Date(timestamp), amount: "9007199254740993.125", absent: null, bytes: Buffer.from([0, 255, 127]),
    }]);
    const rawTimestamp = await sql.query("SELECT $1::timestamptz AS moment", [timestamp], {
      types: { getTypeParser: oid => oid === 1184 ? (value: string) => value : types.getTypeParser(oid) },
    });
    assert.match(rawTimestamp[0].moment, /01:02:03\.123456/);
    const array = await sql.query("SELECT 42::int AS amount, true AS enabled", [], { arrayMode: true, fullResults: true });
    assert.deepEqual(array.rows, [[42, true]]);
    assert.equal(array.rowCount, 1);
    assert.equal(array.command, "SELECT");
  });

  await t.test("失敗batchは全体rollbackし、並行queryと他batchを巻き込まない", async () => {
    await sql`CREATE TABLE cloud_transaction_test (id text PRIMARY KEY)`;
    const batches = Array.from({ length: 6 }, (_, index) => sql.transaction([
      sql`INSERT INTO cloud_transaction_test(id) VALUES (${`batch-${index}`})`,
      sql`SELECT pg_sleep(0.005)`,
      index % 2 === 0 ? sql`INSERT INTO cloud_transaction_test(id) VALUES (${`batch-${index}`})` : sql`SELECT 1`,
    ]));
    const standalone = neon(memory.connectionString)`INSERT INTO cloud_transaction_test(id) VALUES ('single')`;
    const results = await Promise.allSettled([...batches, standalone]);
    assert.deepEqual(results.map(result => result.status), ["rejected", "fulfilled", "rejected", "fulfilled", "rejected", "fulfilled", "fulfilled"]);
    for (const result of results.filter(result => result.status === "rejected")) assert.equal(result.reason.code, "23505");
    assert.deepEqual(await sql`SELECT id FROM cloud_transaction_test ORDER BY id`, [
      { id: "batch-1" }, { id: "batch-3" }, { id: "batch-5" }, { id: "single" },
    ]);
    const readOnly = await sql.transaction([sql`SELECT count(*)::int AS count FROM cloud_transaction_test`], {
      isolationLevel: "Serializable", readOnly: true, deferrable: true,
    });
    assert.deepEqual(readOnly, [[{ count: 4 }]]);
    await assert.rejects(sql.transaction([sql`INSERT INTO cloud_transaction_test(id) VALUES ('read-only')`], { readOnly: true }), { code: "25006" });
  });

  await t.test("SQLエラー本文・入力データは応答へ露出せずSQLSTATEを維持する", async () => {
    const sentinel = "private_business_value_must_not_appear";
    const response = await fetch(memory.url, { method: "POST", headers, body: JSON.stringify({ query: `SELECT ${sentinel}`, params: [] }) });
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.doesNotMatch(body, new RegExp(sentinel));
    assert.deepEqual(JSON.parse(body), { message: "Cake memory database query failed.", code: "42703" });
    assert.deepEqual(await sql`SELECT 1::int AS available`, [{ available: 1 }]);
  });

  await t.test("能力URL・接続identity・Origin・JSON型とbody上限を検査する", async () => {
    const body = JSON.stringify({ query: "SELECT 1", params: [] });
    const cases: { url?: string; method?: string; headers?: Record<string, string>; body?: string; status: number }[] = [
      { url: `${url.origin}/sql`, status: 404 },
      { method: "GET", status: 405 },
      { headers: { ...headers, Origin: "http://localhost:3000" }, status: 403 },
      { headers: { ...headers, "Neon-Connection-String": "postgresql://external/forbidden" }, status: 403 },
      { headers: { ...headers, "Content-Type": "text/plain" }, status: 415 },
      { body: "{invalid-json", status: 400 },
      { body: JSON.stringify({ query: "SELECT $1", params: [{ private: "value" }] }), status: 400 },
      { body: JSON.stringify({ queries: [] }), status: 400 },
      { body: JSON.stringify({ query: "SELECT 1", params: [], padding: "x".repeat(MAX_MEMORY_DATABASE_BODY_BYTES) }), status: 413 },
    ];
    for (const entry of cases) {
      const response = await fetch(entry.url ?? memory.url, {
        method: entry.method ?? "POST", headers: entry.headers ?? headers,
        ...(entry.method === "GET" ? {} : { body: entry.body ?? body }),
      });
      assert.equal(response.status, entry.status);
      await response.arrayBuffer();
    }
    const streamingStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(memory.url, { method: "POST", headers }, response => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      });
      request.on("error", reject);
      const chunk = Buffer.alloc(1024 * 1024, "x");
      for (let index = 0; index <= MAX_MEMORY_DATABASE_BODY_BYTES / chunk.length; index++) request.write(chunk);
      request.end();
    });
    assert.equal(streamingStatus, 413);
    assert.deepEqual(await sql`SELECT 1::int AS available`, [{ available: 1 }]);
  });

  await t.test("停止は冪等で、次回起動は業務更新を持ち越さない", async () => {
    await sql`UPDATE workspaces SET name='previous-run-business-data'`;
    await Promise.all([memory.close(), memory.close()]);
    const next = await startMemoryDatabase({});
    t.after(() => next.close());
    assert.notEqual(next.url, memory.url);
    const sql2 = cloudMemoryDatabase({
      CAKE_CLOUD_MODE: "memory", NODE_ENV: "development", AUTH_MODE: "test",
      DATABASE_URL: next.connectionString, CAKE_MEMORY_DATABASE_URL: next.url,
    });
    assert.ok(sql2);
    assert.deepEqual(await sql2`SELECT name FROM workspaces`, [{ name: "テスト共有家計" }]);
    assert.deepEqual(await sql2`SELECT to_regclass('cloud_transaction_test')::text AS previous_run`, [{ previous_run: null }]);
  });
});

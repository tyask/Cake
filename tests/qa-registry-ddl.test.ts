import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { neon, neonConfig, type NeonQueryFunction, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { applyRegistryDdl, registryDdlStatements, splitSqlStatements } from "../scripts/qa-registry-ddl";
import { NeonQaRegistryStore } from "../scripts/qa-registry-store";

const ddl = () => readFileSync(new URL("../db/qa-registry/001_registry.sql", import.meta.url), "utf8");
type BatchClient = Pick<NeonQueryFunction<false, false>, "transaction">;

/** Offline model of Neon's lazy query builder and single atomic HTTP batch. */
function batchClient(run: (batch: { statement: string; parameters: unknown[] }[]) => Promise<void>): BatchClient {
  return {
    transaction: async (build: (transaction: NeonQueryFunctionInTransaction<false, false>) => NeonQueryInTransaction[]) => {
      const batch: { statement: string; parameters: unknown[] }[] = [];
      const queryBuilder = {
        query: (statement: string, parameters: unknown[]) => {
          batch.push({ statement, parameters });
          return { queryData: { query: statement, params: parameters } };
        },
      } as unknown as NeonQueryFunctionInTransaction<false, false>;
      const queries = build(queryBuilder);
      assert.equal(queries.length, batch.length);
      await run(batch);
      return batch.map(() => []);
    },
  } as unknown as BatchClient;
}

test("PostgreSQL statement splitting preserves dollars, literals, identifiers and nested comments", () => {
  const source = `-- leading ;
SELECT 'semi;colon', 'it''s;fine', E'escaped\\\';still string', "quoted;""name";
/* outer ; /* nested ; */ still outer */
DO $body_1$ BEGIN PERFORM ';'; -- internal ;
  PERFORM $$a;different delimiter$$; END; $body_1$;
SELECT $$literal; -- /* $$; -- trailing ;`;
  const parsed = splitSqlStatements(source);
  assert.equal(parsed.length, 3);
  assert.ok(parsed[0].includes("'semi;colon'"));
  assert.ok(parsed[0].includes("E'escaped\\\';still string'"));
  assert.ok(parsed[1].includes("/* outer ; /* nested ; */ still outer */"));
  assert.ok(parsed[1].includes("PERFORM $$a;different delimiter$$; END; $body_1$;"));
  assert.equal(parsed[2], "SELECT $$literal; -- /* $$;");
  assert.deepEqual(splitSqlStatements("-- comment only\n/* nested /* ; */ */"), []);
});

test("only the outer repository transaction wrapper is removed", () => {
  assert.deepEqual(registryDdlStatements("/* first */ BEGIN; SELECT 'COMMIT;'; -- before end\nCOMMIT;"), ["SELECT 'COMMIT;';"]);
  for (const source of [
    "SELECT 1;", "BEGIN; COMMIT;", "BEGIN; SELECT 1;", "BEGIN; SELECT 1; ROLLBACK;",
    "BEGIN; BEGIN; SELECT 1; COMMIT;", "BEGIN; SAVEPOINT test; COMMIT;",
    "BEGIN; SET TRANSACTION READ ONLY; COMMIT;", "START TRANSACTION; SELECT 1; COMMIT;",
    "BEGIN; SELECT 1; COMMIT; SELECT 2;",
  ]) assert.throws(() => registryDdlStatements(source), /DDL is incomplete|transaction boundaries/);
});

test("unfinished quotes, dollar blocks, comments or statements fail before any batch executes", async () => {
  let batches = 0;
  const client = batchClient(async () => { batches++; });
  for (const source of [
    "BEGIN; SELECT 'unfinished; COMMIT;", 'BEGIN; SELECT "unfinished; COMMIT;',
    "BEGIN; DO $x$ BEGIN; END; COMMIT;", "BEGIN; SELECT 1; /* unfinished COMMIT;",
    "BEGIN; SELECT 1; /* /* nested */ COMMIT;", "BEGIN; SELECT 1; COMMIT",
    "BEGIN; SELECT E'unfinished\\'; COMMIT;",
  ]) await assert.rejects(applyRegistryDdl(client, source), /DDL is incomplete|transaction boundaries/);
  assert.equal(batches, 0);
});

test("repository DDL uses one transaction with one query per complete top-level statement", async () => {
  const expected = registryDdlStatements(ddl());
  let batches = 0;
  await applyRegistryDdl(batchClient(async batch => {
    batches++;
    assert.deepEqual(batch.map(query => query.statement), expected);
    assert.equal(batch.every(query => query.parameters.length === 0), true);
  }), ddl());
  assert.equal(batches, 1);
  assert.ok(expected.length > 15);
  assert.equal(expected.filter(statement => /^CREATE FUNCTION/.test(statement)).length, 3);
  assert.equal(expected.some(statement => /^BEGIN\s*;|^COMMIT\s*;/.test(statement)), false);
  assert.ok(expected.find(statement => statement.startsWith("DO $registry_empty$"))?.includes("END;\n$registry_empty$;"));
});

test("the real Neon HTTP driver sends separate DDL queries in exactly one batch request", async () => {
  const originalFetch = neonConfig.fetchFunction;
  const expected = registryDdlStatements(ddl());
  let requests = 0;
  try {
    // Synthetic credentials only; the replacement handles every request locally.
    neonConfig.fetchFunction = async (_request: unknown, options: RequestInit) => {
      requests++;
      assert.equal(options.method, "POST");
      assert.equal(typeof options.body, "string");
      const body = JSON.parse(options.body as string) as { queries: { query: string; params: unknown[] }[]; query?: string };
      assert.equal(body.query, undefined, "A full-DDL single prepared query is unsupported");
      assert.deepEqual(body.queries.map(query => query.query), expected);
      assert.equal(body.queries.every(query => query.params.length === 0), true);
      return new Response(JSON.stringify({ results: body.queries.map(() => ({ fields: [], rows: [], rowCount: 0 })) }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
    await applyRegistryDdl(neon("postgresql://mock-user:mock-password@ep-synthetic.us-east-1.aws.neon.tech/registry_test"), ddl());
    assert.equal(requests, 1);
  } finally { neonConfig.fetchFunction = originalFetch; }
});

test("batch failures expose only a fixed diagnostic without DB errors or connection information", async () => {
  const client = batchClient(async () => { throw new Error("private postgresql://user:password@host/database SELECT private data"); });
  await assert.rejects(applyRegistryDdl(client, "BEGIN; SELECT 1; COMMIT;"), (error: unknown) => {
    assert.match(String(error), /transaction failed/);
    assert.doesNotMatch(String(error), /postgresql|password|SELECT|private data/);
    return true;
  });
});

const pgliteModule = process.env.CAKE_LOCAL_PGLITE_MODULE;
const loadPGlite = () => pgliteModule ? import(pathToFileURL(pgliteModule).href) : import("@electric-sql/pglite");
type MemoryDatabase = {
  exec: (statement: string) => Promise<unknown>;
  query: (statement: string, parameters?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  close: () => Promise<void>;
};
function memoryBatch(db: MemoryDatabase): BatchClient {
  return batchClient(async batch => {
    await db.exec("BEGIN");
    try {
      for (const query of batch) await db.query(query.statement, query.parameters);
      await db.exec("COMMIT");
    } catch (error) { await db.exec("ROLLBACK"); throw error; }
  });
}

test("real repository statements initialize all three slots through an atomic memory SQL batch", async () => {
  const { PGlite } = await loadPGlite();
  const db = new PGlite() as MemoryDatabase;
  try {
    await applyRegistryDdl(memoryBatch(db), ddl());
    const store = new NeonQaRegistryStore(async (statement, parameters) => (await db.query(statement, parameters)).rows);
    assert.deepEqual((await store.read()).slots, { qa1: null, qa2: null, qa3: null });
    assert.equal((await db.query("SELECT count(*)::int AS count FROM cake_qa_registry.identity")).rows[0].count, 1);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM cake_qa_registry.requests")).rows[0].count, 0);
    const before = await store.read();
    const identityBefore = (await db.query("SELECT * FROM cake_qa_registry.identity")).rows;
    await assert.rejects(applyRegistryDdl(memoryBatch(db), ddl()), /transaction failed/);
    assert.deepEqual(await store.read(), before);
    assert.deepEqual((await db.query("SELECT * FROM cake_qa_registry.identity")).rows, identityBefore);
  } finally { await db.close(); }
});

test("a mid-batch SQL failure rolls back earlier DDL and preserves existing data", async () => {
  const { PGlite } = await loadPGlite();
  const db = new PGlite() as MemoryDatabase;
  try {
    await db.exec("CREATE TABLE preserved (id integer PRIMARY KEY); INSERT INTO preserved VALUES (1)");
    await assert.rejects(applyRegistryDdl(memoryBatch(db), `BEGIN;
      CREATE SCHEMA partial_registry;
      CREATE TABLE partial_registry.created (id integer);
      INSERT INTO preserved VALUES (2);
      SELECT unknown_column FROM preserved;
      COMMIT;`), /transaction failed/);
    assert.equal((await db.query("SELECT to_regnamespace('partial_registry') IS NULL AS absent")).rows[0].absent, true);
    assert.deepEqual((await db.query("SELECT * FROM preserved ORDER BY id")).rows, [{ id: 1 }]);
  } finally { await db.close(); }
});

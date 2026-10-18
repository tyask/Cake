import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupDatabase } from "./setup-db.mjs";

export type MigrationDatabase = { query(statement: string): Promise<{ rows: Record<string, unknown>[] }> };
type RunCase = (name: string, run: () => Promise<void>) => Promise<void>;
const environment = { DATABASE_URL: "isolated-migration-fixture" };
const files = ["001_create.sql", "002_second.sql", "003_third.sql"];

/** Caller must supply a new, isolated database; never a configured app DB. */
export async function createMigrationFixture(sql: MigrationDatabase, slow = false) {
  assert.equal((await sql.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')")).rows[0].count, 0);
  const directory = await mkdtemp(join(tmpdir(), "cake-migration-fixture-"));
  const contents: Record<string, string> = {
    [files[0]]: `${slow ? "PERFORM pg_sleep(0.3);" : ""} CREATE TABLE verify_migration_events (id integer PRIMARY KEY); INSERT INTO verify_migration_events VALUES (1);`,
    [files[1]]: "INSERT INTO verify_migration_events VALUES (2);",
    [files[2]]: "INSERT INTO verify_migration_events VALUES (3);",
  };
  try { for (const name of [...files].reverse()) await writeFile(join(directory, name), contents[name]); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  async function run(client = sql, afterHistory?: () => Promise<void>) {
    const reads: string[] = [], queries: string[] = [];
    await setupDatabase(environment, {
      migrationDirectory: directory,
      readMigration: async name => { reads.push(name); return readFile(join(directory, name), "utf8"); },
      connect: () => ({ query: async statement => {
        queries.push(statement); const result = await client.query(statement);
        if (statement.startsWith("SELECT name FROM schema_migrations")) await afterHistory?.();
        return result;
      } }),
    });
    return { reads, queries: queries.length };
  }
  async function snapshot() {
    return { events: (await sql.query("SELECT id FROM verify_migration_events ORDER BY id")).rows,
      ledger: (await sql.query("SELECT name,applied_at::text AS applied_at FROM schema_migrations ORDER BY name")).rows };
  }
  async function cleanup() {
    try {
      await sql.query("DROP TABLE IF EXISTS verify_migration_events");
      await sql.query("DROP TABLE IF EXISTS schema_migrations");
      assert.equal((await sql.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('verify_migration_events','schema_migrations')")).rows[0].count, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
    return { fixtureTables: 0, temporaryDirectoryRemoved: true };
  }
  return { directory, files, run, snapshot, cleanup };
}

export async function verifyMigrationScenarios(sql: MigrationDatabase, runCase?: RunCase) {
  const started = performance.now(), f = await createMigrationFixture(sql);
  const report = { cases: [] as { name: string; reads?: string[]; queries?: number }[], cleanup: {} as Record<string, number | boolean>, seconds: 0 };
  async function check(name: string, run: () => Promise<{ reads?: string[]; queries?: number } | void>) {
    let counts: { reads?: string[]; queries?: number } | void;
    const invoke = async () => { counts = await run(); };
    if (runCase) await runCase(name, invoke); else await invoke();
    report.cases.push({ name, ...counts! });
  }
  try {
    await check("空DBでは全ファイルを番号順で読み、SQLと適用履歴を登録する", async () => {
      const counts = await f.run(); assert.deepEqual(counts, { reads: f.files, queries: 5 });
      assert.deepEqual((await f.snapshot()).events, [{ id: 1 }, { id: 2 }, { id: 3 }]); return counts;
    });
    await check("全適用済みなら本文0読込・2往復で、業務行と履歴時刻を保持する", async () => {
      const before = await f.snapshot(), counts = await f.run();
      assert.deepEqual(counts, { reads: [], queries: 2 }); assert.deepEqual(await f.snapshot(), before); return counts;
    });
    await check("一部適用済みなら追加した未適用ファイルだけを読み、実行する", async () => {
      await writeFile(join(f.directory, "004_next.sql"), "INSERT INTO verify_migration_events VALUES (4);");
      const counts = await f.run(); assert.deepEqual(counts, { reads: ["004_next.sql"], queries: 3 });
      assert.deepEqual((await f.snapshot()).events, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]); return counts;
    });
    await check("migration途中の失敗はそのSQLと台帳を共にrollbackする", async () => {
      await writeFile(join(f.directory, "005_failure.sql"), "INSERT INTO verify_migration_events VALUES (5); PERFORM 1/0;");
      const before = await f.snapshot(); await assert.rejects(f.run(), /division by zero/); assert.deepEqual(await f.snapshot(), before);
    });
    await check("失敗後の再実行は未記録のmigrationだけを適用する", async () => {
      await writeFile(join(f.directory, "005_failure.sql"), "INSERT INTO verify_migration_events VALUES (5);");
      const counts = await f.run(); assert.deepEqual(counts, { reads: ["005_failure.sql"], queries: 3 });
      assert.equal((await f.snapshot()).ledger.length, 5); return counts;
    });
    await check("後ろの未適用ファイルが不正でも先の未適用SQLを実行しない", async () => {
      await sql.query("DELETE FROM schema_migrations WHERE name='005_failure.sql'");
      await sql.query("DELETE FROM verify_migration_events WHERE id=5");
      await writeFile(join(f.directory, "006_invalid.sql"), "DO $cake_migration$ BEGIN END; $cake_migration$;");
      const before = await f.snapshot(); await assert.rejects(f.run(), /SQL区切りが不正/); assert.deepEqual(await f.snapshot(), before);
    });
  } finally { report.cleanup = await f.cleanup(); report.seconds = (performance.now() - started) / 1000; }
  return report;
}

/** Use independent real PostgreSQL sessions plus a third observer connection. */
export async function verifyConcurrentMigrations(first: MigrationDatabase, second: MigrationDatabase, observer: MigrationDatabase) {
  const f = await createMigrationFixture(first, true);
  const pids = [first, second].map(async client => Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
  const [firstPid, secondPid] = await Promise.all(pids); assert.notEqual(firstPid, secondPid);
  let histories = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const afterHistory = async () => { if (++histories === 2) release(); await barrier; };
  let lockWaitObserved = false;
  const pending = Promise.allSettled([f.run(first, afterHistory), f.run(second, afterHistory)]);
  try {
    const deadline = performance.now() + 10_000;
    do {
      const row = (await observer.query(`SELECT ${firstPid}=ANY(pg_blocking_pids(${secondPid})) OR ${secondPid}=ANY(pg_blocking_pids(${firstPid})) AS blocked`)).rows[0];
      lockWaitObserved ||= row.blocked === true;
      if (!lockWaitObserved) await new Promise(resolve => setTimeout(resolve, 20));
    } while (!lockWaitObserved && performance.now() < deadline);
    release(); const results = await pending;
    for (const result of results) { if (result.status === "rejected") throw result.reason; assert.deepEqual(result.value, { reads: f.files, queries: 5 }); }
    assert.equal(histories, 2); assert.ok(lockWaitObserved);
    const saved = await f.snapshot(); assert.deepEqual(saved.events, [{ id: 1 }, { id: 2 }, { id: 3 }]); assert.equal(saved.ledger.length, 3);
    return { historiesBeforeApply: histories, lockWaitObserved, events: saved.events.length, ledgerRows: saved.ledger.length };
  } finally { release(); await pending; await f.cleanup(); }
}

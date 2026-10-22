import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Connected, independent pg sessions; the caller validates and closes the dedicated Preview DB. */
export type MerchantMigrationDatabase = {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
type Cleanup = { schemas: number; tables: number; functions: number; indexes: number };
type Stage = "preflight" | "setup" | "migration" | "backfill" | "wait" | "update" | "rollback" | "cleanup" | "restore";
type Failure = { stage: Stage; sqlstate: string | null };
type Options = { prefix: string; observeTimeoutMs?: number; lockTimeoutMs?: number; statementTimeoutMs?: number };
export type MerchantNormalizationMigrationReport = {
  success: boolean;
  cases: { name: string; seconds: number }[];
  backendPids: number[];
  wait: { observed: boolean; seconds: number; accessExclusiveLock: boolean };
  cleanup: Cleanup | null;
  sessionSettingsRestored: boolean;
  failures: Failure[];
  seconds: number;
};
const emptyCleanup = (): Cleanup => ({ schemas: 0, tables: 0, functions: 0, indexes: 0 });
const sqlstate = (error: unknown): string | null => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
};
const settle = (operation: Promise<unknown>) => operation.then(() => ({ ok: true as const }),
  error => ({ ok: false as const, sqlstate: sqlstate(error) }));

/**
 * Shared single-session fixture for PGlite and real PostgreSQL. The random schema is
 * created here, never supplied by a caller; cleanup also verifies its OID and owner.
 * The supplied migration must be the reviewed, unqualified 019 SQL from this checkout.
 */
export function createMerchantNormalizationMigrationFixture(sql: MerchantMigrationDatabase, options: { prefix: string }) {
  assert.match(options.prefix, /^verify-merchant-[a-z0-9-]{1,40}$/);
  const suffix = options.prefix.slice("verify-merchant-".length).replaceAll("-", "_").slice(0, 15);
  const schema = `qa_merchant_${suffix}_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^qa_merchant_[a-z0-9_]{1,15}_[a-f0-9]{32}$/);
  const table = `"${schema}".transactions`;
  const ids: string[] = [randomUUID(), randomUUID(), randomUUID()], workspace = randomUUID();
  const values = [["  ＡＢＣ\t スーパー  ", "abc スーパー"], ["Cafe\u0301 ＣＡＦÉ", "café café"], ["㈱ＡＢＣ　東京１-２", "(株)abc 東京1-2"]];
  const updatedMerchant = "  ＢＢＢ\u3000大阪店  ", updatedNormalized = "bbb 大阪店";
  let active = false, created = false, ownedOid: number | undefined, owner: string | undefined;
  let before: Record<string, unknown>[] | undefined;
  async function begin() { active = true; await sql.query("BEGIN ISOLATION LEVEL READ COMMITTED"); }
  async function commit() { await sql.query("COMMIT"); active = false; }
  async function rollback() { if (active) { await sql.query("ROLLBACK"); active = false; } }
  const snapshot = async () => (await sql.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY id`)).rows
    .map(row => row.data as Record<string, unknown>);
  async function setup() {
    assert.equal(ownedOid, undefined);
    await begin();
    try {
      await sql.query(`CREATE SCHEMA "${schema}" AUTHORIZATION CURRENT_USER`);
      created = true;
      const identity = (await sql.query("SELECT oid::int AS oid,pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1", [schema])).rows[0];
      ownedOid = Number(identity.oid); owner = String(identity.owner);
      assert.ok(Number.isInteger(ownedOid) && ownedOid > 0);
      await sql.query(`CREATE TABLE ${table} (
        id uuid PRIMARY KEY,workspace_id uuid NOT NULL,merchant text NOT NULL,
        amount_yen integer NOT NULL,category_id uuid,category_confirmed boolean NOT NULL,
        category_revision integer NOT NULL,memo text NOT NULL,settled_at timestamptz,
        created_by text NOT NULL,updated_by text NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL
      )`);
      for (const [index, [merchant]] of values.entries()) await sql.query(`INSERT INTO ${table}
        VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,$8,$9::timestamptz,
          'fixture-a','fixture-b','2026-10-01T00:00:00.123456Z','2026-10-02T00:00:00.654321Z')`,
      [ids[index], workspace, merchant, 1200 + index, index === 0 ? null : randomUUID(), index !== 0, 7 + index,
        `migration-fixture-${index}`, index === 2 ? "2026-10-03T00:00:00.987654Z" : null]);
      before = await snapshot();
      assert.equal(before.length, values.length);
      await commit();
    } catch (error) { await rollback(); throw error; }
  }
  async function beginMigration(migrationSql: string) {
    assert.ok(before && !active);
    assert.ok(migrationSql.trim());
    await begin();
    await sql.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
    await sql.query(migrationSql);
  }
  async function verifyBackfill() {
    assert.ok(before);
    const rows = await snapshot();
    assert.deepEqual(rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "merchant_normalized"))), before);
    for (const [index, id] of ids.entries()) assert.equal(rows.find(row => row.id === id)?.merchant_normalized, values[index][1]);
    const column = (await sql.query(`SELECT a.attgenerated,a.attnotnull,c.collname
      FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_collation c ON c.oid=a.attcollation
      WHERE n.nspname=$1 AND t.relname='transactions' AND a.attname='merchant_normalized' AND NOT a.attisdropped`, [schema])).rows;
    assert.deepEqual(column, [{ attgenerated: "s", attnotnull: true, collname: "C" }]);
    const functions = (await sql.query(`SELECT p.provolatile,p.proisstrict,p.proparallel FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.proname='cake_normalize_merchant' AND p.proargtypes='25'::oidvector`, [schema])).rows;
    assert.deepEqual(functions, [{ provolatile: "i", proisstrict: true, proparallel: "s" }]);
    const indexes = (await sql.query(`SELECT i.indisvalid,i.indisready,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ordinality) AS columns
      FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_namespace n ON n.oid=x.relnamespace
      WHERE n.nspname=$1 AND x.relname='transactions_workspace_merchant_normalized_idx'`, [schema])).rows;
    assert.deepEqual(indexes, [{ indisvalid: true, indisready: true, columns: ["workspace_id", "merchant_normalized"] }]);
  }
  async function verifyRolledBack() {
    assert.ok(before && !active);
    assert.deepEqual(await snapshot(), before);
    const objects = (await sql.query(`SELECT
      (SELECT count(*)::int FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname=$1 AND t.relname='transactions' AND a.attname='merchant_normalized' AND NOT a.attisdropped) AS columns,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$1 AND p.proname='cake_normalize_merchant') AS functions,
      (SELECT count(*)::int FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace
        WHERE n.nspname=$1 AND x.relname='transactions_workspace_merchant_normalized_idx') AS indexes`, [schema])).rows;
    assert.deepEqual(objects, [{ columns: 0, functions: 0, indexes: 0 }]);
  }
  async function update(client: MerchantMigrationDatabase) {
    assert.equal((await client.query(`UPDATE ${table} SET merchant=$1 WHERE id=$2::uuid RETURNING id`, [updatedMerchant, ids[0]])).rows.length, 1);
  }
  async function verifyUpdated() {
    assert.ok(before);
    const expected = before.map(row => ({ ...row, merchant: row.id === ids[0] ? updatedMerchant : row.merchant,
      merchant_normalized: row.id === ids[0] ? updatedNormalized : values[ids.indexOf(String(row.id))][1] }));
    assert.deepEqual(await snapshot(), expected);
  }
  async function remaining(): Promise<Cleanup> {
    if (!created) return emptyCleanup();
    return (await sql.query(`WITH owned AS (SELECT oid FROM pg_namespace WHERE nspname=$1 OR oid=$2::oid)
      SELECT (SELECT count(*)::int FROM owned) AS schemas,
      (SELECT count(*)::int FROM pg_class WHERE relnamespace IN (SELECT oid FROM owned) AND relkind IN ('r','p')) AS tables,
      (SELECT count(*)::int FROM pg_proc WHERE pronamespace IN (SELECT oid FROM owned)) AS functions,
      (SELECT count(*)::int FROM pg_class WHERE relnamespace IN (SELECT oid FROM owned) AND relkind IN ('i','I')) AS indexes`,
    [schema, ownedOid ?? null])).rows[0] as Cleanup;
  }
  async function cleanup(): Promise<Cleanup> {
    await rollback();
    if (ownedOid === undefined) {
      const counts = await remaining(); assert.deepEqual(counts, emptyCleanup()); return counts;
    }
    const identity = (await sql.query("SELECT oid::int AS oid,pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1", [schema])).rows;
    if (identity.length) {
      assert.deepEqual(identity, [{ oid: ownedOid, owner }]);
      await begin();
      try { await sql.query(`DROP SCHEMA "${schema}" CASCADE`); await commit(); }
      catch (error) { await rollback(); throw error; }
    }
    const counts = await remaining();
    assert.deepEqual(counts, emptyCleanup());
    return counts;
  }
  return { setup, beginMigration, verifyBackfill, verifyRolledBack, commit, rollback, update, verifyUpdated, cleanup, remaining,
    // Passed only as bound query parameters to the observer, never emitted in reports.
    relationIdentity: { schema, table: "transactions" } };
}

/** Returns only sanitized evidence; never acquires connections or touches public tables. */
export async function verifyMerchantNormalizationMigration(first: MerchantMigrationDatabase, second: MerchantMigrationDatabase,
  observer: MerchantMigrationDatabase, migrationSql: string, options: Options): Promise<MerchantNormalizationMigrationReport> {
  const started = performance.now();
  const report: MerchantNormalizationMigrationReport = { success: false, cases: [], backendPids: [],
    wait: { observed: false, seconds: 0, accessExclusiveLock: false }, cleanup: null,
    sessionSettingsRestored: false, failures: [], seconds: 0 };
  const clients = [first, second, observer];
  const settings: { client: MerchantMigrationDatabase; statement: string; lock: string; search: string }[] = [];
  const observeMs = options.observeTimeoutMs ?? 8000, lockMs = options.lockTimeoutMs ?? 12000, statementMs = options.statementTimeoutMs ?? 20000;
  let stage: Stage = "preflight", fixture: ReturnType<typeof createMerchantNormalizationMigrationFixture> | undefined;
  let pending: ReturnType<typeof settle> | undefined, secondActive = false, complete = false;
  const recordFailure = (at: Stage, error: unknown) => report.failures.push({ stage: at, sqlstate: sqlstate(error) });
  async function check(name: string, run: () => Promise<void>) {
    const at = performance.now(); await run(); report.cases.push({ name, seconds: (performance.now() - at) / 1000 });
  }
  try {
    assert.match(options.prefix, /^verify-merchant-[a-z0-9-]{1,40}$/);
    assert.equal(new Set(clients).size, 3);
    assert.ok(Number.isFinite(observeMs) && Number.isFinite(lockMs) && Number.isFinite(statementMs)
      && observeMs >= 1000 && observeMs < lockMs && lockMs < statementMs && statementMs <= 60000);
    assert.ok(migrationSql.trim());
    for (const client of clients) {
      const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      assert.ok(Number.isInteger(pid) && pid > 0); report.backendPids.push(pid);
    }
    assert.equal(new Set(report.backendPids).size, 3);
    // An independent backend sees idle state and xact_start; querying itself would hide an existing transaction.
    for (const [index, client] of clients.entries()) {
      const monitor = client === observer ? first : observer;
      const state = (await monitor.query("SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1::int", [report.backendPids[index]])).rows[0];
      assert.equal(state.state, "idle"); assert.equal(state.xact_start, null);
    }
    assert.equal((await observer.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=ANY($1::int[]) AND locktype='advisory' AND granted) AS held", [report.backendPids])).rows[0].held, false);
    for (const client of clients) {
      const row = (await client.query("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('search_path') AS search")).rows[0];
      settings.push({ client, statement: String(row.statement), lock: String(row.lock), search: String(row.search) });
      await client.query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)", [`${statementMs}ms`, `${lockMs}ms`]);
    }
    fixture = createMerchantNormalizationMigrationFixture(first, options);
    stage = "setup"; await fixture.setup();
    await check("019適用後の意図的22012でDDL・既存行計算を全体rollbackし生成列・関数・新Indexを残さない", async () => {
      stage = "migration";
      try {
        await fixture!.beginMigration(migrationSql);
        stage = "backfill"; await fixture!.verifyBackfill();
        stage = "migration"; await assert.rejects(first.query("SELECT 1/0"), { code: "22012" });
      } finally {
        const previousStage = stage;
        stage = "rollback"; await fixture!.rollback(); stage = previousStage;
      }
      stage = "backfill"; await fixture!.verifyRolledBack();
    });
    stage = "migration";
    await check("019を独立schemaへ適用し既存行・全既存列と生成列・関数・複合Indexを検証する", async () => {
      await fixture!.beginMigration(migrationSql); stage = "backfill"; await fixture!.verifyBackfill();
    });
    await check("ACCESS EXCLUSIVEによるUPDATE待機を第三sessionで観測しcommit後に生成値と既存列を確認する", async () => {
      stage = "update";
      pending = settle((async () => {
        secondActive = true;
        await second.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await fixture!.update(second);
        await second.query("COMMIT"); secondActive = false;
      })());
      const at = performance.now(); stage = "wait";
      try {
        do {
          await observer.query("SELECT pg_stat_clear_snapshot()");
          const row = (await observer.query(`SELECT a.state,a.wait_event_type,$1::int=ANY(pg_blocking_pids(a.pid)) AS blocked,
            EXISTS(SELECT 1 FROM pg_locks l JOIN pg_class t ON t.oid=l.relation JOIN pg_namespace n ON n.oid=t.relnamespace
              WHERE l.pid=$1::int AND l.locktype='relation' AND l.mode='AccessExclusiveLock' AND l.granted
                AND n.nspname=$3 AND t.relname=$4) AS exclusive
            FROM pg_stat_activity a WHERE a.pid=$2::int`,
          [report.backendPids[0], report.backendPids[1], fixture!.relationIdentity.schema, fixture!.relationIdentity.table])).rows[0];
          if (row?.blocked === true && row.state === "active" && row.wait_event_type === "Lock" && row.exclusive === true) {
            report.wait.observed = true; report.wait.accessExclusiveLock = true; break;
          }
          await new Promise(resolve => setTimeout(resolve, 40));
        } while (performance.now() - at < observeMs);
      } finally { report.wait.seconds = (performance.now() - at) / 1000; }
      assert.equal(report.wait.observed, true);
      stage = "migration"; await fixture!.commit();
      stage = "update";
      const outcome = await pending;
      if (!outcome.ok) throw { code: outcome.sqlstate };
      await fixture!.verifyUpdated();
    });
    complete = true;
  } catch (error) { recordFailure(stage, error); }
  finally {
    // Release the DDL lock before awaiting the queued UPDATE. All queries remain server-time-bounded.
    if (fixture) try { await fixture.rollback(); } catch (error) { recordFailure("rollback", error); }
    if (pending) {
      const outcome = await pending;
      if (!outcome.ok && !report.failures.some(failure => failure.stage === "update" && failure.sqlstate === outcome.sqlstate)) {
        report.failures.push({ stage: "update", sqlstate: outcome.sqlstate });
      }
    }
    if (secondActive) try { await second.query("ROLLBACK"); secondActive = false; } catch (error) { recordFailure("rollback", error); }
    if (fixture) try { report.cleanup = await fixture.cleanup(); } catch (error) {
      recordFailure("cleanup", error);
      try { report.cleanup = await fixture.remaining(); } catch (error) { recordFailure("cleanup", error); }
    }
    else report.cleanup = emptyCleanup();
    let restored = settings.length === clients.length;
    for (const saved of settings) try {
      await saved.client.query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false),set_config('search_path',$3,false)",
        [saved.statement, saved.lock, saved.search]);
      const row = (await saved.client.query("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('search_path') AS search")).rows[0];
      assert.deepEqual(row, { statement: saved.statement, lock: saved.lock, search: saved.search });
    } catch (error) { restored = false; recordFailure("restore", error); }
    report.sessionSettingsRestored = restored;
    report.seconds = (performance.now() - started) / 1000;
    report.success = complete && report.failures.length === 0 && report.cases.length === 3 && restored;
  }
  return report;
}

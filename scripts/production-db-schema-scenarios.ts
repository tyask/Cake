import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { aclSql, appTables, catalogSql, quotedIdentifier } from './production-db-migration-inventory';
import { verifyMerchantNormalizationMigration, type MerchantMigrationDatabase } from './merchant-normalization-migration-scenario';
import { setupDatabase } from './setup-db.mjs';

type Sql = MerchantMigrationDatabase;
export type ProductionSchemaMigration = { name: string; sql: string; sha256: string };
type Stage = 'pre' | 'snapshot' | 'scratch' | 'copy' | 'race' | 'schema' | 'repeat' | 'rollback' | 'restore';
type Failure = { stage: Stage; sqlstate: string | null };
type Hashes = { data: string; schema: string; acl: string; ledger: string; owners: string };
export type ProductionSchemaSnapshot = { counts: number[]; hashes: Hashes };
type Race = { queries: number[]; reads: number[]; writer: number; waiter: number; ddl: boolean; advisory: boolean; ms: number };
export type ProductionSchemaScenarioReport = {
  success: boolean; cases: { n: Stage; ms: number }[]; pids: number[]; counts: number[]; hashes: Hashes | null;
  scratch: { success: boolean; cases: number; ms: number; waitMs: number; exclusive: boolean;
    cleanup: number[] | null; restored: boolean } | null;
  race: Race | null; repeat: { reads: number; queries: number } | null;
  unchanged: { scratch: boolean; migration: boolean; repeat: boolean }; mismatches: number | null;
  restored: boolean; failures: Failure[]; ms: number;
};
const migrationName = '019_merchant_normalization.sql';
const indexName = 'transactions_workspace_merchant_normalized_idx';
const indexDefinition = `CREATE INDEX ${indexName} ON public.transactions USING btree (workspace_id, merchant_normalized)`;
const historySql = 'SELECT name FROM schema_migrations ORDER BY name';
const environment = { VERCEL_ENV: 'production', DATABASE_URL: 'cake-connected-session-only' };
const savedSettings = ['statement_timeout', 'lock_timeout', 'search_path', 'TimeZone', 'DateStyle', 'extra_float_digits'] as const;
const settingsSql = `SELECT ${savedSettings.map((name, i) => `current_setting('${name}') AS s${i}`).join(',')}`;
const elapsed = (started: number) => Math.round(performance.now() - started);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sqlstate = (error: unknown): string | null => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
};
const settle = (promise: Promise<unknown>) => promise.then(() => ({ ok: true as const }),
  error => ({ ok: false as const, code: sqlstate(error) }));
function count(value: unknown): number {
  assert.match(String(value), /^\d+$/); const result = Number(value); assert.ok(Number.isSafeInteger(result)); return result;
}
function hash(value: unknown): string { assert.equal(typeof value, 'string'); assert.match(value as string, /^[a-f0-9]{64}$/); return value as string; }
function rows(value: unknown): unknown[][] {
  if (value === null) return [];
  assert.ok(Array.isArray(value) && value.every(Array.isArray)); return value;
}

/** Only fixed, reviewed 019 additions are removed from the existing catalog projection. */
function catalogProjection(row: Record<string, unknown>) {
  assert.deepEqual(Object.keys(row).sort(), ['columns', 'constraints', 'functions', 'indexes', 'triggers']);
  return {
    columns: rows(row.columns).filter(item => !(item[0] === 'transactions' && item[2] === 'merchant_normalized')),
    constraints: rows(row.constraints),
    functions: rows(row.functions).filter(item => !(item[0] === 'cake_normalize_merchant' && item[1] === 'value text')),
    indexes: rows(row.indexes).filter(item => item[4] !== indexDefinition), triggers: rows(row.triggers),
  };
}

/** Hashes all 13 tables in PostgreSQL. Raw business rows never leave PostgreSQL. */
export async function productionSchemaSnapshot(sql: Sql): Promise<ProductionSchemaSnapshot> {
  await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await sql.query("SET LOCAL search_path=pg_catalog,public");
    await sql.query("SET LOCAL TIME ZONE 'UTC'");
    await sql.query("SET LOCAL DateStyle='ISO, YMD'");
    await sql.query('SET LOCAL extra_float_digits=3');
    const counts: number[] = [], hashes: string[] = [];
    for (const name of appTables) {
      const data = name === 'transactions' ? "to_jsonb(t)-'merchant_normalized'" : 'to_jsonb(t)';
      const where = name === 'schema_migrations' ? ' WHERE t.name <> $1' : '';
      const result = (await sql.query(`SELECT count(*)::text AS rows,encode(sha256(convert_to(coalesce(
        string_agg((${data})::text,E'\\n' ORDER BY (${data})::text COLLATE "C"),''),'UTF8')),'hex') AS hash
        FROM public.${quotedIdentifier(name)} t${where}`, where ? [migrationName] : undefined)).rows[0];
      counts.push(count(result.rows)); hashes.push(hash(result.hash));
    }
    const ledger = (await sql.query('SELECT name,applied_at::text AS applied_at FROM public.schema_migrations WHERE name <> $1 ORDER BY name', [migrationName])).rows;
    assert.equal(ledger.length, 18);
    assert.ok(ledger.every(row => typeof row.name === 'string' && typeof row.applied_at === 'string'));
    const catalog = (await sql.query(catalogSql)).rows; assert.equal(catalog.length, 1);
    const acl = (await sql.query(aclSql)).rows.filter(row => !(row.kind === 'function' && row.name === 'cake_normalize_merchant(value text)'));
    const owners = (await sql.query(`SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','i','I','S','v','m','f') AND c.relname<>$1 ORDER BY 1,2`, [indexName])).rows;
    await sql.query('COMMIT');
    return { counts, hashes: { data: digest(hashes), schema: digest(catalogProjection(catalog[0])), acl: digest(acl),
      ledger: digest(ledger), owners: digest(owners) } };
  } catch (error) { await sql.query('ROLLBACK'); throw error; }
}

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject({ code: '57014' }), ms); })]);
  } finally { clearTimeout(timer); }
}

/** Uses the unmodified setupDatabase against two already-connected, independent backends. */
export async function productionSchemaSetupRace(first: Sql, second: Sql, observer: Sql,
  migration: ProductionSchemaMigration, pids: number[], options: { observeMs: number; names: string[] }): Promise<Race> {
  assert.equal(pids.length, 3); assert.equal(new Set(pids).size, 3);
  const started = performance.now(), clients = [first, second], queries = [0, 0], reads = [0, 0];
  let release!: () => void, ready!: () => void, arrived = 0, observerActive = false, migrationReleased = false;
  const barrier = new Promise<void>(resolve => { release = resolve; }), bothReady = new Promise<void>(resolve => { ready = resolve; });
  const pending = clients.map((client, index) => settle(setupDatabase(environment, {
    readMigration: async name => { reads[index]++; assert.equal(name, migrationName); return migration.sql; },
    connect: () => ({ query: async statement => {
      queries[index]++;
      const result = await client.query(statement);
      if (statement === historySql) {
        assert.deepEqual(result.rows.map(row => row.name), options.names);
        if (++arrived === 2) ready();
        await barrier;
        assert.equal(migrationReleased, true);
      }
      return result;
    } }),
  })));
  let evidence: Race | undefined, operationError: unknown;
  try {
    await deadline(Promise.race([bothReady, ...pending.map(operation => operation.then(outcome => {
      if (!outcome.ok) throw { code: outcome.code };
      throw { code: null };
    }))]), options.observeMs);
    observerActive = true; await observer.query('BEGIN');
    await observer.query('LOCK TABLE public.transactions IN SHARE MODE');
    migrationReleased = true; release();
    const at = performance.now();
    do {
      await observer.query('SELECT pg_stat_clear_snapshot()');
      const candidates = (await observer.query(`SELECT holder.pid AS writer,waiting.pid AS waiter,
        $2::int=ANY(pg_blocking_pids(holder.pid)) AS observer_blocks,
        holder.pid=ANY(pg_blocking_pids(waiting.pid)) AS writer_blocks,
        EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=holder.pid AND l.locktype='relation'
          AND l.relation='public.transactions'::regclass AND l.mode='AccessExclusiveLock' AND NOT l.granted) AS ddl,
        EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=$2::int AND l.locktype='relation'
          AND l.relation='public.transactions'::regclass AND l.mode='ShareLock' AND l.granted) AS share,
        EXISTS(SELECT 1 FROM pg_locks a JOIN pg_locks b ON a.database IS NOT DISTINCT FROM b.database
          AND a.classid=b.classid AND a.objid=b.objid AND a.objsubid=b.objsubid
          WHERE a.pid=holder.pid AND b.pid=waiting.pid AND a.locktype='advisory' AND b.locktype='advisory'
            AND a.mode='ExclusiveLock' AND b.mode='ExclusiveLock' AND a.granted AND NOT b.granted) AS advisory
        FROM unnest($1::int[]) holder(pid) CROSS JOIN unnest($1::int[]) waiting(pid) WHERE holder.pid<>waiting.pid`, [pids.slice(0, 2), pids[2]])).rows;
      const found = candidates.find(row => row.observer_blocks === true && row.writer_blocks === true
        && row.ddl === true && row.share === true && row.advisory === true);
      if (found) {
        const writer = count(found.writer), waiter = count(found.waiter);
        assert.ok(pids.slice(0, 2).includes(writer) && pids.slice(0, 2).includes(waiter) && writer !== waiter);
        evidence = { queries, reads, writer, waiter, ddl: true, advisory: true, ms: 0 }; break;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    } while (performance.now() - at < options.observeMs);
    assert.ok(evidence);
    await observer.query('COMMIT'); observerActive = false;
  } catch (error) { operationError = error; }
  finally {
    // Release both JS waiters and the blocking table lock before settling setup calls.
    release();
    if (observerActive) try { await observer.query('ROLLBACK'); } catch (error) { operationError ??= error; }
    const outcomes = await Promise.all(pending);
    for (const outcome of outcomes) if (!outcome.ok) operationError ??= { code: outcome.code };
  }
  if (operationError !== undefined) throw operationError;
  assert.ok(evidence); assert.deepEqual(reads, [1, 1]); assert.deepEqual(queries, [3, 3]);
  evidence.ms = elapsed(started); return evidence;
}

/** Checks the public, committed 019 result independently of the scratch fixture. */
export async function productionSchemaPostconditions(sql: Sql): Promise<number> {
  const mismatches = count((await sql.query(`SELECT count(*)::text AS n FROM public.transactions
    WHERE merchant_normalized IS DISTINCT FROM public.cake_normalize_merchant(merchant)`)).rows[0].n);
  assert.equal(mismatches, 0);
  assert.deepEqual((await sql.query(`SELECT a.attgenerated,a.attnotnull,c.collname,
    format_type(a.atttypid,a.atttypmod) AS type,pg_get_expr(d.adbin,d.adrelid) AS expression
    FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_collation c ON c.oid=a.attcollation JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND t.relname='transactions' AND a.attname='merchant_normalized' AND NOT a.attisdropped`)).rows,
  [{ attgenerated: 's', attnotnull: true, collname: 'C', type: 'text', expression: 'cake_normalize_merchant(merchant)' }]);
  assert.deepEqual((await sql.query(`SELECT p.provolatile,p.proisstrict,p.proparallel,pg_get_function_result(p.oid) AS result
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      AND p.proname='cake_normalize_merchant' AND p.proargtypes='25'::oidvector`)).rows,
  [{ provolatile: 'i', proisstrict: true, proparallel: 's', result: 'text' }]);
  assert.deepEqual((await sql.query(`SELECT i.indisvalid,i.indisready,i.indislive,i.indisunique,
    pg_get_indexdef(i.indexrelid) AS definition,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ordinality) AS columns
    FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_namespace n ON n.oid=x.relnamespace
    WHERE n.nspname='public' AND x.relname='transactions_workspace_merchant_normalized_idx'`)).rows,
  [{ indisvalid: true, indisready: true, indislive: true, indisunique: false, definition: indexDefinition,
    columns: ['workspace_id', 'merchant_normalized'] }]);
  assert.equal(count((await sql.query('SELECT count(*)::text AS n FROM public.schema_migrations WHERE name=$1', [migrationName])).rows[0].n), 1);
  return mismatches;
}

/** The caller owns binding/PG18/raw-source validation, connections, and provider checks. */
export async function verifyProductionSchemaScenarios(first: Sql, second: Sql, observer: Sql,
  migration: ProductionSchemaMigration, options: { beforePublicMigration?: () => Promise<void> } = {}): Promise<ProductionSchemaScenarioReport> {
  const started = performance.now(), clients = [first, second, observer], saved: { client: Sql; values: string[] }[] = [];
  const report: ProductionSchemaScenarioReport = { success: false, cases: [], pids: [], counts: [], hashes: null, scratch: null,
    race: null, repeat: null, unchanged: { scratch: false, migration: false, repeat: false }, mismatches: null,
    restored: false, failures: [], ms: 0 };
  let stage: Stage = 'pre', complete = false;
  const failure = (at: Stage, error: unknown) => { if (report.failures.length < 12) report.failures.push({ stage: at, sqlstate: sqlstate(error) }); };
  const check = async (at: Stage, run: () => Promise<void>) => { stage = at; const began = performance.now(); await run(); report.cases.push({ n: at, ms: elapsed(began) }); };
  try {
    assert.equal(new Set(clients).size, 3); assert.equal(migration.name, migrationName);
    assert.match(migration.sha256, /^[a-f0-9]{64}$/);
    assert.equal(createHash('sha256').update(migration.sql).digest('hex'), migration.sha256);
    const names = (await readdir(new URL('../db/migrations/', import.meta.url))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    assert.equal(names.length, 19); assert.equal(names.at(-1), migrationName);
    for (const client of clients) report.pids.push(count((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    assert.equal(new Set(report.pids).size, 3); assert.ok(report.pids.every(pid => pid > 0));
    for (const [i, client] of clients.entries()) {
      const monitor = client === observer ? first : observer;
      const state = (await monitor.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1::int', [report.pids[i]])).rows;
      assert.deepEqual(state, [{ state: 'idle', xact_start: null }]);
    }
    assert.equal((await observer.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=ANY($1::int[]) AND locktype='advisory' AND granted) AS held", [report.pids])).rows[0].held, false);
    for (const client of clients) {
      const row = (await client.query(settingsSql)).rows[0], values = savedSettings.map((_, i) => { assert.equal(typeof row[`s${i}`], 'string'); return String(row[`s${i}`]); });
      saved.push({ client, values });
      await client.query("SELECT set_config('statement_timeout','20000ms',false),set_config('lock_timeout','12000ms',false),set_config('search_path','public,pg_catalog',false)");
    }
    stage = 'snapshot'; const before = await productionSchemaSnapshot(observer);
    report.counts = before.counts; report.hashes = before.hashes;
    await check('scratch', async () => {
      const scratch = await verifyMerchantNormalizationMigration(first, second, observer, migration.sql, { prefix: 'verify-merchant-production-schema' });
      report.scratch = { success: scratch.success, cases: scratch.cases.length, ms: Math.round(scratch.seconds * 1000),
        waitMs: Math.round(scratch.wait.seconds * 1000), exclusive: scratch.wait.accessExclusiveLock,
        cleanup: scratch.cleanup ? [scratch.cleanup.schemas, scratch.cleanup.tables, scratch.cleanup.functions, scratch.cleanup.indexes] : null,
        restored: scratch.sessionSettingsRestored };
      for (const item of scratch.failures) failure('scratch', { code: item.sqlstate });
      assert.equal(scratch.success, true);
    });
    await check('copy', async () => { assert.deepEqual(await productionSchemaSnapshot(observer), before); report.unchanged.scratch = true; });
    await check('race', async () => {
      await options.beforePublicMigration?.();
      report.race = await productionSchemaSetupRace(first, second, observer, migration, report.pids, { observeMs: 8000, names: names.slice(0, -1) });
    });
    await check('schema', async () => {
      report.mismatches = await productionSchemaPostconditions(observer);
      assert.deepEqual(await productionSchemaSnapshot(observer), before); report.unchanged.migration = true;
    });
    await check('repeat', async () => {
      let reads = 0, queries = 0;
      const ledgerBefore = (await observer.query('SELECT name,applied_at::text AS applied_at FROM public.schema_migrations ORDER BY name')).rows;
      await setupDatabase(environment, { readMigration: async () => { reads++; assert.fail(); },
        connect: () => ({ query: async statement => { queries++; return first.query(statement); } }) });
      report.repeat = { reads, queries }; assert.equal(reads, 0); assert.equal(queries, 2);
      assert.deepEqual((await observer.query('SELECT name,applied_at::text AS applied_at FROM public.schema_migrations ORDER BY name')).rows, ledgerBefore);
      assert.deepEqual(await productionSchemaSnapshot(observer), before);
      await productionSchemaPostconditions(observer); report.unchanged.repeat = true;
    });
    complete = true;
  } catch (error) { failure(stage, error); }
  finally {
    // Only touched sessions are rolled back; invalid input never executes SQL.
    for (const item of saved) try { await item.client.query('ROLLBACK'); } catch (error) { failure('rollback', error); }
    let restored = saved.length === 3;
    for (const item of saved) try {
      await item.client.query(`SELECT ${savedSettings.map((name, i) => `set_config('${name}',$${i + 1},false)`).join(',')}`, item.values);
      const row = (await item.client.query(settingsSql)).rows[0];
      assert.deepEqual(savedSettings.map((_, i) => row[`s${i}`]), item.values);
    } catch (error) { restored = false; failure('restore', error); }
    report.restored = restored; report.ms = elapsed(started);
    report.success = complete && restored && report.failures.length === 0;
  }
  return report;
}

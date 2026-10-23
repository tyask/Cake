import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, fail, hash, MigrationError, type Binding, type Connection } from './production-db-migration-provider';
import { appTables, assertCopy, databaseClient, inventory, startSnapshot, type Snapshot, type Sql } from './production-db-migration-inventory';
import { restoreList, runCommand, type Command } from './production-db-migration';
import { migration019 } from './production-db-schema-qa';
import { productionSchemaPostconditions, productionSchemaSnapshot, type ProductionSchemaSnapshot } from './production-db-schema-scenarios';
import { setupDatabase } from './setup-db.mjs';

const stages = ['connections','source-connect','target-connect','source-preflight','target-preflight','migration-source',
  'dump','pre-write','refresh','target-verification','source-verification','post-write','cleanup','completed'] as const;
export type FinalCopyStage = typeof stages[number];
export type FinalCopyReport = {
  success: boolean; stage: FinalCopyStage; code: string; sqlstate: string | null;
  cases: { stage: FinalCopyStage; ms: number }[]; ms: number;
  source: ProductionSchemaSnapshot | null; target: ProductionSchemaSnapshot | null; beforeTargetDataHash: string | null;
  targetTouched: boolean; restored: boolean; migrated: boolean; verified: boolean; sourceUnchanged: boolean;
  restoreStatus: 'not-started' | 'acknowledged' | 'unknown'; temporaryFilesRemoved: boolean; sessionsClosed: boolean;
};
export type FinalCopyOptions = { source: Connection; target: Connection; beforeWrite: () => Promise<void>; afterWrite: () => Promise<void> };
export type FinalCopyDependencies = {
  client: (connection: Connection) => Sql; command: Command; inspect: typeof inventory; begin: typeof startSnapshot;
  project: typeof productionSchemaSnapshot; postconditions: typeof productionSchemaPostconditions;
  now: () => number; readMigration: () => Promise<string>;
};
const directory = new URL('../db/migrations/', import.meta.url);
const drop019 = 'ALTER TABLE public.transactions DROP COLUMN merchant_normalized;\nDROP FUNCTION public.cake_normalize_merchant(text);\n';
const allowedCodes = new Set(['FAILED','FINAL_COPY_CONNECTION','FINAL_COPY_INDEPENDENT_SESSIONS','FINAL_COPY_LEDGER',
  'FINAL_COPY_DATASET','FINAL_COPY_LEGACY_MISMATCH','FINAL_COPY_TARGET_CHANGED','FINAL_COPY_SOURCE_CHANGED',
  'FINAL_COPY_MIGRATION_SOURCE','FINAL_COPY_MIGRATION_STATEMENT','FINAL_COPY_SESSION_CLEANUP','FINAL_COPY_TEMP_CLEANUP',
  'PG_COMMAND_FAILED','PG_VERSION','DUMP_CONTENT','COPY_MISMATCH','MAIN_CHANGED','TARGET_CONNECTED','INVALID_RESPONSE',
  'PROVIDER_BINDING','PROVIDER_CHANGED','INCOMPLETE_INVENTORY','CONNECTION_BINDING','DATABASE_BINDING','INVALID_INVENTORY',
  'UNKNOWN_STRUCTURE','AUTH_STRUCTURE','AUTH_DATA_PRESENT','UNSUPPORTED_SCHEMA','UNSUPPORTED_PRIVILEGES','UNSUPPORTED_EXTENSION',
  'MANAGED_DEFAULT_ACL','DATABASE_LIMIT','INVALID_IDENTIFIER'].map(code => `PRODUCTION_MIGRATION_${code}`));
export function isFinalCopyPublicCode(code: string): boolean {
  return code === 'OK' || allowedCodes.has(code)
    || /^PRODUCTION_MIGRATION_PROVIDER_(?:NEON|VERCEL|GITHUB)_(?:HTTP_[1-5][0-9]{2}|TRANSPORT|INVALID_STATUS|JSON)$/.test(code);
}
function publicCode(error: unknown): string {
  return error instanceof MigrationError && isFinalCopyPublicCode(error.message)
    ? error.message : 'PRODUCTION_MIGRATION_FAILED';
}
function sqlstate(error: unknown): string | null {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}
function same(actual: unknown, expected: unknown, code: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code);
}
function assertConnection(connection: Connection, binding: Binding): void {
  if (connection.database !== binding.database || connection.user !== binding.role || connection.port !== 5432
    || typeof connection.password !== 'string' || !connection.password || /[\u0000-\u001f\u007f]/.test(connection.password)
    || typeof connection.host !== 'string' || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(connection.host)
    || connection.host.includes('-pooler.') || !connection.host.startsWith(`${binding.endpointId}.`)
    || hash(connection.host) !== binding.hostDigest) fail('FINAL_COPY_CONNECTION');
}
function assertDataset(snapshot: Snapshot, ledger: string[], binding: Binding): void {
  if (snapshot.empty || snapshot.summary.authRows !== 0 || snapshot.summary.publicTables !== appTables.length
    || Math.floor(snapshot.summary.version / 10000) !== binding.majorVersion) fail('FINAL_COPY_DATASET');
  same(snapshot.tables, appTables, 'FINAL_COPY_DATASET');
  same(snapshot.extensions, ['pgcrypto','plpgsql'], 'FINAL_COPY_DATASET');
  same(snapshot.ledger, ledger, 'FINAL_COPY_LEDGER');
  if (snapshot.summary.counts[appTables.indexOf('schema_migrations')] !== ledger.length) fail('FINAL_COPY_LEDGER');
}
function assertLegacyStructure(source: ProductionSchemaSnapshot, target: ProductionSchemaSnapshot): void {
  for (const key of ['schema','acl','ledger','owners'] as const) same(target.hashes[key], source.hashes[key], 'FINAL_COPY_LEGACY_MISMATCH');
}
function assertPreserved(before: Snapshot, after: Snapshot): void {
  for (const key of ['authSchemaHash','authRows','defaultAclHash','localeHash','roleHash','extensionsHash','extensionAclHash'] as const) {
    same(after.summary[key], before.summary[key], 'FINAL_COPY_TARGET_CHANGED');
  }
  same(after.schemaOwner, before.schemaOwner, 'FINAL_COPY_TARGET_CHANGED');
}

/** The caller already owns a verified read-only snapshot; keep it alive for pg_dump. */
async function projectInSnapshot(sql: Sql, project: typeof productionSchemaSnapshot): Promise<ProductionSchemaSnapshot> {
  return project({ query: (text, values) => text.startsWith('BEGIN ') || text === 'COMMIT'
    ? Promise.resolve({ rows: [] }) : sql.query(text, values) });
}

/** Capture the actual setupDatabase-generated migration instead of maintaining a second SQL implementation. */
async function migrationStatement(names: string[], source: string): Promise<string> {
  if (hash(source) !== migration019.sha256) fail('FINAL_COPY_MIGRATION_SOURCE');
  const queries: string[] = [], reads: string[] = [];
  await setupDatabase({ VERCEL_ENV: 'production', DATABASE_URL: 'cake-final-copy-connected-session-only' }, {
    readMigration: async name => { reads.push(name); if (name !== migration019.name) fail('FINAL_COPY_MIGRATION_SOURCE'); return source; },
    connect: () => ({ query: async text => {
      queries.push(text);
      return { rows: text === 'SELECT name FROM schema_migrations ORDER BY name' ? names.map(name => ({ name })) : [] };
    } }),
  });
  if (queries.length !== 3 || queries[1] !== 'SELECT name FROM schema_migrations ORDER BY name'
    || !queries[0].startsWith('DO $cake_migration$ BEGIN ') || !queries[0].includes('CREATE TABLE IF NOT EXISTS schema_migrations')
    || !queries[2].startsWith('DO $cake_migration$ BEGIN ') || !queries[2].endsWith(' END; $cake_migration$;')
    || !queries[2].includes(source) || !queries[2].includes("PERFORM pg_advisory_xact_lock(hashtext('cake:schema-migrations'))")
    || !queries[2].includes(`INSERT INTO schema_migrations (name) VALUES ('${migration019.name}');`)
    || JSON.stringify(reads) !== JSON.stringify([migration019.name])) fail('FINAL_COPY_MIGRATION_STATEMENT');
  return queries[2];
}

function projectedSnapshot(snapshot: ProductionSchemaSnapshot | null): ProductionSchemaSnapshot | null {
  if (snapshot === null) return null;
  if (!Array.isArray(snapshot.counts) || snapshot.counts.length !== appTables.length
    || snapshot.counts.some(count => !Number.isSafeInteger(count) || count < 0)) return fail('FINAL_COPY_REPORT');
  const hashes = Object.fromEntries(['data','schema','acl','ledger','owners'].map(key => {
    const value = snapshot.hashes[key as keyof ProductionSchemaSnapshot['hashes']];
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail('FINAL_COPY_REPORT');
    return [key, value];
  })) as ProductionSchemaSnapshot['hashes'];
  return { counts: [...snapshot.counts], hashes };
}
/** Drop unknown properties, including private errors/SQL/connections, before a caller publishes the result. */
export function projectFinalCopyReport(value: FinalCopyReport): FinalCopyReport {
  const booleans = ['success','targetTouched','restored','migrated','verified','sourceUnchanged','temporaryFilesRemoved','sessionsClosed'] as const;
  if (booleans.some(key => typeof value[key] !== 'boolean') || !stages.includes(value.stage)
    || !isFinalCopyPublicCode(value.code)
    || value.sqlstate !== null && !/^[0-9A-Z]{5}$/.test(value.sqlstate)
    || !['not-started','acknowledged','unknown'].includes(value.restoreStatus)
    || !Number.isSafeInteger(value.ms) || value.ms < 0 || !Array.isArray(value.cases) || value.cases.length > stages.length
    || value.beforeTargetDataHash !== null && !/^[a-f0-9]{64}$/.test(value.beforeTargetDataHash)) return fail('FINAL_COPY_REPORT');
  const report: FinalCopyReport = { success: value.success, stage: value.stage, code: value.code, sqlstate: value.sqlstate,
    cases: value.cases.map(item => { if (!stages.includes(item.stage) || !Number.isSafeInteger(item.ms) || item.ms < 0) return fail('FINAL_COPY_REPORT');
      return { stage: item.stage, ms: item.ms }; }), ms: value.ms, source: projectedSnapshot(value.source), target: projectedSnapshot(value.target),
    beforeTargetDataHash: value.beforeTargetDataHash, targetTouched: value.targetTouched, restored: value.restored, migrated: value.migrated,
    verified: value.verified, sourceUnchanged: value.sourceUnchanged, restoreStatus: value.restoreStatus,
    temporaryFilesRemoved: value.temporaryFilesRemoved, sessionsClosed: value.sessionsClosed };
  if (report.targetTouched !== (report.restoreStatus !== 'not-started') || report.restored !== (report.restoreStatus === 'acknowledged')
    || report.migrated !== report.restored || report.verified && (!report.restored || !report.source || !report.target
      || JSON.stringify(report.source) !== JSON.stringify(report.target))
    || report.success && (report.stage !== 'completed' || report.code !== 'OK' || report.sqlstate !== null || !report.verified
      || !report.sourceUnchanged || !report.temporaryFilesRemoved || !report.sessionsClosed)) return fail('FINAL_COPY_REPORT');
  return report;
}

/** Refresh only the fixed, isolated PG18 target. Provider/provenance authorization belongs to the caller. */
export async function runFinalCopy(options: FinalCopyOptions, overrides: Partial<FinalCopyDependencies> = {}): Promise<FinalCopyReport> {
  const dependencies: FinalCopyDependencies = { client: databaseClient, command: runCommand, inspect: inventory, begin: startSnapshot,
    project: productionSchemaSnapshot, postconditions: productionSchemaPostconditions, now: () => performance.now(),
    readMigration: () => readFile(new URL(migration019.name, directory), 'utf8'), ...overrides };
  const started = dependencies.now(), elapsed = (since: number) => Math.max(0, Math.round(dependencies.now() - since));
  const report: FinalCopyReport = { success: false, stage: 'connections', code: 'PRODUCTION_MIGRATION_FAILED', sqlstate: null,
    cases: [], ms: 0, source: null, target: null, beforeTargetDataHash: null, targetTouched: false, restored: false,
    migrated: false, verified: false, sourceUnchanged: false, restoreStatus: 'not-started', temporaryFilesRemoved: true, sessionsClosed: true };
  const clients: Sql[] = []; let temporaryDirectory: string | undefined;
  const stage = async <T>(name: FinalCopyStage, work: () => Promise<T>): Promise<T> => {
    report.stage = name; const began = dependencies.now();
    try { return await work(); } finally { report.cases.push({ stage: name, ms: elapsed(began) }); }
  };
  try {
    assertConnection(options.source, config.source); assertConnection(options.target, config.target);
    const source = dependencies.client(options.source); clients.push(source);
    const target = dependencies.client(options.target); clients.push(target);
    if (source === target) fail('FINAL_COPY_INDEPENDENT_SESSIONS');
    await stage('source-connect', () => source.connect());
    await stage('target-connect', () => target.connect());
    const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    const previous = names.filter(name => /^0(?:0[1-9]|1[0-8])_[a-z0-9_]+\.sql$/.test(name));
    if (previous.length !== 18 || names.length !== 19 || names.at(-1) !== migration019.name) fail('FINAL_COPY_LEDGER');
    let exported = '';
    const originalSource = await stage('source-preflight', async () => {
      exported = await dependencies.begin(source, config.source);
      const snapshot = await dependencies.inspect(source, config.source); assertDataset(snapshot, previous, config.source);
      report.source = await projectInSnapshot(source, dependencies.project); return snapshot;
    });
    let originalTargetProjection: ProductionSchemaSnapshot | undefined;
    const originalTarget = await stage('target-preflight', async () => {
      await dependencies.begin(target, config.target);
      const snapshot = await dependencies.inspect(target, config.target); assertDataset(snapshot, names, config.target);
      const projected = await projectInSnapshot(target, dependencies.project); originalTargetProjection = projected;
      assertLegacyStructure(report.source!, projected); report.beforeTargetDataHash = projected.hashes.data;
      for (const key of ['localeHash','roleHash','extensionsHash','extensionAclHash'] as const) {
        same(snapshot.summary[key], originalSource.summary[key], 'FINAL_COPY_LEGACY_MISMATCH');
      }
      same(snapshot.schemaOwner, originalSource.schemaOwner, 'FINAL_COPY_LEGACY_MISMATCH');
      await dependencies.postconditions(target); await target.query('ROLLBACK'); return snapshot;
    });
    const statement = await stage('migration-source', async () => migrationStatement(previous, await dependencies.readMigration()));
    let refreshFile = '';
    await stage('dump', async () => {
      for (const program of ['pg_dump','pg_restore','psql'] as const) {
        if (!new RegExp(`^${program} \\(PostgreSQL\\) 18\\.[0-9]+(?:[ .-]|$)`).test(await dependencies.command(program, ['--version']))) fail('PG_VERSION');
      }
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'cake-production-final-copy-')); report.temporaryFilesRemoved = false;
      await chmod(temporaryDirectory, 0o700);
      const archive = join(temporaryDirectory, 'database.dump'), list = join(temporaryDirectory, 'restore.list'), rawSql = join(temporaryDirectory, 'restore.sql');
      refreshFile = join(temporaryDirectory, 'refresh.sql');
      for (const file of [archive, list, rawSql, refreshFile]) await writeFile(file, '', { mode: 0o600 });
      await dependencies.command('pg_dump', ['--format=custom','--schema=public','--extension=pgcrypto','--strict-names',
        '--lock-wait-timeout=20s', `--snapshot=${exported}`, `--file=${archive}`], options.source);
      await writeFile(list, restoreList(await dependencies.command('pg_restore', ['--list', archive])), { mode: 0o600 });
      await dependencies.command('pg_restore', ['--exit-on-error','--clean','--if-exists', `--use-list=${list}`, `--file=${rawSql}`, archive]);
      await writeFile(refreshFile, `${drop019}${await readFile(rawSql, 'utf8')}\n${statement}\n`, { mode: 0o600 });
    });
    await stage('pre-write', async () => {
      await options.beforeWrite();
      await dependencies.begin(target, config.target);
      const latest = await dependencies.inspect(target, config.target); assertCopy(originalTarget, latest); assertPreserved(originalTarget, latest);
      same(await projectInSnapshot(target, dependencies.project), originalTargetProjection, 'FINAL_COPY_TARGET_CHANGED');
      await dependencies.postconditions(target); await target.query('ROLLBACK');
    });
    await stage('refresh', async () => {
      // A lost COMMIT response is ambiguous: never report targetTouched=false or infer rollback from a command failure.
      report.targetTouched = true; report.restoreStatus = 'unknown';
      await dependencies.command('psql', ['-X','--single-transaction','--set=ON_ERROR_STOP=1', `--file=${refreshFile}`], options.target);
      report.restored = true; report.migrated = true; report.restoreStatus = 'acknowledged';
    });
    await stage('target-verification', async () => {
      await dependencies.begin(target, config.target);
      const after = await dependencies.inspect(target, config.target); assertDataset(after, names, config.target); assertPreserved(originalTarget, after);
      report.target = await projectInSnapshot(target, dependencies.project);
      same(report.target, report.source, 'FINAL_COPY_LEGACY_MISMATCH');
      await dependencies.postconditions(target); await target.query('ROLLBACK'); report.verified = true;
    });
    await stage('source-verification', async () => {
      await source.query('ROLLBACK'); await dependencies.begin(source, config.source);
      const latest = await dependencies.inspect(source, config.source); assertDataset(latest, previous, config.source);
      try { assertCopy(originalSource, latest); assertPreserved(originalSource, latest);
        same(await projectInSnapshot(source, dependencies.project), report.source, 'FINAL_COPY_SOURCE_CHANGED');
      } catch { fail('FINAL_COPY_SOURCE_CHANGED'); }
      await source.query('ROLLBACK'); report.sourceUnchanged = true;
    });
    await stage('post-write', options.afterWrite);
    report.success = true; report.stage = 'completed'; report.code = 'OK';
  } catch (error) { report.success = false; report.code = publicCode(error); report.sqlstate = sqlstate(error); }
  finally {
    for (const sql of new Set(clients)) {
      try { await sql.query('ROLLBACK'); } catch { report.sessionsClosed = false; }
      try { await sql.end(); } catch { report.sessionsClosed = false; }
    }
    if (!report.sessionsClosed) { report.success = false; report.stage = 'cleanup'; report.code = 'PRODUCTION_MIGRATION_FINAL_COPY_SESSION_CLEANUP'; }
    if (temporaryDirectory) {
      try { await rm(temporaryDirectory, { recursive: true, force: true }); report.temporaryFilesRemoved = true; }
      catch { report.success = false; report.stage = 'cleanup'; report.code = 'PRODUCTION_MIGRATION_FINAL_COPY_TEMP_CLEANUP'; }
    }
    report.ms = elapsed(started);
  }
  return projectFinalCopyReport(report);
}

import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { config, hash, MigrationError, type Connection } from '../scripts/production-db-migration-provider';
import { appTables, type Snapshot, type Sql } from '../scripts/production-db-migration-inventory';
import { childEnvironment } from '../scripts/production-db-migration';
import { migration019 } from '../scripts/production-db-schema-qa';
import { productionSchemaPostconditions, productionSchemaSnapshot, type ProductionSchemaSnapshot } from '../scripts/production-db-schema-scenarios';
import { projectFinalCopyReport, runFinalCopy, type FinalCopyDependencies, type FinalCopyOptions } from '../scripts/production-db-final-copy';

const sourceConnection: Connection = { host: 'ep-ancient-flower-az7oh01x.c-3.ap-southeast-1.aws.neon.tech',
  port: 5432, user: 'neondb_owner', database: 'neondb', password: 'never-publish-source-password' };
const targetConnection: Connection = { ...sourceConnection, host: 'ep-odd-wildflower-a1kwkl1v.ap-southeast-1.aws.neon.tech', password: 'never-publish-target-password' };
const migrationDirectory = new URL('../db/migrations/', import.meta.url);
const previousNames = async () => (await readdir(migrationDirectory)).filter(name => /^0(?:0[1-9]|1[0-8])_/.test(name)).sort();
const toc = ['; archive', '1; 2615 2200 SCHEMA - public pg_database_owner', '2; 3079 17000 EXTENSION - pgcrypto ',
  '3; 0 0 COMMENT - EXTENSION pgcrypto ', '4; 1259 17001 TABLE public transactions neondb_owner',
  '5; 0 17001 TABLE DATA public transactions neondb_owner', '6; 0 0 ACL - SCHEMA public pg_database_owner',
  '7; 826 18001 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES cloud_admin',
  '8; 826 18002 DEFAULT ACL public DEFAULT PRIVILEGES FOR SEQUENCES cloud_admin'].join('\n');
function projected(data = 'source'): ProductionSchemaSnapshot {
  return { counts: appTables.map(name => name === 'schema_migrations' ? 18 : 1),
    hashes: { data: hash(data), schema: hash('legacy-schema'), acl: hash('legacy-acl'), ledger: hash('legacy-ledger'), owners: hash('owners') } };
}
async function snapshot(source: boolean, copied = false): Promise<Snapshot> {
  const ledger = await previousNames(); if (!source) ledger.push(migration019.name);
  const data = source || copied ? 'source' : 'old-target';
  return { empty: false, tables: [...appTables], tableHashes: appTables.map(name => hash(`${name}-${data}`)), ledger,
    extensions: ['pgcrypto','plpgsql'], schemaOwner: 'pg_database_owner', summary: {
      counts: appTables.map(name => name === 'schema_migrations' ? ledger.length : 1), dataHash: hash(data),
      schemaHash: hash(source ? 'schema18' : 'schema19'), aclHash: hash(source ? 'acl18' : 'acl19'), ledgerHash: hash(source ? 'ledger18' : 'ledger19'),
      authSchemaHash: hash('auth'), authRows: 0, publicTables: 13, version: source ? 170011 : 180006, bytes: 1000,
      localeHash: hash('locale'), roleHash: hash('role'), extensionsHash: hash('extensions'),
      defaultAclHash: hash(source ? 'managed17' : 'managed18'), extensionAclHash: hash('extension-acl') } };
}
type Mode = 'ok' | 'target-schema' | 'target-owners' | 'target-ledger' | 'target-auth' | 'target-drift' | 'target-owner-drift' | 'postcondition'
  | 'source-drift' | 'restore-response-lost' | 'before-write' | 'after-write' | 'migration-source' | 'session-cleanup' | 'wrong-version';
async function mockRun(mode: Mode = 'ok', optionsOverride: Partial<FinalCopyOptions> = {}) {
  const events: string[] = [], queries: string[][] = [[], []], commands: { program: string; args: string[]; connection?: Connection }[] = [];
  let sourceReads = 0, targetReads = 0, targetProjections = 0, postconditions = 0, ended = 0, now = 0;
  let temporaryDirectory: string | undefined, refresh = '', sourceSnapshotActive = false;
  const clients = [0, 1].map(index => ({ connect: async () => { events.push(`connect-${index}`); },
    query: async (text: string) => {
      queries[index].push(text);
      if (text === 'fixture-id') return { rows: [{ index }] };
      if (text === 'ROLLBACK' && index === 0) sourceSnapshotActive = false;
      if (index === 0 && /^(?:DROP|ALTER|INSERT|UPDATE|DELETE|CREATE)\b/.test(text)) assert.fail('source write');
      return { rows: [] };
    }, end: async () => { ended++; if (mode === 'session-cleanup' && index === 1) throw new Error('private cleanup password'); } } satisfies Sql));
  const dependencies: Partial<FinalCopyDependencies> = {
    client: connection => connection === sourceConnection ? clients[0] : clients[1], now: () => ++now,
    begin: async (sql, binding) => { assert.equal(sql, binding === config.source ? clients[0] : clients[1]);
      if (sql === clients[0]) sourceSnapshotActive = true; return '00000001-00000001-1'; },
    inspect: async sql => {
      const isSource = sql === clients[0], value = await snapshot(isSource, !isSource && ++targetReads >= 3);
      if (isSource && ++sourceReads === 2 && mode === 'source-drift') value.summary.dataHash = hash('drift');
      if (!isSource && targetReads === 2 && mode === 'target-drift') value.summary.dataHash = hash('drift');
      if (!isSource && mode === 'target-auth') value.summary.authRows = 1;
      return value;
    },
    project: async sql => {
      await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const isTarget = (await sql.query('fixture-id')).rows[0].index === 1;
      const value = projected(isTarget && ++targetProjections <= 2 ? 'old-target' : 'source');
      if (isTarget && mode === 'target-schema') value.hashes.schema = hash('unexpected');
      if (isTarget && mode === 'target-owners') value.hashes.owners = hash('unexpected');
      if (isTarget && mode === 'target-ledger') value.hashes.ledger = hash('unexpected');
      if (isTarget && targetProjections === 2 && mode === 'target-owner-drift') value.hashes.owners = hash('unexpected');
      await sql.query('COMMIT'); return value;
    },
    postconditions: async () => { if (mode === 'postcondition' && ++postconditions === 1) throw Object.assign(new Error('private SQL'), { code: '23514' }); return 0; },
    command: async (program, args, connection) => {
      commands.push({ program, args: [...args], connection });
      if (args[0] === '--version') return `${program} (PostgreSQL) ${mode === 'wrong-version' ? 17 : 18}.6`;
      if (program === 'pg_dump') {
        assert.equal(sourceSnapshotActive, true, 'the exact source snapshot stays open for dump');
        assert.equal(connection, sourceConnection);
        const file = args.find(argument => argument.startsWith('--file='))!.slice(7);
        temporaryDirectory = file.slice(0, file.lastIndexOf('/'));
        assert.equal((await stat(temporaryDirectory)).mode & 0o777, 0o700); assert.equal((await stat(file)).mode & 0o777, 0o600);
        await writeFile(file, 'private archive'); return '';
      }
      if (program === 'pg_restore' && args[0] === '--list') return toc;
      if (program === 'pg_restore') {
        assert.equal(connection, undefined);
        const file = args.find(argument => argument.startsWith('--file='))!.slice(7);
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        await writeFile(file, '-- private business rows in restore SQL\n'); return '';
      }
      assert.equal(connection, targetConnection);
      const file = args.find(argument => argument.startsWith('--file='))!.slice(7);
      assert.equal((await stat(file)).mode & 0o777, 0o600); refresh = await readFile(file, 'utf8');
      events.push('refresh');
      if (mode === 'restore-response-lost') throw Object.assign(new Error('private SQL password and rows'), { code: '08006' });
      return '';
    },
    ...(mode === 'migration-source' ? { readMigration: async () => 'unreviewed private SQL' } : {}),
  };
  const result = await runFinalCopy({ source: sourceConnection, target: targetConnection,
    beforeWrite: async () => { events.push('before-write'); if (mode === 'before-write') throw new MigrationError('MAIN_CHANGED'); },
    afterWrite: async () => { events.push('after-write'); if (mode === 'after-write') throw new MigrationError('PROVIDER_CHANGED'); }, ...optionsOverride }, dependencies);
  assert.equal(ended, new Set(clients).size * (events.includes('connect-0') ? 1 : 0));
  if (temporaryDirectory) await assert.rejects(stat(temporaryDirectory), { code: 'ENOENT' });
  for (const secret of [sourceConnection.password, targetConnection.password, 'private SQL', 'private business', 'postgresql://', 'database.dump']) {
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  return { result, commands, queries, events, refresh };
}

test('latest source snapshot refreshes target and applies the exact setupDatabase 019 statement in one transaction', async () => {
  const { result, commands, queries, events, refresh } = await mockRun();
  assert.equal(result.success, true); assert.equal(result.restoreStatus, 'acknowledged'); assert.equal(result.sourceUnchanged, true);
  assert.equal(result.targetTouched, true); assert.equal(result.restored, true); assert.equal(result.migrated, true); assert.equal(result.verified, true);
  assert.deepEqual(result.source, result.target); assert.notEqual(result.beforeTargetDataHash, result.source!.hashes.data);
  const dump = commands.find(command => command.program === 'pg_dump' && command.args[0] !== '--version')!;
  for (const argument of ['--schema=public','--extension=pgcrypto','--format=custom','--snapshot=00000001-00000001-1']) assert.ok(dump.args.includes(argument));
  const restore = commands.find(command => command.program === 'pg_restore' && command.args.includes('--clean'))!;
  assert.ok(restore.args.includes('--if-exists')); assert.ok(restore.args.some(argument => argument.startsWith('--use-list=')));
  const psql = commands.find(command => command.program === 'psql' && command.args[0] !== '--version')!;
  assert.ok(psql.args.includes('--single-transaction')); assert.ok(psql.args.includes('--set=ON_ERROR_STOP=1'));
  assert.ok(refresh.startsWith('ALTER TABLE public.transactions DROP COLUMN merchant_normalized;\nDROP FUNCTION public.cake_normalize_merchant(text);\n'));
  assert.ok(refresh.includes(await readFile(new URL(migration019.name, migrationDirectory), 'utf8')));
  assert.ok(refresh.includes("INSERT INTO schema_migrations (name) VALUES ('019_merchant_normalization.sql');"));
  assert.ok(!/DROP SCHEMA|CASCADE/i.test(refresh));
  assert.equal(queries[0].includes('COMMIT'), false); assert.deepEqual(events.slice(-3), ['before-write','refresh','after-write']);
  assert.ok(commands.every(command => !command.args.some(argument => argument.includes('password'))));
  const child = childEnvironment(targetConnection, { PATH: '/trusted/bin', NEON_SOURCE_API_KEY: 'private-provider', GH_TOKEN: 'private-github', PGOPTIONS: 'unsafe' });
  assert.equal(child.PGPASSWORD, targetConnection.password); assert.equal(child.PGSSLMODE, 'verify-full');
  for (const key of ['NEON_SOURCE_API_KEY','GH_TOKEN','PGOPTIONS']) assert.equal(child[key], undefined);
  assert.equal(projectFinalCopyReport({ ...result, private: sourceConnection.password } as typeof result).success, true);
  assert.throws(() => projectFinalCopyReport({ ...result, restoreStatus: 'unknown' }), /FINAL_COPY_REPORT/);
});

for (const mode of ['target-schema','target-owners','target-ledger','target-auth','postcondition','migration-source','wrong-version','before-write','target-drift','target-owner-drift'] as const) {
  test(`${mode} aborts before any target write and removes private files`, async () => {
    const { result, commands } = await mockRun(mode);
    assert.equal(result.success, false); assert.equal(result.targetTouched, false); assert.equal(result.restoreStatus, 'not-started');
    assert.equal(result.sessionsClosed, true); assert.equal(result.temporaryFilesRemoved, true);
    assert.equal(commands.some(command => command.program === 'psql' && command.args[0] !== '--version'), false);
  });
}
test('a lost restore response remains explicitly ambiguous and is never retried', async () => {
  const { result, commands, events } = await mockRun('restore-response-lost');
  assert.equal(result.success, false); assert.equal(result.stage, 'refresh'); assert.equal(result.targetTouched, true);
  assert.equal(result.restoreStatus, 'unknown'); assert.equal(result.restored, false); assert.equal(result.migrated, false); assert.equal(result.sqlstate, '08006');
  assert.equal(commands.filter(command => command.program === 'psql' && command.args[0] !== '--version').length, 1);
  assert.equal(events.includes('after-write'), false);
});
for (const mode of ['source-drift','after-write','session-cleanup'] as const) {
  test(`${mode} cannot report a completed migration even after the atomic refresh`, async () => {
    const { result } = await mockRun(mode);
    assert.equal(result.success, false); assert.equal(result.restored, true); assert.equal(result.verified, true);
    if (mode === 'source-drift') { assert.equal(result.sourceUnchanged, false); assert.match(result.code, /FINAL_COPY_SOURCE_CHANGED/); }
    if (mode === 'session-cleanup') assert.equal(result.sessionsClosed, false);
  });
}
test('connection identity is validated before creating sessions', async () => {
  const { result, commands, events } = await mockRun('ok', { target: sourceConnection });
  assert.equal(result.success, false); assert.equal(result.stage, 'connections'); assert.match(result.code, /FINAL_COPY_CONNECTION/);
  assert.deepEqual(commands, []); assert.deepEqual(events, []);
});

function fixtureSql(names: string[], data: string): string {
  return appTables.map(name => {
    const drop = `DROP TABLE IF EXISTS public.${name};`;
    if (name === 'schema_migrations') return `${drop} CREATE TABLE public.schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());\n`
      + names.map(name => `INSERT INTO public.schema_migrations VALUES ('${name}','2026-10-01 01:02:03.123456+00');`).join('\n');
    if (name === 'transactions') return `${drop} CREATE TABLE public.transactions(id int PRIMARY KEY,workspace_id uuid NOT NULL,merchant text NOT NULL,memo text NOT NULL,created_at timestamptz NOT NULL);\n`
      + `INSERT INTO public.transactions VALUES(1,'00000000-0000-4000-8000-000000000001','  ＡＢＣ　Café  ','${data}','2026-10-01 01:02:03.654321+00');`;
    return `${drop} CREATE TABLE public.${name}(id int PRIMARY KEY,value text,created_at timestamptz NOT NULL);\n`
      + `INSERT INTO public.${name} VALUES(1,'${data}','2026-10-01 01:02:03.987654+00');`;
  }).join('\n');
}
function localClient(db: PGlite): Sql {
  return { connect: async () => undefined, end: async () => undefined, query: async (text, values) => {
    if (values) return db.query(text, values);
    const result = await db.exec(text); return { rows: result.at(-1)?.rows as Record<string, unknown>[] ?? [] };
  } };
}
test('real SQL refresh replaces all 13 tables and rolls back the original 019 target completely on an in-transaction failure', async t => {
  const sourceDb = new PGlite(), targetDb = new PGlite(); t.after(async () => { await sourceDb.close(); await targetDb.close(); });
  const names = await previousNames(), originalMigration = await readFile(new URL(migration019.name, migrationDirectory), 'utf8');
  const sourceSql = fixtureSql(names, 'source-private'), targetSql = fixtureSql(names, 'target-private');
  await sourceDb.exec(sourceSql); await targetDb.exec(`${targetSql}\n${originalMigration}`);
  await targetDb.query('INSERT INTO schema_migrations(name) VALUES ($1)', [migration019.name]);
  const source = localClient(sourceDb), target = localClient(targetDb);
  const beforeSource = await productionSchemaSnapshot(source), beforeTarget = await productionSchemaSnapshot(target);
  let injectedFailure = true, targetReads = 0;
  const overrides: Partial<FinalCopyDependencies> = { client: connection => connection === sourceConnection ? source : target,
    begin: async sql => { await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); return '00000001-00000001-1'; },
    inspect: async sql => snapshot(sql === source, sql === target && ++targetReads >= 3),
    command: async (program, args) => {
      if (args[0] === '--version') return `${program} (PostgreSQL) 18.6`;
      if (program === 'pg_dump') { await writeFile(args.find(argument => argument.startsWith('--file='))!.slice(7), 'private archive'); return ''; }
      if (program === 'pg_restore' && args[0] === '--list') return toc;
      if (program === 'pg_restore') { await writeFile(args.find(argument => argument.startsWith('--file='))!.slice(7), sourceSql); return ''; }
      const sql = await readFile(args.find(argument => argument.startsWith('--file='))!.slice(7), 'utf8');
      await targetDb.exec('BEGIN');
      try { await targetDb.exec(sql); if (injectedFailure) await targetDb.query('SELECT 1/0'); await targetDb.exec('COMMIT'); }
      catch (error) { await targetDb.exec('ROLLBACK'); throw error; }
      return '';
    } };
  const options = { source: sourceConnection, target: targetConnection, beforeWrite: async () => undefined, afterWrite: async () => undefined };
  const failed = await runFinalCopy(options, overrides);
  assert.equal(failed.success, false); assert.equal(failed.restoreStatus, 'unknown'); assert.equal(failed.sqlstate, '22012');
  assert.deepEqual(await productionSchemaSnapshot(target), beforeTarget); assert.equal(await productionSchemaPostconditions(target), 0);
  assert.deepEqual(await productionSchemaSnapshot(source), beforeSource);
  injectedFailure = false; targetReads = 0;
  const passed = await runFinalCopy(options, overrides);
  assert.equal(passed.success, true); assert.equal(passed.restoreStatus, 'acknowledged');
  assert.deepEqual(await productionSchemaSnapshot(target), beforeSource); assert.equal(await productionSchemaPostconditions(target), 0);
  assert.deepEqual(await productionSchemaSnapshot(source), beforeSource);
  assert.notEqual(beforeSource.hashes.data, beforeTarget.hashes.data);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, hash, MigrationError, type Connection } from '../scripts/production-db-migration-provider';
import { appTables, type Snapshot, type Sql } from '../scripts/production-db-migration-inventory';
import { assertEmptyTarget, assertUnconnectedTarget, childEnvironment, context, restoreList, runMigration, serializeReceipt, type Dependencies } from '../scripts/production-db-migration';

const sha = 'a'.repeat(40), operation = '10000000-0000-4000-8000-000000000001';
const event = { repository: { full_name: config.repository, id: config.repositoryId }, inputs: { action: 'rehearsal', controlSha: sha, operation } };
const environment = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: config.repository, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: `${config.repository}/${config.workflow}@refs/heads/main`, GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
  NEON_API_KEY: 'never-publish-provider', VERCEL_TOKEN: 'never-publish-vercel', GH_TOKEN: 'never-publish-github' };
const toc = [
  '; archive', '1; 2615 2200 SCHEMA - public pg_database_owner', '2; 3079 17000 EXTENSION - pgcrypto ',
  '3; 0 0 COMMENT - EXTENSION pgcrypto ', '4; 1259 17001 TABLE public app_users neondb_owner',
  '5; 0 17001 TABLE DATA public app_users neondb_owner', '6; 0 0 ACL - SCHEMA public pg_database_owner',
  '7; 826 18001 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES cloud_admin',
  '8; 826 18002 DEFAULT ACL public DEFAULT PRIVILEGES FOR SEQUENCES cloud_admin',
].join('\n');
const credentials: Connection = { host: 'ep-fixture.ap-southeast-1.aws.neon.tech', user: 'neondb_owner', database: 'neondb', port: 5432, password: 'never-publish-password' };
const store = { id: config.targetStoreId, ownerId: config.vercelTeamId, type: 'integration', externalResourceId: config.target.projectId,
  status: 'available', totalConnectedProjects: 0, projectsMetadata: [] };
function snapshot(empty = false): Snapshot {
  return { empty, schemaOwner: 'pg_database_owner', tables: empty ? [] : [...appTables], tableHashes: empty ? [] : appTables.map(name => hash(name)), ledger: [],
    extensions: empty ? ['plpgsql'] : ['pgcrypto','plpgsql'], summary: { counts: empty ? [] : appTables.map(() => 0), dataHash: hash('data'), schemaHash: hash('schema'),
      aclHash: hash('acl'), ledgerHash: hash('ledger'), authSchemaHash: hash('auth'), authRows: 0, publicTables: empty ? 0 : 13,
      version: 180006, bytes: 1000, localeHash: hash('locale'), roleHash: hash('role'), extensionsHash: hash('extensions'),
      defaultAclHash: hash('managed18'), extensionAclHash: hash('extension-acl') } };
}

test('workflow context binds trusted main, exact checkout and operation before any provider access', () => {
  assert.equal(context(environment, event, sha).action, 'rehearsal');
  const failures = [{ ...environment, GITHUB_ACTIONS: 'false' }, { ...environment, GITHUB_REF: 'refs/heads/codex/unsafe' },
    { ...environment, GITHUB_EVENT_NAME: 'pull_request_target' }, { ...environment, GITHUB_SHA: 'b'.repeat(40) },
    { ...environment, GITHUB_WORKFLOW_REF: `${config.repository}/${config.workflow}@refs/heads/codex/unsafe` },
    { ...environment, GITHUB_RUN_ATTEMPT: '2' }];
  for (const input of failures) assert.throws(() => context(input, event, sha), /UNTRUSTED_WORKFLOW/);
  for (const inputs of [{ ...event.inputs, controlSha: 'b'.repeat(40) }, { ...event.inputs, action: 'cutover' },
    { ...event.inputs, targetProjectId: 'another' }, { ...event.inputs, operation: '$(echo unsafe)' }]) {
    assert.throws(() => context(environment, { ...event, inputs }, sha), /UNTRUSTED_WORKFLOW/);
  }
});

test('child credentials exist only in libpq environment with system TLS and no inherited overrides', () => {
  const inherited = { ...environment, PATH: '/trusted/bin', HOME: '/private', PGHOST: 'attacker', PGOPTIONS: '-c unsafe',
    NODE_OPTIONS: '--require=/unsafe', SSL_CERT_FILE: '/unsafe', PGPASSFILE: '/unsafe' };
  const child = childEnvironment(credentials, inherited);
  assert.equal(child.PGPASSWORD, credentials.password); assert.equal(child.PGSSLMODE, 'verify-full'); assert.equal(child.PGSSLROOTCERT, 'system');
  assert.equal(child.PGHOST, credentials.host); assert.equal(child.PGPASSFILE, '/dev/null');
  for (const key of ['NEON_API_KEY','VERCEL_TOKEN','GH_TOKEN','PGOPTIONS','NODE_OPTIONS','HOME','SSL_CERT_FILE']) assert.equal(child[key], undefined);
  assert.equal(childEnvironment(undefined, inherited).PGPASSWORD, undefined);
});

test('restore TOC omits only existing public creation, pinned extension creation and two managed defaults', () => {
  const filtered = restoreList(toc);
  assert.equal(filtered.split('\n').filter(line => line.startsWith(';') && !line.startsWith('; archive')).length, 4);
  for (const kept of ['COMMENT - EXTENSION pgcrypto', 'TABLE public app_users', 'TABLE DATA public app_users', 'ACL - SCHEMA public']) {
    assert.ok(filtered.split('\n').some(line => !line.startsWith(';') && line.includes(kept)));
  }
  for (const bad of [toc.replace('SCHEMA - public','SCHEMA - another'), toc.replace('EXTENSION - pgcrypto','EXTENSION - unknown'),
    toc.replace('FOR TABLES cloud_admin','FOR TABLES another'), toc.replace('FOR SEQUENCES','FOR TABLES'),
    toc + '\n9; 1259 18003 TABLE neon_auth jwks neon_auth', toc + '\n9; 1259 18003 TABLE unknown secrets admin']) {
    assert.throws(() => restoreList(bad), /DUMP_CONTENT/);
  }
});

test('only an unconnected fixed Native candidate and empty compatible dataset can be restored', async () => {
  await assertUnconnectedTarget(async () => ({ store }));
  for (const delta of [{ totalConnectedProjects: 1 }, { projectsMetadata: [{}] }, { externalResourceId: config.source.projectId },
    { ownerId: 'team_another' }, { status: 'pending' }]) {
    await assert.rejects(assertUnconnectedTarget(async () => ({ store: { ...store, ...delta } })), /TARGET_CONNECTED/);
  }
  const source = snapshot(), target = snapshot(true); assertEmptyTarget(source, target);
  for (const changed of [{ ...target, empty: false }, { ...target, schemaOwner: 'another' },
    { ...target, summary: { ...target.summary, localeHash: hash('another') } }]) assert.throws(() => assertEmptyTarget(source, changed), /TARGET_NOT_EMPTY|DATABASE_COMPATIBILITY/);
});

async function runFixture(mode: 'success' | 'dump-failure' | 'restore-failure' | 'main-changed' | 'not-empty' | 'hash-mismatch', action: 'inventory' | 'rehearsal' = 'rehearsal', failedStage?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'cake-migration-unit-'));
  const eventPath = join(directory, 'event.json'), receiptPath = join(directory, 'receipt.json');
  await writeFile(eventPath, JSON.stringify({ ...event, inputs: { ...event.inputs, action } }));
  const source = snapshot(), empty = snapshot(true), restored = snapshot();
  source.summary.version = 170011; source.summary.defaultAclHash = hash('managed17');
  source.ledger = (await readdir('db/migrations')).filter(name => /^0(?:0[1-9]|1[0-8])_/.test(name)).sort(); restored.ledger = [...source.ledger];
  if (mode === 'hash-mismatch') restored.summary.dataHash = hash('different');
  const commands: { program: string; args: string[]; credentials?: Connection }[] = [], queries: string[] = [];
  const clients: Sql[] = [];
  let targetReads = 0, mainReads = 0, ended = 0, privateDirectory: string | undefined;
  const failAt = (stage: string) => {
    if (stage === failedStage) throw new MigrationError('PROVIDER_NEON_HTTP_404');
  };
  const dependencies: Partial<Dependencies> = {
    receiptPath, head: () => sha, now: () => '2026-10-23T00:00:00.000Z',
    binding: async (_api, binding) => { failAt(binding === config.source ? 'source-binding' : 'target-binding'); },
    resolveConnection: async (_api, binding) => { failAt(binding === config.source ? 'source-connection' : 'target-connection'); return credentials; },
    api: async (provider) => {
      failAt(provider === 'vercel' ? 'target-store' : 'main-check');
      return provider === 'vercel' ? { store } : { ref: 'refs/heads/main', object: { type: 'commit',
        sha: mode === 'main-changed' && ++mainReads > 1 ? 'b'.repeat(40) : sha } };
    },
    client: () => {
      const sql: Sql = { connect: async () => undefined, query: async text => { queries.push(text); return { rows: [{ version: '1.3' }] }; }, end: async () => { ended++; } };
      clients.push(sql); return sql;
    },
    begin: async (sql) => { queries.push(sql === clients[0] ? 'BEGIN SOURCE READ ONLY' : 'BEGIN TARGET READ ONLY'); return '00000001-00000001-1'; },
    inspect: async sql => sql === clients[0] ? source : mode === 'not-empty' ? restored : ++targetReads < 3 ? empty : restored,
    command: async (program, args, connection) => {
      commands.push({ program, args: [...args], credentials: connection });
      if (args[0] === '--version') return `${program} (PostgreSQL) 18.6`;
      if (program === 'pg_dump') {
        const path = args.find(arg => arg.startsWith('--file='))!.slice(7); privateDirectory = path.slice(0, path.lastIndexOf('/'));
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
        if (mode === 'dump-failure') throw new Error('raw SQL password never-publish-password');
        await writeFile(path, 'private archive'); return '';
      }
      if (program === 'pg_restore' && args[0] === '--list') return toc;
      if (program === 'pg_restore') {
        const path = args.find(arg => arg.startsWith('--file='))!.slice(7); await writeFile(path, 'private SQL'); return '';
      }
      if (mode === 'restore-failure') throw new Error('raw business row never-publish-password');
      return '';
    },
  };
  try {
    const result = await runMigration({ ...environment, GITHUB_EVENT_PATH: eventPath }, dependencies);
    assert.equal(ended, failedStage ? 0 : 2); assert.equal(result.temporaryFilesRemoved, true);
    if (privateDirectory) await assert.rejects(stat(privateDirectory), { code: 'ENOENT' });
    const raw = await readFile(receiptPath, 'utf8');
    for (const secret of [credentials.password, environment.NEON_API_KEY, environment.VERCEL_TOKEN, 'raw SQL', 'raw business row']) assert.ok(!raw.includes(secret));
    assert.ok(Buffer.byteLength(raw) <= 4096);
    return { result, commands, queries };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('rehearsal shares the source snapshot and atomically restores pinned pgcrypto plus public data', async () => {
  const { result, commands, queries } = await runFixture('success');
  assert.equal(result.success, true); assert.equal(result.restored, true);
  const dump = commands.find(command => command.program === 'pg_dump' && command.args[0] !== '--version')!;
  assert.ok(dump.args.includes('--snapshot=00000001-00000001-1')); assert.ok(dump.args.includes('--schema=public')); assert.ok(dump.args.includes('--extension=pgcrypto'));
  const execution = commands.find(command => command.program === 'psql' && command.args[0] !== '--version')!;
  assert.ok(execution.args.includes('--single-transaction')); assert.ok(execution.args.includes('--set=ON_ERROR_STOP=1'));
  assert.ok(execution.args.some(arg => arg.includes("VERSION '1.3'"))); assert.equal(execution.credentials, credentials);
  assert.ok(commands.every(command => !JSON.stringify(command.args).includes(credentials.password)));
  assert.equal(queries.filter(query => query === 'BEGIN SOURCE READ ONLY').length, 2);
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(serializeReceipt({ ...result, private: credentials.password } as typeof result), serializeReceipt(result));
});

for (const stage of ['main-check','source-binding','target-binding','target-store','source-connection','target-connection']) {
  test(`inventory identifies ${stage} failure before any SQL connection or copy`, async () => {
    const { result, commands, queries } = await runFixture('success', 'inventory', stage);
    assert.equal(result.success, false); assert.equal(result.stage, stage);
    assert.equal(result.code, 'PRODUCTION_MIGRATION_PROVIDER_NEON_HTTP_404');
    assert.equal(result.restored, false); assert.equal(result.source, undefined); assert.equal(result.target, undefined);
    assert.deepEqual(commands, []); assert.deepEqual(queries, []);
    assert.equal(JSON.parse(serializeReceipt(result)).stage, stage);
    for (const code of ['PRODUCTION_MIGRATION_PROVIDER_NEON_HTTP_999', 'PRODUCTION_MIGRATION_PROVIDER_UNKNOWN_HTTP_404',
      'PRODUCTION_MIGRATION_PROVIDER_NEON_HTTP_404_PRIVATE', 'PRODUCTION_MIGRATION_secret_404']) {
      assert.throws(() => serializeReceipt({ ...result, code }), /INVALID_RECEIPT/);
    }
  });
}

test('inventory can reconcile an existing candidate after a copy without running a restore or deleting data', async () => {
  const { result, commands } = await runFixture('not-empty', 'inventory');
  assert.equal(result.success, true); assert.equal(result.restored, false); assert.equal(result.target?.publicTables, 13);
  assert.deepEqual(commands, []);
});

for (const mode of ['dump-failure','restore-failure','main-changed','not-empty','hash-mismatch'] as const) {
  test(`rehearsal stops and removes private files on ${mode}`, async () => {
    const { result, commands } = await runFixture(mode);
    assert.equal(result.success, false);
    if (['dump-failure','main-changed','not-empty'].includes(mode)) assert.ok(!commands.some(command => command.program === 'psql' && command.args[0] !== '--version'));
    if (mode === 'hash-mismatch') assert.equal(result.restored, true);
  });
}

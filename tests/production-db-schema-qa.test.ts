import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, hash, MigrationError, type Connection } from '../scripts/production-db-migration-provider';
import { appTables, type Snapshot, type Sql } from '../scripts/production-db-migration-inventory';
import { migration019, projectSchemaQaReport, runSchemaQa, schemaQaContext, schemaQaProtocol, schemaQaWorkflow,
  serializeSchemaQaReceipt, type SchemaQaDependencies, type SchemaQaReceipt } from '../scripts/production-db-schema-qa';
import type { ProductionSchemaScenarioReport } from '../scripts/production-db-schema-scenarios';

const sha = 'a'.repeat(40), operation = '10000000-0000-4000-8000-000000000001';
const event = { repository: { full_name: config.repository, id: config.repositoryId }, inputs: { controlSha: sha, operation } };
const environment = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: config.repository, GITHUB_REPOSITORY_ID: String(config.repositoryId),
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: `${config.repository}/${schemaQaWorkflow}@refs/heads/main`,
  GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', NEON_SOURCE_API_KEY: 'never-publish-source', NEON_TARGET_API_KEY: 'never-publish-target',
  VERCEL_TOKEN: 'never-publish-vercel', GH_TOKEN: 'never-publish-github' };
const credentials: Connection = { host: 'ep-fixture.ap-southeast-1.aws.neon.tech', user: 'neondb_owner', database: 'neondb',
  port: 5432, password: 'never-publish-password' };
const store = { id: config.targetStoreId, ownerId: config.vercelTeamId, type: 'integration', externalResourceId: config.target.projectId,
  status: 'available', totalConnectedProjects: 0, projectsMetadata: [] };
function report(): ProductionSchemaScenarioReport {
  const counts = appTables.map(() => 0); counts[appTables.indexOf('schema_migrations')] = 18;
  return { success: true, cases: [{ n: 'scratch', ms: 1 }, { n: 'copy', ms: 1 }, { n: 'race', ms: 1 }, { n: 'schema', ms: 1 }, { n: 'repeat', ms: 1 }], pids: [11,12,13], counts,
    hashes: { data: hash('data'), schema: hash('schema'), acl: hash('acl'), ledger: hash('ledger'), owners: hash('owners') },
    scratch: { success: true, cases: 3, ms: 1, waitMs: 1, exclusive: true, cleanup: [0,0,0,0], restored: true },
    race: { queries: [3,3], reads: [1,1], writer: 11, waiter: 12, ddl: true, advisory: true, ms: 1 }, repeat: { reads: 0, queries: 2 },
    unchanged: { scratch: true, migration: true, repeat: true }, mismatches: 0, restored: true, failures: [], ms: 2 };
}
function snapshot(ledger: string[]): Snapshot {
  const counts = appTables.map(() => 0); counts[appTables.indexOf('schema_migrations')] = ledger.length;
  return { empty: false, schemaOwner: 'pg_database_owner', tables: [...appTables], tableHashes: appTables.map(hash), ledger,
    extensions: ['pgcrypto','plpgsql'], summary: { counts, dataHash: hash('data'), schemaHash: hash('schema'), aclHash: hash('acl'),
      ledgerHash: hash('ledger'), authSchemaHash: hash('auth'), authRows: 0, publicTables: 13, version: 180006, bytes: 1000,
      localeHash: hash('locale'), roleHash: hash('role'), extensionsHash: hash('extensions'), defaultAclHash: hash('managed18'), extensionAclHash: hash('extension-acl') } };
}
type FixtureOptions = { env?: Record<string, string | undefined>; input?: unknown; events?: string[]; before?: (value: Snapshot) => void;
  after?: (value: Snapshot) => void; prerequisites?: Record<string, unknown>; connectedOn?: number; failure?: unknown;
  report?: ProductionSchemaScenarioReport; endFailure?: boolean; rollbackFailure?: boolean };
async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cake-schema-qa-unit-')), events = options.events ?? [];
  const eventPath = join(directory, 'event.json'), receiptPath = join(directory, 'receipt.json');
  await writeFile(eventPath, JSON.stringify(options.input ?? event));
  const ledger = (await readdir('db/migrations')).filter(name => /^0(?:0[1-9]|1[0-8])_/.test(name)).sort();
  const before = snapshot(ledger), after = snapshot([...ledger, migration019.name]); options.before?.(before); options.after?.(after);
  // Full data/schema hashes necessarily change after 019; only stable metadata is compared outside the scenario.
  after.summary.dataHash = hash('data-with-generated-column'); after.summary.schemaHash = hash('schema-with-019');
  after.summary.ledgerHash = hash('ledger-with-019'); after.summary.aclHash = hash('acl-with-019-function');
  const clients: Sql[] = [], connectionBindings: unknown[] = [], clientConnections: Connection[] = [];
  let inspections = 0, stores = 0, ended = 0;
  const dependencies: Partial<SchemaQaDependencies> = {
    receiptPath, head: () => sha, now: () => '2026-10-23T00:00:00.000Z',
    binding: async (_api, binding) => { events.push(`binding:${binding.projectId}`); },
    resolveConnection: async (_api, binding) => { connectionBindings.push(binding); events.push('target-uri'); return credentials; },
    api: async provider => {
      events.push(`api:${provider}`);
      return provider === 'vercel' ? { store: { ...store, totalConnectedProjects: ++stores === options.connectedOn ? 1 : 0 } }
        : { ref: 'refs/heads/main', object: { type: 'commit', sha } };
    },
    client: connection => {
      clientConnections.push(connection);
      const index = clients.length;
      const client: Sql = { connect: async () => { events.push(`connect:${index}`); }, query: async text => {
        events.push(`sql:${index}:${text === 'ROLLBACK' ? 'ROLLBACK' : 'prerequisites'}`);
        if (text === 'ROLLBACK' && options.rollbackFailure) throw new Error('never-publish-rollback');
        return { rows: [{ unicode_fast: true, function_exists: false, column_exists: false, index_exists: false, ...options.prerequisites }] };
      }, end: async () => { events.push(`end:${index}`); ended++; if (options.endFailure && index === 0) throw new Error('never-publish-close'); } };
      clients.push(client); return client;
    },
    begin: async (client, binding) => {
      assert.equal(binding, config.target); assert.equal(client, clients[2]); events.push('read-only-snapshot'); return '00000001-00000001-1';
    },
    inspect: async () => ++inspections === 1 ? before : after,
    scenarios: async (first, second, observer, migration, scenarioOptions) => {
      assert.deepEqual([first,second,observer], clients); assert.equal(new Set(clients).size, 3);
      assert.equal(migration.name, migration019.name); assert.equal(hash(migration.sql), migration019.sha256);
      events.push('scratch-write'); await scenarioOptions?.beforePublicMigration?.(); events.push('public-write');
      if (options.failure) throw options.failure;
      return options.report ?? report();
    },
  };
  try {
    const result = await runSchemaQa({ ...environment, GITHUB_EVENT_PATH: eventPath, ...options.env }, dependencies);
    assert.equal(ended, clients.length);
    const raw = await readFile(receiptPath, 'utf8');
    assert.equal((await stat(receiptPath)).mode & 0o777, 0o600); assert.ok(Buffer.byteLength(raw) <= 4096);
    for (const secret of [credentials.password, ...Object.values(environment).filter(value => value.startsWith('never-publish')), 'raw SQL', 'raw business row']) assert.ok(!raw.includes(secret));
    return { result, raw, events, connectionBindings, clientConnections, stores };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('schema QA context accepts only initial dispatch of exact reviewed main and two fixed inputs', async () => {
  assert.deepEqual(schemaQaContext(environment, event, sha), { controlSha: sha, operation, runId: '123', runAttempt: 1 });
  const invalidEnvironments = [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY_ID: '1' }, { GITHUB_REPOSITORY: 'another/Cake' },
    { GITHUB_REF: 'refs/heads/codex/unsafe' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_SHA: 'b'.repeat(40) },
    { GITHUB_WORKFLOW_REF: `${config.repository}/${config.workflow}@refs/heads/main` }, { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_RUN_ID: '01' }];
  for (const env of invalidEnvironments) {
    const events: string[] = [];
    await assert.rejects(fixture({ env, events }), /UNTRUSTED_WORKFLOW/); assert.deepEqual(events, []);
  }
  for (const input of [{ ...event, repository: { ...event.repository, id: 1 } },
    ...[{ controlSha: 'b'.repeat(40) }, { operation: '$(unsafe)' }, { sql: 'SELECT 1' }, { url: 'postgres://unsafe' }, { target: 'another' }]
      .map(delta => ({ ...event, inputs: { ...event.inputs, ...delta } }))]) {
    const events: string[] = [];
    await assert.rejects(fixture({ input, events }), /UNTRUSTED_WORKFLOW/); assert.deepEqual(events, []);
  }
});

for (const [label, env, code] of [
  ['source missing', { NEON_SOURCE_API_KEY: undefined }, 'SOURCE_CREDENTIALS_MISSING'],
  ['target missing', { NEON_TARGET_API_KEY: '' }, 'TARGET_CREDENTIALS_MISSING'],
  ['legacy fallback only', { NEON_SOURCE_API_KEY: undefined, NEON_TARGET_API_KEY: undefined, NEON_API_KEY: 'private-legacy' }, 'SOURCE_CREDENTIALS_MISSING'],
  ['source newline', { NEON_SOURCE_API_KEY: 'private\nsource' }, 'SOURCE_CREDENTIALS_INVALID'],
  ['target newline', { NEON_TARGET_API_KEY: 'private\rtarget' }, 'TARGET_CREDENTIALS_INVALID'],
  ['shared credentials', { NEON_TARGET_API_KEY: environment.NEON_SOURCE_API_KEY }, 'CREDENTIALS_NOT_SEPARATED'],
  ['missing vercel', { VERCEL_TOKEN: '' }, 'CREDENTIALS_MISSING'],
  ['multiline github', { GH_TOKEN: 'private\ngithub' }, 'CREDENTIALS_MISSING'],
  ['TLS disabled', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'CREDENTIALS_MISSING'],
] as const) {
  test(`schema QA rejects ${label} before any provider read, URI retrieval or SQL`, async () => {
    const { result, events, connectionBindings, clientConnections } = await fixture({ env });
    assert.equal(result.success, false); assert.equal(result.stage, 'credentials'); assert.equal(result.code, `PRODUCTION_MIGRATION_${code}`);
    assert.deepEqual(events, []); assert.deepEqual(connectionBindings, []); assert.deepEqual(clientConnections, []);
  });
}

test('schema QA gets only the target URI, opens exactly three target sessions and rechecks all bindings before writes and after completion', async () => {
  const { result, events, connectionBindings, clientConnections, stores } = await fixture();
  assert.equal(result.success, true); assert.equal(result.sessionsClosed, true); assert.equal(stores, 4);
  assert.deepEqual(connectionBindings, [config.target]); assert.equal(clientConnections.length, 3);
  assert.ok(clientConnections.every(connection => connection === credentials));
  assert.equal(events.filter(event => event === `binding:${config.source.projectId}`).length, 4);
  const scratch = events.indexOf('scratch-write'), publicWrite = events.indexOf('public-write');
  assert.equal(events[scratch - 1], 'api:vercel'); assert.equal(events[publicWrite - 1], 'api:vercel');
  assert.ok(events.indexOf('sql:2:ROLLBACK') < scratch);
  assert.equal(events.filter(event => /^end:/.test(event)).length, 3);
});

for (const [label, before, prerequisites] of [
  ['019 already applied', (value: Snapshot) => { value.ledger.push(migration019.name); }, undefined],
  ['missing 018', (value: Snapshot) => { value.ledger.pop(); }, undefined],
  ['duplicate ledger row', (value: Snapshot) => { value.summary.counts[appTables.indexOf('schema_migrations')]++; }, undefined],
  ['unexpected table', (value: Snapshot) => { value.tables.push('unexpected'); }, undefined],
  ['Auth in use', (value: Snapshot) => { value.summary.authRows = 1; }, undefined],
  ['PG17', (value: Snapshot) => { value.summary.version = 170011; }, undefined],
  ['missing Unicode authority', undefined, { unicode_fast: false }],
  ['existing function', undefined, { function_exists: true }],
  ['existing generated column', undefined, { column_exists: true }],
  ['existing index', undefined, { index_exists: true }],
] as const) {
  test(`schema QA rejects ${label} in a read-only probe before scenario writes`, async () => {
    const { result, events } = await fixture({ before, prerequisites });
    assert.equal(result.success, false); assert.equal(result.stage, 'target-preflight');
    assert.ok(!events.includes('scratch-write')); assert.ok(!events.includes('public-write'));
    assert.equal(events.filter(event => /^end:/.test(event)).length, 3);
  });
}

for (const connectedOn of [2,3,4]) {
  test(`schema QA fails closed when Native candidate becomes connected at check ${connectedOn}`, async () => {
    const { result, events } = await fixture({ connectedOn });
    assert.equal(result.success, false); assert.equal(result.code, 'PRODUCTION_MIGRATION_TARGET_CONNECTED');
    if (connectedOn < 4) assert.ok(!events.includes('public-write'));
    if (connectedOn === 2) assert.ok(!events.includes('scratch-write'));
  });
}

test('post migration metadata checks retain Auth, default ACL, locale, roles, extensions and extension ACL', async () => {
  for (const key of ['authSchemaHash','defaultAclHash','localeHash','roleHash','extensionsHash','extensionAclHash'] as const) {
    const { result } = await fixture({ after: value => { value.summary[key] = hash('changed'); } });
    assert.equal(result.success, false); assert.equal(result.stage, 'target-verification');
    assert.equal(result.code, 'PRODUCTION_MIGRATION_SCHEMA_QA_TARGET_CHANGED');
  }
});

test('raw SQL/provider errors are replaced with fixed diagnostics, SQLSTATE is bounded, and all sessions close', async () => {
  for (const error of [Object.assign(new Error('raw SQL raw business row never-publish-password'), { code: '22012' }),
    Object.assign(new Error('raw SQL'), { code: 'never-publish-password' }), new MigrationError('RAW_SECRET_PASSWORD')]) {
    const { result, raw, events } = await fixture({ failure: error });
    assert.equal(result.success, false); assert.equal(result.stage, 'scenarios'); assert.equal(result.code, 'PRODUCTION_MIGRATION_FAILED');
    assert.equal(result.sqlstate, 'code' in error && error.code === '22012' ? '22012' : null);
    assert.equal(events.filter(event => /^end:/.test(event)).length, 3); assert.ok(!raw.includes('RAW_SECRET_PASSWORD'));
  }
});

test('failed scenario evidence is retained, while session cleanup failures prevent a successful receipt', async () => {
  const failed = report(); failed.success = false; failed.failures = [{ stage: 'race', sqlstate: '55P03' }];
  const { result } = await fixture({ report: failed });
  assert.equal(result.code, 'PRODUCTION_MIGRATION_SCHEMA_QA_SCENARIOS_FAILED'); assert.equal(result.report?.failures[0].sqlstate, '55P03');
  for (const option of [{ endFailure: true }, { rollbackFailure: true }]) {
    const { result: cleanup, events } = await fixture(option);
    assert.equal(cleanup.success, false); assert.equal(cleanup.sessionsClosed, false); assert.equal(cleanup.stage, 'session-cleanup');
    assert.equal(events.filter(event => /^end:/.test(event)).length, 3);
  }
});

test('notice serialization reprojects nested evidence and rejects changed provenance or impossible success', async () => {
  const { result } = await fixture();
  const withPrivate = structuredClone(result) as SchemaQaReceipt & { raw: string };
  withPrivate.raw = 'never-publish-password'; Object.assign(withPrivate.report!.scratch!, { raw: 'raw SQL' });
  assert.equal(serializeSchemaQaReceipt(withPrivate), serializeSchemaQaReceipt(result));
  assert.ok(Buffer.byteLength(serializeSchemaQaReceipt(result)) < 4096);
  assert.equal(JSON.parse(serializeSchemaQaReceipt(result)).protocol, schemaQaProtocol);
  for (const delta of [{ protocol: config.protocol }, { configHash: hash('wrong') }, { targetProject: config.source.projectId },
    { targetBranch: 'another' }, { targetEndpoint: 'another' }, { targetHostDigest: hash('wrong') }, { migrationSha256: hash('wrong') },
    { runAttempt: 2 }, { operation: 'arbitrary' }, { code: 'PRODUCTION_MIGRATION_RAW_SECRET' }, { sqlstate: 'private' },
    { sessionsClosed: false }, { report: undefined }, { checkedAt: '2026-10-22T00:00:00.000Z' }]) {
    assert.throws(() => serializeSchemaQaReceipt({ ...result, ...delta } as SchemaQaReceipt), /INVALID_RECEIPT/);
  }
  const invalid = report(); invalid.scratch!.cleanup = [0,0,1,0]; assert.throws(() => projectSchemaQaReport(invalid), /INVALID_RECEIPT/);
  invalid.success = false; invalid.failures = Array.from({ length: 13 }, () => ({ stage: 'race' as const, sqlstate: null }));
  assert.throws(() => projectSchemaQaReport(invalid), /INVALID_RECEIPT/);
  const tooLarge = { ...result, runId: '1'.repeat(5000) }; assert.throws(() => serializeSchemaQaReceipt(tooLarge), /INVALID_RECEIPT/);
});

test('workflow shares migration exclusion, pins reviewed main and confines credentials to the runtime step', async () => {
  const workflow = await readFile('.github/workflows/production-db-schema-qa.yml', 'utf8');
  assert.match(workflow, /^name: Cake Production DB Schema QA$/m); assert.match(workflow, /^run-name: Production DB schema QA \$\{\{ inputs.operation \}\}$/m);
  assert.match(workflow, /group: cake-production-db-migration\n  cancel-in-progress: false/);
  assert.match(workflow, /github.repository == 'tyask\/Cake' && github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /inputs.controlSha == github.sha/); assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/); assert.match(workflow, /timeout-minutes: 25/);
  assert.match(workflow, /node-version: '24.19.0'/); assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /permissions: \{\}/); assert.match(workflow, /permissions:\n      contents: read/);
  assert.ok(!/NEON_API_KEY:|secrets\.NEON_API_KEY|pull_request|artifacts|checks:|id-token:/.test(workflow));
  const steps = workflow.split(/^      - /m), credentialSteps = steps.filter(step => /(?:secrets\.|GH_TOKEN:)/.test(step));
  assert.equal(credentialSteps.length, 1); assert.ok(credentialSteps[0].startsWith('name: Verify the fixed Production schema candidate'));
  assert.match(credentialSteps[0], /NEON_SOURCE_API_KEY: \$\{\{ secrets.PRODUCTION_DB_SOURCE_NEON_API_KEY \}\}/);
  assert.match(credentialSteps[0], /NEON_TARGET_API_KEY: \$\{\{ secrets.PRODUCTION_DB_TARGET_NEON_API_KEY \}\}/);
  const publish = steps.find(step => step.startsWith('name: Publish the public receipt'))!;
  assert.ok(publish.includes('scripts/production-db-schema-qa.ts --notice')); assert.ok(!publish.includes('env:'));
  const inputs = workflow.slice(workflow.indexOf('    inputs:'), workflow.indexOf('permissions: {}'));
  assert.deepEqual([...inputs.matchAll(/^      (\w+):$/gm)].map(match => match[1]), ['controlSha','operation']);
});

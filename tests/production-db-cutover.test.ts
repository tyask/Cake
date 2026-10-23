import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessAssumption, cutoverContext, cutoverProtocol, cutoverWorkflow, runCutover, serializeCutoverReceipt,
  type CutoverDependencies, type CutoverReceipt } from '../scripts/production-db-cutover';
import { config, hash, MigrationError, type Connection, type Environment } from '../scripts/production-db-migration-provider';
import { appTables } from '../scripts/production-db-migration-inventory';
import type { FinalCopyReport } from '../scripts/production-db-final-copy';
import { productionAliases, type ProductionSwitchReport } from '../scripts/production-db-cutover-vercel';

const sha = 'a'.repeat(40), operation = '10000000-0000-4000-8000-000000000001';
const event = { repository: { full_name: config.repository, id: config.repositoryId }, inputs: { controlSha: sha, operation } };
const environment = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: config.repository, GITHUB_REPOSITORY_ID: String(config.repositoryId),
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: `${config.repository}/${cutoverWorkflow}@refs/heads/main`,
  GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', NEON_SOURCE_API_KEY: 'never-publish-source', NEON_TARGET_API_KEY: 'never-publish-target',
  VERCEL_TOKEN: 'never-publish-vercel', GH_TOKEN: 'never-publish-github' };
const secret = 'never-publish-private-row-or-connection';
function copyReport(): FinalCopyReport {
  const counts = appTables.map(() => 0); counts[appTables.indexOf('schema_migrations')] = 18;
  const source = { counts, hashes: { data: hash('data'), schema: hash('schema'), acl: hash('acl'), ledger: hash('ledger'), owners: hash('owners') } };
  return { success: true, stage: 'completed', code: 'OK', sqlstate: null,
    cases: [{ stage: 'dump', ms: 1 }, { stage: 'refresh', ms: 2 }, { stage: 'source-verification', ms: 1 }], ms: 4,
    source, target: structuredClone(source), beforeTargetDataHash: hash('old target'), targetTouched: true,
    restored: true, migrated: true, verified: true, sourceUnchanged: true, restoreStatus: 'acknowledged',
    temporaryFilesRemoved: true, sessionsClosed: true };
}
function switchReport(): ProductionSwitchReport {
  const routing = { aliases: 4, hash: hash('routing'), domains: 3, domainHash: hash('domains'),
    production: [...productionAliases], known: productionAliases.map((alias, index): [string, string] => [alias, `dpl_before${index}`]) };
  return { success: true, stage: 'complete', code: 'OK', httpStatus: null, responseUnknown: false,
    writes: { source: 'acknowledged', target: 'acknowledged', deployment: 'acknowledged', promote: 'acknowledged' },
    before: routing, after: { ...structuredClone(routing), known: productionAliases.map((alias): [string, string] => [alias, 'dpl_candidate']) },
    deployment: { id: 'dpl_candidate', url: 'https://candidate.vercel.app', sha }, sourceScopeUpdated: true,
    targetConnected: true, nativeVerified: true, ready: true, probed: true, promoted: true, aliasVerified: true,
    knownAliasesCurrent: true, ms: 5 };
}
type FixtureOptions = { env?: Environment; input?: unknown; head?: string; events?: string[];
  connected?: boolean; bindingFailure?: unknown; copyFailure?: unknown; switchFailure?: unknown;
  copyReport?: FinalCopyReport; switchReport?: ProductionSwitchReport; currentMain?: (events: readonly string[]) => string };
async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cake-cutover-offline-'));
  const eventPath = join(directory, 'event.json'), receiptPath = join(directory, 'receipt.json');
  await writeFile(eventPath, JSON.stringify(options.input ?? event));
  const events = options.events ?? [];
  const dependencies: Partial<CutoverDependencies> = {
    head: () => options.head ?? sha, now: () => '2026-10-23T00:00:00.000Z', receiptPath,
    api: async (provider, path) => {
      events.push(`api:${provider}`);
      if (provider === 'github') {
        assert.equal(path, `/repos/${config.repository}/git/ref/heads/main`);
        return { ref: 'refs/heads/main', object: { type: 'commit', sha: options.currentMain?.(events) ?? sha } };
      }
      assert.equal(provider, 'vercel');
      assert.equal(path, `/v1/storage/stores/${config.targetStoreId}?skip-metadata=true`);
      return { store: { id: config.targetStoreId, ownerId: config.vercelTeamId, type: 'integration', externalResourceId: config.target.projectId,
        status: 'available', totalConnectedProjects: options.connected ? 1 : 0, projectsMetadata: [] } };
    },
    binding: async (_api, binding) => { events.push(`binding:${binding.projectId}`); if (options.bindingFailure) throw options.bindingFailure; },
    resolveConnection: async (_api, binding): Promise<Connection> => {
      events.push(`connection:${binding.projectId}`);
      return { host: `${binding.endpointId}.ap-southeast-1.aws.neon.tech`, port: 5432, user: binding.role, database: binding.database, password: secret };
    },
    copy: async optionsCopy => {
      events.push('copy:beforeWrite'); await optionsCopy.beforeWrite(); events.push('copy:write');
      if (options.copyFailure) throw options.copyFailure;
      events.push('copy:afterWrite'); await optionsCopy.afterWrite();
      return options.copyReport ?? copyReport();
    },
    switch: async (context, switchOptions) => {
      assert.equal(context.controlSha, sha); assert.equal(context.operation, operation);
      assert.equal(switchOptions?.environment?.VERCEL_TOKEN, environment.VERCEL_TOKEN);
      events.push('switch:beforeWrite'); await context.beforeWrite(); events.push('switch:write');
      if (options.switchFailure) throw options.switchFailure;
      return options.switchReport ?? switchReport();
    },
  };
  try {
    const result = await runCutover({ ...environment, GITHUB_EVENT_PATH: eventPath, ...options.env }, dependencies);
    const raw = await readFile(receiptPath, 'utf8');
    assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
    assert.ok(Buffer.byteLength(raw) <= 4096);
    for (const value of [secret, ...Object.values(environment).filter(value => value.startsWith('never-publish'))]) assert.ok(!raw.includes(value));
    return { result, raw, events, published: JSON.parse(raw) as CutoverReceipt };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('初回dispatchの固定repository・main完全SHA・2入力だけを受け付け、不一致でproviderを呼ばない', async () => {
  assert.deepEqual(cutoverContext(environment, event, sha), { controlSha: sha, operation, runId: '123', runAttempt: 1 });
  for (const env of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'other/Cake' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_REF: 'refs/heads/codex/unsafe' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_SHA: 'b'.repeat(40) },
    { GITHUB_SHA: 'a'.repeat(39) }, { GITHUB_RUN_ID: '01' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_WORKFLOW_REF: `${config.repository}/${config.workflow}@refs/heads/main` }]) {
    const events: string[] = [];
    await assert.rejects(fixture({ env, events }), /UNTRUSTED_WORKFLOW/); assert.deepEqual(events, []);
  }
  for (const input of [{ ...event, repository: { ...event.repository, id: 1 } },
    { ...event, repository: { ...event.repository, full_name: 'other/Cake' } },
    { ...event, inputs: { controlSha: sha } },
    ...[{ controlSha: 'b'.repeat(40) }, { operation: '$(unsafe)' }, { sql: 'SELECT 1' }, { target: 'other' }, { url: 'postgres://unsafe' }]
      .map(delta => ({ ...event, inputs: { ...event.inputs, ...delta } }))]) {
    const events: string[] = [];
    await assert.rejects(fixture({ input, events }), /UNTRUSTED_WORKFLOW/); assert.deepEqual(events, []);
  }
  const events: string[] = [];
  await assert.rejects(fixture({ head: 'b'.repeat(40), events }), /UNTRUSTED_WORKFLOW/); assert.deepEqual(events, []);
});

for (const [label, env] of [
  ['sourceなし', { NEON_SOURCE_API_KEY: undefined }], ['targetなし', { NEON_TARGET_API_KEY: '' }],
  ['同一キー', { NEON_TARGET_API_KEY: environment.NEON_SOURCE_API_KEY }],
  ['Previewキーだけ', { NEON_SOURCE_API_KEY: undefined, NEON_TARGET_API_KEY: undefined, NEON_API_KEY: 'private-preview' }],
  ['改行入りキー', { NEON_SOURCE_API_KEY: 'private\nsource' }], ['Vercelなし', { VERCEL_TOKEN: '' }],
  ['TLS検証無効', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }],
] as const) {
  test(`資格情報が${label}ならprovider・DB・切替を開始しない`, async () => {
    const { result, events } = await fixture({ env });
    assert.equal(result.success, false); assert.equal(result.stage, 'credentials'); assert.deepEqual(events, []);
    assert.equal(result.copy, undefined); assert.equal(result.deployment, undefined);
  });
}

test('provider所属または候補Native未接続の照合失敗で接続解決・コピー・切替を開始しない', async () => {
  for (const options of [{ bindingFailure: new MigrationError('PROVIDER_BINDING') }, { connected: true }]) {
    const { result, events } = await fixture(options);
    assert.equal(result.success, false); assert.equal(result.stage, 'bindings');
    assert.ok(!events.some(item => /^(connection|copy|switch):/.test(item)));
    assert.equal(result.deployment, undefined);
  }
});

test('コピーの検証失敗と例外はProduction切替を止め、公開可能なコピー状態を保持する', async () => {
  const failed: FinalCopyReport = { ...copyReport(), success: false, stage: 'source-verification',
    code: 'PRODUCTION_MIGRATION_FINAL_COPY_SOURCE_CHANGED', sourceUnchanged: false };
  const { result, events } = await fixture({ copyReport: failed });
  assert.equal(result.success, false); assert.equal(result.stage, 'copy'); assert.equal(result.code, failed.code);
  assert.equal(result.copy?.targetTouched, true); assert.equal(result.copy?.restored, true); assert.equal(result.copy?.sourceUnchanged, false);
  assert.ok(!events.some(item => item.startsWith('switch:')));
  const thrown = await fixture({ copyFailure: new Error(secret) });
  assert.equal(thrown.result.success, false); assert.equal(thrown.result.code, 'PRODUCTION_CUTOVER_FAILED');
  assert.ok(!thrown.events.some(item => item.startsWith('switch:')));
});

test('Native変更後の応答不明は全体失敗とし、確定済み・試行済みの段階を失わない', async () => {
  const partial: ProductionSwitchReport = { ...switchReport(), success: false, stage: 'create', code: 'RESPONSE_UNKNOWN',
    responseUnknown: true, writes: { source: 'acknowledged', target: 'acknowledged', deployment: 'attempted', promote: 'not-started' },
    deployment: null, ready: false, probed: false, promoted: false, aliasVerified: false, knownAliasesCurrent: false, after: null };
  const { result, published, events } = await fixture({ switchReport: partial });
  assert.equal(result.success, false); assert.equal(result.stage, 'switch');
  assert.equal(result.code, 'PRODUCTION_CUTOVER_SWITCH_RESPONSE_UNKNOWN'); assert.equal(result.copy?.success, true);
  assert.deepEqual(published.deployment?.writes, partial.writes); assert.equal(published.deployment?.responseUnknown, true);
  assert.equal(events.filter(item => item === 'switch:write').length, 1);
});

test('copyの前後・Native各書込み直前・完了前のmain変更を検出して次の更新を止める', async () => {
  for (const marker of ['copy:beforeWrite', 'copy:afterWrite', 'switch:beforeWrite', 'switch:write']) {
    const { result, events } = await fixture({ currentMain: trace => trace.includes(marker) ? 'b'.repeat(40) : sha });
    assert.equal(result.success, false); assert.equal(result.code, 'PRODUCTION_MIGRATION_MAIN_CHANGED');
    const lastCheck = events.lastIndexOf('api:github'); assert.ok(lastCheck > events.indexOf(marker));
    if (marker === 'copy:beforeWrite') assert.ok(!events.includes('copy:write'));
    if (marker.startsWith('copy:')) assert.ok(!events.includes('switch:beforeWrite'));
    if (marker === 'switch:beforeWrite') assert.ok(!events.includes('switch:write'));
    if (marker === 'switch:write') { assert.equal(result.copy?.success, true); assert.equal(result.deployment?.success, true); }
  }
});

test('成功receiptは無アクセス前提・全段階・sourceの13表018台帳projectionを記録する', async () => {
  const { result, published, raw, events } = await fixture();
  assert.equal(result.success, true); assert.equal(result.stage, 'completed'); assert.equal(result.code, 'OK');
  assert.equal(published.protocol, cutoverProtocol); assert.equal(published.accessAssumption, accessAssumption);
  assert.equal(published.accessAssumption, 'no-production-db-access');
  assert.equal(published.copy?.success, true); assert.equal(published.copy?.sessionsClosed, true);
  assert.equal(published.copy?.temporaryFilesRemoved, true); assert.equal(published.copy?.sourceUnchanged, true);
  assert.deepEqual(published.copy?.snapshot?.counts, copyReport().source?.counts);
  assert.equal(published.copy?.snapshot?.counts[appTables.indexOf('schema_migrations')], 18);
  assert.equal(published.deployment?.success, true); assert.equal(published.deployment?.aliasVerified, true);
  assert.equal(published.deployment?.deployment?.sha, sha); assert.ok(events.includes('copy:write')); assert.ok(events.includes('switch:write'));
  assert.equal(serializeCutoverReceipt(result), raw);
});

test('copy・Nativeの未知フィールドとraw行を除去し、既知aliasだけを固定順へ射影する', async () => {
  const copy = copyReport(), routing = switchReport();
  Object.assign(copy, { rawRows: [secret], connection: secret, error: secret });
  Object.assign(copy.source!, { rawRows: [secret] }); Object.assign(copy.source!.hashes, { unknown: secret });
  Object.assign(copy.cases[0], { rawSql: secret });
  Object.assign(routing, { rawRows: [secret], provider: { token: secret } });
  Object.assign(routing.writes, { unknown: secret }); Object.assign(routing.deployment!, { private: secret });
  routing.before!.known.reverse(); routing.before!.known.push(['private.example', secret]);
  Object.assign(routing.before!, { rawRows: [secret] });
  const { published, raw } = await fixture({ copyReport: copy, switchReport: routing });
  assert.ok(!raw.includes(secret)); assert.ok(!raw.includes('private.example'));
  assert.deepEqual(published.deployment?.before?.known, ['dpl_before0', 'dpl_before1', 'dpl_before2']);
  assert.equal(published.deployment?.before?.productionCount, productionAliases.length);
  assert.equal('cases' in published.copy!, false); assert.equal('source' in published.copy!, false);
  assert.equal('rawRows' in published.copy!.snapshot!, false); assert.equal('private' in published.deployment!.deployment!, false);
});

test('公開receiptは異なる対象・context・code・SQLSTATE・秘密文字列・不正な成功宣言を拒否する', async () => {
  const { published } = await fixture();
  const changes: ((value: CutoverReceipt) => void)[] = [
    value => { value.sourceBranch = 'br-other'; }, value => { value.targetBranch = 'br-other'; },
    value => { value.configHash = '0'.repeat(64); }, value => { value.controlSha = 'a'.repeat(39); },
    value => { value.operation = 'bad'; }, value => { value.runAttempt = 2; }, value => { value.runId = '01'; },
    value => { value.accessAssumption = 'sql-fenced' as typeof accessAssumption; },
    value => { value.startedAt = 'not-a-time'; }, value => { value.checkedAt = '2026-10-22T00:00:00.000Z'; },
    value => { value.success = false; value.code = secret; },
    value => { value.copy!.sqlstate = secret; }, value => { value.copy!.code = 'PRODUCTION_MIGRATION_PRIVATE_SENTINEL'; },
    value => { value.copy!.snapshot!.counts.pop(); },
    value => { value.copy!.targetDataHash = 'f'.repeat(64); }, value => { value.copy!.snapshot!.hashes.data = secret; },
    value => { value.deployment!.code = 'PRIVATE_SENTINEL' as never; }, value => { value.deployment!.stage = 'private' as never; },
    value => { value.deployment!.httpStatus = 999; }, value => { value.deployment!.before!.known[0] = secret; },
    value => { value.deployment!.deployment!.sha = 'b'.repeat(40); },
    value => { value.deployment!.deployment!.url = 'https://user:password@candidate.vercel.app'; },
    value => { value.copy!.sessionsClosed = false; }, value => { value.copy!.temporaryFilesRemoved = false; },
    value => { value.deployment!.aliasVerified = false; },
    value => { value.deployment!.writes.promote = 'attempted'; },
    value => { value.success = false; value.code = 'OK'; },
  ];
  for (const change of changes) {
    const changed = structuredClone(published); change(changed);
    assert.throws(() => serializeCutoverReceipt(changed));
  }
});

test('失敗receiptでも未知の上位codeや例外内の秘密断片を公開しない', async () => {
  const { published } = await fixture();
  for (const code of ['PRODUCTION_CUTOVER_SWITCH_PRIVATE_SENTINEL', 'PRODUCTION_MIGRATION_PRIVATE_SENTINEL']) {
    const failed: CutoverReceipt = { ...structuredClone(published), success: false, stage: 'switch', code };
    assert.throws(() => serializeCutoverReceipt(failed), /INVALID_RECEIPT/);
  }
  const thrown = await fixture({ copyFailure: new MigrationError('PRIVATE_SENTINEL') });
  assert.equal(thrown.result.success, false); assert.equal(thrown.result.code, 'PRODUCTION_CUTOVER_FAILED');
  assert.ok(!thrown.raw.includes('PRIVATE_SENTINEL'));
});

test('4KiBを超えるreceiptは公開しない', async () => {
  const { published } = await fixture();
  published.deployment!.deployment!.url = `https://${'a'.repeat(5000)}.vercel.app`;
  assert.throws(() => serializeCutoverReceipt(published), /INVALID_RECEIPT/);
});

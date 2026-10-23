import test from 'node:test';
import assert from 'node:assert/strict';
import { config, hash } from '../scripts/production-db-migration-provider';
import { migration019, schemaQaProtocol, schemaQaWorkflow, serializeSchemaQaReceipt, type SchemaQaReceipt } from '../scripts/production-db-schema-qa';
import { parseArguments, readProductionSchemaQaReceipt, receiptText, type Get, type Request } from '../scripts/production-db-schema-qa-proof';

const expected: Request = { runId: 100, controlSha: 'a'.repeat(40), operation: '10000000-0000-4000-8000-000000000001' };
const api = (path: string) => `https://api.github.com/repos/${config.repository}/${path}`;
const app = { id: 15368, slug: 'github-actions', html_url: 'https://github.com/apps/github-actions' };
const repository = { id: config.repositoryId, full_name: config.repository };
function receipt(success = false): SchemaQaReceipt {
  return {
    protocol: schemaQaProtocol, controlSha: expected.controlSha, operation: expected.operation,
    runId: String(expected.runId), runAttempt: 1, configHash: hash(JSON.stringify(config)),
    targetProject: config.target.projectId, targetBranch: config.target.branchId, targetEndpoint: config.target.endpointId,
    targetHostDigest: config.target.hostDigest, migrationSha256: migration019.sha256,
    startedAt: '2026-10-23T00:00:10.000Z', checkedAt: '2026-10-23T00:00:50.000Z',
    success, stage: success ? 'completed' : 'main-check', code: success ? 'OK' : 'PRODUCTION_MIGRATION_MAIN_CHANGED',
    sqlstate: null, sessionsClosed: true, ...(success ? { report: {
      success: true, cases: [{ n: 'scratch' as const, ms: 10 }, { n: 'copy' as const, ms: 20 },
        { n: 'race' as const, ms: 30 }, { n: 'schema' as const, ms: 10 }, { n: 'repeat' as const, ms: 10 }],
      pids: [501, 502, 503], counts: Array.from({ length: 13 }, (_, i) => i === 7 ? 18 : 1),
      hashes: { data: hash('data'), schema: hash('schema'), acl: hash('acl'), ledger: hash('ledger'), owners: hash('owners') },
      scratch: { success: true, cases: 3, ms: 20, waitMs: 5, exclusive: true, cleanup: [0, 0, 0, 0], restored: true },
      race: { queries: [3, 3], reads: [1, 1], writer: 501, waiter: 502, ddl: true, advisory: true, ms: 30 },
      repeat: { reads: 0, queries: 2 }, unchanged: { scratch: true, migration: true, repeat: true },
      mismatches: 0, restored: true, failures: [], ms: 80,
    } } : {}),
  };
}

function fixture(success = false) {
  const conclusion = success ? 'success' : 'failure';
  const workflow = { id: 200, path: schemaQaWorkflow, state: 'active', url: api('actions/workflows/200') };
  const run = { id: 100, workflow_id: 200, run_attempt: 1, event: 'workflow_dispatch', path: schemaQaWorkflow,
    head_branch: 'main', head_sha: expected.controlSha, display_title: `Production DB schema QA ${expected.operation}`,
    repository, head_repository: repository, check_suite_id: 400, status: 'completed', conclusion,
    url: api('actions/runs/100'), check_suite_url: api('check-suites/400'),
    created_at: '2026-10-23T00:00:00Z', updated_at: '2026-10-23T00:01:00Z' };
  const job = { id: 300, name: 'schema-qa', run_id: 100, run_attempt: 1, head_sha: expected.controlSha,
    head_branch: 'main', url: api('actions/jobs/300'), run_url: run.url, check_run_url: api('check-runs/300'),
    status: 'completed', conclusion, started_at: '2026-10-23T00:00:03Z', completed_at: '2026-10-23T00:00:56Z',
    steps: [{ name: 'Verify the fixed Production schema candidate', number: 6, status: 'completed', conclusion },
      { name: 'Publish the public receipt', number: 7, status: 'completed', conclusion: 'success' }] };
  const suite = { id: 400, url: api('check-suites/400'), head_sha: expected.controlSha, head_branch: 'main',
    repository, app, status: 'completed', conclusion };
  const check = { id: 300, url: api('check-runs/300'), name: job.name, head_sha: expected.controlSha,
    check_suite: { id: 400 }, app, status: 'completed', conclusion, started_at: job.started_at, completed_at: job.completed_at,
    output: { annotations_count: 1, annotations_url: api('check-runs/300/annotations') } };
  const annotations: { annotation_level: string; title: string; message: string }[] = [
    { annotation_level: 'notice', title: schemaQaProtocol, message: serializeSchemaQaReceipt(receipt(success)) },
  ];
  const values: Record<string, unknown> = {
    'actions/workflows/production-db-schema-qa.yml': workflow, 'actions/runs/100': run,
    'actions/workflows/200/runs?event=workflow_dispatch&branch=main&per_page=100&page=1': { total_count: 1, workflow_runs: [run] },
    'actions/runs/100/attempts/1/jobs?per_page=100&page=1': { total_count: 1, jobs: [job] },
    'check-suites/400': suite, 'check-runs/300': check,
    'check-runs/300/annotations?per_page=100&page=1': annotations,
  };
  const calls: string[] = [];
  const get: Get = async path => { calls.push(path); assert.ok(path in values, path); return structuredClone(values[path]); };
  return { get, calls, values, run, workflow, job, suite, check, annotations };
}

test('schema proof accepts a completed failure and revalidates its provenance without dispatch', async () => {
  const f = fixture(); const result = await readProductionSchemaQaReceipt(f.get, expected);
  assert.equal(result.success, false); assert.equal(result.receipt.code, 'PRODUCTION_MIGRATION_MAIN_CHANGED');
  assert.equal(result.runAttempt, 1); assert.equal(result.checkId, 300);
  for (const path of ['actions/runs/100', 'check-runs/300', 'check-suites/400']) assert.equal(f.calls.filter(p => p === path).length, 2);
  assert.ok(f.calls.every(path => !path.includes('dispatches') && !path.includes('artifacts') && !path.includes('logs')));
});

test('schema proof accepts successful bounded evidence for all three independent sessions', async () => {
  const f = fixture(true); const result = await readProductionSchemaQaReceipt(f.get, expected);
  assert.equal(result.success, true); assert.deepEqual(result.receipt.report?.pids, [501, 502, 503]);
  assert.equal(result.receipt.report?.race?.advisory, true); assert.equal(result.receipt.sessionsClosed, true);
});

for (const [name, mutate] of [
  ['another repository', (f: ReturnType<typeof fixture>) => { f.run.repository = { ...repository, id: 1 }; }],
  ['another source repository', (f: ReturnType<typeof fixture>) => { f.run.head_repository = { ...repository, full_name: 'fork/Cake' }; }],
  ['another main SHA', (f: ReturnType<typeof fixture>) => { f.run.head_sha = 'b'.repeat(40); }],
  ['another workflow', (f: ReturnType<typeof fixture>) => { f.workflow.path = '.github/workflows/preview.yml'; }],
  ['a rerun', (f: ReturnType<typeof fixture>) => { f.run.run_attempt = 2; }],
  ['another event', (f: ReturnType<typeof fixture>) => { f.run.event = 'pull_request_target'; }],
  ['another operation', (f: ReturnType<typeof fixture>) => { f.run.display_title = 'Production DB schema QA another'; }],
  ['another job', (f: ReturnType<typeof fixture>) => { f.job.name = 'migration'; }],
  ['an incomplete receipt step', (f: ReturnType<typeof fixture>) => { f.job.steps[1].conclusion = 'failure'; }],
  ['another app', (f: ReturnType<typeof fixture>) => { f.check.app = { ...app, id: 1 }; }],
  ['another suite', (f: ReturnType<typeof fixture>) => { f.check.check_suite.id = 999; }],
  ['a non-notice', (f: ReturnType<typeof fixture>) => { f.annotations[0].annotation_level = 'warning'; }],
  ['a missing notice', (f: ReturnType<typeof fixture>) => { f.annotations[0].title = 'unrelated'; }],
  ['duplicate notices', (f: ReturnType<typeof fixture>) => { f.annotations.push({ ...f.annotations[0] }); f.check.output.annotations_count = 2; }],
  ['an incomplete annotation page', (f: ReturnType<typeof fixture>) => { f.check.output.annotations_count = 2; }],
] as const) {
  test(`schema proof refuses ${name}`, async () => {
    const f = fixture(); mutate(f); await assert.rejects(readProductionSchemaQaReceipt(f.get, expected));
  });
}

test('schema proof rejects duplicated operation runs instead of selecting the newest', async () => {
  const f = fixture();
  f.values['actions/workflows/200/runs?event=workflow_dispatch&branch=main&per_page=100&page=1'] = {
    total_count: 2, workflow_runs: [f.run, { ...f.run, id: 101 }],
  };
  await assert.rejects(readProductionSchemaQaReceipt(f.get, expected), /DUPLICATE_OPERATION_RUN/);
});

test('schema proof rejects changes during before/after revalidation', async () => {
  const f = fixture(); let checks = 0;
  const get: Get = async path => {
    const value = await f.get(path);
    if (path === 'check-runs/300' && ++checks === 2) (value as typeof f.check).output.annotations_count = 2;
    return value;
  };
  await assert.rejects(readProductionSchemaQaReceipt(get, expected), /CHECK_CHANGED/);
});

test('schema proof reads a receipt on the second annotation page and revalidates both pages', async () => {
  const f = fixture(); const firstPage = Array.from({ length: 100 }, () => ({ annotation_level: 'warning', title: 'unrelated', message: 'other' }));
  f.check.output.annotations_count = 101;
  f.values['check-runs/300/annotations?per_page=100&page=1'] = firstPage;
  f.values['check-runs/300/annotations?per_page=100&page=2'] = f.annotations;
  assert.equal((await readProductionSchemaQaReceipt(f.get, expected)).success, false);
  assert.equal(f.calls.filter(path => path.endsWith('annotations?per_page=100&page=2')).length, 2);
});

test('schema proof rejects a nested extra report field and changed receipt content', async () => {
  const f = fixture(true);
  const raw = JSON.parse(f.annotations[0].message); raw.report.private = 'never-publish';
  assert.throws(() => receiptText(JSON.stringify(raw), expected, f.run, f.job));
  let reads = 0;
  const get: Get = async path => {
    const value = await f.get(path);
    if (path.startsWith('check-runs/300/annotations?') && ++reads === 2) {
      const annotations = value as typeof f.annotations;
      annotations[0].message = annotations[0].message.replace('00:00:50.000Z', '00:00:51.000Z');
    }
    return value;
  };
  await assert.rejects(readProductionSchemaQaReceipt(get, expected), /CHECK_CHANGED/);
});

for (const [name, change] of [
  ['extra raw fields', (text: string) => text.replace('{', '{"private":"never-publish",')],
  ['duplicate JSON keys', (text: string) => text.replace('{', '{"success":true,')],
  ['masked content', (text: string) => text.replace('MAIN_CHANGED', '***')],
  ['another target', (text: string) => text.replace(config.target.projectId, config.source.projectId)],
  ['another receipt operation', (text: string) => text.replace(expected.operation, '20000000-0000-4000-8000-000000000002')],
  ['a forged success', (text: string) => text.replace('"success":false', '"success":true')],
  ['a reversed timestamp', (text: string) => text.replace('00:00:50.000Z', '00:00:01.000Z')],
  ['a timestamp outside the job', (text: string) => text.replace('00:00:50.000Z', '00:02:50.000Z')],
  ['an oversized notice', (text: string) => text + ' '.repeat(4097)],
] as const) {
  test(`schema receipt refuses ${name}`, () => {
    const f = fixture(); assert.throws(() => receiptText(change(f.annotations[0].message), expected, f.run, f.job));
  });
}

test('schema proof CLI accepts only explicit numeric run, full SHA and UUID', () => {
  assert.deepEqual(parseArguments(['100', expected.controlSha, expected.operation]), expected);
  for (const args of [[], ['100', expected.controlSha], ['100', expected.controlSha, expected.operation, 'reset'],
    ['0', expected.controlSha, expected.operation], ['9007199254740992', expected.controlSha, expected.operation],
    ['100', 'abc', expected.operation], ['100', expected.controlSha, '$(unsafe)']]) assert.throws(() => parseArguments(args));
});

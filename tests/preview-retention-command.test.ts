import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import capability from '../preview-retention.config.json';
import verifyCapability from '../preview-verify.config.json';
import { config, type Source } from '../scripts/preview-model';
import { retentionTarget, readRetentionProof, retentionProof, runRetention } from '../scripts/preview-retention-command';
import { type RetentionAction } from '../scripts/preview-retention-model';
import { serializeRetentionReceipt } from '../scripts/preview-retention-receipt';
import { verifyReceiptNoticeTitle, serializeVerifyReceipt, type VerifyReceipt } from '../scripts/preview-verify-receipt';
import type { WorkflowExecutor } from '../scripts/task-workflow';
import type { Receipt } from '../scripts/preview-service';
import { checksFixture } from './preview-checks-fixture';
import { verifyReceiptFixture } from './preview-verify-fixture';
import { retentionChecksFixture, retentionReceiptFixture, retentionDeployment, retentionNewDeployment,
  retentionSource, retentionNewSource, retentionMarker, retentionMainSha } from './preview-retention-fixture';

const silent = () => {};
const noWait = async () => {};
const prepareArgs = ['prepare', '--pr', '75', '--sha', retentionSource.sha, '--deployment', retentionDeployment.id, '--marker', retentionMarker];
const proofName = (mode: string, marker = retentionMarker) => `.cake/retention-75-${marker}-${mode}.json`;
const positive = (id: number) => Number.isSafeInteger(id) && id > 0;

function verifyGraph(receipt: VerifyReceipt) {
  const f = checksFixture(), id = Number(receipt.runId), job = id + 1000, suite = id + 2000, check = id + 3000;
  const url = (path: string) => `https://api.github.com/repos/${config.repository}/${path}`;
  const conclusion = receipt.success ? 'success' : 'failure';
  Object.assign(f.run, { id, display_title: `Preview verify PR ${receipt.source.pr} ${receipt.operation}`, head_sha: receipt.controlSha,
    check_suite_id: suite, url: url(`actions/runs/${id}`), check_suite_url: url(`check-suites/${suite}`), conclusion });
  Object.assign(f.job, { id: job, run_id: id, head_sha: receipt.controlSha, url: url(`actions/jobs/${job}`), run_url: f.run.url,
    check_run_url: url(`check-runs/${check}`), conclusion, steps: [{ name: 'Publish public operation receipt notice', number: 7, status: 'completed', conclusion: 'success' }] });
  Object.assign(f.suite, { id: suite, url: f.run.check_suite_url, head_sha: receipt.controlSha, conclusion });
  Object.assign(f.check, { id: check, url: f.job.check_run_url, head_sha: receipt.controlSha, check_suite: { id: suite }, conclusion,
    output: { annotations_count: 1, annotations_url: url(`check-runs/${check}/annotations`) } });
  Object.assign(f.annotation, { title: verifyReceiptNoticeTitle, message: serializeVerifyReceipt(receipt) });
  return { ...f, responses: new Map<string, unknown>([['actions/workflows/preview.yml', f.workflow], [`actions/runs/${id}`, f.run],
    [`actions/runs/${id}/attempts/1/jobs?per_page=100&page=1`, f.jobs], [`check-suites/${suite}`, f.suite],
    [`check-runs/${check}`, f.check], [`check-runs/${check}/annotations?per_page=100&page=1`, [f.annotation]]]) };
}

/** Real CLI, provenance readers and UI QA client, with only Git/GitHub/status I/O stubbed. */
function fixture(cwd: string) {
  let current: Source = { ...retentionSource }, head = retentionMainSha, installed = true, dirty = false, unknownDispatch = false;
  let unknownPrepare = false, unknownUpdate = false, noNotice = false, uiFailure = false, changeAfterDispatch = false, tamperUiAfterCheck = false, changeCheckEvidence = false;
  const responses = new Map<string, unknown>(), runs: Record<string, unknown>[] = [], events: string[] = [], history: { command: string; args: readonly string[]; cwd: string }[] = [];
  responses.set('actions/workflows/preview.yml', checksFixture().workflow);
  const graphs = new Map<string, ReturnType<typeof retentionChecksFixture>>();
  let uiGraph: ReturnType<typeof verifyGraph> | undefined;
  const pull = () => ({ number: current.pr, state: current.state, created_at: current.createdAt,
    head: { ref: current.branch, sha: current.sha, repo: { full_name: config.repository } }, base: { ref: 'main', repo: { full_name: config.repository } } });
  const execute: WorkflowExecutor = async (command, args, actualCwd) => {
    history.push({ command, args: [...args], cwd: actualCwd }); assert.equal(actualCwd, cwd);
    let value: unknown;
    if (command === 'git') {
      const call = args.join(' ');
      if (call === 'rev-parse --show-toplevel') value = cwd;
      else if (call === 'rev-parse HEAD') value = head;
      else if (call.startsWith('status ')) value = dirty ? ' M scripts/control.ts' : '';
      else if (call === 'remote get-url origin') value = 'https://github.com/tyask/Cake.git';
      else assert.fail(`Unexpected stubbed git operation: ${call}`);
    } else {
      assert.equal(args[0], 'api');
      const path = args[1].slice(`repos/${config.repository}/`.length);
      if (args.includes('POST')) {
        assert.equal(path, 'actions/workflows/preview.yml/dispatches');
        const input = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
        assert.equal(input.ref, 'main'); assert.equal(input.inputs.pr, '75'); assert.equal(input.inputs.sha, current.sha);
        assert.equal(input.inputs.controlSha, retentionMainSha); events.push(`dispatch:${input.inputs.action}`);
        if (input.inputs.action === 'verify') {
          assert.equal(input.inputs.deploymentId, retentionNewDeployment.id);
          const receipt = { ...verifyReceiptFixture(!uiFailure), source: { ...current }, expectedDeploymentId: retentionNewDeployment.id,
            deployment: structuredClone(retentionNewDeployment), database: { ...retentionNewDeployment.database! },
            operation: input.inputs.operation, runId: '128', controlSha: retentionMainSha };
          uiGraph = verifyGraph(receipt); for (const [key, v] of uiGraph.responses) responses.set(key, v);
          runs.unshift(uiGraph.run);
        } else {
          const action = input.inputs.action as RetentionAction;
          const receipt = retentionReceiptFixture(action);
          receipt.source = { ...current }; receipt.operation = input.inputs.operation; receipt.marker = input.inputs.marker;
          receipt.expectedDeploymentId = input.inputs.deploymentId;
          if (input.inputs.baselineRunId) receipt.baselineRunId = input.inputs.baselineRunId;
          if (input.inputs.updateRunId) receipt.updateRunId = input.inputs.updateRunId;
          if (action === 'retention-check' && changeCheckEvidence) receipt.evidence!.collectionDigest = 'f'.repeat(64);
          if (action === 'retention-prepare' && unknownPrepare || action === 'retention-update' && unknownUpdate
            || noNotice && ['retention-inspect', 'retention-reconcile'].includes(action)) {
            receipt.success = false; receipt.outcome = 'unknown'; delete receipt.evidence;
            delete receipt.observedAt; delete receipt.runtimeAfterAt;
            receipt.failure = { stage: action === 'retention-update' ? 'update' : 'write',
              code: action === 'retention-update' ? 'PREVIEW_RETENTION_UPDATE_UNKNOWN' : 'PREVIEW_RETENTION_WRITE_UNKNOWN' };
            if (action === 'retention-update') { delete receipt.deployment; delete receipt.database; }
          }
          const graph = retentionChecksFixture(receipt); graphs.set(action, graph);
          for (const [key, v] of graph.responses) responses.set(key, v);
          runs.unshift(graph.run);
          if (action === 'retention-check' && tamperUiAfterCheck) uiGraph!.annotation.message = '{"operation":"***"}';
          if (unknownDispatch) return { status: 1, signal: null, stdout: 'private-external-failure-do-not-print' };
        }
        if (changeAfterDispatch) current = { ...current, sha: 'e'.repeat(40) };
        value = '';
      } else if (path === 'branches/main') value = { commit: { sha: retentionMainSha } };
      else if (path.startsWith('contents/')) {
        const file = path.split('?')[0].slice('contents/'.length);
        const content = file === 'preview.config.json' ? config : file === 'preview-verify.config.json' ? verifyCapability : installed ? capability : {};
        value = { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(content)).toString('base64') };
      } else if (path === 'pulls/75') value = pull();
      else if (path.startsWith('actions/workflows/45/runs?')) {
        const page = Number(new URL(`https://github.invalid/${path}`).searchParams.get('page') ?? 1);
        value = { total_count: runs.length, workflow_runs: runs.slice((page - 1) * 100, page * 100) };
      } else if (path.startsWith('actions/workflows/preview.yml/runs?')) value = { workflow_runs: runs };
      else {
        if (path.includes('/annotations')) events.push(`notice:${path}`);
        assert.ok(responses.has(path), `Unexpected stubbed API read: ${path}`); value = responses.get(path);
      }
    }
    return { status: 0, signal: null, stdout: typeof value === 'string' ? value : JSON.stringify(value) };
  };
  const status = async (): Promise<Receipt> => {
    events.push('status');
    const deployment = current.sha === retentionSource.sha ? retentionDeployment : retentionNewDeployment;
    return { protocol: 'cake-preview/v1', action: 'status', source: { ...current }, deployment: structuredClone(deployment), database: { ...deployment.database! },
      checkedAt: '2026-10-16T01:00:03Z', success: true };
  };
  const options = { cwd, execute, wait: noWait, log: silent, status };
  return { options, events, history, graphs, responses, runs, advance: () => { current = { ...retentionNewSource }; },
    wrongHead: () => { head = 'f'.repeat(40); }, oldCapability: () => { installed = false; }, dirty: () => { dirty = true; },
    unknownDispatch: () => { unknownDispatch = true; }, unknownPrepare: () => { unknownPrepare = true; }, unknownUpdate: () => { unknownUpdate = true; },
    noNotice: () => { noNotice = true; }, uiFailure: () => { uiFailure = true; }, changeSource: () => { changeAfterDispatch = true; },
    tamperUiAfterCheck: () => { tamperUiAfterCheck = true; }, changeCheckEvidence: () => { changeCheckEvidence = true; }, ui: () => uiGraph };
}
async function withFixture(run: (f: ReturnType<typeof fixture>, cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'cake-retention-command-'));
  try { await run(fixture(cwd), cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}
const updateArgs = ['update', '--pr', '75', '--sha', retentionNewSource.sha, '--baseline', proofName('prepare')];
const checkArgs = (update = 'update') => ['check', '--pr', '75', '--sha', retentionNewSource.sha, '--deployment', retentionNewDeployment.id,
  '--baseline', proofName('prepare'), '--update', proofName(update)];

test('retention requires exact per-mode inputs and canonical IDs, SHA and marker', () => {
  assert.equal(retentionTarget(prepareArgs).mode, 'prepare');
  assert.equal(retentionTarget(updateArgs).baselinePath, proofName('prepare'));
  for (const args of [[], ['deploy'], [...prepareArgs, '--marker', retentionMarker], prepareArgs.map(value => value === '75' ? '075' : value),
    prepareArgs.map(value => value === retentionSource.sha ? 'main' : value), prepareArgs.map(value => value === retentionMarker ? 'A0000000-0000-4000-8000-000000000001' : value),
    ['inspect', ...prepareArgs.slice(1)], [...updateArgs, '--deployment', retentionDeployment.id], [...checkArgs(), '--run', '123'],
    ['reconcile', '--pr', '75', '--sha', retentionNewSource.sha, '--baseline', 'a', '--run', '0']]) assert.throws(() => retentionTarget(args), /RETENTION_ARGUMENTS/);
});

test('full original baseline → one update → UI QA → final GET check keeps the old target untouched', async () => withFixture(async (f, cwd) => {
  const prepared = await runRetention({ ...f.options, args: prepareArgs });
  assert.equal(prepared.receipt.action, 'retention-prepare'); assert.equal(prepared.receipt.operation, retentionMarker);
  assert.equal((await lstat(join(cwd, proofName('prepare')))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(cwd, '.cake/retention-75-prepare.intent.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(cwd, '.cake/retention-75-prepare.intent.json'), 'utf8')).runId, '123');
  f.advance();
  const updated = await runRetention({ ...f.options, args: updateArgs });
  assert.equal(updated.receipt.deployment!.id, retentionNewDeployment.id);
  const proof = await runRetention({ ...f.options, args: checkArgs() });
  assert.equal(proof.receipt.evidence!.contentDigest, prepared.receipt.evidence!.contentDigest);
  assert.deepEqual(proof.uiVerification, { workflowId: 45, runId: '128', controlSha: retentionMainSha, proofPath: '.cake/verify-75.json' });
  assert.ok(f.events.indexOf('dispatch:verify') < f.events.indexOf('dispatch:retention-check'));
  const lastCheck = f.events.indexOf('dispatch:retention-check');
  assert.ok(f.events.slice(lastCheck + 1).some(event => event === 'notice:check-runs/3128/annotations?per_page=100&page=1'));
  assert.ok(f.history.every(call => ['git', 'gh'].includes(call.command)));
  assert.ok(!f.history.some(call => call.command === 'git' && ['push', 'checkout', 'worktree'].includes(call.args[0])));
  assert.deepEqual((await readRetentionProof(join(cwd, proofName('check')))).uiVerification, proof.uiVerification);
}));

test('unknown prepare is recovered only by inspect and original notice is reread before update', async () => withFixture(async (f, cwd) => {
  f.unknownPrepare(); await assert.rejects(runRetention({ ...f.options, args: prepareArgs }), /RETENTION_WRITE_UNKNOWN/);
  const inspected = await runRetention({ ...f.options, args: ['inspect', ...prepareArgs.slice(1), '--run', '123'] });
  assert.equal(inspected.receipt.writeAttempts, 0); assert.equal(inspected.receipt.baselineRunId, '123');
  f.advance();
  await runRetention({ ...f.options, args: updateArgs.map(value => value === proofName('prepare') ? proofName('inspect') : value) });
  assert.equal(f.graphs.get('retention-update')!.receipt.baselineRunId, '126');
  assert.equal(f.events.filter(event => event === 'dispatch:retention-prepare').length, 1);
  assert.ok((await lstat(join(cwd, '.cake/retention-75-prepare.intent.json'))).isFile());
}));

test('unknown update is recovered only by reconcile; check references the accepted reconcile chain', async () => withFixture(async (f) => {
  await runRetention({ ...f.options, args: prepareArgs }); f.advance(); f.unknownUpdate();
  await assert.rejects(runRetention({ ...f.options, args: updateArgs }), /RETENTION_UPDATE_UNKNOWN/);
  const reconciled = await runRetention({ ...f.options, args: ['reconcile', '--pr', '75', '--sha', retentionNewSource.sha,
    '--baseline', proofName('prepare'), '--run', '124'] });
  assert.equal(reconciled.receipt.updateRunId, '124');
  const checked = await runRetention({ ...f.options, args: checkArgs('reconcile') });
  assert.equal(checked.receipt.updateRunId, '127'); assert.equal(f.events.filter(event => event === 'dispatch:retention-update').length, 1);
}));

test('durable write intent survives an ambiguous dispatch and neither marker change nor rerun dispatches again', async () => withFixture(async (f, cwd) => {
  f.unknownDispatch(); await assert.rejects(runRetention({ ...f.options, args: prepareArgs }), /RETENTION_DISPATCH_UNKNOWN/);
  const intent = JSON.parse(await readFile(join(cwd, '.cake/retention-75-prepare.intent.json'), 'utf8'));
  assert.equal(intent.operation, retentionMarker); assert.equal(intent.source.sha, retentionSource.sha);
  await assert.rejects(runRetention({ ...f.options, args: prepareArgs }), /RETENTION_REPLAY/);
  await assert.rejects(runRetention({ ...f.options, args: prepareArgs.map(value => value === retentionMarker ? '40000000-0000-4000-8000-000000000004' : value) }), /RETENTION_REPLAY/);
  assert.equal(f.events.filter(event => event === 'dispatch:retention-prepare').length, 1);
}));

test('local exclusive intent prevents dispatch even when the complete remote history is empty', async () => withFixture(async (f, cwd) => {
  await mkdir(join(cwd, '.cake')); await writeFile(join(cwd, '.cake/retention-75-prepare.intent.json'), '{}', { mode: 0o600 });
  await assert.rejects(runRetention({ ...f.options, args: prepareArgs }), /WRITE_INTENT_EXISTS/);
  assert.ok(!f.events.some(event => event.startsWith('dispatch:')));
}));

test('dirty or stale control, missing independent capability and changed target fail without retention dispatch', async () => {
  for (const mode of ['dirty', 'wrongHead', 'oldCapability'] as const) await withFixture(async f => {
    f[mode](); await assert.rejects(runRetention({ ...f.options, args: prepareArgs }), /PREVIEW_(VERIFY_TRUSTED_MAIN_REQUIRED|RETENTION_NOT_INSTALLED_ON_MAIN)/);
    assert.deepEqual(f.events, []);
  });
  await withFixture(async f => {
    await assert.rejects(runRetention({ ...f.options, args: prepareArgs.map(value => value === retentionDeployment.id ? 'dpl_other' : value) }), /RETENTION_TARGET_CHANGED/);
    assert.ok(!f.events.some(event => event.startsWith('dispatch:')));
  });
});

test('masked, duplicate or changed original baseline cannot authorize an update', async () => {
  for (const mode of ['mask', 'duplicate', 'changed'] as const) await withFixture(async (f, cwd) => {
    await runRetention({ ...f.options, args: prepareArgs }); f.advance();
    const graph = f.graphs.get('retention-prepare')!;
    if (mode === 'mask') graph.annotation.message = '{"marker":"***"}';
    if (mode === 'duplicate') graph.annotation.message = graph.annotation.message.replace('{', '{"marker":"bad",');
    if (mode === 'changed') {
      const changed = structuredClone(graph.receipt); changed.evidence!.collectionDigest = 'f'.repeat(64);
      graph.annotation.message = serializeRetentionReceipt(changed);
    }
    await assert.rejects(runRetention({ ...f.options, args: updateArgs }), /PREVIEW_/);
    assert.equal(f.events.filter(event => event === 'dispatch:retention-update').length, 0);
    assert.ok((await readRetentionProof(join(cwd, proofName('prepare')))).receipt.success);
  });
});

test('no original notice permits only read diagnostic and never manufactures a registration baseline', async () => withFixture(async (f, cwd) => {
  await runRetention({ ...f.options, args: prepareArgs });
  const graph = f.graphs.get('retention-prepare')!; graph.check.output.annotations_count = 0;
  graph.responses.set('check-runs/3123/annotations?per_page=100&page=1', []);
  f.responses.set('check-runs/3123/annotations?per_page=100&page=1', []); f.noNotice();
  await assert.rejects(runRetention({ ...f.options, args: ['inspect', ...prepareArgs.slice(1), '--run', '123'] }), /RETENTION_WRITE_UNKNOWN/);
  const diagnostic = await readRetentionProof(join(cwd, proofName('inspect')));
  assert.equal(diagnostic.receipt.success, false); assert.equal(diagnostic.receipt.outcome, 'unknown');
  f.advance();
  await assert.rejects(runRetention({ ...f.options, args: updateArgs.map(value => value === proofName('prepare') ? proofName('inspect') : value) }), /PREVIEW_/);
  assert.equal(f.events.filter(event => event === 'dispatch:retention-prepare').length, 1);
  assert.equal(f.events.filter(event => event === 'dispatch:retention-update').length, 0);
}));

test('final UI QA failure or original QA notice mutation leaves no successful combined check proof', async () => {
  for (const mode of ['uiFailure', 'tamperUiAfterCheck', 'changeCheckEvidence'] as const) await withFixture(async (f, cwd) => {
    await runRetention({ ...f.options, args: prepareArgs }); f.advance(); await runRetention({ ...f.options, args: updateArgs }); f[mode]();
    await assert.rejects(runRetention({ ...f.options, args: checkArgs() }), /PREVIEW_/);
    await assert.rejects(readFile(join(cwd, proofName('check'))), /ENOENT/);
    assert.equal(f.events.filter(event => event === 'dispatch:retention-check').length, mode === 'uiFailure' ? 0 : 1);
  });
});

test('source changes after dispatch never publish a proof or repeat a write', async () => withFixture(async (f, cwd) => {
  f.changeSource(); await assert.rejects(runRetention({ ...f.options, args: prepareArgs }), /PR_CHANGED/);
  await assert.rejects(readFile(join(cwd, proofName('prepare'))), /ENOENT/);
  assert.equal(f.events.filter(event => event === 'dispatch:retention-prepare').length, 1);
}));

test('proof wrappers reject unexpected keys, duplicate JSON, symlinks, masks and oversized files', async () => withFixture(async (_f, cwd) => {
  const receipt = retentionReceiptFixture(), proof = retentionProof(45, receipt), path = join(cwd, 'public.json');
  assert.equal(proof.protocol, 'cake-preview-retention-proof/v1');
  assert.throws(() => retentionProof(0, receipt), /PROOF_INVALID/); assert.ok(positive(proof.workflowId));
  for (const text of [JSON.stringify({ ...proof, private: 'never-accepted' }), JSON.stringify(proof).replace('{', '{"workflowId":46,'),
    JSON.stringify(proof).replace(retentionMarker, '***'), ' '.repeat(20_001)]) {
    await writeFile(path, text); await assert.rejects(readRetentionProof(path), /PROOF_INVALID/);
  }
  await writeFile(path, JSON.stringify(proof)); assert.deepEqual(await readRetentionProof(path), proof);
  await writeFile(path, JSON.stringify({ ...proof, workflowId: '45' })); await assert.rejects(readRetentionProof(path), /PROOF_INVALID/);
  const checked = retentionReceiptFixture('retention-check');
  assert.throws(() => retentionProof(45, checked), /PROOF_INVALID/);
  assert.throws(() => retentionProof(45, checked, { workflowId: 45, runId: '128', controlSha: 'f'.repeat(40), proofPath: '.cake/verify-75.json' }), /PROOF_INVALID/);
  await rm(path); await symlink(join(cwd, 'synthetic-only-file'), path);
  await assert.rejects(readRetentionProof(path), /PROOF_INVALID/);
}));

test('read invalidation refuses symlinks and never deletes their target', async () => withFixture(async (f, cwd) => {
  await mkdir(join(cwd, '.cake')); const target = join(cwd, 'synthetic-only-file');
  await writeFile(target, 'preserve synthetic fixture'); await symlink(target, join(cwd, proofName('check')));
  await assert.rejects(runRetention({ ...f.options, args: checkArgs() }), /PROOF_INVALID/);
  assert.equal(await readFile(target, 'utf8'), 'preserve synthetic fixture'); assert.equal(f.history.length, 0);
}));

test('a read retry invalidates earlier same-mode success before control validation, while write evidence and intents remain', async () => withFixture(async (f, cwd) => {
  await mkdir(join(cwd, '.cake'));
  const oldCheck = join(cwd, proofName('check')), baseline = join(cwd, proofName('prepare')), intent = join(cwd, '.cake/retention-75-update.intent.json');
  await writeFile(oldCheck, 'old check success'); await writeFile(baseline, 'original baseline'); await writeFile(intent, 'original intent'); f.dirty();
  await assert.rejects(runRetention({ ...f.options, args: checkArgs() }), /TRUSTED_MAIN_REQUIRED/);
  await assert.rejects(readFile(oldCheck), /ENOENT/);
  assert.equal(await readFile(baseline, 'utf8'), 'original baseline'); assert.equal(await readFile(intent, 'utf8'), 'original intent');
}));

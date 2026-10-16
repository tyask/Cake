import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import capability from '../preview-verify.config.json';
import { config } from '../scripts/preview-model';
import { verificationTarget, requestCiVerification, runCiVerify } from '../scripts/preview-verify-command';
import { readRemotePreviewProof, remotePreviewProof, revalidateRemotePreviewProof } from '../scripts/preview-remote-proof';
import type { WorkflowExecutor } from '../scripts/task-workflow';
import type { Receipt } from '../scripts/preview-service';
import { verifyChecksFixture } from './preview-verify-fixture';

function fixture(cwd = '/tmp', success = true) {
  const f = verifyChecksFixture(success), s = f.receipt.source;
  let dispatches = 0, controlHead = f.mainSha, installed = true, uncertain = false, cancelled = false, mainChanged = false;
  const pull = { number: s.pr, state: s.state, created_at: s.createdAt,
    head: { ref: s.branch, sha: s.sha, repo: { full_name: config.repository } }, base: { ref: 'main', repo: { full_name: config.repository } } };
  const execute: WorkflowExecutor = async (command, args) => {
    let value: unknown;
    if (command === 'git') {
      const call = args.join(' ');
      if (call === 'rev-parse --show-toplevel') value = cwd;
      else if (call === 'rev-parse HEAD') value = controlHead;
      else if (call.startsWith('status ')) value = '';
      else if (call === 'remote get-url origin') value = 'https://github.com/tyask/Cake.git';
      else throw new Error('Unexpected git command');
    } else {
      assert.equal(args[0], 'api');
      const path = args[1].slice(`repos/${config.repository}/`.length);
      if (args.includes('POST')) {
        dispatches++;
        const input = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
        assert.equal(input.ref, 'main'); assert.equal(input.inputs.action, 'verify'); assert.equal(input.inputs.deploymentId, f.deployment.id);
        assert.equal(input.inputs.sha, s.sha); assert.equal(input.inputs.controlSha, f.mainSha);
        f.receipt.operation = input.inputs.operation; f.run.display_title = `Preview verify PR ${s.pr} ${input.inputs.operation}`; f.sync();
        if (uncertain) return { status: 1, signal: null, stdout: 'secret-provider-error' };
        value = '';
      } else if (path === 'branches/main') value = { commit: { sha: mainChanged && dispatches ? 'c'.repeat(40) : f.mainSha } };
      else if (path.startsWith('contents/')) {
        const content = path.startsWith('contents/preview.config.json') ? config : installed ? capability : {};
        value = { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(content)).toString('base64') };
      } else if (path.startsWith('pulls/')) value = pull;
      else if (path.startsWith('actions/workflows/preview.yml/runs?')) value = { workflow_runs: [cancelled ? { ...f.run, conclusion: 'cancelled' } : f.run] };
      else value = await f.get(path);
    }
    return { status: 0, signal: null, stdout: typeof value === 'string' ? value : JSON.stringify(value) };
  };
  const status: Receipt = { protocol: 'cake-preview/v1', action: 'status', source: s, deployment: f.deployment,
    database: f.deployment.database, checkedAt: f.receipt.checkedAt, success: true };
  return { ...f, execute, status, pull, dispatches: () => dispatches, wrongControl: () => { controlHead = 'c'.repeat(40); },
    oldMain: () => { installed = false; }, uncertain: () => { uncertain = true; }, cancelled: () => { cancelled = true; },
    advanceMain: () => { mainChanged = true; } };
}
const silent = () => {};
const noWait = async () => {};
const argsFor = (f: ReturnType<typeof fixture>) => ['--pr', String(f.receipt.source.pr), '--sha', f.receipt.source.sha, '--deployment', f.deployment.id];

test('CI QA requires explicit exact PR, SHA and Deployment inputs', () => {
  const f = fixture(); assert.deepEqual(verificationTarget(argsFor(f)), { pr: 71, sha: f.receipt.source.sha, deploymentId: f.deployment.id });
  for (const args of [[], ['--pr', '71'], [...argsFor(f), '--pr', '71'], argsFor(f).map(x => x === '71' ? '071' : x),
    argsFor(f).map(x => x === f.receipt.source.sha ? 'main' : x), argsFor(f).map(x => x === f.deployment.id ? 'https://example.com' : x)]) {
    assert.throws(() => verificationTarget(args), /PREVIEW_VERIFY_ARGUMENTS/);
  }
});

test('CI request binds expected deployment and reads strict successful or failed notices without artifacts', async () => {
  for (const success of [true, false]) {
    const f = fixture('/tmp', success);
    const result = await requestCiVerification(f.receipt.source, f.deployment, f.mainSha, '/tmp', f.execute, noWait, silent);
    assert.equal(result.receipt.success, success); assert.equal(result.workflowId, f.workflow.id); assert.equal(f.dispatches(), 1);
    assert.ok(f.calls.includes('actions/runs/123/attempts/1/jobs?per_page=100&page=1'));
  }
});

test('uncertain dispatch, cancellation and changed main never trigger another verify request', async () => {
  for (const mode of ['uncertain', 'cancelled', 'advanceMain'] as const) {
    const f = fixture(); f[mode]();
    await assert.rejects(requestCiVerification(f.receipt.source, f.deployment, f.mainSha, '/tmp', f.execute, noWait, silent), /PREVIEW_/);
    assert.equal(f.dispatches(), 1);
  }
});

test('control client keeps target branch untouched and persists provenance on success and failure', async () => {
  for (const success of [true, false]) {
    const cwd = await mkdtemp(join(tmpdir(), 'cake-verify-client-test-'));
    try {
      const f = fixture(cwd, success), options = { args: argsFor(f), cwd, execute: f.execute, wait: noWait, log: silent,
        status: async () => f.status };
      if (success) assert.equal((await runCiVerify(options)).success, true);
      else await assert.rejects(runCiVerify(options), /PREVIEW_VERIFY_FAILED/);
      const saved = await readRemotePreviewProof(join(cwd, '.cake/verify-71.json'));
      assert.equal(saved.receipt.success, success); assert.equal(saved.workflowId, f.workflow.id); assert.equal(f.dispatches(), 1);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
});

test('source, control, capability or expected deployment mismatch invalidates previous success before dispatch', async () => {
  for (const mode of ['control', 'capability', 'source', 'deployment'] as const) {
    const cwd = await mkdtemp(join(tmpdir(), 'cake-verify-client-test-'));
    try {
      const f = fixture(cwd), path = join(cwd, '.cake/verify-71.json');
      await mkdir(join(cwd, '.cake')); await writeFile(path, 'old success');
      if (mode === 'control') f.wrongControl();
      if (mode === 'capability') f.oldMain();
      if (mode === 'source') f.pull.head.sha = 'c'.repeat(40);
      if (mode === 'deployment') f.status.deployment = { ...f.deployment, id: 'dpl_other' };
      await assert.rejects(runCiVerify({ args: argsFor(f), cwd, execute: f.execute, wait: noWait, log: silent, status: async () => f.status }), /PREVIEW_/);
      await assert.rejects(readFile(path)); assert.equal(f.dispatches(), 0);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
});

test('Ready remote evidence is re-read from its original run and failures cannot become local browser proof', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cake-verify-proof-test-')), path = join(cwd, 'proof.json');
  try {
    const f = verifyChecksFixture();
    await writeFile(path, JSON.stringify(remotePreviewProof(f.workflow.id, f.receipt)));
    const proof = await revalidateRemotePreviewProof(path, f.receipt.source, f.get);
    assert.equal(proof.clicks.length, 16); assert.equal(proof.observations!.length, 12); assert.equal(proof.success, true);
    const failed = verifyChecksFixture(false);
    await writeFile(path, JSON.stringify(remotePreviewProof(failed.workflow.id, failed.receipt)));
    await assert.rejects(revalidateRemotePreviewProof(path, failed.receipt.source, failed.get), /PROOF_INVALID/);
    assert.equal(failed.calls.length, 0);
    await writeFile(path, JSON.stringify({ ...remotePreviewProof(f.workflow.id, f.receipt), unknown: true }));
    await assert.rejects(readRemotePreviewProof(path), /PROOF_INVALID/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

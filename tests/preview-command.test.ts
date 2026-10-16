import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requestReceipt } from '../scripts/preview-command';
import { config } from '../scripts/preview-model';
import type { WorkflowExecutor } from '../scripts/task-workflow';
import { checksFixture, receiptSource as s } from './preview-checks-fixture';

function fixture(stale = false, attempt = 1, conclusion = 'success') {
  const checks = checksFixture();
  let dispatches = 0, pullReads = 0, downloaded = false;
  let installedConfig: unknown = config;
  const execute: WorkflowExecutor = async (_command, args) => {
    assert.ok(!args.includes('list'), 'workflow attempts use REST run_attempt, not version-dependent gh run list fields');
    if (args[0] !== 'api') { downloaded = true; throw new Error('Artifact download must not run'); }
    const path = args[1].slice(`repos/${config.repository}/`.length);
    let value: unknown = '';
    if (args.includes('POST')) {
      const request = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
      assert.equal(request.inputs.controlSha, checks.mainSha, 'dispatch must pin the main commit before any provider operation');
      dispatches++;
      checks.request.operation = request.inputs.operation;
      checks.receipt.operation = request.inputs.operation;
      checks.receipt.action = request.inputs.action;
      checks.run.display_title = `Preview ${request.inputs.action} PR ${s.pr} ${request.inputs.operation}`;
      checks.annotation.message = JSON.stringify(checks.receipt);
      checks.run.head_sha = stale ? 'c'.repeat(40) : checks.mainSha;
      checks.run.run_attempt = attempt;
      checks.run.conclusion = conclusion;
    } else if (path.startsWith('pulls/')) {
      pullReads++;
      value = { number: s.pr, state: s.state, created_at: s.createdAt, head: { ref: s.branch, sha: s.sha, repo: { full_name: config.repository } },
        base: { ref: 'main', repo: { full_name: config.repository } } };
    } else if (path.startsWith('actions/workflows/preview.yml/runs?')) value = { workflow_runs: [checks.run] };
    else if (path === 'branches/main') value = { commit: { sha: checks.mainSha } };
    else if (path.startsWith('contents/preview.config.json?')) value = { encoding: 'base64', content: Buffer.from(JSON.stringify(installedConfig)).toString('base64') };
    else value = await checks.get(path);
    return { status: 0, signal: null, stdout: typeof value === 'string' ? value : JSON.stringify(value) };
  };
  return { execute, checks, dispatches: () => dispatches, pullReads: () => pullReads, downloaded: () => downloaded,
    setConfig: (value: unknown) => { installedConfig = value; } };
}

test('CLI binds a notice receipt to the exact main workflow run, attempt, and request without downloading ZIPs', async () => {
  const f = fixture(); const result = await requestReceipt('status', s, '/tmp', f.execute, async () => {}, () => {});
  assert.equal(result.source.sha, s.sha); assert.equal(f.dispatches(), 1); assert.equal(f.downloaded(), false); assert.equal(f.pullReads(), 2);
  const stale = fixture(true);
  await assert.rejects(requestReceipt('status', s, '/tmp', stale.execute, async () => {}, () => {}), /RUN_CHANGED/);
  assert.equal(stale.downloaded(), false);
});

test('CLI rejects reruns and reports a failed run before reading receipt evidence', async () => {
  const rerun = fixture(false, 2);
  await assert.rejects(requestReceipt('status', s, '/tmp', rerun.execute, async () => {}, () => {}), /RUN_CHANGED/);
  assert.equal(rerun.checks.calls.includes('check-runs/345'), false);
  const failed = fixture(false, 1, 'failure'), logs: string[] = [];
  await assert.rejects(requestReceipt('status', s, '/tmp', failed.execute, async () => {}, m => logs.push(m)), /RUN_FAILED/);
  assert.equal(failed.checks.calls.includes('check-runs/345'), false);
  assert.ok(logs.some(m => m.includes('https://github.com/tyask/Cake/actions/runs/123')));
});

test('CLI refuses a main without the installed receipt transport before dispatch', async () => {
  const f = fixture();
  const previous: Record<string, unknown> = { ...config }; delete previous.receiptTransport; f.setConfig(previous);
  await assert.rejects(requestReceipt('status', s, '/tmp', f.execute, async () => {}, () => {}), /PREVIEW_NOT_INSTALLED_ON_MAIN/);
  assert.equal(f.dispatches(), 0);
});

test('CLI rechecks PR head after receipt retrieval', async () => {
  const f = fixture();
  await assert.rejects(requestReceipt('status', s, '/tmp', async (command, args, cwd) => {
    const result = await f.execute(command, args, cwd);
    if (args[1].includes('/pulls/') && f.pullReads() === 2) {
      const changed = JSON.parse(result.stdout); changed.head.sha = 'c'.repeat(40);
      return { ...result, stdout: JSON.stringify(changed) };
    }
    return result;
  }, async () => {}, () => {}), /PREVIEW_PR_CHANGED/);
});

test('CLI sanitizes API parse and provider errors', async () => {
  for (const value of ['provider-secret-body', '{"unfinished":']) {
    await assert.rejects(requestReceipt('status', s, '/tmp', async () => ({ status: 0, signal: null, stdout: value }), async () => {}, () => {}),
      error => error instanceof Error && error.message === 'PREVIEW_API_UNAVAILABLE');
  }
});

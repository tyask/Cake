import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readPreviewReceipt, readVerifyReceipt } from '../../scripts/preview/preview-checks';
import { parseReceipt, receiptMaxBytes } from '../../scripts/preview/preview-receipt';
import { verifyChecksFixture } from './fixtures/preview-verify-fixture';

// GitHub leaves this matrix job name unevaluated when the whole job is skipped.
const skippedPreviewName = "github.event_name == 'push' && format('preview-cleanup-{0}', matrix.pr) || 'preview'";

test('the observed skipped matrix name stays aligned with the management workflow expression', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/preview.yml', import.meta.url), 'utf8');
  const management = workflow.split('\n  preview:\n')[1]?.split('\n  preview-verify:\n')[0];
  assert.ok(management?.includes('    name: ${{ ' + skippedPreviewName + ' }}'));
});

test('verify receipt binds all metadata and rereads run, job, suite and check without an artifact', async () => {
  const f = verifyChecksFixture();
  assert.deepEqual(await readVerifyReceipt(f.get, 123, f.request), f.receipt);
  for (const path of ['actions/runs/123', 'actions/runs/123/attempts/1/jobs?per_page=100&page=1', 'check-suites/234', 'check-runs/345']) {
    assert.equal(f.calls.filter(value => value === path).length, 2);
  }
  assert.ok(f.calls.every(path => !path.startsWith('http') && !path.includes('artifact')));
  assert.throws(() => parseReceipt(f.annotation.message), /PREVIEW_RECEIPT_INVALID/);
});

test('only a matching completed failure is diagnostic; legacy operations still require success', async () => {
  const f = verifyChecksFixture(false);
  assert.deepEqual(await readVerifyReceipt(f.get, 123, f.request), f.receipt);
  for (const [key, patch] of [['run', { conclusion: 'cancelled' }], ['run', { conclusion: 'timed_out' }], ['run', { status: 'in_progress' }],
    ['job', { conclusion: 'success' }], ['suite', { conclusion: 'success' }], ['check', { conclusion: 'success' }]] as const) {
    const changed = verifyChecksFixture(false); Object.assign(changed[key], patch);
    await assert.rejects(readVerifyReceipt(changed.get, 123, changed.request), /PREVIEW_/);
  }
  const mismatch = verifyChecksFixture(false); mismatch.receipt.success = true; delete mismatch.receipt.failure; mismatch.sync();
  await assert.rejects(readVerifyReceipt(mismatch.get, 123, mismatch.request), /PREVIEW_VERIFY_RESULT_CHANGED/);
  await assert.rejects(readPreviewReceipt(f.get, 123, { ...f.request, action: 'status' }), /PREVIEW_RUN_CHANGED/);
});

test('split verify success and diagnostic failure select preview-verify with a skipped preview peer', async () => {
  for (const success of [true, false]) for (const peerName of ['preview', skippedPreviewName]) {
    const f = verifyChecksFixture(success, true); f.peer.name = peerName;
    assert.deepEqual(await readVerifyReceipt(f.get, 123, f.request), f.receipt);
    assert.equal(f.job.name, 'preview-verify');
    assert.equal(f.calls.filter(path => path === 'check-runs/345').length, 2);
    assert.equal(f.calls.includes('check-runs/346'), false);
    assert.equal(f.peer.name, peerName, 'the original peer name is retained');
  }
});

test('the skipped matrix alias requires one verification job and exactly one management peer', async () => {
  for (const inventory of ['canonical-and-alias', 'canonical-and-active-alias', 'canonical-and-executed-alias',
    'duplicate-alias', 'duplicate-verify', 'missing-verify', 'legacy-alias'] as const) {
    const f = verifyChecksFixture(true, inventory !== 'legacy-alias');
    f.peer.name = skippedPreviewName;
    if (inventory === 'canonical-and-active-alias') f.peer.status = 'in_progress';
    if (inventory === 'canonical-and-executed-alias') f.peer.conclusion = 'success';
    if (inventory === 'legacy-alias') f.job.name = f.check.name = skippedPreviewName;
    else if (inventory === 'missing-verify') f.jobs.jobs.splice(0, 1);
    else {
      const extra = inventory === 'duplicate-verify' ? f.job : f.peer;
      f.jobs.jobs.push({ ...extra, ...(inventory.startsWith('canonical-and-') ? { name: 'preview' } : {}), id: 458,
        url: 'https://api.github.com/repos/tyask/Cake/actions/jobs/458', check_run_url: 'https://api.github.com/repos/tyask/Cake/check-runs/347' });
    }
    f.jobs.total_count = f.jobs.jobs.length;
    await assert.rejects(readVerifyReceipt(f.get, 123, f.request), /PREVIEW_JOB_AMBIGUOUS/);
    assert.equal(f.calls.some(path => path.startsWith('check-runs/')), false);
  }
});

test('similar or modified skipped matrix names cannot substitute for the observed peer name', async () => {
  for (const name of [skippedPreviewName + ' ', skippedPreviewName.replace("'push'", "'pull_request'"),
    '${{ ' + skippedPreviewName + ' }}', 'preview-cleanup-71', 'preview (skipped)']) {
    const f = verifyChecksFixture(true, true); f.peer.name = name;
    await assert.rejects(readVerifyReceipt(f.get, 123, f.request), /PREVIEW_JOB_AMBIGUOUS/);
    assert.equal(f.calls.some(path => path.startsWith('check-runs/')), false);
  }
});

test('split verify rejects missing or duplicate known jobs and a skipped selected job without fallback', async () => {
  for (const inventory of ['missing-preview', 'missing-verify', 'duplicate-preview', 'duplicate-verify', 'skipped-verify'] as const) {
    const f = verifyChecksFixture(true, true);
    if (inventory === 'missing-preview') f.jobs.jobs.pop();
    else if (inventory === 'missing-verify') f.jobs.jobs.splice(0, 1);
    else if (inventory === 'skipped-verify') {
      f.job.conclusion = 'skipped'; f.peer.conclusion = 'success';
    } else f.jobs.jobs.push({ ...(inventory === 'duplicate-preview' ? f.peer : f.job), id: 458,
      url: 'https://api.github.com/repos/tyask/Cake/actions/jobs/458', check_run_url: 'https://api.github.com/repos/tyask/Cake/check-runs/347' });
    f.jobs.total_count = f.jobs.jobs.length;
    await assert.rejects(readVerifyReceipt(f.get, 123, f.request), /PREVIEW_JOB_(AMBIGUOUS|CHANGED)/);
    assert.equal(f.calls.some(path => path.startsWith('check-runs/')), false);
  }
});

test('split verify checks peer provenance and requires the notice step on the selected job', async () => {
  for (const peerName of ['preview', skippedPreviewName]) for (const patch of [
    { status: 'queued' }, { status: 'in_progress' }, { conclusion: 'success' }, { conclusion: 'failure' }, { conclusion: 'cancelled' },
    { run_id: 124 }, { run_attempt: 2 },
    { head_sha: 'c'.repeat(40) }, { head_branch: 'codex/test' }, { url: 'https://evil.example/jobs/457' },
    { run_url: 'https://evil.example/runs/123' }, { check_run_url: 'https://api.github.com/repos/tyask/Cake/check-runs/346?x=1' },
  ]) {
    const f = verifyChecksFixture(true, true); Object.assign(f.peer, { name: peerName }, patch);
    await assert.rejects(readVerifyReceipt(f.get, 123, f.request), /PREVIEW_(JOB_CHANGED|CHECK_URL)/);
  }
  const misplaced = verifyChecksFixture(true, true);
  Object.assign(misplaced.peer, { steps: Reflect.get(misplaced.job, 'steps') });
  Reflect.deleteProperty(misplaced.job, 'steps');
  await assert.rejects(readVerifyReceipt(misplaced.get, 123, misplaced.request), /PREVIEW_VERIFY_NOTICE_STEP/);
});

test('split verify rereads bind the selected and skipped jobs and reject downgrade to an executed preview', async () => {
  for (const peerName of ['preview', skippedPreviewName]) for (const change of ['selected', 'peer-state', 'peer-identity', 'downgrade', 'add-peer'] as const) {
    const f = verifyChecksFixture(true, change !== 'add-peer'); f.peer.name = peerName; let reads = 0;
    await assert.rejects(readVerifyReceipt(async path => {
      const value = await f.get(path);
      if (path.endsWith('jobs?per_page=100&page=1') && ++reads === 2) {
        const response = value as typeof f.jobs;
        if (change === 'selected') Object.assign(response.jobs[0], { completed_at: '2026-10-16T01:00:03Z' });
        else if (change === 'peer-state') Object.assign(response.jobs[1], { conclusion: 'success' });
        else if (change === 'peer-identity') Object.assign(response.jobs[1], { id: 458,
          url: 'https://api.github.com/repos/tyask/Cake/actions/jobs/458', check_run_url: 'https://api.github.com/repos/tyask/Cake/check-runs/347' });
        else if (change === 'downgrade') {
          // A valid legacy job still cannot replace the selected split job during retrieval.
          response.jobs = [{ ...f.job, name: 'preview' }]; response.total_count = 1;
        } else {
          response.jobs[0].name = 'preview-verify'; response.jobs.push(f.peer); response.total_count = 2;
        }
      }
      return value;
    }, 123, f.request), /PREVIEW_JOB_CHANGED/);
  }
});

test('canonical and unevaluated peer names cannot change during receipt retrieval', async () => {
  for (const [before, after] of [['preview', skippedPreviewName], [skippedPreviewName, 'preview']]) {
    const f = verifyChecksFixture(true, true); f.peer.name = before; let reads = 0;
    await assert.rejects(readVerifyReceipt(async path => {
      const value = await f.get(path);
      if (path.endsWith('jobs?per_page=100&page=1') && ++reads === 2) {
        (value as typeof f.jobs).jobs[1].name = after;
      }
      return value;
    }, 123, f.request), /PREVIEW_JOB_CHANGED/);
  }
});

test('skipped peer timestamps and steps are not required or included in execution snapshot comparison', async () => {
  for (const peerName of ['preview', skippedPreviewName]) {
    const f = verifyChecksFixture(true, true); f.peer.name = peerName; let reads = 0;
    assert.deepEqual(await readVerifyReceipt(async path => {
      const value = await f.get(path);
      if (path.endsWith('jobs?per_page=100&page=1') && ++reads === 2) {
        const response = value as typeof f.jobs;
        Object.assign(response.jobs[1], { started_at: null, completed_at: null, steps: [] });
      }
      return value;
    }, 123, f.request), f.receipt);
  }
});

test('verify requires the unique receipt publication step to have succeeded', async () => {
  for (const steps of [undefined, [], [{ name: 'other', number: 6, status: 'completed', conclusion: 'success' }],
    [{ name: 'Publish public operation receipt notice', number: 6, status: 'completed', conclusion: 'failure' }],
    [{ name: 'Publish public operation receipt notice', number: 0, status: 'completed', conclusion: 'success' }],
    Array.from({ length: 2 }, () => ({ name: 'Publish public operation receipt notice', number: 6, status: 'completed', conclusion: 'success' }))]) {
    const f = verifyChecksFixture(false); Object.assign(f.job, { steps });
    await assert.rejects(readVerifyReceipt(f.get, 123, f.request), /PREVIEW_VERIFY_NOTICE_STEP/);
  }
});

test('verify source, pinned control, exact attempt, repository, suite and app cannot be substituted', async () => {
  for (const [key, patch] of [
    ['run', { run_attempt: 2 }], ['run', { head_sha: 'c'.repeat(40) }], ['run', { event: 'pull_request' }],
    ['run', { head_repository: { id: 1, full_name: 'other/Cake' } }], ['job', { run_attempt: 2 }],
    ['job', { check_run_url: 'https://api.github.com/repos/other/Cake/check-runs/345' }],
    ['suite', { repository: { id: 1, full_name: 'other/Cake' } }], ['suite', { head_sha: 'c'.repeat(40) }],
    ['check', { app: { id: 15369, slug: 'github-actions', html_url: 'https://github.com/apps/github-actions' } }],
  ] as const) {
    const f = verifyChecksFixture(); Object.assign(f[key], patch);
    await assert.rejects(readVerifyReceipt(f.get, 123, f.request), /PREVIEW_/);
  }
  const f = verifyChecksFixture();
  await assert.rejects(readVerifyReceipt(f.get, 123, { ...f.request, expectedDeployment: { ...f.deployment, operation: '30000000-0000-4000-8000-000000000003' } }), /VERIFY_RECEIPT_INVALID/);
  await assert.rejects(readVerifyReceipt(f.get, 123, { ...f.request, source: { ...f.request.source, sha: 'c'.repeat(40) } }), /VERIFY_RECEIPT_INVALID/);
});

test('all jobs and annotations pages are read and exactly one verify notice is accepted', async () => {
  const f = verifyChecksFixture();
  f.responses.set('actions/runs/123/attempts/1/jobs?per_page=100&page=1', { total_count: 101,
    jobs: Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `other-${i}`, check_run_url: `https://api.github.com/repos/tyask/Cake/check-runs/${1000 + i}` })) });
  f.responses.set('actions/runs/123/attempts/1/jobs?per_page=100&page=2', { total_count: 101, jobs: [f.job] });
  f.check.output.annotations_count = 101;
  f.responses.set('check-runs/345/annotations?per_page=100&page=1', Array.from({ length: 100 }, () => ({ title: 'other' })));
  f.responses.set('check-runs/345/annotations?per_page=100&page=2', [f.annotation]);
  assert.deepEqual(await readVerifyReceipt(f.get, 123, f.request), f.receipt);
  assert.equal(f.calls.filter(path => path.endsWith('jobs?per_page=100&page=2')).length, 2);
  f.responses.set('check-runs/345/annotations?per_page=100&page=1', [f.annotation, ...Array.from({ length: 99 }, () => ({ title: 'other' }))]);
  await assert.rejects(readVerifyReceipt(f.get, 123, f.request), /PREVIEW_RECEIPT_AMBIGUOUS/);
});

test('missing, masked, truncated or excessive notices and evidence outside the job fail closed', async () => {
  for (const patch of [{ title: 'cake-preview-receipt/v1' }, { annotation_level: 'warning' }, { message: '' },
    { message: '{"operation":"***"}' }, { message: '{"protocol":"cake-preview-verify/v1"' }, { message: 'あ'.repeat(receiptMaxBytes) }]) {
    const f = verifyChecksFixture(); Object.assign(f.annotation, patch);
    await assert.rejects(readVerifyReceipt(f.get, 123, f.request), /PREVIEW_.*RECEIPT_/);
  }
  const outside = verifyChecksFixture(); outside.receipt.browser!.checks[0][2] = '2026-10-16T00:58:00Z'; outside.sync();
  await assert.rejects(readVerifyReceipt(outside.get, 123, outside.request), /VERIFY_RECEIPT_INVALID/);
});

test('verify rejects run, job, suite and check metadata changes during receipt retrieval', async () => {
  for (const changedPath of ['actions/runs/123', 'actions/runs/123/attempts/1/jobs?per_page=100&page=1', 'check-suites/234', 'check-runs/345']) {
    const f = verifyChecksFixture(); let reads = 0;
    await assert.rejects(readVerifyReceipt(async path => {
      const result = await f.get(path);
      if (path === changedPath && ++reads === 2) {
        const value = result as Record<string, unknown>;
        if (path.includes('/jobs?')) Object.assign((value.jobs as Record<string, unknown>[])[0], { completed_at: '2026-10-16T01:00:03Z' });
        else if (path.includes('check-suites')) Object.assign(value, { repository: { id: 1318171856, full_name: 'tyask/Cake', changed: true } });
        else if (path.includes('check-runs')) Object.assign(value, { output: { ...f.check.output, annotations_count: 2 } });
        else Object.assign(value, { updated_at: '2026-10-16T01:00:06Z' });
      }
      return result;
    }, 123, f.request), /PREVIEW_/);
  }
});

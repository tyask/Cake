import test from 'node:test';
import assert from 'node:assert/strict';
import { readPreviewReceipt, readVerifyReceipt } from '../scripts/preview-checks';
import { parseReceipt, receiptMaxBytes } from '../scripts/preview-receipt';
import { verifyChecksFixture } from './preview-verify-fixture';

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

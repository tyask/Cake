import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPreviewRun, previewWorkflow, readPreviewReceipt } from '../scripts/preview-checks';
import { receiptMaxBytes } from '../scripts/preview-receipt';
import { checksFixture } from './preview-checks-fixture';

test('receipt GET follows a pinned workflow, exact attempt, operation job, suite, and canonical check URL', async () => {
  const f = checksFixture();
  assert.deepEqual(await previewWorkflow(f.get), { id: 45 });
  assert.deepEqual(await readPreviewReceipt(f.get, 123, f.request), f.receipt);
  assert.equal(f.calls.filter(path => path === 'actions/runs/123').length, 2);
  assert.equal(f.calls.filter(path => path === 'check-runs/345').length, 2);
  assert.ok(f.calls.includes('actions/runs/123/attempts/1/jobs?per_page=100&page=1'));
  assert.ok(f.calls.every(path => !path.startsWith('http')));
});

test('the notice reader accepts bounded deploy, status, and closed-PR cleanup receipts', async () => {
  const database = { branchId: 'br-preview-test', endpointId: 'ep-preview-test', hostDigest: 'd'.repeat(64) };
  for (const action of ['deploy', 'status', 'cleanup'] as const) {
    const f = checksFixture(action);
    if (action === 'cleanup') f.request.source = { ...f.request.source, state: 'closed' };
    const receipt = { ...f.receipt, source: f.request.source, ...(action !== 'cleanup' ? { database,
      deployment: { id: 'dpl_previewtest', url: 'https://cake-preview-test.vercel.app', sha: f.request.source.sha,
        branch: f.request.source.branch, pr: f.request.source.pr, generation: f.operation, operation: f.operation,
        phase: 'application', state: 'READY', createdAt: Date.parse('2026-10-16T00:30:00Z'), database } } : {}) };
    f.annotation.message = JSON.stringify(receipt);
    assert.deepEqual(await readPreviewReceipt(f.get, 123, f.request), receipt);
  }
});

test('workflow identity comes from the configured workflow endpoint', async () => {
  for (const patch of [{ id: 0 }, { path: '.github/workflows/other.yml' }, { state: 'disabled_manually' }, { url: 'https://evil.example/actions/workflows/45' }]) {
    const f = checksFixture(); Object.assign(f.workflow, patch);
    await assert.rejects(previewWorkflow(f.get), /PREVIEW_WORKFLOW_CHANGED/);
  }
});

test('run provenance rejects reruns, another workflow/repository/head/event, old title, and spoofed URLs', () => {
  const f = checksFixture();
  const patches = [
    { id: 0 }, { run_attempt: 2 }, { workflow_id: 46 }, { head_sha: 'c'.repeat(40) }, { head_branch: 'codex/test' },
    { path: '.github/workflows/other.yml' }, { event: 'push' }, { display_title: 'Preview status PR 71 old-operation' },
    { repository: { id: 1, full_name: 'other/Cake' } }, { head_repository: { id: 1, full_name: 'other/Cake' } },
    { url: `${f.run.url}?ref=other` }, { check_suite_url: 'https://evil.example/check-suites/234' }, { check_suite_id: 0 },
    { created_at: 'not-a-time' }, { updated_at: '2026-10-15T01:00:00Z' },
  ];
  for (const patch of patches) assert.throws(() => assertPreviewRun({ ...f.run, ...patch }, f.request), /PREVIEW_/);
});

test('a matching check name or external ID cannot replace job and suite provenance', async () => {
  for (const patch of [
    { name: 'other' }, { run_id: 124 }, { run_attempt: 2 }, { head_sha: 'c'.repeat(40) }, { head_branch: 'codex/test' },
    { status: 'in_progress' }, { conclusion: 'failure' }, { url: 'https://evil.example/jobs/456' }, { run_url: 'https://evil.example/runs/123' },
    { started_at: '2026-10-14T00:00:00Z' }, { completed_at: '2026-10-16T03:00:00Z' },
  ]) {
    const f = checksFixture(); Object.assign(f.job, patch);
    await assert.rejects(readPreviewReceipt(f.get, 123, f.request), /PREVIEW_/);
  }
  for (const value of ['https://evil.example/check-runs/345', 'https://api.github.com/repos/other/Cake/check-runs/345',
    'https://api.github.com/repos/tyask/Cake/check-runs/345?x=1', 'https://api.github.com/repos/tyask/Cake/check-runs/0345',
    'https://api.github.com/repos/tyask/Cake/check-runs/345/annotations']) {
    const f = checksFixture(); f.job.check_run_url = value;
    await assert.rejects(readPreviewReceipt(f.get, 123, f.request), /PREVIEW_CHECK_URL/);
    assert.equal(f.calls.some(path => path.startsWith('check-runs/')), false);
  }
});

test('suite and check must belong to the verified repository, main head, and GitHub Actions app', async () => {
  for (const patch of [
    { id: 235 }, { url: 'https://evil.example/check-suites/234' }, { head_sha: 'c'.repeat(40) }, { head_branch: 'codex/test' },
    { repository: { id: 1, full_name: 'other/Cake' } }, { status: 'queued' }, { conclusion: 'failure' },
    { app: { id: 15368, slug: 'other-app', html_url: 'https://github.com/apps/other-app' } },
  ]) {
    const f = checksFixture(); Object.assign(f.suite, patch);
    await assert.rejects(readPreviewReceipt(f.get, 123, f.request), /PREVIEW_/);
  }
  for (const patch of [
    { id: 346 }, { url: 'https://evil.example/check-runs/345' }, { head_sha: 'c'.repeat(40) }, { check_suite: { id: 235 } },
    { name: 'other' }, { status: 'queued' }, { conclusion: 'failure' },
    { app: { id: 15369, slug: 'github-actions', html_url: 'https://github.com/apps/github-actions' } },
  ]) {
    const f = checksFixture(); Object.assign(f.check, patch);
    await assert.rejects(readPreviewReceipt(f.get, 123, f.request), /PREVIEW_/);
  }
});

test('all jobs and annotations pages are read before accepting exactly one receipt', async () => {
  const f = checksFixture();
  const otherJobs = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `other-${i}`, check_run_url: `https://api.github.com/repos/tyask/Cake/check-runs/${1000 + i}` }));
  f.responses.set('actions/runs/123/attempts/1/jobs?per_page=100&page=1', { total_count: 101, jobs: otherJobs });
  f.responses.set('actions/runs/123/attempts/1/jobs?per_page=100&page=2', { total_count: 101, jobs: [f.job] });
  f.check.output.annotations_count = 101;
  f.responses.set('check-runs/345/annotations?per_page=100&page=1', Array.from({ length: 100 }, () => ({ title: 'other', annotation_level: 'notice', message: 'other' })));
  f.responses.set('check-runs/345/annotations?per_page=100&page=2', [f.annotation]);
  assert.deepEqual(await readPreviewReceipt(f.get, 123, f.request), f.receipt);
  assert.ok(f.calls.includes('actions/runs/123/attempts/1/jobs?per_page=100&page=2'));
  assert.ok(f.calls.includes('check-runs/345/annotations?per_page=100&page=2'));
  f.responses.set('check-runs/345/annotations?per_page=100&page=1', [f.annotation, ...Array.from({ length: 99 }, () => ({ title: 'other' }))]);
  await assert.rejects(readPreviewReceipt(f.get, 123, f.request), /PREVIEW_RECEIPT_AMBIGUOUS/);
});

test('check and job timestamps allow small API clock differences but reject a different time window', async () => {
  const f = checksFixture();
  f.check.started_at = '2026-10-16T01:00:02Z'; f.check.completed_at = '2026-10-16T01:00:05Z';
  assert.deepEqual(await readPreviewReceipt(f.get, 123, f.request), f.receipt);
  for (const patch of [{ started_at: '2026-10-16T00:58:59Z' }, { completed_at: '2026-10-16T01:01:05Z' }]) {
    const changed = checksFixture(); Object.assign(changed.check, patch);
    await assert.rejects(readPreviewReceipt(changed.get, 123, changed.request), /PREVIEW_CHECK_CHANGED/);
  }
});

test('incomplete, duplicate, or excessive inventories are rejected', async () => {
  for (const response of [{ total_count: 0, jobs: [] }, { total_count: 2, jobs: [] }, { total_count: 1001, jobs: [] },
    { total_count: 2, jobs: [checksFixture().job, checksFixture().job] }]) {
    const f = checksFixture(); f.responses.set('actions/runs/123/attempts/1/jobs?per_page=100&page=1', response);
    await assert.rejects(readPreviewReceipt(f.get, 123, f.request), /PREVIEW_JOBS_INCOMPLETE/);
  }
  const duplicate = checksFixture(); duplicate.jobs.jobs.push({ ...duplicate.job, id: 457, check_run_url: 'https://api.github.com/repos/tyask/Cake/check-runs/346' }); duplicate.jobs.total_count = 2;
  await assert.rejects(readPreviewReceipt(duplicate.get, 123, duplicate.request), /PREVIEW_JOB_AMBIGUOUS/);
  for (const count of [0, 2, 1001]) {
    const f = checksFixture(); f.check.output.annotations_count = count;
    await assert.rejects(readPreviewReceipt(f.get, 123, f.request), /PREVIEW_ANNOTATIONS_INCOMPLETE/);
  }
  const spoof = checksFixture(); spoof.check.output.annotations_url = 'https://evil.example/annotations';
  await assert.rejects(readPreviewReceipt(spoof.get, 123, spoof.request), /PREVIEW_ANNOTATIONS_INCOMPLETE/);
});

test('missing, duplicate, wrong level, masked, truncated, and oversized notices are rejected', async () => {
  for (const patch of [{ title: 'other' }, { annotation_level: 'warning' }, { message: '' }, { message: '{"operation":"***"}' },
    { message: '{"protocol":"cake-preview/v1"' }, { message: 'あ'.repeat(Math.floor(receiptMaxBytes / 3) + 1) }]) {
    const f = checksFixture(); Object.assign(f.annotation, patch);
    await assert.rejects(readPreviewReceipt(f.get, 123, f.request), /PREVIEW_RECEIPT_/);
  }
  const f = checksFixture(); f.check.output.annotations_count = 2;
  f.responses.set('check-runs/345/annotations?per_page=100&page=1', [f.annotation, f.annotation]);
  await assert.rejects(readPreviewReceipt(f.get, 123, f.request), /PREVIEW_RECEIPT_AMBIGUOUS/);
});

test('receipt must match request identity and current operation job time', async () => {
  for (const patch of [{ runId: '124' }, { runAttempt: 2 }, { action: 'deploy' }, { operation: '12345678-1234-4234-8234-123456789abd' },
    { controlSha: 'c'.repeat(40) }, { source: { ...checksFixture().request.source, sha: 'c'.repeat(40) } },
    { checkedAt: '2026-10-15T00:00:00Z' }, { checkedAt: '2026-10-17T00:00:00Z' }]) {
    const f = checksFixture(); f.annotation.message = JSON.stringify({ ...f.receipt, ...patch });
    await assert.rejects(readPreviewReceipt(f.get, 123, f.request), /PREVIEW_RECEIPT_/);
  }
});

test('completed run or check metadata changes during the read fail closed', async () => {
  for (const changedPath of ['actions/runs/123', 'check-runs/345']) {
    const f = checksFixture(); let reads = 0;
    await assert.rejects(readPreviewReceipt(async path => {
      const response = await f.get(path);
      if (path === changedPath && ++reads === 2) {
        if (changedPath === 'actions/runs/123') Object.assign(response!, { run_attempt: 2 });
        else Object.assign(response!, { output: { ...f.check.output, annotations_count: 2 } });
      }
      return response;
    }, 123, f.request), /PREVIEW_(RUN|CHECK)_CHANGED/);
  }
});

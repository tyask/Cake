import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../scripts/preview-model';
import { retentionActions } from '../scripts/preview-retention-model';
import { loadRegistrationBaseline, loadRetentionOriginal, loadRetentionReceipt, loadRetentionRun, loadRetentionUpdate, readRetentionReceipt, type PreviewGet } from '../scripts/preview-checks';
import { serializeRetentionReceipt, type RetentionReceipt } from '../scripts/preview-retention-receipt';
import { retentionChecksFixture, retentionReceiptFixture, retentionNewSource } from './preview-retention-fixture';

function graph(...receipts: RetentionReceipt[]) {
  const fixtures = receipts.map(receipt => retentionChecksFixture(receipt));
  const responses = new Map(fixtures.flatMap(f => [...f.responses]));
  const s = retentionNewSource;
  responses.set(`pulls/${s.pr}`, { number: s.pr, state: 'open', created_at: s.createdAt,
    head: { ref: s.branch, sha: s.sha, repo: { full_name: config.repository } }, base: { ref: 'main', repo: { full_name: config.repository } } });
  const calls: string[] = [];
  const get: PreviewGet = async path => { calls.push(path); if (!responses.has(path)) throw new Error(`UNEXPECTED_TEST_PATH:${path}`); return structuredClone(responses.get(path)); };
  return { fixtures, responses, calls, get };
}
function unknownPrepare() {
  const r = retentionReceiptFixture(); r.success = false; r.outcome = 'unknown'; delete r.evidence; delete r.runtimeAfterAt;
  r.failure = { stage: 'write', code: 'PREVIEW_RETENTION_WRITE_UNKNOWN' }; return r;
}

test('every retention action binds a unique notice to its exact initial main run and all provenance snapshots', async () => {
  for (const action of retentionActions) {
    const f = retentionChecksFixture(retentionReceiptFixture(action));
    assert.deepEqual(await readRetentionReceipt(f.get, Number(f.receipt.runId), f.request), f.receipt);
    for (const path of [`actions/runs/${f.receipt.runId}`, `actions/runs/${f.receipt.runId}/attempts/1/jobs?per_page=100&page=1`,
      `check-suites/${Number(f.receipt.runId) + 2000}`, `check-runs/${Number(f.receipt.runId) + 3000}`]) assert.equal(f.calls.filter(value => value === path).length, 2);
    assert.ok(f.calls.every(path => !path.startsWith('http') && !path.includes('artifacts')));
  }
});
test('failed receipts require failure conclusions across the run, job, check and suite', async () => {
  const f = retentionChecksFixture(unknownPrepare());
  assert.deepEqual(await readRetentionReceipt(f.get, Number(f.receipt.runId), f.request), f.receipt);
  for (const key of ['run', 'job', 'check', 'suite'] as const) {
    const bad = retentionChecksFixture(unknownPrepare()); Object.assign(bad[key], { conclusion: 'success' });
    await assert.rejects(readRetentionReceipt(bad.get, Number(bad.receipt.runId), bad.request), /PREVIEW_/);
  }
  const changed = retentionChecksFixture(); changed.receipt.success = false;
  changed.receipt.failure = { stage: 'boundary', code: 'PREVIEW_RETENTION_BROWSER_FAILED' }; changed.annotation.message = serializeRetentionReceipt(changed.receipt);
  await assert.rejects(readRetentionReceipt(changed.get, Number(changed.receipt.runId), changed.request), /RETENTION_RESULT_CHANGED/);
});
test('historical receipt derives old source from trusted provenance while current head intentionally advances', async () => {
  const r = retentionReceiptFixture(), f = graph(r);
  assert.deepEqual(await loadRetentionReceipt(f.get, Number(r.runId)), r);
  const context = await loadRetentionRun(f.get, Number(r.runId));
  assert.equal(context.pr, r.source.pr); assert.equal(context.operation, r.marker); assert.equal(context.controlSha, r.controlSha);
  assert.equal('source' in context, false); assert.equal('expectedDeploymentId' in context, false);
  const foreign = graph(r), current = foreign.responses.get(`pulls/${r.source.pr}`) as { head: { ref: string } }; current.head.ref = 'codex/foreign';
  await assert.rejects(loadRetentionReceipt(foreign.get, Number(r.runId)), /PREVIEW_PR_CHANGED/);
});
test('only a genuinely missing original notice permits diagnostic recovery; malformed data never becomes missing', async () => {
  const f = graph(unknownPrepare()), original = f.fixtures[0], checkId = Number(original.receipt.runId) + 3000;
  original.check.output.annotations_count = 0;
  f.responses.set(`check-runs/${checkId}/annotations?per_page=100&page=1`, []);
  Object.assign(original.job, { steps: [{ name: 'Publish public operation receipt notice', number: 7, status: 'completed', conclusion: 'failure' }] });
  const loaded = await loadRetentionOriginal(f.get, Number(original.receipt.runId));
  assert.equal(loaded.receipt, undefined); assert.equal(loaded.run.action, 'retention-prepare');
  await assert.rejects(loadRegistrationBaseline(f.get, Number(original.receipt.runId)), /RETENTION_RECEIPT_MISSING/);
  for (const message of ['{"operation":"***"}', '{', JSON.stringify({ ...original.receipt, token: 'private' })]) {
    const bad = graph(unknownPrepare()); bad.fixtures[0].annotation.message = message;
    await assert.rejects(loadRetentionOriginal(bad.get, Number(original.receipt.runId)), /RECEIPT_/);
  }
  const duplicate = graph(unknownPrepare()); duplicate.fixtures[0].check.output.annotations_count = 2;
  duplicate.responses.set(`check-runs/${checkId}/annotations?per_page=100&page=1`, [duplicate.fixtures[0].annotation, duplicate.fixtures[0].annotation]);
  await assert.rejects(loadRetentionOriginal(duplicate.get, Number(original.receipt.runId)), /RECEIPT_AMBIGUOUS/);
});
test('registration baseline reloads the original unknown prepare and accepts only one inspect hop', async () => {
  const original = unknownPrepare(), inspect = retentionReceiptFixture('retention-inspect'), f = graph(original, inspect);
  assert.deepEqual(await loadRegistrationBaseline(f.get, Number(inspect.runId)), inspect);
  assert.ok(f.calls.includes(`actions/runs/${original.runId}`));
  const noWrite = structuredClone(original); noWrite.writeAttempts = 0;
  const bad = graph(noWrite, inspect); await assert.rejects(loadRegistrationBaseline(bad.get, Number(inspect.runId)), /RETENTION_RECEIPT_INVALID/);
  const secondInspect = structuredClone(inspect); secondInspect.runId = '128'; secondInspect.baselineRunId = inspect.runId;
  const nested = graph(original, inspect, secondInspect);
  await assert.rejects(loadRegistrationBaseline(nested.get, Number(secondInspect.runId)), /RETENTION_RECEIPT_INVALID/);
});
test('accepted update and reconcile reload their baseline and original unknown update chain', async () => {
  const baseline = retentionReceiptFixture(), update = retentionReceiptFixture('retention-update');
  const f = graph(baseline, update); assert.deepEqual(await loadRetentionUpdate(f.get, Number(update.runId), baseline), update);
  const unknown = structuredClone(update); unknown.success = false; delete unknown.deployment; delete unknown.database;
  unknown.failure = { stage: 'update', code: 'PREVIEW_RETENTION_UPDATE_UNKNOWN' };
  const reconcile = retentionReceiptFixture('retention-reconcile'), recovered = graph(baseline, unknown, reconcile);
  assert.deepEqual(await loadRetentionUpdate(recovered.get, Number(reconcile.runId), baseline), reconcile);
  unknown.attemptedDeploymentId = reconcile.deployment!.id;
  const identified = graph(baseline, unknown, reconcile);
  assert.deepEqual(await loadRetentionUpdate(identified.get, Number(reconcile.runId), baseline), reconcile);
  unknown.attemptedDeploymentId = 'dpl_otherattempt';
  const different = graph(baseline, unknown, reconcile);
  await assert.rejects(loadRetentionUpdate(different.get, Number(reconcile.runId), baseline), /RETENTION_RECEIPT_INVALID/);
  const localForgery = structuredClone(baseline); localForgery.evidence!.collectionDigest = 'f'.repeat(64);
  await assert.rejects(loadRetentionUpdate(recovered.get, Number(reconcile.runId), localForgery), /BASELINE_CHANGED/);
});
test('wrong attempts, workflow/repository provenance, notice step or evidence time fail closed', async () => {
  for (const [key, patch] of [['run', { run_attempt: 2 }], ['run', { workflow_id: 999 }], ['run', { head_branch: 'codex/foreign' }],
    ['run', { head_repository: { id: 1, full_name: config.repository } }], ['suite', { repository: { id: 1, full_name: 'other/Cake' } }],
    ['job', { check_run_url: 'https://evil.example/check-runs/1' }], ['job', { steps: [] }], ['check', { app: { id: 1, slug: 'other', html_url: 'other' } }]] as const) {
    const f = retentionChecksFixture(); Object.assign(f[key], patch);
    await assert.rejects(readRetentionReceipt(f.get, Number(f.receipt.runId), f.request), /PREVIEW_/);
  }
  const f = retentionChecksFixture(); f.receipt.runtimeBeforeAt = '2026-10-16T00:58:00Z'; f.annotation.message = serializeRetentionReceipt(f.receipt);
  await assert.rejects(readRetentionReceipt(f.get, Number(f.receipt.runId), f.request), /RETENTION_RECEIPT_INVALID/);
});
test('all jobs and annotation pages are read and metadata changes invalidate accepted data', async () => {
  const f = retentionChecksFixture(), id = Number(f.receipt.runId), checkId = id + 3000;
  f.responses.set(`actions/runs/${id}/attempts/1/jobs?per_page=100&page=1`, { total_count: 101,
    jobs: Array.from({ length: 100 }, (_, i) => ({ id: 10000 + i, name: `other-${i}`, check_run_url: `https://api.github.com/repos/tyask/Cake/check-runs/${10000 + i}` })) });
  f.responses.set(`actions/runs/${id}/attempts/1/jobs?per_page=100&page=2`, { total_count: 101, jobs: [f.job] });
  f.check.output.annotations_count = 101;
  f.responses.set(`check-runs/${checkId}/annotations?per_page=100&page=1`, Array.from({ length: 100 }, () => ({ title: 'other' })));
  f.responses.set(`check-runs/${checkId}/annotations?per_page=100&page=2`, [f.annotation]);
  assert.deepEqual(await readRetentionReceipt(f.get, id, f.request), f.receipt);
  assert.equal(f.calls.filter(path => path.endsWith('jobs?per_page=100&page=2')).length, 2);
  const changed = retentionChecksFixture(); let reads = 0;
  await assert.rejects(readRetentionReceipt(async path => {
    const value = await changed.get(path);
    if (path === `actions/runs/${id}` && ++reads === 2) Object.assign(value as object, { run_attempt: 2 });
    return value;
  }, id, changed.request), /PREVIEW_RUN_CHANGED/);
});

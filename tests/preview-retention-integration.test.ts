import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../scripts/preview-model';
import { loadRegistrationBaseline, loadRetentionUpdate, readRetentionReceipt, type PreviewGet } from '../scripts/preview-checks';
import { retentionSnapshot, sameRetentionEvidence } from '../scripts/preview-retention-model';
import { serializeRetentionReceipt, type RetentionReceipt } from '../scripts/preview-retention-receipt';
import { retentionAppFixture, retentionChecksFixture, retentionMarker, retentionNewSource, retentionReceiptFixture } from './preview-retention-fixture';

function graph(receipts: RetentionReceipt[]) {
  const fixtures = receipts.map(r => retentionChecksFixture(r));
  const responses = new Map(fixtures.flatMap(f => [...f.responses]));
  responses.set(`pulls/${retentionNewSource.pr}`, { number: retentionNewSource.pr, state: 'open', created_at: retentionNewSource.createdAt,
    head: { ref: retentionNewSource.branch, sha: retentionNewSource.sha, repo: { full_name: config.repository } },
    base: { ref: 'main', repo: { full_name: config.repository } } });
  const calls: string[] = [];
  const get: PreviewGet = async path => { calls.push(path); if (!responses.has(path)) throw new Error('UNEXPECTED_SYNTHETIC_PATH'); return structuredClone(responses.get(path)); };
  return { fixtures, responses, calls, get };
}
function unknownPrepare() {
  const r = retentionReceiptFixture();
  r.success = false; r.outcome = 'unknown'; delete r.evidence;
  r.failure = { stage: 'write', code: 'PREVIEW_RETENTION_WRITE_UNKNOWN' };
  return r;
}
function unknownUpdate() {
  const r = retentionReceiptFixture('retention-update');
  r.success = false; delete r.deployment; delete r.database;
  r.failure = { stage: 'update', code: 'PREVIEW_RETENTION_UPDATE_UNKNOWN' };
  return r;
}

test('GET-normalized baseline binds original notice, docs update, and final retained data across source SHA change', async () => {
  const prepare = retentionReceiptFixture(), update = retentionReceiptFixture('retention-update'), final = retentionReceiptFixture('retention-check');
  const g = graph([prepare, update, final]);
  const baseline = await loadRegistrationBaseline(g.get, Number(prepare.runId));
  const deployed = await loadRetentionUpdate(g.get, Number(update.runId), baseline);
  const result = await readRetentionReceipt(g.get, Number(final.runId), g.fixtures[2].request);
  assert.notEqual(deployed.source.sha, baseline.source.sha);
  assert.equal(deployed.deployment!.generation, baseline.deployment!.generation);
  assert.deepEqual(deployed.database, baseline.database);
  assert.equal(result.deployment!.id, deployed.deployment!.id);
  assert.ok(sameRetentionEvidence(result.evidence!, baseline.evidence!));
  assert.ok(sameRetentionEvidence(retentionSnapshot(retentionAppFixture(), retentionMarker).evidence!, baseline.evidence!));
  assert.ok(g.calls.filter(p => p === 'check-runs/3123/annotations?per_page=100&page=1').length >= 2, 'original baseline notice is read again for update');
});

test('uncertain single registration can become baseline only through original failure notice and GET-only inspect', async () => {
  const prepare = unknownPrepare(), inspect = retentionReceiptFixture('retention-inspect'), update = retentionReceiptFixture('retention-update');
  update.baselineRunId = inspect.runId;
  const g = graph([prepare, inspect, update]);
  const baseline = await loadRegistrationBaseline(g.get, Number(inspect.runId));
  assert.equal(baseline.writeAttempts, 0);
  assert.equal(baseline.baselineRunId, prepare.runId);
  assert.ok((await loadRetentionUpdate(g.get, Number(update.runId), baseline)).success);
  prepare.writeAttempts = 0;
  g.fixtures[0].annotation.message = serializeRetentionReceipt(prepare);
  await assert.rejects(loadRegistrationBaseline(g.get, Number(inspect.runId)), /PREVIEW_RETENTION/);
});

test('uncertain deployment is accepted only by a new GET-only reconcile receipt joined to its original write and baseline', async () => {
  const prepare = retentionReceiptFixture(), update = unknownUpdate(), reconcile = retentionReceiptFixture('retention-reconcile');
  const g = graph([prepare, update, reconcile]);
  const baseline = await loadRegistrationBaseline(g.get, Number(prepare.runId));
  const recovered = await loadRetentionUpdate(g.get, Number(reconcile.runId), baseline);
  assert.equal(recovered.writeAttempts, 0);
  assert.equal(recovered.updateRunId, update.runId);
  update.writeAttempts = 0;
  g.fixtures[1].annotation.message = serializeRetentionReceipt(update);
  await assert.rejects(loadRetentionUpdate(g.get, Number(reconcile.runId), baseline), /PREVIEW_RETENTION/);
});

test('editing an already loaded baseline cannot authorize update after its original notice changes', async () => {
  const prepare = retentionReceiptFixture(), update = retentionReceiptFixture('retention-update');
  const g = graph([prepare, update]), baseline = await loadRegistrationBaseline(g.get, Number(prepare.runId));
  prepare.evidence!.collectionDigest = 'f'.repeat(64);
  g.fixtures[0].annotation.message = serializeRetentionReceipt(prepare);
  await assert.rejects(loadRetentionUpdate(g.get, Number(update.runId), baseline), /PREVIEW_RETENTION_BASELINE_CHANGED/);
});

test('a known attempted deployment ID remains bound through read-only reconciliation', async () => {
  const prepare = retentionReceiptFixture(), update = unknownUpdate(), reconcile = retentionReceiptFixture('retention-reconcile');
  update.attemptedDeploymentId = reconcile.deployment!.id;
  const g = graph([prepare, update, reconcile]);
  const baseline = await loadRegistrationBaseline(g.get, Number(prepare.runId));
  assert.equal((await loadRetentionUpdate(g.get, Number(reconcile.runId), baseline)).deployment!.id, update.attemptedDeploymentId);
  update.attemptedDeploymentId = 'dpl_otherattempt';
  g.fixtures[1].annotation.message = serializeRetentionReceipt(update);
  await assert.rejects(loadRetentionUpdate(g.get, Number(reconcile.runId), baseline), /PREVIEW_RETENTION/);
});

test('GET observation precision, full collection and fixture mutations remain detectable at final check', () => {
  const baseline = retentionSnapshot(retentionAppFixture(), retentionMarker).evidence!;
  for (const change of [
    (a: ReturnType<typeof retentionAppFixture>) => { a.selected.transactions[0].amountYen += 1; },
    (a: ReturnType<typeof retentionAppFixture>) => { a.selected.members[1].name = 'Changed synthetic name'; },
    (a: ReturnType<typeof retentionAppFixture>) => { a.selected.transactions[1].memo += '-changed'; },
  ]) {
    const app = retentionAppFixture(); change(app);
    try { assert.equal(sameRetentionEvidence(retentionSnapshot(app, retentionMarker).evidence!, baseline), false); }
    catch (error) { assert.match(String(error), /PREVIEW_RETENTION_EVIDENCE_INVALID/); }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../scripts/preview-model';
import { retentionActions, retentionProtocol } from '../scripts/preview-retention-model';
import { receiptMaxBytes, parseReceipt } from '../scripts/preview-receipt';
import { parseVerifyReceipt } from '../scripts/preview-verify-receipt';
import { assertRegistrationBaseline, assertRetentionBaselineTarget, assertRetentionReceipt, assertRetentionUpdate, parseRetentionReceipt, serializeRetentionReceipt, retentionReceiptNoticeCommand, type RetentionReceipt } from '../scripts/preview-retention-receipt';
import { retentionReceiptFixture, retentionNewSource, retentionNewDeployment, retentionDeployment } from './preview-retention-fixture';

test('all retention actions use a separate bounded public receipt and initial-attempt context', () => {
  for (const action of retentionActions) {
    const receipt = retentionReceiptFixture(action), text = serializeRetentionReceipt(receipt);
    assert.ok(Buffer.byteLength(text) < receiptMaxBytes); assert.deepEqual(parseRetentionReceipt(text), receipt);
    assert.equal(retentionReceiptNoticeCommand(receipt), `::notice title=${retentionProtocol}::${text}`);
    assertRetentionReceipt(receipt, { ...receipt, expectedDeployment: action === 'retention-check' ? retentionNewDeployment : retentionDeployment });
    assert.throws(() => parseReceipt(text), /PREVIEW_RECEIPT_INVALID/);
    assert.throws(() => parseVerifyReceipt(text), /PREVIEW_VERIFY_RECEIPT_INVALID/);
  }
});
test('public projection excludes arbitrary details, while parser rejects unknown and duplicate keys', () => {
  const receipt = retentionReceiptFixture(), secret = 'private-do-not-log';
  const input = { ...receipt, token: secret, source: { ...receipt.source, secret }, database: { ...receipt.database, password: secret },
    deployment: { ...receipt.deployment, env: secret, database: { ...receipt.database, password: secret } }, evidence: { ...receipt.evidence, merchant: secret } };
  const text = serializeRetentionReceipt(input); assert.ok(!text.includes(secret)); assert.deepEqual(parseRetentionReceipt(text), receipt);
  for (const path of [[], ['source'], ['database'], ['deployment'], ['deployment', 'database'], ['evidence']]) {
    const changed = structuredClone(receipt) as unknown as Record<string, unknown>; let value = changed;
    for (const key of path) value = value[key] as Record<string, unknown>; value.secret = secret;
    assert.throws(() => parseRetentionReceipt(JSON.stringify(changed)), /RETENTION_RECEIPT_INVALID/);
  }
  for (const bad of [text.replace('"success":true', '"success":true,"success":true'), text.replace(`"pr":${receipt.source.pr}`, `"pr":${receipt.source.pr},"\\u0070r":${receipt.source.pr}`),
    text.replace('"marker":', '"marker":"***","unknown":'), text.slice(0, -1), `${text}\n{}`, '[]']) assert.throws(() => parseRetentionReceipt(bad), /RETENTION_RECEIPT_INVALID/);
});
test('wire checks original UTF-8 bytes and fails rather than truncating a notice', () => {
  const receipt = retentionReceiptFixture(), text = serializeRetentionReceipt(receipt), bytes = Buffer.byteLength(text);
  assert.deepEqual(parseRetentionReceipt(text + ' '.repeat(receiptMaxBytes - bytes)), receipt);
  assert.throws(() => parseRetentionReceipt(text + ' '.repeat(receiptMaxBytes - bytes + 1)), /RETENTION_RECEIPT_TOO_LARGE/);
  assert.throws(() => parseRetentionReceipt('あ'.repeat(1500)), /RETENTION_RECEIPT_TOO_LARGE/);
  const huge = structuredClone(receipt); huge.expectedDeploymentId = huge.deployment!.id = `dpl_${'a'.repeat(4096)}`;
  assert.throws(() => serializeRetentionReceipt(huge), /RETENTION_RECEIPT_TOO_LARGE/);
});
test('success demands exact fields, record and runtime evidence; readonly actions never claim a write', () => {
  const mutations: ((r: RetentionReceipt) => void)[] = [
    r => { r.runAttempt = 2; }, r => { r.source.state = 'closed'; }, r => { r.operation = '90000000-0000-4000-8000-000000000009'; },
    r => { r.evidence!.matchingCount = 2 as never; }, r => { r.evidence!.amountYen = 0 as never; },
    r => { r.evidence!.workspaceId = '00000000-0000-4000-8000-000000000002'; }, r => { r.evidence!.marker = r.deployment!.generation; },
    r => { r.database!.hostDigest = config.productionHostDigest; }, r => { r.deployment!.phase = 'provisioning'; },
    r => { delete r.evidence; }, r => { delete r.runtimeBeforeAt; }, r => { r.runtimeAfterAt = '2026-10-16T00:59:00Z'; },
    r => { r.observedAt = '2026-02-31T00:00:00Z'; }, r => { r.writeAttempts = 0; }, r => { r.baselineRunId = r.runId; },
  ];
  for (const mutate of mutations) { const r = retentionReceiptFixture(); mutate(r); assert.throws(() => serializeRetentionReceipt(r), /RETENTION_RECEIPT_INVALID/); }
  for (const action of ['retention-inspect', 'retention-check', 'retention-reconcile'] as const) {
    const r = retentionReceiptFixture(action); r.writeAttempts = 1; assert.throws(() => serializeRetentionReceipt(r), /RETENTION_RECEIPT_INVALID/);
  }
  const absent = retentionReceiptFixture('retention-inspect'); absent.outcome = 'absent'; delete absent.evidence;
  assert.throws(() => serializeRetentionReceipt(absent), /RETENTION_RECEIPT_INVALID/);
  for (const action of ['retention-update', 'retention-reconcile'] as const) {
    const malformed = retentionReceiptFixture(action); malformed.outcome = ['unknown'] as never;
    assert.throws(() => parseRetentionReceipt(JSON.stringify(malformed)), /RETENTION_RECEIPT_INVALID/);
  }
});
test('failed results retain uncertainty and can carry an old update anchor without claiming a new deployment', () => {
  const unknown = retentionReceiptFixture(); unknown.success = false; unknown.outcome = 'unknown'; delete unknown.evidence;
  unknown.failure = { stage: 'write', code: 'PREVIEW_RETENTION_WRITE_UNKNOWN' };
  assert.deepEqual(parseRetentionReceipt(serializeRetentionReceipt(unknown)), unknown);
  const update = retentionReceiptFixture('retention-update'); update.success = false;
  update.deployment = structuredClone(retentionDeployment); update.failure = { stage: 'preflight', code: 'PREVIEW_RETENTION_PREFLIGHT_FAILED' };
  assert.deepEqual(parseRetentionReceipt(serializeRetentionReceipt(update)), update);
  update.success = true; delete update.failure;
  assert.throws(() => serializeRetentionReceipt(update), /RETENTION_RECEIPT_INVALID/);
  const rawFailure = structuredClone(unknown); rawFailure.failure!.code = 'raw-secret' as never;
  assert.throws(() => serializeRetentionReceipt(rawFailure), /RETENTION_RECEIPT_INVALID/);
});
test('one-hop registration recovery requires an actual original prepare write and immutable identity', () => {
  const prepare = retentionReceiptFixture(), inspect = retentionReceiptFixture('retention-inspect');
  assertRegistrationBaseline(prepare); assertRegistrationBaseline(inspect, prepare);
  const unknown = structuredClone(prepare); unknown.success = false; unknown.outcome = 'unknown'; delete unknown.evidence;
  unknown.failure = { stage: 'write', code: 'PREVIEW_RETENTION_WRITE_UNKNOWN' }; assertRegistrationBaseline(inspect, unknown);
  for (const alter of [(r: RetentionReceipt) => { r.writeAttempts = 0; }, (r: RetentionReceipt) => { r.action = 'retention-inspect'; },
    (r: RetentionReceipt) => { r.source.sha = 'e'.repeat(40); }, (r: RetentionReceipt) => { r.marker = '90000000-0000-4000-8000-000000000009'; }]) {
    const changed = structuredClone(unknown); alter(changed); assert.throws(() => assertRegistrationBaseline(inspect, changed), /RETENTION_RECEIPT_INVALID/);
  }
  assert.throws(() => assertRegistrationBaseline(inspect), /RETENTION_RECEIPT_INVALID/);
});
test('update/reconcile chains allow only the new SHA on the original acceptance DB and generation', () => {
  const baseline = retentionReceiptFixture(), update = retentionReceiptFixture('retention-update'), reconcile = retentionReceiptFixture('retention-reconcile');
  assertRetentionBaselineTarget(baseline, retentionNewSource, retentionNewDeployment);
  assertRetentionUpdate(update, baseline); assertRetentionUpdate(reconcile, baseline, update);
  const unknown = structuredClone(update); unknown.success = false; unknown.deployment = undefined;
  unknown.database = undefined; unknown.failure = { stage: 'update', code: 'PREVIEW_RETENTION_UPDATE_UNKNOWN' };
  assertRetentionUpdate(reconcile, baseline, unknown);
  const foreign = structuredClone(update); foreign.deployment!.database!.endpointId = 'ep-foreign'; foreign.database!.endpointId = 'ep-foreign';
  assert.throws(() => assertRetentionUpdate(foreign, baseline), /RETENTION_RECEIPT_INVALID/);
  assert.throws(() => assertRetentionUpdate(reconcile, baseline), /RETENTION_RECEIPT_INVALID/);
  const noWrite = structuredClone(unknown); noWrite.writeAttempts = 0;
  assert.throws(() => assertRetentionUpdate(reconcile, baseline, noWrite), /RETENTION_RECEIPT_INVALID/);
  const oldAnchor = structuredClone(unknown); oldAnchor.deployment = structuredClone(baseline.deployment); oldAnchor.database = structuredClone(baseline.database);
  assertRetentionUpdate(reconcile, baseline, oldAnchor);
  const wrongAnchor = structuredClone(oldAnchor); wrongAnchor.deployment!.createdAt++;
  assert.throws(() => assertRetentionUpdate(reconcile, baseline, wrongAnchor), /RETENTION_RECEIPT_INVALID/);
});
test('request binding includes reference runs, exact source, target and every observed timestamp', () => {
  const r = retentionReceiptFixture(), expected = { ...r, expectedDeployment: retentionDeployment };
  assertRetentionReceipt(r, expected);
  for (const patch of [{ marker: '90000000-0000-4000-8000-000000000009' }, { runId: '999' }, { expectedDeploymentId: 'dpl_other' },
    { controlSha: 'e'.repeat(40) }, { baselineRunId: '999' }, { notBefore: '2026-10-16T01:00:02Z' }, { notAfter: '2026-10-16T01:00:02Z' }]) {
    assert.throws(() => assertRetentionReceipt(r, { ...expected, ...patch }), /RETENTION_RECEIPT_INVALID/);
  }
});

test('attempted deployment IDs preserve known failed resources and remain bound to the new deployment', () => {
  const baseline = retentionReceiptFixture(), update = retentionReceiptFixture('retention-update'), reconcile = retentionReceiptFixture('retention-reconcile');
  const unknown = structuredClone(update); unknown.success = false; delete unknown.deployment; delete unknown.database;
  unknown.attemptedDeploymentId = reconcile.deployment!.id;
  unknown.failure = { stage: 'update', code: 'PREVIEW_RETENTION_UPDATE_UNKNOWN' };
  const text = serializeRetentionReceipt({ ...unknown, secret: 'private-do-not-log' });
  assert.ok(!text.includes('private-do-not-log')); assert.deepEqual(parseRetentionReceipt(text), unknown);
  assertRetentionUpdate(reconcile, baseline, unknown);
  const wrongOriginal = structuredClone(unknown); wrongOriginal.attemptedDeploymentId = 'dpl_anotherattempt';
  assert.throws(() => assertRetentionUpdate(reconcile, baseline, wrongOriginal), /RETENTION_RECEIPT_INVALID/);
  const anchor = structuredClone(unknown); anchor.deployment = structuredClone(retentionDeployment); anchor.database = structuredClone(retentionDeployment.database);
  assert.deepEqual(parseRetentionReceipt(serializeRetentionReceipt(anchor)), anchor);
  for (const action of ['retention-update', 'retention-reconcile'] as const) {
    const success = retentionReceiptFixture(action); success.attemptedDeploymentId = success.deployment!.id;
    assert.deepEqual(parseRetentionReceipt(serializeRetentionReceipt(success)), success);
    success.attemptedDeploymentId = 'dpl_other'; assert.throws(() => serializeRetentionReceipt(success), /RETENTION_RECEIPT_INVALID/);
  }
  for (const action of ['retention-prepare', 'retention-inspect', 'retention-check'] as const) {
    const wrongAction = retentionReceiptFixture(action); wrongAction.attemptedDeploymentId = 'dpl_attempted';
    assert.throws(() => serializeRetentionReceipt(wrongAction), /RETENTION_RECEIPT_INVALID/);
  }
  for (const value of [unknown.expectedDeploymentId, 'not-a-deployment', ['dpl_other'], 123, '***']) {
    const malformed = structuredClone(unknown); malformed.attemptedDeploymentId = value as never;
    assert.throws(() => parseRetentionReceipt(JSON.stringify(malformed)), /RETENTION_RECEIPT_INVALID/);
  }
  assert.throws(() => parseRetentionReceipt(text.replace('"attemptedDeploymentId":', '"attemptedDeploymentId":"dpl_duplicate","attemptedDeploymentId":')), /RETENTION_RECEIPT_INVALID/);
});

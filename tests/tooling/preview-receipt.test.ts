import test from 'node:test';
import assert from 'node:assert/strict';
import { config, protocol } from '../../scripts/preview/preview-model';
import { assertReceipt, parseReceipt, receiptMaxBytes, receiptNoticeCommand, receiptNoticeTitle, serializeReceipt, type OperationReceipt } from '../../scripts/preview/preview-receipt';

const operation = '20000000-0000-4000-8000-000000000002';
function fixture(action: 'deploy' | 'status' | 'cleanup' = 'deploy'): OperationReceipt {
  const source = { pr: 71, branch: 'codex/test', sha: 'a'.repeat(40), createdAt: '2026-10-16T00:00:00Z', state: action === 'cleanup' ? 'closed' as const : 'open' as const };
  const database = { branchId: 'br-test-123', endpointId: 'ep-test-123', hostDigest: 'b'.repeat(64) };
  return { protocol, action, source, ...(action !== 'cleanup' ? { deployment: {
    id: 'dpl_Test123', url: 'https://cake-test.vercel.app', sha: source.sha, branch: source.branch, pr: source.pr,
    generation: '10000000-0000-4000-8000-000000000001', operation, phase: 'application', state: 'READY',
    createdAt: Date.parse('2026-10-16T00:02:00Z'), database,
  }, database } : {}), checkedAt: '2026-10-16T00:05:00.000Z', success: true, operation, runId: '38896088643', runAttempt: 1, controlSha: 'c'.repeat(40) };
}

test('public receipt round trips deploy, status with/without resources, and dispatched/automatic cleanup', () => {
  const status = fixture('status'), closedStatus = fixture('status'), cleanup = fixture('cleanup');
  closedStatus.source.state = 'closed';
  cleanup.operation = null;
  const emptyStatus = { ...status }, databaseStatus = fixture('status');
  delete emptyStatus.deployment; delete emptyStatus.database; delete databaseStatus.deployment;
  for (const receipt of [fixture(), status, closedStatus, emptyStatus, databaseStatus, fixture('cleanup'), cleanup]) {
    const text = serializeReceipt(receipt);
    assert.ok(Buffer.byteLength(text) < receiptMaxBytes);
    assert.deepEqual(parseReceipt(text), receipt);
    assertReceipt(parseReceipt(text), receipt);
    const command = receiptNoticeCommand(receipt);
    assert.ok(command.startsWith(`::notice title=${receiptNoticeTitle}::`));
    assert.equal(command.split('\n').length, 1);
    assert.equal(command.slice(command.indexOf('::', 2) + 2), text);
  }
});

test('serializer projects public fields at every level and parser rejects private additions', () => {
  const receipt = fixture(), secret = 'private-do-not-log';
  const input = { ...receipt, token: secret, source: { ...receipt.source, private: secret },
    database: { ...receipt.database, connectionString: secret }, deployment: { ...receipt.deployment,
      env: { DATABASE_URL: secret }, database: { ...receipt.deployment!.database, password: secret } } };
  const encoded = serializeReceipt(input);
  assert.ok(!encoded.includes(secret));
  assert.deepEqual(parseReceipt(encoded), receipt);
  for (const mutate of [
    (r: Record<string, unknown>) => { r.token = secret; },
    (r: Record<string, unknown>) => { (r.source as Record<string, unknown>).private = secret; },
    (r: Record<string, unknown>) => { (r.database as Record<string, unknown>).connectionString = secret; },
    (r: Record<string, unknown>) => { (r.deployment as Record<string, unknown>).env = secret; },
    (r: Record<string, unknown>) => { ((r.deployment as Record<string, unknown>).database as Record<string, unknown>).password = secret; },
  ]) {
    const changed = JSON.parse(encoded) as Record<string, unknown>;
    mutate(changed);
    assert.throws(() => parseReceipt(JSON.stringify(changed)), /^Error: PREVIEW_RECEIPT_INVALID$/);
  }
});

test('parser rejects duplicate keys including escaped aliases and truncation/masking', () => {
  const json = serializeReceipt(fixture());
  for (const text of [
    json.replace('"success":true', '"success":true,"success":true'),
    json.replace('"pr":71', '"pr":71,"pr":71'),
    json.replace('"pr":71', '"pr":71,"\\u0070r":71'),
    json.replace('"branchId":"br-test-123"', '"branchId":"br-test-123","branchId":"br-test-123"'),
    json.slice(0, -1), json + '\n{}', json.replace(operation, '***'), 'null', '[]',
  ]) assert.throws(() => parseReceipt(text), /^Error: PREVIEW_RECEIPT_INVALID$/);
});

test('UTF-8 limit is checked on original received bytes and compact emitted JSON before notice creation', () => {
  const json = serializeReceipt(fixture()), bytes = Buffer.byteLength(json);
  assert.deepEqual(parseReceipt(json + ' '.repeat(receiptMaxBytes - bytes)), fixture());
  assert.throws(() => parseReceipt(json + ' '.repeat(receiptMaxBytes - bytes + 1)), /PREVIEW_RECEIPT_TOO_LARGE/);
  const multibyte = JSON.stringify({ ...fixture(), private: 'あ'.repeat(1500) });
  assert.ok(multibyte.length < receiptMaxBytes && Buffer.byteLength(multibyte) > receiptMaxBytes);
  assert.throws(() => parseReceipt(multibyte), /PREVIEW_RECEIPT_TOO_LARGE/);
  const receipt = fixture();
  receipt.deployment!.id = `dpl_${'a'.repeat(receiptMaxBytes)}`;
  assert.throws(() => serializeReceipt(receipt), /PREVIEW_RECEIPT_TOO_LARGE/);
  assert.throws(() => receiptNoticeCommand(receipt), /PREVIEW_RECEIPT_TOO_LARGE/);
});

test('receipt validation preserves deployment/source/DB identity and cleanup invariants', () => {
  const mutate: ((r: OperationReceipt) => void)[] = [
    r => { r.protocol = 'unknown' as typeof protocol; }, r => { r.success = false as true; }, r => { r.action = 'unknown' as OperationReceipt['action']; },
    r => { r.action = ['deploy'] as unknown as OperationReceipt['action']; },
    r => { r.runId = '01'; }, r => { r.runId = '9007199254740992'; }, r => { r.runAttempt = 0; }, r => { r.runAttempt = 1.5; },
    r => { r.controlSha = 'short'; }, r => { r.operation = null; }, r => { r.source.pr = 0; }, r => { r.source.branch = 'main'; },
    r => { r.source.sha = 'short'; }, r => { r.source.state = 'closed'; }, r => { r.source.createdAt = '2026-02-31T00:00:00Z'; },
    r => { r.checkedAt = 'invalid'; }, r => { r.checkedAt = '2026-10-15T00:00:00Z'; },
    r => { r.deployment!.url += '?secret=value'; }, r => { r.deployment!.id = 'other'; }, r => { r.deployment!.generation = 'unknown'; },
    r => { r.deployment!.operation = 'unknown'; }, r => { r.deployment!.pr++; }, r => { r.deployment!.branch = 'codex/other'; },
    r => { r.deployment!.sha = 'd'.repeat(40); }, r => { r.deployment!.state = 'ERROR'; }, r => { r.deployment!.phase = 'provisioning'; },
    r => { r.deployment!.createdAt = Date.parse('2026-10-15T00:00:00Z'); }, r => { delete r.deployment!.database; },
    r => { delete r.database; }, r => { r.database = { ...r.database!, branchId: 'br-other' }; },
    r => { r.database!.hostDigest = config.productionHostDigest; }, r => { r.database!.endpointId = 'invalid'; },
    r => { delete r.deployment; },
  ];
  for (const change of mutate) {
    const receipt = fixture(); change(receipt);
    assert.throws(() => parseReceipt(JSON.stringify(receipt)), /PREVIEW_RECEIPT_INVALID/);
  }
  const cleanup = fixture('cleanup'); cleanup.database = fixture().database;
  assert.throws(() => serializeReceipt(cleanup), /PREVIEW_RECEIPT_INVALID/);
  const status = fixture('status'); delete status.deployment; status.database!.hostDigest = config.productionHostDigest;
  assert.throws(() => serializeReceipt(status), /PREVIEW_RECEIPT_INVALID/);
});

test('request binding matches every source/context field and bounded checkedAt', () => {
  const receipt = fixture(), expected = { action: 'deploy' as const, source: { ...receipt.source }, operation,
    runId: receipt.runId, runAttempt: 1, controlSha: receipt.controlSha,
    notBefore: '2026-10-16T00:04:00Z', notAfter: '2026-10-16T00:06:00Z' };
  assertReceipt(receipt, expected);
  for (const key of ['pr', 'branch', 'sha', 'createdAt', 'state'] as const) {
    const changed = { ...expected, source: { ...expected.source, [key]: key === 'pr' ? 72 : 'changed' } };
    assert.throws(() => assertReceipt(receipt, changed), /PREVIEW_RECEIPT_INVALID/);
  }
  for (const changed of [
    { action: 'status' as const }, { operation: '30000000-0000-4000-8000-000000000003' }, { runId: '38896088644' },
    { runAttempt: 2 }, { controlSha: 'd'.repeat(40) }, { notBefore: '2026-10-16T00:05:01Z' }, { notAfter: '2026-10-16T00:04:59Z' },
  ]) assert.throws(() => assertReceipt(receipt, { ...expected, ...changed }), /PREVIEW_RECEIPT_INVALID/);
});

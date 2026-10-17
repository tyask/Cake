import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRetentionEvidence, retentionPayload, retentionSnapshot, sameRetentionEvidence } from '../scripts/preview-retention-model';
import { retentionAppFixture, retentionMarker, retentionTransactionFixture } from './preview-retention-browser-fixture';

test('retention uses one fixed payload and a strict canonical lowercase operation marker', () => {
  assert.deepEqual(retentionPayload(retentionMarker), { action: 'saveTransaction', workspaceId: '00000000-0000-4000-8000-000000000001',
    occurredAt: '2020-01-01T00:00:00.000Z', merchant: 'Cake retention test', method: 'QA_TEST', type: 'PAYMENT', amountYen: 1234,
    actorUserId: 'test-user-a', expenseClass: 'PERSONAL', splitWeights: { 'test-user-a': 1, 'test-user-b': 0 }, memo: `cake-retention:${retentionMarker}` });
  for (const marker of ['not-a-uuid', retentionMarker.replace('10000000', 'ABCDEF00'), `${retentionMarker}\n`]) assert.throws(() => retentionPayload(marker), /PREVIEW_RETENTION_EVIDENCE_INVALID/);
});
test('canonical digests cover all projected transactions and fixture fields with stable ordering', () => {
  const app = retentionAppFixture(), a = retentionSnapshot(app, retentionMarker), changed = structuredClone(app);
  changed.selected.transactions.reverse(); changed.selected.members.reverse();
  changed.selected.transactions[0].splitWeights = { 'test-user-b': 0, 'test-user-a': 1 };
  assert.deepEqual(retentionSnapshot(changed, retentionMarker), a);
  assert.equal(a.evidence?.matchingCount, 1); assert.equal(a.transactionCount, 2); assert.equal(a.totalAmountYen, 1434);
  assert.equal(sameRetentionEvidence(a.evidence!, parseRetentionEvidence(a.evidence)), true);
  changed.selected.transactions.find(t => t.id.startsWith('4000'))!.memo = 'Changed existing data';
  const b = retentionSnapshot(changed, retentionMarker);
  assert.equal(a.evidence!.contentDigest, b.evidence!.contentDigest); assert.notEqual(a.collectionDigest, b.collectionDigest);
  assert.equal(sameRetentionEvidence(a.evidence!, b.evidence!), false);
  const renamed = structuredClone(app); renamed.user.name = renamed.selected.members[0].name = 'Renamed fixture';
  for (const t of renamed.selected.transactions) t.actorName = 'Renamed fixture';
  assert.notEqual(retentionSnapshot(renamed, retentionMarker).fixtureDigest, a.fixtureDigest);
});
test('an absent marker preserves a full pre-insert collection digest', () => {
  const before = retentionSnapshot(retentionAppFixture(retentionMarker, false), retentionMarker);
  const after = retentionSnapshot(retentionAppFixture(), retentionMarker);
  assert.equal(before.evidence, undefined); assert.equal(before.transactionCount + 1, after.transactionCount);
  assert.equal(before.totalAmountYen + 1234, after.totalAmountYen); assert.equal(before.collectionDigest, after.withoutMarkerDigest);
  assert.equal(before.fixtureDigest, after.fixtureDigest);
});
test('malformed, duplicated or unexpected marker, collection and fixture data fail closed', async t => {
  const cases: [string, (app: ReturnType<typeof retentionAppFixture>) => void][] = [
    ['selection', app => { app.selected.workspace.id = '00000000-0000-4000-8000-000000000099'; }],
    ['workspace type', app => { app.selected.workspace.type = 'PERSONAL'; }],
    ['owner', app => { app.selected.workspace.ownerUserId = 'test-user-b'; }],
    ['member count', app => { app.selected.workspace.memberCount = 1; }],
    ['member missing', app => { app.selected.members.pop(); }],
    ['role', app => { app.selected.members[1].role = 'OWNER'; }],
    ['weight', app => { app.selected.members[1].weight = 2; }],
    ['identity', app => { app.user.id = 'test-user-b'; }],
    ['disabled', app => { app.user.isEnabled = false; }],
    ['admin', app => { app.user.isAdmin = false; }],
    ['email', app => { app.selected.members[1].email = 'unrelated@example.test'; }],
    ['duplicate marker', app => { app.selected.transactions.push({ ...retentionTransactionFixture(), id: '60000000-0000-4000-8000-000000000006' }); }],
    ['duplicate ID', app => { app.selected.transactions.push({ ...app.selected.transactions[0] }); }],
    ['changed amount', app => { app.selected.transactions[1].amountYen++; }],
    ['changed memo', app => { app.selected.transactions[1].memo += ' changed'; }],
    ['changed actor', app => { app.selected.transactions[1].actorUserId = 'test-user-b'; }],
    ['changed source', app => { app.selected.transactions[1].source = 'PAYPAY'; }],
    ['changed external ID', app => { app.selected.transactions[1].externalId = 'manual-other'; }],
    ['settled marker', app => { app.selected.transactions[1].settledAt = '2020-01-02T00:00:00.000Z'; }],
    ['changed date', app => { app.selected.transactions[1].occurredAt = '2020-01-02T00:00:00.000Z'; }],
    ['different marker', app => { app.selected.transactions[1].memo = 'cake-retention:70000000-0000-4000-8000-000000000007'; }],
    ['unknown projection field', app => { Object.assign(app.selected.transactions[0], { secret: 'must never be projected' }); }],
    ['unsafe number', app => { app.selected.transactions[0].amountYen = Number.MAX_SAFE_INTEGER; }],
  ];
  for (const [name, change] of cases) await t.test(name, () => {
    const app = retentionAppFixture(); change(app);
    assert.throws(() => retentionSnapshot(app, retentionMarker), { message: 'PREVIEW_RETENTION_EVIDENCE_INVALID' });
  });
});
test('receipt evidence validation rejects extra fields and incorrect fixed/count/digest values', () => {
  const e = retentionSnapshot(retentionAppFixture(), retentionMarker).evidence!;
  for (const changed of [{ ...e, extra: true }, { ...e, matchingCount: 2 }, { ...e, amountYen: 1 }, { ...e, transactionCount: 0 },
    { ...e, totalAmountYen: Number.MAX_SAFE_INTEGER + 1 }, { ...e, fixtureDigest: 'x'.repeat(64) }, { ...e, transactionId: 'bad' }]) {
    assert.throws(() => parseRetentionEvidence(changed), /PREVIEW_RETENTION_EVIDENCE_INVALID/);
    assert.equal(sameRetentionEvidence(e, changed as typeof e), false);
  }
  assert.ok(!JSON.stringify(e).includes('Fixture')); assert.ok(!JSON.stringify(e).includes('@cake.local'));
});

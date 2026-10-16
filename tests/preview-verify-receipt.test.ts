import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptMaxBytes } from '../scripts/preview-receipt';
import { assertVerifyReceipt, browserEvidence, exactDeploymentIdentity, parseVerifyReceipt, serializeVerifyReceipt, verifyReceiptNoticeCommand, verifyReceiptNoticeTitle, type VerifyReceipt } from '../scripts/preview-verify-receipt';
import { verifyProofFixture, verifyReceiptFixture } from './preview-verify-fixture';

test('verify success and diagnostic failure have a separate bounded notice schema', () => {
  for (const receipt of [verifyReceiptFixture(), verifyReceiptFixture(false)]) {
    const text = serializeVerifyReceipt(receipt);
    assert.ok(Buffer.byteLength(text, 'utf8') <= receiptMaxBytes);
    assert.deepEqual(parseVerifyReceipt(text), receipt);
    assert.equal(verifyReceiptNoticeCommand(receipt), `::notice title=${verifyReceiptNoticeTitle}::${text}`);
    assertVerifyReceipt(receipt, { action: 'verify', source: receipt.source, expectedDeployment: receipt.deployment!,
      operation: receipt.operation, runId: receipt.runId, runAttempt: 1, controlSha: receipt.controlSha,
      notBefore: '2026-10-16T01:00:00Z', notAfter: '2026-10-16T01:00:04Z' });
  }
});

test('serializer projects secrets while parser rejects unknown fields at every public object', () => {
  const receipt = verifyReceiptFixture(false), secret = 'private-do-not-log';
  const input = { ...receipt, token: secret, source: { ...receipt.source, secret }, database: { ...receipt.database, password: secret },
    deployment: { ...receipt.deployment, env: secret, database: { ...receipt.database, connectionString: secret } },
    browser: { ...receipt.browser, cookies: secret }, failure: { ...receipt.failure, detail: secret } };
  const text = serializeVerifyReceipt(input);
  assert.ok(!text.includes(secret)); assert.deepEqual(parseVerifyReceipt(text), receipt);
  for (const objectPath of [[], ['source'], ['database'], ['deployment'], ['deployment', 'database'], ['browser'], ['failure']]) {
    const changed = structuredClone(receipt) as unknown as Record<string, unknown>;
    let value = changed;
    for (const key of objectPath) value = value[key] as Record<string, unknown>;
    value.private = secret;
    assert.throws(() => parseVerifyReceipt(JSON.stringify(changed)), /VERIFY_RECEIPT_INVALID/);
  }
});

test('verify parser rejects masking, duplicate aliases, invalid JSON and original UTF-8 overflow', () => {
  const text = serializeVerifyReceipt(verifyReceiptFixture());
  for (const value of [text.replace('"success":true', '"success":true,"success":true'),
    text.replace('"pr":71', '"pr":71,"\\u0070r":71'), text.replace('dpl_previewtest', '***'), text.slice(0, -1), `${text}\n{}`, 'null']) {
    assert.throws(() => parseVerifyReceipt(value), /VERIFY_RECEIPT_INVALID/);
  }
  assert.deepEqual(parseVerifyReceipt(text + ' '.repeat(receiptMaxBytes - Buffer.byteLength(text))), verifyReceiptFixture());
  assert.throws(() => parseVerifyReceipt(text + ' '.repeat(receiptMaxBytes - Buffer.byteLength(text) + 1)), /VERIFY_RECEIPT_TOO_LARGE/);
  assert.throws(() => parseVerifyReceipt('あ'.repeat(1500)), /VERIFY_RECEIPT_TOO_LARGE/);
  const large = verifyReceiptFixture(); large.deployment!.id = large.expectedDeploymentId = `dpl_${'a'.repeat(4096)}`;
  assert.throws(() => serializeVerifyReceipt(large), /VERIFY_RECEIPT_TOO_LARGE/);
});

test('successful evidence requires all cases, 16 ordered clicks and 12 ordered checks', () => {
  const mutations: ((receipt: VerifyReceipt) => void)[] = [
    r => { r.browser!.cases.pop(); }, r => { r.browser!.clicks.pop(); }, r => { r.browser!.checks.pop(); },
    r => { r.browser!.clicks[0][0] = 4; }, r => { r.browser!.checks[0][1] = 3; },
    r => { r.browser!.clicks[0].push('extra' as never); }, r => { r.browser!.checks[0][2] = '2026-02-31T00:00:00Z'; },
    r => { r.browser!.checks[0][2] = '2026-10-16T01:00:03Z'; },
    r => { r.browser!.checks[1][2] = r.browser!.checks[0][2]; },
    r => { r.browser!.cases[0] = 'mobile-a'; }, r => { r.browser!.verifiedAt = '2026-10-16T01:00:04Z'; },
  ];
  for (const mutate of mutations) { const receipt = verifyReceiptFixture(); mutate(receipt); assert.throws(() => parseVerifyReceipt(JSON.stringify(receipt)), /VERIFY_RECEIPT_INVALID/); }
});

test('failed evidence is one operation prefix and cannot skip checks or completed cases', () => {
  const receipt = verifyReceiptFixture(false);
  receipt.browser = { cases: [], clicks: [[0, 0, '2026-10-16T01:00:01.100Z']], checks: [[0, 0, '2026-10-16T01:00:01.050Z']], verifiedAt: '2026-10-16T01:00:01.200Z' };
  assert.deepEqual(parseVerifyReceipt(serializeVerifyReceipt(receipt)), receipt);
  const missingRuntime = structuredClone(receipt); missingRuntime.browser!.checks = [];
  assert.throws(() => serializeVerifyReceipt(missingRuntime), /VERIFY_RECEIPT_INVALID/);
  const falseCase = structuredClone(receipt); falseCase.browser!.cases = ['desktop-a'];
  assert.throws(() => serializeVerifyReceipt(falseCase), /VERIFY_RECEIPT_INVALID/);
  const preflight = verifyReceiptFixture(false); delete preflight.deployment; delete preflight.database; delete preflight.browser;
  preflight.failure = { stage: 'preflight', code: 'PREVIEW_VERIFY_STATUS_FAILED' };
  assert.deepEqual(parseVerifyReceipt(serializeVerifyReceipt(preflight)), preflight);
  const noProof = verifyReceiptFixture(false); delete noProof.browser;
  assert.deepEqual(parseVerifyReceipt(serializeVerifyReceipt(noProof)), noProof);
  noProof.failure!.stage = 'postflight'; noProof.failure!.code = 'PREVIEW_VERIFY_STATUS_FAILED'; delete noProof.failure!.browserStage;
  assert.throws(() => serializeVerifyReceipt(noProof), /VERIFY_RECEIPT_INVALID/);
});

test('each real operation boundary is accepted as partial evidence after a browser failure', () => {
  const full = verifyReceiptFixture(false), proof = full.browser!;
  const events = [...proof.clicks.map(row => ({ kind: 'click', row })), ...proof.checks.map(row => ({ kind: 'check', row }))]
    .sort((a, b) => Date.parse(a.row[2]) - Date.parse(b.row[2]));
  for (let count = 0; count <= events.length; count++) {
    const receipt = structuredClone(full), prefix = events.slice(0, count);
    receipt.browser = { cases: proof.cases.slice(0, Math.floor(count / 7)),
      clicks: prefix.filter(event => event.kind === 'click').map(event => event.row),
      checks: prefix.filter(event => event.kind === 'check').map(event => event.row), verifiedAt: proof.verifiedAt };
    assert.deepEqual(parseVerifyReceipt(serializeVerifyReceipt(receipt)), receipt);
  }
});

test('receipt context, failure enums and exact deployment identity fail closed', () => {
  const receipt = verifyReceiptFixture(), expected = { action: 'verify' as const, source: receipt.source, expectedDeployment: receipt.deployment!,
    operation: receipt.operation, runId: receipt.runId, runAttempt: 1, controlSha: receipt.controlSha };
  for (const mutate of [
    (r: VerifyReceipt) => { r.runAttempt = 2; }, (r: VerifyReceipt) => { r.source.state = 'closed'; },
    (r: VerifyReceipt) => { r.expectedDeploymentId = 'dpl_other'; }, (r: VerifyReceipt) => { r.failure = { stage: 'browser', code: 'PREVIEW_VERIFY_BROWSER_FAILED' }; },
    (r: VerifyReceipt) => { r.deployment!.phase = 'provisioning'; }, (r: VerifyReceipt) => { delete r.browser; },
  ]) { const changed = structuredClone(receipt); mutate(changed); assert.throws(() => serializeVerifyReceipt(changed), /VERIFY_RECEIPT_INVALID/); }
  for (const key of ['operation', 'phase', 'createdAt', 'generation', 'url'] as const) {
    const changed = structuredClone(receipt.deployment!);
    if (key === 'createdAt') changed.createdAt++; else if (key === 'phase') changed.phase = 'provisioning'; else changed[key] += 'x';
    assert.equal(exactDeploymentIdentity(receipt.deployment!, changed), false);
  }
  assert.equal(exactDeploymentIdentity(receipt.deployment!, receipt.deployment!), true);
  const changed = structuredClone(receipt); changed.deployment!.operation = '30000000-0000-4000-8000-000000000003';
  assert.throws(() => assertVerifyReceipt(changed, expected), /VERIFY_RECEIPT_INVALID/);
  assert.throws(() => assertVerifyReceipt(receipt, { ...expected, notBefore: '2026-10-16T01:00:02Z' }), /VERIFY_RECEIPT_INVALID/);
  const failure = verifyReceiptFixture(false); failure.failure!.code = 'raw-provider-error' as never;
  assert.throws(() => serializeVerifyReceipt(failure), /VERIFY_RECEIPT_INVALID/);
});

test('browser proof compacts known observations and rejects unknown targets or case labels', () => {
  const proof = verifyProofFixture(), result = browserEvidence(proof);
  assert.equal(result.clicks.length, 16); assert.equal(result.checks.length, 12);
  assert.deepEqual(result.clicks[0].slice(0, 2), [0, 0]); assert.deepEqual(result.checks.at(-1)!.slice(0, 2), [3, 2]);
  const changed = structuredClone(proof); (changed.clicks[0] as { target: string }).target = 'secret-value';
  assert.throws(() => browserEvidence(changed), /VERIFY_RECEIPT_INVALID/);
});

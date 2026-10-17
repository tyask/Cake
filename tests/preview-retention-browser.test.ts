import test from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Page } from 'playwright';
import { config } from '../scripts/preview-model';
import { interceptRetentionRequests, runRetentionBrowser } from '../scripts/preview-retention-browser';
import { retentionPayload, retentionSnapshot, retentionWorkspaceId } from '../scripts/preview-retention-model';
import { parseRetentionReceipt, serializeRetentionReceipt } from '../scripts/preview-retention-receipt';
import { retentionAppFixture, retentionDeployment as d, retentionMarker as marker, retentionOidcFixture, retentionSource as s, retentionTransactionFixture } from './preview-retention-browser-fixture';

type Paused = { requestId: string; redirectedRequestId?: string; request: { url: string; method: string; headers: Record<string, string>; postData?: string } };
async function gateFixture(allow = true) {
  let handler: (event: Paused) => Promise<void> = async () => {};
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const session = { on: (_name: string, callback: typeof handler) => { handler = callback; }, send: async (method: string, params: Record<string, unknown>) => { sent.push({ method, params }); } };
  const control = await interceptRetentionRequests({ newCDPSession: async () => session } as unknown as BrowserContext, {} as Page, d.url, marker, allow);
  control.authenticate('local-private-oidc');
  const request = (change: Partial<Paused['request']> = {}, redirectedRequestId?: string) => handler({ requestId: String(sent.length),
    ...(redirectedRequestId ? { redirectedRequestId } : {}), request: { url: d.url + '/api/app', method: 'POST', headers: { 'Content-Type': 'application/json' }, postData: JSON.stringify(retentionPayload(marker)), ...change } });
  return { control, sent, request };
}
test('the exact fixed application POST requires arming and can only be forwarded once', async () => {
  const f = await gateFixture(); f.control.arm(); await f.request();
  assert.equal(f.sent.at(-1)?.method, 'Fetch.continueRequest'); assert.equal(f.control.writeAttempts(), 1);
  assert.ok(JSON.stringify(f.sent.at(-1)).includes('local-private-oidc'));
  assert.throws(() => f.control.arm(), /PREVIEW_RETENTION_BOUNDARY_FAILED/);
  await f.request(); assert.equal(f.sent.at(-1)?.method, 'Fetch.failRequest'); assert.equal(f.control.writeAttempts(), 1);
});
test('wrong bodies, paths, methods, redirects and origins never consume a write', async t => {
  const changes: [string, Partial<Paused['request']>, string?][] = [
    ['unrelated payload', { postData: JSON.stringify({ ...retentionPayload(marker), amountYen: 1 }) }],
    ['extra payload key', { postData: JSON.stringify({ ...retentionPayload(marker), transactionId: '50000000-0000-4000-8000-000000000005' }) }],
    ['duplicate JSON key', { postData: JSON.stringify(retentionPayload(marker)).replace('{', '{"action":"deleteWorkspace",') }],
    ['query', { url: d.url + '/api/app?extra=1' }], ['other path', { url: d.url + '/api/recurring-payments' }],
    ['other origin', { url: 'https://other.invalid/api/app' }], ['other method', { method: 'PUT' }],
    ['wrong content type', { headers: { 'Content-Type': 'text/plain' } }], ['redirect hop', {}, 'previous-request'],
  ];
  for (const [name, change, redirected] of changes) await t.test(name, async () => {
    const f = await gateFixture(); f.control.arm(); await f.request(change, redirected);
    assert.equal(f.sent.at(-1)?.method, 'Fetch.failRequest'); assert.equal(f.control.writeAttempts(), 0); assert.equal(f.control.blocked(), true);
    assert.ok(!JSON.stringify(f.sent.at(-1)).includes('local-private-oidc'));
  });
  const unarmed = await gateFixture(); await unarmed.request(); assert.equal(unarmed.control.writeAttempts(), 0);
  const readOnly = await gateFixture(false); assert.throws(() => readOnly.control.arm()); await readOnly.request(); assert.equal(readOnly.control.writeAttempts(), 0);
});
test('same-origin reads and normal login stay allowed without arming a business write', async () => {
  const f = await gateFixture(false);
  await f.request({ url: d.url + '/', method: 'GET', postData: undefined }); assert.equal(f.sent.at(-1)?.method, 'Fetch.continueRequest');
  await f.request({ url: d.url + '/api/auth/callback/test-login', postData: 'testUserKey=user-a' }); assert.equal(f.sent.at(-1)?.method, 'Fetch.continueRequest');
  assert.equal(f.control.writeAttempts(), 0); assert.equal(f.control.blocked(), false);
});

type FakeOptions = { lostResponse?: boolean; skipInsert?: boolean; wrongResponseId?: boolean; failReadAfter?: boolean;
  changeExisting?: boolean; changeFixture?: boolean; duplicate?: boolean; wrongRuntime?: boolean; closeFailure?: boolean; runtimeChange?: Record<string, unknown> };
function fakeBrowser(app = retentionAppFixture(marker, false), options: FakeOptions = {}) {
  let handler: (event: Paused) => Promise<void> = async () => {}, lastMethod = '';
  let posts = 0, evaluations = 0, reads = 0, runtimeCalls = 0, closes = 0;
  const session = { on: (_name: string, callback: typeof handler) => { handler = callback; }, send: async (method: string) => { lastMethod = method; } };
  const page = {
    setDefaultTimeout: () => {}, goto: async () => ({ status: () => 200 }), url: () => d.url, title: async () => 'Cake',
    getByRole: () => ({ click: async () => { await handler({ requestId: 'login', request: { url: d.url + '/api/auth/callback/test-login', method: 'POST', headers: {}, postData: 'testUserKey=user-a' } }); } }),
    locator: () => ({ waitFor: async () => {} }), waitForLoadState: async () => {},
    evaluate: async (_fn: unknown, value: unknown) => {
      if (typeof value === 'string' && value.length === 43) {
        runtimeCalls++; return { protocol: config.protocol, nonce: value, deploymentId: d.id, pr: s.pr, sha: options.wrongRuntime ? 'b'.repeat(40) : s.sha,
          branch: s.branch, generation: d.generation, database: d.database, connectionVerified: true, ...options.runtimeChange };
      }
      if (value === retentionWorkspaceId) {
        reads++; if (options.failReadAfter && posts) throw new Error('private raw app response'); return structuredClone(app);
      }
      evaluations++;
      await handler({ requestId: 'insert', request: { url: d.url + '/api/app', method: 'POST', headers: { 'Content-Type': 'application/json' }, postData: JSON.stringify(value) } });
      if (lastMethod !== 'Fetch.continueRequest') throw new Error('private blocked browser request');
      posts++;
      if (!options.skipInsert) app.selected.transactions.push(retentionTransactionFixture(marker));
      if (options.changeExisting) app.selected.transactions[0].memo = 'Unexpected changed existing data';
      if (options.changeFixture) { app.selected.members[0].name = app.user.name = 'Changed name'; for (const t of app.selected.transactions) t.actorName = 'Changed name'; }
      if (options.duplicate) app.selected.transactions.push({ ...retentionTransactionFixture(marker), id: '60000000-0000-4000-8000-000000000006' });
      if (options.lostResponse) throw new Error('private timeout after commit, cookie=secret');
      return options.wrongResponseId ? '70000000-0000-4000-8000-000000000007' : retentionTransactionFixture().id;
    },
  };
  const context = { newPage: async () => page, newCDPSession: async () => session, close: async () => { closes++; if (options.closeFailure) throw new Error('private close exception'); } };
  const browser = { newContext: async () => context, close: async () => { closes++; } } as unknown as Browser;
  return { browser, posts: () => posts, evaluations: () => evaluations, reads: () => reads, runtimeCalls: () => runtimeCalls, closes: () => closes };
}
const environment = () => ({ VERCEL_OIDC_TOKEN: retentionOidcFixture(), VERCEL_TOKEN: 'private-provider-token', CAKE_TEST_DATABASE_URL: 'private-db-url' });
test('prepare makes one normal app write and proves the full post-GET baseline through the public receipt codec', async () => {
  const f = fakeBrowser();
  const result = await runRetentionBrowser(s, d, '/tmp', { mode: 'prepare', marker }, environment(), async options => {
    assert.ok(!JSON.stringify(options).includes('private-')); return f.browser;
  });
  assert.equal(result.success, true); assert.equal(result.outcome, 'present'); assert.equal(result.writeAttempts, 1);
  assert.equal(f.posts(), 1); assert.equal(f.reads(), 2); assert.equal(f.runtimeCalls(), 2); assert.equal(f.closes(), 2);
  assert.ok(result.runtimeBeforeAt! <= result.observedAt); assert.ok(result.observedAt <= result.runtimeAfterAt!);
  assert.deepEqual(result.evidence, retentionSnapshot(retentionAppFixture(), marker).evidence);
  assert.ok(!JSON.stringify(result).includes('Fixture')); assert.ok(!JSON.stringify(result).includes('@cake.local'));
  const receipt = { protocol: 'cake-preview-retention/v1', action: 'retention-prepare', source: s, expectedDeploymentId: d.id,
    marker, deployment: d, database: d.database, ...result, checkedAt: new Date().toISOString(), operation: marker, runId: '123', runAttempt: 1, controlSha: 'b'.repeat(40) };
  assert.equal(parseRetentionReceipt(serializeRetentionReceipt(receipt)).success, true);
});
test('a timeout after successful insert is recovered by GET without a second POST', async () => {
  const f = fakeBrowser(undefined, { lostResponse: true });
  const result = await runRetentionBrowser(s, d, '/tmp', { mode: 'prepare', marker }, environment(), async () => f.browser);
  assert.equal(result.success, true); assert.equal(result.writeAttempts, 1); assert.equal(f.posts(), 1); assert.equal(f.evaluations(), 1); assert.equal(f.reads(), 2);
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('existing marker, duplicate or changed data cannot authorize a registration baseline', async t => {
  const existing = fakeBrowser(retentionAppFixture());
  const rejected = await runRetentionBrowser(s, d, '/tmp', { mode: 'prepare', marker }, environment(), async () => existing.browser);
  assert.equal(rejected.success, false); assert.equal(rejected.writeAttempts, 0); assert.equal(existing.posts(), 0);
  for (const option of ['skipInsert', 'wrongResponseId', 'failReadAfter', 'changeExisting', 'changeFixture', 'duplicate', 'closeFailure'] as const) await t.test(option, async () => {
    const f = fakeBrowser(undefined, { [option]: true });
    const result = await runRetentionBrowser(s, d, '/tmp', { mode: 'prepare', marker }, environment(), async () => f.browser);
    assert.equal(result.success, false); assert.equal(result.outcome, 'unknown'); assert.equal(result.writeAttempts, 1);
    assert.equal(f.posts(), 1); assert.equal(f.evaluations(), 1); assert.equal(result.evidence, undefined); assert.ok(!JSON.stringify(result).includes('private'));
  });
});
test('inspect is GET-only for present or absent data and check requires every baseline field', async () => {
  const baseline = retentionSnapshot(retentionAppFixture(), marker).evidence!;
  for (const present of [true, false]) {
    const f = fakeBrowser(retentionAppFixture(marker, present));
    const result = await runRetentionBrowser(s, d, '/tmp', { mode: 'inspect', marker }, environment(), async () => f.browser);
    assert.equal(result.outcome, present ? 'present' : 'absent'); assert.equal(result.success, present); assert.equal(f.posts(), 0); assert.equal(result.writeAttempts, 0);
  }
  const f = fakeBrowser(retentionAppFixture());
  assert.equal((await runRetentionBrowser(s, d, '/tmp', { mode: 'check', marker, baseline }, environment(), async () => f.browser)).success, true);
  const changed = fakeBrowser(retentionAppFixture());
  assert.equal((await runRetentionBrowser(s, d, '/tmp', { mode: 'check', marker, baseline: { ...baseline, collectionDigest: 'f'.repeat(64) } }, environment(), async () => changed.browser)).success, false);
  assert.equal(changed.posts(), 0);
});
test('source, runtime, fixture and OIDC failures remain sanitized and never write', async () => {
  const runtime = fakeBrowser(undefined, { wrongRuntime: true });
  const result = await runRetentionBrowser(s, d, '/tmp', { mode: 'prepare', marker }, environment(), async () => runtime.browser);
  assert.equal(result.failureStage, 'runtime-before'); assert.equal(result.writeAttempts, 0); assert.equal(runtime.posts(), 0);
  const wrong = await runRetentionBrowser({ ...s, sha: 'f'.repeat(40) }, d, '/tmp', { mode: 'prepare', marker }, environment(), async () => { throw new Error('must not launch'); });
  assert.equal(wrong.failureStage, 'boundary'); assert.equal(wrong.writeAttempts, 0);
  const oidc = await runRetentionBrowser(s, d, '/tmp', { mode: 'prepare', marker }, {}, async () => { throw new Error('must not launch'); }, async () => { throw new Error('private-provider-response'); });
  assert.equal(oidc.failureStage, 'oidc'); assert.ok(!JSON.stringify(oidc).includes('private'));
  const app = retentionAppFixture(marker, false); app.selected.members[1].role = 'OWNER'; const fixture = fakeBrowser(app);
  const invalid = await runRetentionBrowser(s, d, '/tmp', { mode: 'prepare', marker }, environment(), async () => fixture.browser);
  assert.equal(invalid.failureStage, 'read-before'); assert.equal(fixture.posts(), 0);
});
test('every runtime binding is independently required before the write can be armed', async t => {
  const changes = [
    { deploymentId: 'dpl_other' }, { pr: s.pr + 1 }, { branch: 'codex/other' }, { generation: '70000000-0000-4000-8000-000000000007' },
    { database: { ...d.database!, branchId: 'br-other' } }, { database: { ...d.database!, hostDigest: 'e'.repeat(64) } },
    { connectionVerified: false }, { nonce: 'not-the-supplied-nonce' },
  ];
  for (const [index, runtimeChange] of changes.entries()) await t.test(String(index), async () => {
    const f = fakeBrowser(undefined, { runtimeChange });
    const result = await runRetentionBrowser(s, d, '/tmp', { mode: 'prepare', marker }, environment(), async () => f.browser);
    assert.equal(result.failureStage, 'runtime-before'); assert.equal(result.writeAttempts, 0); assert.equal(f.posts(), 0);
  });
});

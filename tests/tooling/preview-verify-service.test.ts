import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserVerificationError, browserCases, developmentToken, type BrowserProof } from '../../scripts/preview/preview-browser';
import { config, hostDigest, protocol, type Deployment, type Source } from '../../scripts/preview/preview-model';
import type { Transport } from '../../scripts/preview/preview-provider';
import { PreviewVerifyService, readonlyVerifyTransport } from '../../scripts/preview/preview-verify-service';
import { serializeVerifyReceipt } from '../../scripts/preview/preview-verify-receipt';
import type { Receipt } from '../../scripts/preview/preview-service';

const sha = 'a'.repeat(40), generation = '10000000-0000-4000-8000-000000000001', operation = '20000000-0000-4000-8000-000000000002';
const source: Source = { pr: 71, branch: 'codex/test-preview', sha, createdAt: '2026-10-15T00:00:00Z', state: 'open' };
const database = { branchId: 'br-child', endpointId: 'ep-child', hostDigest: hostDigest('ep-child.ap-southeast-1.aws.neon.tech') };
const deployment: Deployment = { id: 'dpl_Test', url: 'https://cake-test.vercel.app', sha, branch: source.branch, pr: source.pr,
  generation, operation, phase: 'application', state: 'READY', createdAt: Date.parse('2026-10-16T00:00:00Z'), database };
function proofFor(s: Source, d: Deployment): BrowserProof {
  const at = new Date().toISOString();
  return { protocol: 'cake-preview-browser/v1', source: s, deployment: d, cases: [...browserCases],
    clicks: browserCases.slice(0, 4).flatMap(c => [`ログイン${c.at(-1)?.toUpperCase()}`, '取引明細', '設定', 'ホーム'].map(target => ({ case: c, target, at }))),
    observations: browserCases.slice(0, 4).flatMap(c => (['runtime-before', 'session-app', 'runtime-after'] as const).map(kind => ({ case: c, kind, at }))),
    verifiedAt: at, success: true };
}
function status(d: Deployment = deployment): Receipt {
  return { protocol, action: 'status', source, deployment: d, database: d.database, checkedAt: new Date().toISOString(), success: true };
}
function fixture(browse: ConstructorParameters<typeof PreviewVerifyService>[1]) {
  const requests: { provider: string; path: string; method: string }[] = [];
  let currentSha = sha;
  const branch = { id: database.branchId, project_id: config.neonProjectId, name: `preview/${source.branch}`, parent_id: config.neonParentBranchId,
    default: false, protected: false, created_at: '2026-10-16T00:00:01Z' };
  const endpoint = { id: database.endpointId, project_id: config.neonProjectId, branch_id: database.branchId, type: 'read_write', host: 'ep-child.ap-southeast-1.aws.neon.tech' };
  const rawDeployment = { id: deployment.id, url: 'cake-test.vercel.app', projectId: config.vercelProjectId, target: null,
    gitSource: { type: 'github', repoId: config.repositoryId, ref: source.branch, sha }, createdAt: deployment.createdAt, readyState: 'READY',
    meta: { cakePreviewProtocol: protocol, cakePreviewRepository: config.repository, cakePreviewPr: String(source.pr), cakePreviewGeneration: generation,
      cakePreviewOperation: operation, cakePreviewPhase: 'application', cakePreviewDatabaseBranch: database.branchId,
      cakePreviewDatabaseEndpoint: database.endpointId, cakePreviewDatabaseDigest: database.hostDigest } };
  const api: Transport = async (provider, path, method = 'GET', body) => {
    assert.equal(method, 'GET'); assert.equal(body, undefined); requests.push({ provider, path, method });
    if (provider === 'github') {
      if (path.endsWith('/pulls/71')) return { number: source.pr, state: source.state, created_at: source.createdAt,
        head: { ref: source.branch, sha: currentSha, repo: { full_name: config.repository } }, base: { ref: 'main', repo: { full_name: config.repository } } };
      if (path.endsWith(config.repository)) return { id: config.repositoryId, full_name: config.repository };
    }
    if (provider === 'vercel') {
      if (path.startsWith('/v9/projects/')) return { id: config.vercelProjectId, accountId: config.vercelTeamId, link: { repoId: config.repositoryId } };
      if (path.startsWith('/v6/deployments?')) return { deployments: [rawDeployment], pagination: { next: null } };
      if (path === `/v13/deployments/${deployment.id}`) return rawDeployment;
      if (path === `/v3/env/pull/${config.vercelProjectId}/development`) return { env: { VERCEL_OIDC_TOKEN: `header.${Buffer.from(JSON.stringify({ project_id: config.vercelProjectId,
        owner_id: config.vercelTeamId, environment: 'development', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.signature` } };
    }
    if (provider === 'neon') {
      if (path === `/projects/${config.neonProjectId}`) return { project: { id: config.neonProjectId } };
      if (path.endsWith(`/branches/${config.neonParentBranchId}`)) return { branch: { id: config.neonParentBranchId, project_id: config.neonProjectId } };
      if (path.includes('/branches?')) return { branches: [branch], pagination: {} };
      if (path.endsWith('/endpoints')) return { endpoints: [endpoint] };
      if (path.endsWith(`/branches/${database.branchId}`)) return { branch };
      if (path.endsWith(`/endpoints/${database.endpointId}`)) return { endpoint };
    }
    throw new Error('UNEXPECTED_TEST_REQUEST');
  };
  return { service: new PreviewVerifyService(api, browse), requests, changeSource: () => { currentSha = 'b'.repeat(40); } };
}

test('verify performs provider status → browser/OIDC GET → status, reuses existing resources and removes ephemeral files', async () => {
  let temp = '', browserCount = 0;
  const f = fixture(async (s, d, directory, env, _launch, api) => {
    browserCount++; temp = directory;
    assert.deepEqual(s, source); assert.deepEqual(d, deployment);
    assert.ok(await developmentToken(env, api));
    await writeFile(join(directory, 'ephemeral.png'), 'test-only');
    return proofFor(s, d);
  });
  const result = await f.service.verify(source, deployment.id, {});
  assert.equal(result.success, true); assert.equal(browserCount, 1);
  assert.equal(result.browser?.clicks.length, 16); assert.equal(result.browser?.checks.length, 12);
  const oidc = f.requests.findIndex(r => r.path.startsWith('/v3/env/pull/'));
  assert.ok(oidc > 0 && oidc < f.requests.length - 1);
  assert.ok(f.requests.slice(0, oidc).some(r => r.path.endsWith(`/endpoints/${database.endpointId}`)));
  assert.ok(f.requests.slice(oidc + 1).some(r => r.path.endsWith(`/endpoints/${database.endpointId}`)));
  assert.ok(f.requests.every(r => r.method === 'GET'));
  await assert.rejects(access(temp), /ENOENT/);
  const text = serializeVerifyReceipt({ ...result, operation, runId: '123', runAttempt: 1, controlSha: 'c'.repeat(40) });
  assert.ok(Buffer.byteLength(text) <= 4096); assert.ok(!text.includes('signature')); assert.ok(!text.includes('ep-child.ap-'));
});

test('verify provider transport rejects every write and GET bodies before invoking underlying transport', async () => {
  let calls = 0;
  const api = readonlyVerifyTransport(async () => { calls++; return null; });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'get']) await assert.rejects(api('vercel', '/v13/deployments', method), /READ_ONLY/);
  await assert.rejects(api('vercel', '/v13/deployments', 'GET', {}), /READ_ONLY/);
  await assert.rejects(api('vercel', '/v13/deployments', undefined, null), /READ_ONLY/);
  assert.equal(calls, 0);
  await api('vercel', '/v9/projects/test', 'GET'); assert.equal(calls, 1);
});

test('unexpected Deployment ID or changed PR source stops before browser or OIDC', async () => {
  const f = fixture(async () => { assert.fail('browser must not run'); });
  const wrong = await f.service.verify(source, 'dpl_Other', {});
  assert.equal(wrong.success, false); assert.deepEqual(wrong.failure, { stage: 'preflight', code: 'PREVIEW_VERIFY_TARGET_CHANGED' });
  assert.equal(wrong.deployment, undefined); assert.equal(wrong.database, undefined);
  f.changeSource();
  const changed = await f.service.verify(source, deployment.id, {});
  assert.equal(changed.success, false); assert.deepEqual(changed.failure, { stage: 'preflight', code: 'PREVIEW_VERIFY_STATUS_FAILED' });
  assert.ok(!f.requests.some(r => r.path.startsWith('/v3/env/pull/')));
});

test('every deployment identity field and dedicated DB identity is bound across postflight', async (t) => {
  const changes: Partial<Deployment>[] = [{ id: 'dpl_Other' }, { url: 'https://cake-other.vercel.app' }, { sha: 'b'.repeat(40) }, { branch: 'codex/other' }, { pr: 72 },
    { generation: '30000000-0000-4000-8000-000000000003' }, { operation: '30000000-0000-4000-8000-000000000003' },
    { phase: 'provisioning' }, { state: 'ERROR' }, { createdAt: deployment.createdAt + 1 },
    { database: { ...database, branchId: 'br-other' } }, { database: { ...database, endpointId: 'ep-other' } }, { database: { ...database, hostDigest: 'b'.repeat(64) } }];
  for (const change of changes) {
    let calls = 0;
    const service = new PreviewVerifyService(async () => { assert.fail('no provider in isolated identity test'); }, async (s, d) => proofFor(s, d));
    t.mock.method(service.statusService, 'status', async () => { calls++; return calls === 1 ? status() : status({ ...deployment, ...change }); });
    const result = await service.verify(source, deployment.id, {});
    assert.equal(calls, 2); assert.equal(result.success, false, JSON.stringify(change));
    assert.deepEqual(result.failure, { stage: 'postflight', code: 'PREVIEW_VERIFY_TARGET_CHANGED' });
    assert.deepEqual(result.deployment, deployment); assert.equal(result.browser?.checks.length, 12);
  }
});

test('missing or inconsistent dedicated DB before browser fails closed', async (t) => {
  for (const invalid of [{ ...status(), database: undefined }, { ...status(), database: { ...database, endpointId: 'ep-other' } },
    { ...status(), source: { ...source, sha: 'b'.repeat(40) } }, { ...status(), deployment: undefined }]) {
    const service = new PreviewVerifyService(async () => null, async () => { assert.fail('browser must not run'); });
    t.mock.method(service.statusService, 'status', async () => invalid);
    const result = await service.verify(source, deployment.id, {});
    assert.equal(result.success, false); assert.equal(result.failure?.stage, 'preflight'); assert.equal(result.browser, undefined);
  }
});

test('browser failures report only safe partial observations and fixed stage/code, then omit postflight', async () => {
  const f = fixture(async (s, d) => {
    const proof = proofFor(s, d); proof.success = false; proof.cases = []; proof.clicks = []; proof.observations = [];
    throw new BrowserVerificationError('oidc', proof);
  });
  const result = await f.service.verify(source, deployment.id, {});
  assert.equal(result.success, false); assert.deepEqual(result.failure, { stage: 'browser', code: 'PREVIEW_VERIFY_OIDC_UNAVAILABLE', browserStage: 'oidc' });
  assert.deepEqual(result.browser?.cases, []); assert.deepEqual(result.browser?.clicks, []);
  assert.equal(f.requests.filter(r => r.path.startsWith('/v9/projects/')).length, 1);
  const raw = fixture(async () => { throw new Error('private-provider-response-do-not-output'); });
  const failed = await raw.service.verify(source, deployment.id, {});
  assert.equal(failed.failure?.code, 'PREVIEW_VERIFY_BROWSER_FAILED'); assert.equal(failed.browser, undefined);
  assert.ok(!JSON.stringify(failed).includes('private-provider-response'));
  assert.doesNotThrow(() => serializeVerifyReceipt({ ...failed, operation, runId: '123', runAttempt: 1, controlSha: 'c'.repeat(40) }));
});

test('postflight provider error cannot retain successful overall result', async (t) => {
  let calls = 0;
  const service = new PreviewVerifyService(async () => null, async (s, d) => proofFor(s, d));
  t.mock.method(service.statusService, 'status', async () => { if (++calls === 2) throw new Error('private'); return status(); });
  const result = await service.verify(source, deployment.id, {});
  assert.equal(result.success, false); assert.deepEqual(result.failure, { stage: 'postflight', code: 'PREVIEW_VERIFY_STATUS_FAILED' });
  assert.equal(result.browser?.cases.length, 5); assert.ok(!JSON.stringify(result).includes('private'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config, type Deployment, type Source } from '../../scripts/preview/preview-model';
import type { OperationReceipt } from '../../scripts/preview/preview-receipt';
import { parseReceipt } from '../../scripts/preview/preview-receipt';
import { assertQaDispatch, oidcChecks, parseWindowsQaConfig, pinQaReceipt, qaCommandEnvironment, qaReadApiAllowed,
  summarizeQaProof, type WindowsQaRequest } from '../../scripts/qa/windows/windows-qa-model';

const implementationSha = 'a'.repeat(40), runtimeSha = 'b'.repeat(40), mainSha = 'c'.repeat(40);
const generation = '11111111-1111-4111-8111-111111111111', operation = '22222222-2222-4222-8222-222222222222';
const common = { protocol: 'cake-windows-qa-request/v1' as const, controlCwd: 'D:\\Projects\\Cake control',
  controlSha: implementationSha, gitExe: 'D:\\Tools\\Git\\cmd\\git.exe', ghExe: 'D:\\Tools\\gh.exe' };
const request: WindowsQaRequest = { ...common, mode: 'verify', targetWorktree: 'E:\\Other task\\Cake', pr: 42, sha: runtimeSha,
  deploymentId: 'dpl_test123', databaseBranchId: 'br-test-branch', generation };
const source: Source = { pr: request.pr, branch: 'codex/other-change', sha: runtimeSha, createdAt: '2026-01-01T00:00:00Z', state: 'open' };
const db = { branchId: request.databaseBranchId, endpointId: 'ep-test-endpoint', hostDigest: 'd'.repeat(64) };
const deployment: Deployment = { id: request.deploymentId, url: 'https://cake-independent-test.vercel.app', sha: runtimeSha,
  branch: source.branch, pr: request.pr, generation, operation, phase: 'application', state: 'READY', createdAt: Date.parse(source.createdAt) + 1000, database: db };
function receipt(): OperationReceipt { return { protocol: 'cake-preview/v1', action: 'status', source: { ...source }, deployment: structuredClone(deployment),
  database: { ...db }, checkedAt: '2026-01-01T00:00:03Z', success: true, operation, runId: '123', runAttempt: 1, controlSha: mainSha }; }
const copy = <T>(value: T): T => structuredClone(value);

test('Windows QA config supports independent PR, checkout, tool paths and implementation/runtime SHAs', () => {
  assert.deepEqual(parseWindowsQaConfig(request, 'verify'), request);
  const preflight = { ...common, mode: 'preflight' };
  assert.deepEqual(parseWindowsQaConfig(preflight, 'preflight'), preflight);
  const ordinary = { ...request, controlCwd: request.targetWorktree, controlSha: runtimeSha };
  assert.deepEqual(parseWindowsQaConfig(ordinary, 'verify'), ordinary);
  for (const change of [{ url: deployment.url }, { token: 'dummy' }, { sha: 'a0' }, { pr: 0 }, { mode: 'preflight' },
    { targetWorktree: 'relative' }, { gitExe: 'git.exe' }, { ghExe: 'D:\\Tools\\other.exe' }, { deploymentId: '../other' },
    { generation: '11111111-1111-1111-1111-111111111111' }]) {
    assert.throws(() => parseWindowsQaConfig({ ...request, ...change }, 'verify'), /QA_CONFIG_REJECTED/);
  }
  assert.throws(() => parseWindowsQaConfig({ ...preflight, targetWorktree: request.targetWorktree }, 'preflight'), /QA_CONFIG_REJECTED/);
});

test('Git and gh children retain saved gh identity but receive no provider/application/debug secrets', () => {
  const environment = { SystemRoot: 'D:\\Windows', USERPROFILE: 'D:\\Users\\fixture', HTTP_PROXY: 'http://proxy.invalid:8080',
    VERCEL_TOKEN: 'dummy', VERCEL_OIDC_TOKEN: 'dummy', GH_TOKEN: 'dummy', GITHUB_TOKEN: 'dummy', DATABASE_URL: 'dummy',
    CAKE_TEST_DATABASE_URL: 'dummy', AUTH_SECRET: 'dummy', NEON_API_KEY: 'dummy', NODE_OPTIONS: '--inspect',
    NODE_TLS_REJECT_UNAUTHORIZED: '0', DEBUG: '*', PWDEBUG: '1', PATH: 'untrusted' } as unknown as NodeJS.ProcessEnv;
  const safe = qaCommandEnvironment(environment, { ...common, nodeExe: 'D:\\Tools\\node\\node.exe' });
  assert.equal(safe.USERPROFILE, environment.USERPROFILE);
  assert.equal(safe.GH_HOST, 'github.com'); assert.equal(safe.GH_PROMPT_DISABLED, '1');
  assert.equal(safe.PATH, 'D:\\Tools\\Git\\cmd;D:\\Tools;D:\\Tools\\node;D:\\Windows\\System32;D:\\Windows');
  for (const key of ['VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'DATABASE_URL', 'CAKE_TEST_DATABASE_URL',
    'AUTH_SECRET', 'NEON_API_KEY', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'DEBUG', 'PWDEBUG']) assert.equal(safe[key], undefined);
  assert.throws(() => qaCommandEnvironment({} as NodeJS.ProcessEnv, { ...common, nodeExe: 'D:\\node.exe' }), /QA_RUNTIME_REJECTED/);
});

test('only exact status dispatch inputs pass; create/update/verify/cleanup, broad inputs and wrong identities stop', () => {
  const dispatch = { ref: 'main', inputs: { action: 'status', pr: String(request.pr), sha: runtimeSha, operation, controlSha: mainSha } };
  assert.equal(assertQaDispatch(dispatch, request, mainSha), operation);
  for (const action of ['deploy', 'verify', 'cleanup', 'status '])
    assert.throws(() => assertQaDispatch({ ...dispatch, inputs: { ...dispatch.inputs, action } }, request, mainSha), /QA_COMMAND_REJECTED/);
  for (const inputs of [{ ...dispatch.inputs, pr: '43' }, { ...dispatch.inputs, sha: implementationSha },
    { ...dispatch.inputs, controlSha: implementationSha }, { ...dispatch.inputs, token: 'dummy' }, { ...dispatch.inputs, operation: 'bad' }])
    assert.throws(() => assertQaDispatch({ ...dispatch, inputs }, request, mainSha), /QA_COMMAND_REJECTED/);
  assert.throws(() => assertQaDispatch({ ...dispatch, ref: 'codex/other-change' }, request, mainSha), /QA_COMMAND_REJECTED/);
});

test('API allowlist is read-only, same repository/PR and initial main SHA only', () => {
  const prefix = `repos/${config.repository}/`;
  for (const tail of [`pulls/${request.pr}`, 'branches/main', `contents/preview.config.json?ref=${mainSha}`,
    'actions/workflows/preview.yml', 'actions/workflows/preview.yml/runs?event=workflow_dispatch&branch=main&per_page=100',
    'actions/runs/123', 'actions/runs/123/attempts/1/jobs?per_page=100&page=1', 'check-suites/123', 'check-runs/123',
    'check-runs/123/annotations?per_page=100&page=1']) assert.equal(qaReadApiAllowed(prefix + tail, request, mainSha), true, tail);
  for (const tail of ['pulls/43', 'actions/workflows/preview.yml/dispatches', 'contents/secret',
    `contents/preview.config.json?ref=${implementationSha}`, 'actions/runs/123/attempts/2/jobs?per_page=100&page=1',
    'check-runs/123/annotations?per_page=100&page=0']) assert.equal(qaReadApiAllowed(prefix + tail, request, mainSha), false, tail);
  assert.equal(qaReadApiAllowed(`repos/another/repository/pulls/${request.pr}`, request, mainSha), false);
});

test('receipt pin adds resource checks while preserving full formal receipt parser and provenance contract', () => {
  const first = parseReceipt(JSON.stringify(receipt()));
  assert.equal(pinQaReceipt(first, request, source.branch, mainSha), first);
  const after = receipt(); after.operation = '33333333-3333-4333-8333-333333333333'; after.runId = '124';
  assert.equal(pinQaReceipt(after, request, source.branch, mainSha, first), after);
  // Implementation commit may be a new branch while Actions still pins current main.
  assert.notEqual(first.controlSha, request.controlSha);
  for (const mutate of [
    (r: OperationReceipt) => { r.source.sha = implementationSha; },
    (r: OperationReceipt) => { r.source.branch = 'codex/another'; },
    (r: OperationReceipt) => { r.source.createdAt = '2026-01-01T00:00:01Z'; },
    (r: OperationReceipt) => { r.deployment!.id = 'dpl_other'; },
    (r: OperationReceipt) => { r.deployment!.url = 'https://other.vercel.app'; },
    (r: OperationReceipt) => { r.deployment!.generation = operation; },
    (r: OperationReceipt) => { r.deployment!.operation = generation; },
    (r: OperationReceipt) => { r.deployment!.createdAt++; },
    (r: OperationReceipt) => { r.database!.branchId = 'br-other'; },
    (r: OperationReceipt) => { r.database!.endpointId = 'ep-other'; r.deployment!.database!.endpointId = 'ep-other'; },
    (r: OperationReceipt) => { r.database!.hostDigest = 'e'.repeat(64); r.deployment!.database!.hostDigest = 'e'.repeat(64); },
    (r: OperationReceipt) => { r.runAttempt = 2; },
    (r: OperationReceipt) => { r.controlSha = implementationSha; },
  ]) {
    const changed = receipt(); mutate(changed);
    assert.throws(() => pinQaReceipt(changed, request, source.branch, mainSha, first), /QA_(?:RESOURCE|TARGET)_IDENTITY_REJECTED/);
  }
  const raw = JSON.stringify(receipt());
  assert.throws(() => parseReceipt(raw.replace('"success":true', '"success":true,"success":true')), /PREVIEW_RECEIPT_INVALID/);
});

function proof() {
  const at = '2026-01-01T02:00:01.000Z', cases = ['desktop-a', 'desktop-b', 'mobile-a', 'mobile-b'];
  return { protocol: 'cake-preview-browser/v1', source: copy(source), deployment: copy(deployment), cases: [...cases, 'read-api'],
    clicks: cases.flatMap(caseName => [`ログイン${caseName.endsWith('a') ? 'A' : 'B'}`, '取引明細', '設定', 'ホーム'].map(target => ({ case: caseName, target, at }))),
    observations: cases.flatMap(caseName => ['runtime-before', 'session-app', 'runtime-after'].map(kind => ({ case: caseName, kind, at }))),
    verifiedAt: at, success: true };
}
test('formal proof requires all 16 clicks, 12 ordered observations, four viewports/users and current timestamps', () => {
  const startedAt = '2026-01-01T02:00:00.000Z', now = Date.parse(startedAt) + 10_000;
  const validate = (value: unknown, complete = true) => summarizeQaProof(value, request, source.branch, receipt(), startedAt, complete, now);
  assert.deepEqual(validate(proof()), { clickCount: 16, caseCount: 5, observationCount: 12 });
  for (const mutate of [
    (p: ReturnType<typeof proof>) => { p.clicks.pop(); },
    (p: ReturnType<typeof proof>) => { p.observations.pop(); },
    (p: ReturnType<typeof proof>) => { p.cases[2] = 'desktop-a'; },
    (p: ReturnType<typeof proof>) => { p.clicks[5].target = 'ホーム'; },
    (p: ReturnType<typeof proof>) => { p.clicks[0].at = '2026-01-01T01:59:00.000Z'; },
    (p: ReturnType<typeof proof>) => { p.observations[3].at = '2026-01-01T03:00:00.000Z'; },
    (p: ReturnType<typeof proof>) => { p.observations[0].kind = 'runtime-after'; },
    (p: ReturnType<typeof proof>) => { p.success = false; },
    (p: ReturnType<typeof proof>) => { p.deployment.url = 'https://other.vercel.app'; },
  ]) { const p = proof(); mutate(p); assert.throws(() => validate(p), /QA_PROOF_REJECTED/); }
  const partial = proof(); partial.success = false; partial.clicks = partial.clicks.slice(0, 2);
  partial.observations = partial.observations.slice(0, 1); partial.cases = [];
  assert.deepEqual(validate(partial, false), { clickCount: 2, caseCount: 0, observationCount: 1 });
});

test('OIDC result contains only four checks; project, team, development and expiry all matter', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const claims = { project_id: config.vercelProjectId, owner_id: config.vercelTeamId, environment: 'development', exp: now / 1000 + 120 };
  const jwt = (value: unknown) => `header.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`;
  const expected = { oidcProjectMatches: true, oidcOwnerMatches: true, oidcDevelopment: true, oidcExpiryValid: true };
  assert.deepEqual(oidcChecks(jwt(claims), now), expected);
  for (const [field, value, flag] of [['project_id', 'other', 'oidcProjectMatches'], ['owner_id', 'other', 'oidcOwnerMatches'],
    ['environment', 'production', 'oidcDevelopment'], ['exp', now / 1000 + 59, 'oidcExpiryValid'],
    ['exp', String(now / 1000 + 120), 'oidcExpiryValid']] as const)
    assert.equal(oidcChecks(jwt({ ...claims, [field]: value }), now)[flag], false);
  for (const token of ['bad', 'a.b.c.d', 'a.!.c', 'x'.repeat(32769)])
    assert.deepEqual(oidcChecks(token, now), Object.fromEntries(Object.keys(expected).map(key => [key, false])));
});

test('child rejects unsafe dummy runtime before opening config or connecting; stdout is a strict public projection', () => {
  const dummy = 'vcp_dummy_only_never_a_real_token';
  const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH'].flatMap(key =>
    process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const run = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/qa/windows/windows-qa-child.ts'),
    '--broker-mode', 'verify', '--broker-config', resolve('.cake/does-not-exist-public-request.json')], {
    encoding: 'utf8', timeout: 20_000, env: { ...environment, NODE_ENV: 'test', VERCEL_TOKEN: dummy, DEBUG: 'dummy-rejected' },
  });
  assert.equal(run.status, 1);
  assert.equal(run.stdout.includes(dummy), false); assert.equal(run.stderr.includes(dummy), false);
  const value = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(value).sort(), ['protocol', 'mode', 'success', 'code', 'oidcProjectMatches', 'oidcOwnerMatches',
    'oidcDevelopment', 'oidcExpiryValid', 'counts'].sort());
  assert.equal(value.protocol, 'cake-windows-qa-child/v1'); assert.equal(value.mode, 'verify');
  assert.equal(value.code, 'QA_RUNTIME_REJECTED'); assert.equal(value.success, false);
  assert.deepEqual({ ...value.counts, elapsedMs: 0 }, { statusDispatchCount: 0, statusReceiptCount: 0, clickCount: 0,
    caseCount: 0, observationCount: 0, screenshotCount: 0, elapsedMs: 0 });
});

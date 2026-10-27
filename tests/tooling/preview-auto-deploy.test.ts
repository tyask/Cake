import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreviewWorkflow, emitPreviewReceipt } from '../../scripts/preview/preview-workflow';
import { PreviewProvider } from '../../scripts/preview/preview-provider';
import { PreviewService } from '../../scripts/preview/preview-service';
import { config, protocol, source, uuid, type Source } from '../../scripts/preview/preview-model';
import { parseReceipt } from '../../scripts/preview/preview-receipt';

test('a resolved current PR deploys the exact HEAD and reruns reconcile the same operation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cake-auto-')), previous = process.cwd();
  const path = join(dir, 'event.json'), sha = 'a'.repeat(40);
  const raw = { number: 82, state: 'open', merged: false, created_at: '2026-10-17T00:00:00Z',
    head: { ref: 'codex/auto-test', sha, repo: { full_name: config.repository } },
    base: { ref: 'main', repo: { full_name: config.repository } } };
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CAKE_PREVIEW_PR: '82', VERCEL_TOKEN: 'fixture', NEON_API_KEY: 'fixture', GITHUB_REPOSITORY: config.repository,
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/preview.yml@refs/heads/main`,
    GITHUB_EVENT_PATH: path, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'c'.repeat(40), GITHUB_EVENT_NAME: 'workflow_run' };
  let resolution: { source: Source; raw: Record<string, unknown> } | undefined = { source: source(raw), raw };
  const sources = {
    workflowRunPullRequest: async () => resolution,
    pushedPullRequests: async () => assert.fail('workflow_run must not use push discovery'),
  };
  let reads = 0;
  const service = new PreviewService(new PreviewProvider(async (provider, request, method = 'GET') => {
    assert.equal(provider, 'github'); assert.equal(request, '/repos/tyask/Cake/pulls/82'); assert.equal(method, 'GET');
    reads++; return raw;
  }));
  const calls: { operation: string; resume: boolean | undefined }[] = [];
  t.mock.method(service, 'deploy', async (current: Source, operation: string, resume?: boolean) => {
    assert.equal(current.sha, sha); assert.equal(current.branch, raw.head.ref);
    assert.ok(uuid(operation)); calls.push({ operation, resume });
    const database = { branchId: 'br-test', endpointId: 'ep-test', hostDigest: 'd'.repeat(64) };
    return { protocol, action: 'deploy', source: current, checkedAt: '2026-10-17T00:01:00Z', success: true, database,
      deployment: { id: 'dpl_Auto', url: 'https://cake-auto.vercel.app', sha, branch: current.branch, pr: current.pr,
        generation: operation, operation, phase: 'application', state: 'READY', createdAt: Date.parse('2026-10-17T00:00:30Z'), database } };
  });
  try {
    process.chdir(dir);
    await writeFile(path, JSON.stringify({ repository: { full_name: config.repository } }));
    await runPreviewWorkflow(env, service, undefined, sources);
    const receipt = parseReceipt(await readFile('preview-result.json', 'utf8'));
    assert.equal(receipt.action, 'deploy'); assert.equal(receipt.source.sha, sha); assert.equal(calls[0].resume, false);
    await runPreviewWorkflow({ ...env, GITHUB_RUN_ATTEMPT: '2' }, service, undefined, sources);
    assert.equal(calls.at(-1)!.resume, true);
    assert.equal(new Set(calls.map(c => c.operation)).size, 1);
    await runPreviewWorkflow({ ...env, GITHUB_RUN_ID: '101' }, service, undefined, sources);
    assert.notEqual(calls.at(-1)!.operation, calls[0].operation);

    const before = calls.length, beforeReads = reads;
    resolution = undefined;
    await runPreviewWorkflow({ ...env, VERCEL_TOKEN: '', NEON_API_KEY: '' }, service, undefined, sources);
    const notices: string[] = []; await emitPreviewReceipt(undefined, line => notices.push(line));
    assert.deepEqual(notices, []); assert.equal(reads, beforeReads); assert.equal(calls.length, before);
    resolution = { source: { ...source(raw), state: 'closed' }, raw: { ...raw, merged: true } };
    await runPreviewWorkflow(env, service, undefined, sources);
    assert.equal(reads, beforeReads); assert.equal(calls.length, before);

    resolution = { source: { ...source(raw), sha: 'b'.repeat(40) }, raw };
    await assert.rejects(runPreviewWorkflow(env, service, undefined, sources), /PREVIEW_PR_CHANGED/);
    assert.equal(calls.length, before);
    await assert.rejects(readFile('preview-result.json'), /ENOENT/);
    await assert.rejects(runPreviewWorkflow({ ...env, GITHUB_EVENT_NAME: 'pull_request' }, service, undefined, sources), /UNTRUSTED_EVENT/);
  } finally { process.chdir(previous); await rm(dir, { recursive: true, force: true }); }
});

test('a close notification cleans only a still-closed unmerged PR and rejects reopen races', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cake-close-')), previous = process.cwd();
  const path = join(dir, 'event.json');
  const raw = { number: 82, state: 'closed', merged: false, created_at: '2026-10-17T00:00:00Z',
    head: { ref: 'codex/auto-test', sha: 'a'.repeat(40), repo: { full_name: config.repository } },
    base: { ref: 'main', repo: { full_name: config.repository } } };
  const closed = source(raw), sources = {
    workflowRunPullRequest: async () => ({ source: closed, raw }),
    pushedPullRequests: async () => assert.fail('not a push'),
  };
  const service = new PreviewService(new PreviewProvider(async () => raw));
  let cleanups = 0;
  t.mock.method(service, 'cleanup', async (current: Source) => {
    cleanups++; assert.deepEqual(current, closed);
    return { protocol, action: 'cleanup', source: current, checkedAt: '2026-10-17T00:01:00Z', success: true };
  });
  const env = { CAKE_PREVIEW_PR: '82', VERCEL_TOKEN: 'fixture', NEON_API_KEY: 'fixture', GITHUB_REPOSITORY: config.repository,
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/preview.yml@refs/heads/main`,
    GITHUB_EVENT_PATH: path, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'c'.repeat(40), GITHUB_EVENT_NAME: 'workflow_run' };
  try {
    process.chdir(dir);
    await writeFile(path, JSON.stringify({ repository: { full_name: config.repository } }));
    await runPreviewWorkflow(env, service, undefined, sources);
    const receipt = parseReceipt(await readFile('preview-result.json', 'utf8'));
    assert.equal(cleanups, 1); assert.equal(receipt.operation, null); assert.equal(receipt.action, 'cleanup');
    raw.state = 'open';
    await assert.rejects(runPreviewWorkflow(env, service, undefined, sources), /PR_CHANGED/);
    assert.equal(cleanups, 1); await assert.rejects(readFile('preview-result.json'), /ENOENT/);
  } finally { process.chdir(previous); await rm(dir, { recursive: true, force: true }); }
});

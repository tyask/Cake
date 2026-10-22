import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreviewWorkflow } from '../../scripts/preview/preview-workflow';
import { PreviewProvider } from '../../scripts/preview/preview-provider';
import { PreviewService } from '../../scripts/preview/preview-service';
import { config, protocol, uuid, type Source } from '../../scripts/preview/preview-model';
import { parseReceipt } from '../../scripts/preview/preview-receipt';

test('same-repository PR open/update/reopen deploys the exact HEAD and reruns reconcile one operation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cake-auto-')), previous = process.cwd();
  const path = join(dir, 'event.json'), sha = 'a'.repeat(40);
  const raw = { number: 82, state: 'open', created_at: '2026-10-17T00:00:00Z',
    head: { ref: 'codex/auto-test', sha, repo: { full_name: config.repository } },
    base: { ref: 'main', repo: { full_name: config.repository } } };
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', VERCEL_TOKEN: 'fixture', NEON_API_KEY: 'fixture', GITHUB_REPOSITORY: config.repository,
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/preview.yml@refs/heads/main`,
    GITHUB_EVENT_PATH: path, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'c'.repeat(40), GITHUB_EVENT_NAME: 'pull_request_target' };
  let reads = 0;
  const service = new PreviewService(new PreviewProvider(async (provider, request, method = 'GET') => {
    assert.equal(provider, 'github'); assert.equal(request, '/repos/tyask/Cake/pulls/82'); assert.equal(method, 'GET');
    reads++; return raw;
  }));
  const calls: { operation: string; resume: boolean | undefined }[] = [];
  t.mock.method(service, 'deploy', async (source: Source, operation: string, resume?: boolean) => {
    assert.equal(source.sha, sha); assert.equal(source.branch, raw.head.ref);
    assert.ok(uuid(operation)); calls.push({ operation, resume });
    const database = { branchId: 'br-test', endpointId: 'ep-test', hostDigest: 'd'.repeat(64) };
    return { protocol, action: 'deploy', source, checkedAt: '2026-10-17T00:01:00Z', success: true, database,
      deployment: { id: 'dpl_Auto', url: 'https://cake-auto.vercel.app', sha, branch: source.branch, pr: source.pr,
        generation: operation, operation, phase: 'application', state: 'READY', createdAt: Date.parse('2026-10-17T00:00:30Z'), database } };
  });
  try {
    process.chdir(dir);
    for (const action of ['opened', 'synchronize', 'reopened']) {
      await writeFile(path, JSON.stringify({ repository: { full_name: config.repository }, action, pull_request: raw }));
      await runPreviewWorkflow(env, service);
      const receipt = parseReceipt(await readFile('preview-result.json', 'utf8'));
      assert.equal(receipt.action, 'deploy'); assert.equal(receipt.source.sha, sha);
      assert.equal(receipt.operation, calls.at(-1)!.operation); assert.equal(calls.at(-1)!.resume, false);
    }
    await runPreviewWorkflow({ ...env, GITHUB_RUN_ATTEMPT: '2' }, service);
    assert.equal(calls.at(-1)!.resume, true);
    assert.equal(new Set(calls.map(c => c.operation)).size, 1);
    await runPreviewWorkflow({ ...env, GITHUB_RUN_ID: '101' }, service);
    assert.notEqual(calls.at(-1)!.operation, calls[0].operation);
    const before = calls.length;
    const beforeReads = reads;
    for (const change of [
      { action: 'edited', pull_request: raw },
      { action: 'opened', pull_request: { ...raw, state: 'closed' } },
      { action: 'opened', pull_request: { ...raw, head: { ...raw.head, repo: { full_name: 'other/fork' } } } },
      { action: 'opened', pull_request: { ...raw, head: { ...raw.head, ref: 'main' } } },
      { action: 'opened', pull_request: { ...raw, base: { ...raw.base, ref: 'other' } } },
    ]) {
      await writeFile(path, JSON.stringify({ repository: { full_name: config.repository }, ...change }));
      await assert.rejects(runPreviewWorkflow(env, service), /PREVIEW_UNTRUSTED_EVENT/);
    }
    assert.equal(reads, beforeReads); assert.equal(calls.length, before);
    await writeFile(path, JSON.stringify({ repository: { full_name: config.repository }, action: 'synchronize',
      pull_request: { ...raw, head: { ...raw.head, sha: 'b'.repeat(40) } } }));
    await assert.rejects(runPreviewWorkflow(env, service), /PREVIEW_PR_CHANGED/);
    assert.equal(calls.length, before);
    await assert.rejects(readFile('preview-result.json'), /ENOENT/);
  } finally { process.chdir(previous); await rm(dir, { recursive: true, force: true }); }
});

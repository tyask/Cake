import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreviewWorkflow, preparePreviewWorkflow, emitPreviewReceipt } from '../../scripts/preview/preview-workflow';
import { PreviewProvider } from '../../scripts/preview/preview-provider';
import { PreviewService } from '../../scripts/preview/preview-service';
import { config, protocol, source, type Source } from '../../scripts/preview/preview-model';
import { parseReceipt } from '../../scripts/preview/preview-receipt';

const rawPr = (number: number) => ({ number, state: 'closed', merged: true, created_at: '2026-10-17T00:00:00Z',
  head: { ref: `codex/push-${number}`, sha: number.toString(16).padStart(40, '0'), repo: { full_name: config.repository } },
  base: { ref: 'main', repo: { full_name: config.repository } } });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cake-push-cleanup-')), previous = process.cwd();
  const eventPath = join(directory, 'event.json');
  await writeFile(eventPath, JSON.stringify({ repository: { full_name: config.repository } }));
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CAKE_PREVIEW_PR: '81', VERCEL_TOKEN: 'fixture', NEON_API_KEY: 'fixture', GITHUB_REPOSITORY: config.repository,
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/preview.yml@refs/heads/main`,
    GITHUB_SHA: 'c'.repeat(40), GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_STEP_SUMMARY: join(directory, 'summary.md'), GITHUB_OUTPUT: join(directory, 'output.txt') };
  process.chdir(directory);
  return { directory, env, cleanup: async () => { process.chdir(previous); await rm(directory, { recursive: true, force: true }); } };
}

test('main push prepares every merged PR without credentials and each matrix job cleans only its bound PR', async t => {
  const f = await fixture(), pulls = [rawPr(81), rawPr(82)], calls: number[] = [];
  const service = new PreviewService(new PreviewProvider(async (provider, path, method = 'GET') => {
    assert.equal(provider, 'github'); assert.equal(method, 'GET');
    const raw = pulls.find(pr => path.endsWith(`/pulls/${pr.number}`)); assert.ok(raw); return raw;
  }));
  const sources = { workflowRunPullRequest: async () => assert.fail('not a workflow_run'), pushedPullRequests: async () => pulls };
  t.mock.method(service, 'cleanup', async (current: Source) => {
    calls.push(current.pr);
    return { protocol, action: 'cleanup', source: { ...current, token: 'private-do-not-log' },
      checkedAt: '2026-10-17T00:01:00Z', success: true, credentials: 'private-do-not-log' };
  });
  try {
    assert.deepEqual(await preparePreviewWorkflow({ ...f.env, VERCEL_TOKEN: '', NEON_API_KEY: '' },
      async () => assert.fail('fixture resolution needs no provider access'), sources), [81, 82]);
    assert.equal(await readFile(f.env.GITHUB_OUTPUT!, 'utf8'), 'targets=[81,82]\n');
    assert.deepEqual(calls, []);
    for (const raw of pulls) {
      await runPreviewWorkflow({ ...f.env, CAKE_PREVIEW_PR: String(raw.number) }, service, undefined, sources);
      const notices: string[] = []; await emitPreviewReceipt(undefined, line => notices.push(line));
      assert.equal(notices.length, 1);
      assert.ok(notices[0].startsWith(`::notice title=cake-preview/v1 PR ${raw.number}::`));
      const receipt = parseReceipt(notices[0].split('::').slice(2).join('::'));
      assert.deepEqual(receipt.source, source(raw)); assert.equal(receipt.operation, null);
      assert.equal(receipt.controlSha, f.env.GITHUB_SHA); assert.equal(receipt.runId, f.env.GITHUB_RUN_ID);
      assert.equal(receipt.runAttempt, 1);
    }
    assert.deepEqual(calls, [81, 82]);
    assert.ok(!(await readFile('preview-result.json', 'utf8')).includes('private-do-not-log'));
    assert.ok(!(await readFile(f.env.GITHUB_STEP_SUMMARY!, 'utf8')).includes('private-do-not-log'));
  } finally { await f.cleanup(); }
});

test('a failed matrix cleanup emits no success evidence for its target PR', async t => {
  const f = await fixture(), pulls = [rawPr(81), rawPr(82)], calls: number[] = [];
  const service = new PreviewService(new PreviewProvider(async (_provider, path) => pulls.find(pr => path.endsWith(`/pulls/${pr.number}`))));
  t.mock.method(service, 'cleanup', async (current: Source) => {
    calls.push(current.pr); throw new Error('private-provider-response');
  });
  try {
    await assert.rejects(runPreviewWorkflow(f.env, service, undefined, {
      workflowRunPullRequest: async () => assert.fail('not a workflow_run'), pushedPullRequests: async () => pulls,
    }), /private-provider-response/);
    assert.deepEqual(calls, [81]);
    const progress = JSON.parse(await readFile('preview-result.json', 'utf8'));
    assert.equal(progress.complete, false); assert.equal(progress.receipts.length, 0);
    const notices: string[] = [];
    await assert.rejects(emitPreviewReceipt(undefined, line => notices.push(line)), /CLEANUP_BATCH_INCOMPLETE/);
    assert.deepEqual(notices, []);
    const summary = await readFile(f.env.GITHUB_STEP_SUMMARY!, 'utf8');
    assert.match(summary, /未完了 \/ PR #81/); assert.ok(!summary.includes('private-provider-response'));
  } finally { await f.cleanup(); }
});

test('push rejects changed identity, arbitrary matrix targets and oversized discoveries before deletion', async t => {
  const f = await fixture(), raw = rawPr(81), expected = rawPr(81);
  raw.state = 'open';
  const service = new PreviewService(new PreviewProvider(async () => raw));
  let calls = 0;
  t.mock.method(service, 'cleanup', async () => { calls++; assert.fail('untrusted target must not clean'); });
  try {
    const sources = { workflowRunPullRequest: async () => undefined, pushedPullRequests: async () => [expected] };
    await assert.rejects(runPreviewWorkflow(f.env, service, undefined, sources), /PR_CHANGED/);
    const notices: string[] = [];
    await assert.rejects(emitPreviewReceipt(undefined, line => notices.push(line)), /CLEANUP_BATCH_INCOMPLETE/);
    await assert.rejects(runPreviewWorkflow({ ...f.env, CAKE_PREVIEW_PR: '82' }, service, undefined, sources), /PR_CHANGED/);
    for (const value of [undefined, '0', '081', '9007199254740992']) {
      await assert.rejects(runPreviewWorkflow({ ...f.env, CAKE_PREVIEW_PR: value }, service, undefined, sources), /MATRIX_TARGET_INVALID/);
    }
    const oversized = { ...sources, pushedPullRequests: async () => Array.from({ length: 11 }, (_, i) => rawPr(i + 1)) };
    await assert.rejects(preparePreviewWorkflow(f.env, service.provider.api, oversized), /CLEANUP_BATCH_TOO_LARGE/);
    await assert.rejects(runPreviewWorkflow(f.env, service, undefined, oversized), /CLEANUP_BATCH_TOO_LARGE/);
    assert.equal(calls, 0); assert.deepEqual(notices, []);
    await assert.rejects(readFile('preview-result.json'), /ENOENT/);
  } finally { await f.cleanup(); }
});

test('a direct main push prepares an empty matrix without provider credentials or provider work', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await preparePreviewWorkflow({ ...f.env, VERCEL_TOKEN: '', NEON_API_KEY: '' },
      async () => assert.fail('no provider work'), { workflowRunPullRequest: async () => undefined, pushedPullRequests: async () => [] }), []);
    assert.equal(await readFile(f.env.GITHUB_OUTPUT!, 'utf8'), 'targets=[]\n');
  } finally { await f.cleanup(); }
});

test('preparation derives a PR lock from resolved notifications, skips obsolete events, and preserves manual verify', async () => {
  const f = await fixture(), raw = rawPr(81), open = { ...raw, merged: false, state: 'open' };
  let selected: { source: Source; raw: Record<string, unknown> } | undefined = { source: source(open), raw: open };
  const sources = { workflowRunPullRequest: async () => selected, pushedPullRequests: async () => [raw] };
  const noProvider = async () => assert.fail('the source resolver is the only API consumer');
  try {
    const env = { ...f.env, GITHUB_EVENT_NAME: 'workflow_run', VERCEL_TOKEN: '', NEON_API_KEY: '' };
    assert.deepEqual(await preparePreviewWorkflow(env, noProvider, sources), [81]);
    selected = undefined;
    assert.deepEqual(await preparePreviewWorkflow(env, noProvider, sources), []);
    selected = { source: source(raw), raw };
    assert.deepEqual(await preparePreviewWorkflow(env, noProvider, sources), []);
    await writeFile(f.env.GITHUB_EVENT_PATH!, JSON.stringify({ repository: { full_name: config.repository }, inputs: {
      action: 'status', pr: '81', sha: raw.head.sha, operation: '20000000-0000-4000-8000-000000000002', controlSha: f.env.GITHUB_SHA,
    } }));
    assert.deepEqual(await preparePreviewWorkflow({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, noProvider, sources), [81]);
    await writeFile(f.env.GITHUB_EVENT_PATH!, JSON.stringify({ repository: { full_name: config.repository }, inputs: {
      action: 'verify', pr: '81', sha: raw.head.sha, operation: '20000000-0000-4000-8000-000000000002', controlSha: f.env.GITHUB_SHA,
    } }));
    assert.deepEqual(await preparePreviewWorkflow({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, noProvider, sources), []);
    await assert.rejects(preparePreviewWorkflow({ ...env, GITHUB_REF: 'refs/pull/81/merge' }, noProvider, sources), /UNTRUSTED_WORKFLOW/);
  } finally { await f.cleanup(); }
});

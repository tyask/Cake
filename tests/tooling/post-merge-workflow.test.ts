import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { config, type Source } from '../../scripts/preview/preview-model';
import { type Transport, PreviewProvider } from '../../scripts/preview/preview-provider';
import { PreviewService } from '../../scripts/preview/preview-service';
import { StagingProvider } from '../../scripts/preview/staging-service';
import { PostMergeChecks } from '../../scripts/task/post-merge-checks';
import { parseTaskMetadata, mergedTask, parsePostMergeResult, type PostMergeResult, type TaskMetadata } from '../../scripts/task/post-merge-model';
import { verifyPostMerge, publishPostMerge, postMergeComment, stalePostMergeResult, preparePostMerge, postMergeContext } from '../../scripts/task/post-merge-workflow';

const head = 'a'.repeat(40), merge = 'b'.repeat(40), control = 'c'.repeat(40);
const metadata: TaskMetadata = { issue: 9, intent: 'aidlc/spaces/default/intents/261027-example', completesIssue: true, manualPostMerge: false };
const marker = (value: unknown = metadata) => `<!-- cake-task/v1 ${JSON.stringify(value)} -->`;
const rawPr = (value: TaskMetadata = metadata) => ({ number: 71, state: 'closed', merged: true, merged_at: '2026-10-27T00:00:00Z',
  merge_commit_sha: merge, body: marker(value), created_at: '2026-10-26T00:00:00Z',
  head: { ref: 'codex/example', sha: head, repo: { id: config.repositoryId, full_name: config.repository } },
  base: { ref: 'main', repo: { id: config.repositoryId, full_name: config.repository } } });
const task = () => mergedTask(rawPr())!;
const result = (changes: Partial<PostMergeResult> = {}): PostMergeResult => ({ protocol: 'cake-post-merge/v1', task: task(),
  controlSha: control, runId: '101', runAttempt: 1, checkedAt: '2026-10-27T00:04:00.000Z', status: 'success',
  checks: { ci: { status: 'success', code: 'CI_VERIFIED', runId: 20 }, production: { status: 'success', code: 'PRODUCTION_VERIFIED', deploymentId: 'dpl_Production' },
    staging: { status: 'success', code: 'STAGING_VERIFIED', runId: 21 }, cleanup: { status: 'success', code: 'CLEANUP_VERIFIED', runId: 22 } }, ...changes });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cake-post-merge-'));
  const eventPath = join(directory, 'event.json');
  await writeFile(eventPath, JSON.stringify({ repository: { id: config.repositoryId, full_name: config.repository },
    inputs: { pr: '71' } }));
  const env = { GH_TOKEN: 'fixture-token', GITHUB_REPOSITORY: config.repository, GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/post-merge.yml@refs/heads/main`, GITHUB_SHA: control,
    GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1' };
  return { directory, eventPath, env, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('metadata binds one same-repository intent and rejects ambiguous or executable-looking input', () => {
  assert.deepEqual(parseTaskMetadata(`description\n${marker()}`), metadata);
  assert.equal(parseTaskMetadata('A legacy PR with no marker'), undefined);
  for (const value of [marker() + marker(), '<!-- cake-task/v1 {} -->', '<!-- cake-task/v1 broken -->',
    marker({ ...metadata, issue: '9' }), marker({ ...metadata, manualPostMerge: undefined }),
    marker({ ...metadata, intent: 'https://other.invalid/script' }), marker({ ...metadata, intent: '../outside' }),
    marker({ ...metadata, command: 'sh' }), marker().replace('"issue":9', '"issue":8,"issue":9')]) {
    assert.throws(() => parseTaskMetadata(value), /METADATA_INVALID/);
  }
  assert.equal(task().source.sha, head);
  assert.equal(task().mergeSha, merge);
  for (const value of [{ ...rawPr(), merged: false }, { ...rawPr(), merge_commit_sha: 'short' },
    { ...rawPr(), base: { ref: 'develop', repo: { id: config.repositoryId, full_name: config.repository } } }]) {
    assert.throws(() => mergedTask(value));
  }
});

test('the result schema cannot report success while one required check is missing or failed', () => {
  assert.equal(parsePostMergeResult(result()).status, 'success');
  const partial = result(); partial.checks.cleanup = { status: 'pending', code: 'RUN_PENDING' };
  assert.throws(() => parsePostMergeResult(partial), /RESULT_INVALID/);
  assert.throws(() => parsePostMergeResult({ ...result(), task: { ...task(), mergeSha: head.slice(1) } }), /RESULT_INVALID/);
});

test('workflow trust, fork identity and PR changes are checked before any provider access', async () => {
  const f = await fixture(); let calls = 0;
  const api: Transport = async () => { calls++; assert.fail('not authorized'); };
  try {
    for (const change of [{ GITHUB_REF: 'refs/heads/codex/example' }, { GITHUB_RUN_ATTEMPT: '0' }, { GH_TOKEN: '' },
      { GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/other.yml@refs/heads/main` }, { GITHUB_SHA: 'short' }]) {
      await assert.rejects(verifyPostMerge({ ...f.env, ...change }, { api, directory: f.directory }), /UNTRUSTED_WORKFLOW/);
    }
    await assert.rejects(verifyPostMerge({ ...f.env, GITHUB_EVENT_NAME: 'pull_request_target' }, { api, directory: f.directory }), /UNTRUSTED_EVENT/);
    assert.equal(calls, 0);
    const forkApi: Transport = async provider => {
      assert.equal(provider, 'github');
      return { ...rawPr(), head: { ...rawPr().head, repo: { id: 1, full_name: 'other/Cake' } } };
    };
    await assert.rejects(verifyPostMerge(f.env, { api: forkApi, directory: f.directory }), /PR_MISMATCH/);
  } finally { await f.cleanup(); }
});

test('legacy merged PRs without task metadata do not create reports or touch providers', async () => {
  const f = await fixture();
  try {
    const api: Transport = async provider => {
      assert.equal(provider, 'github', 'legacy tasks must not fetch providers');
      return { ...rawPr(), body: 'legacy' };
    };
    assert.equal(await verifyPostMerge(f.env, { api, directory: f.directory }), undefined);
    assert.deepEqual(await preparePostMerge(f.env, api), []);
  } finally { await f.cleanup(); }
});

test('main push discovers separate PR and Issue matrix targets and binds each matrix to that push', async () => {
  const f = await fixture(), before = 'f'.repeat(40), earlierMerge = 'd'.repeat(40);
  const older = { ...rawPr({ ...metadata, issue: 8, completesIssue: false }), number: 72,
    merge_commit_sha: earlierMerge, head: { ...rawPr().head, ref: 'codex/earlier', sha: 'e'.repeat(40) } };
  const legacy = { ...rawPr(), number: 73, body: 'legacy', head: { ...rawPr().head, ref: 'codex/legacy' } };
  const prs = [older, legacy, rawPr()];
  const env = { ...f.env, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: merge };
  const api: Transport = async (provider, path, method = 'GET') => {
    assert.equal(provider, 'github', 'discovery never accesses providers'); assert.equal(method, 'GET');
    if (path.includes(`/compare/${before}...${merge}?`)) return { status: 'ahead', behind_by: 0, ahead_by: 2, total_commits: 2,
      base_commit: { sha: before }, merge_base_commit: { sha: before }, commits: [{ sha: earlierMerge }, { sha: merge }] };
    if (path.includes('/commits/') && path.includes('/pulls?')) return prs;
    const matched = prs.find(pr => path.endsWith(`/pulls/${pr.number}`));
    if (matched) return matched;
    assert.fail(path);
  };
  try {
    await writeFile(f.eventPath, JSON.stringify({ repository: { id: config.repositoryId, full_name: config.repository },
      ref: 'refs/heads/main', before, after: merge, forced: false, created: false, deleted: false }));
    const output = join(f.directory, 'output');
    assert.deepEqual(await preparePostMerge({ ...env, GITHUB_OUTPUT: output }, api), [{ pr: 72, issue: 8 }, { pr: 71, issue: 9 }]);
    assert.equal(await readFile(output, 'utf8'), 'targets=[{"pr":72,"issue":8},{"pr":71,"issue":9}]\n');
    const context = await postMergeContext({ ...env, CAKE_POST_MERGE_PR: '71' }, api);
    assert.equal(context.eventTask!.mergeSha, merge); assert.equal(context.controlSha, merge);
    const previous = await postMergeContext({ ...env, CAKE_POST_MERGE_PR: '72' }, api);
    assert.equal(previous.eventTask!.mergeSha, earlierMerge, 'each PR preserves its own actual merge SHA');
    for (const selected of [undefined, '73', '999', '01']) {
      await assert.rejects(postMergeContext({ ...env, CAKE_POST_MERGE_PR: selected }, api), /INVALID_PR/);
    }
    for (let i = 0; i < 8; i++) prs.push({ ...rawPr(), number: 100 + i,
      head: { ...rawPr().head, ref: `codex/bulk-${i}` } });
    await assert.rejects(preparePostMerge(env, api), /TASKS_INVALID/, 'an oversized push cannot partially start provider verification');
    await writeFile(f.eventPath, JSON.stringify({ repository: { id: config.repositoryId, full_name: config.repository },
      ref: 'refs/heads/main', before, after: merge, forced: true, created: false, deleted: false }));
    await assert.rejects(preparePostMerge(env, api), /UNTRUSTED_PUSH/);
  } finally { await f.cleanup(); }
});

test('publication cannot consume the artifact for another matrix PR', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const report = result(); report.task.source.pr = 72;
    await writeFile(join(f.directory, 'post-merge-result.json'), JSON.stringify(report));
    const api: Transport = async () => { calls++; assert.fail('mismatched result must not access the Issue'); };
    await assert.rejects(publishPostMerge({ ...f.env, CAKE_POST_MERGE_PR: '71' }, api, f.directory), /RESULT_MISMATCH/);
    assert.equal(calls, 0);
    await assert.rejects(publishPostMerge({ ...f.env, CAKE_POST_MERGE_PR: '72' }, api, f.directory), /INVALID_PR/);
  } finally { await f.cleanup(); }
});

test('a main-push matrix verifies its PR and publishes the same run result before completing the Issue', async t => {
  const f = await fixture(), before = 'f'.repeat(40), writes: { path: string; body: unknown }[] = [];
  const env = { ...f.env, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: merge, CAKE_POST_MERGE_PR: '71' };
  const api: Transport = async (provider, path, method = 'GET', body) => {
    assert.equal(provider, 'github');
    if (method !== 'GET') { writes.push({ path, body }); return {}; }
    if (path.includes(`/compare/${before}...${merge}?`)) return { status: 'ahead', behind_by: 0, ahead_by: 1, total_commits: 1,
      base_commit: { sha: before }, merge_base_commit: { sha: before }, commits: [{ sha: merge }] };
    if (path.includes('/commits/') && path.includes('/pulls?')) return [rawPr()];
    if (path.endsWith('/pulls/71')) return rawPr();
    if (path.endsWith('/issues/9')) return { number: 9, state: 'open' };
    if (path.includes('/issues/9/comments?')) return [];
    if (path.endsWith('/branches/main')) return { name: 'main', commit: { sha: merge } };
    if (path.includes('/pulls?state=all')) return [rawPr()];
    assert.fail(path);
  };
  const checks = new PostMergeChecks(api);
  t.mock.method(checks, 'assertBindings', async () => {});
  t.mock.method(checks, 'mainSha', async () => merge);
  t.mock.method(checks, 'all', async () => result().checks);
  try {
    await writeFile(f.eventPath, JSON.stringify({ repository: { id: config.repositoryId, full_name: config.repository },
      ref: 'refs/heads/main', before, after: merge, forced: false, created: false, deleted: false }));
    const verified = await verifyPostMerge(env, { api, checks, directory: f.directory });
    assert.equal(verified!.status, 'success'); assert.equal(verified!.controlSha, merge);
    assert.equal(writes.length, 0, 'read-side verification must not change the Issue');
    await publishPostMerge(env, api, f.directory);
    const comment = writes.find(write => write.path.endsWith('/comments'))!.body as { body: string };
    assert.ok(comment.body.includes(`"controlSha":"${merge}"`));
    assert.ok(comment.body.includes('"pr":71'));
    assert.deepEqual(writes.find(write => write.path.endsWith('/issues/9'))!.body, { state: 'closed', state_reason: 'completed' });
  } finally { await f.cleanup(); }
});

test('verification waits for four checks, preserves failure, and never accepts a newer main SHA', async t => {
  const f = await fixture();
  const api: Transport = async (provider, path, method = 'GET') => {
    assert.equal(provider, 'github'); assert.equal(method, 'GET');
    if (path.endsWith('/pulls/71')) return rawPr();
    if (path.endsWith('/issues/9')) return { number: 9, state: 'open' };
    assert.fail(path);
  };
  let clock = Date.parse('2026-10-27T00:04:00Z'), polls = 0, actualMain = merge;
  const checks = new PostMergeChecks(api);
  t.mock.method(checks, 'assertBindings', async () => {});
  t.mock.method(checks, 'mainSha', async () => actualMain);
  t.mock.method(checks, 'all', async () => {
    polls++; const values = result().checks;
    if (polls === 1) values.cleanup = { status: 'pending', code: 'RUN_PENDING' };
    return values;
  });
  try {
    const verified = await verifyPostMerge(f.env, { api, checks, directory: f.directory, now: () => clock,
      wait: async ms => { clock += ms; }, maxWaitMs: 60_000 });
    assert.equal(verified!.status, 'success'); assert.equal(polls, 2);
    assert.equal(parsePostMergeResult(JSON.parse(await readFile(join(f.directory, 'post-merge-result.json'), 'utf8'))).task.mergeSha, merge);
    actualMain = 'd'.repeat(40);
    assert.equal((await verifyPostMerge(f.env, { api, checks, directory: f.directory }))!.status, 'superseded');
    actualMain = merge;
    t.mock.method(checks, 'all', async () => ({ ...result().checks, cleanup: { status: 'pending', code: 'RUN_PENDING' } }));
    assert.equal((await verifyPostMerge(f.env, { api, checks, directory: f.directory, maxWaitMs: 0 }))!.status, 'timeout');
    t.mock.method(checks, 'all', async () => { throw new Error('provider-secret-must-not-be-published'); });
    assert.equal((await verifyPostMerge(f.env, { api, checks, directory: f.directory }))!.status, 'failed');
    assert.ok(!(await readFile(join(f.directory, 'post-merge-result.json'), 'utf8')).includes('provider-secret'));
  } finally { await f.cleanup(); }
});

test('production proof requires the exact main deployment and every reported alias', async () => {
  let actualSha = merge, aliasId = 'dpl_Production', readyState = 'READY';
  const api: Transport = async (provider, path, method = 'GET') => {
    assert.equal(provider, 'vercel'); assert.equal(method, 'GET');
    if (path.startsWith('/v9/projects/')) return { id: config.vercelProjectId, accountId: config.vercelTeamId,
      link: { repoId: config.repositoryId }, targets: { production: { id: 'dpl_Production', alias: ['cake.example.test'] } } };
    if (path === '/v13/deployments/dpl_Production') return { id: 'dpl_Production', projectId: config.vercelProjectId,
      ownerId: config.vercelTeamId, target: 'production', readyState, aliasAssigned: true, alias: ['cake.example.test'],
      gitSource: { type: 'github', repoId: config.repositoryId, ref: 'main', sha: actualSha },
      meta: { githubCommitOrg: 'tyask', githubCommitRepo: 'Cake', githubCommitRef: 'main', githubCommitSha: actualSha, githubRepoId: String(config.repositoryId) } };
    if (path === '/v4/aliases/cake.example.test') return { projectId: config.vercelProjectId, deploymentId: aliasId };
    assert.fail(path);
  };
  const checks = new PostMergeChecks(api);
  assert.equal((await checks.production(task())).status, 'success');
  aliasId = 'dpl_Other'; assert.equal((await checks.production(task())).code, 'PRODUCTION_ALIAS_PENDING');
  aliasId = 'dpl_Production'; actualSha = head; assert.equal((await checks.production(task())).code, 'PRODUCTION_SHA_PENDING');
  actualSha = merge; readyState = 'ERROR'; assert.equal((await checks.production(task())).status, 'failure');
});

function workflowFixture(file: string, id: number, overrides: Record<string, unknown> = {}) {
  return { id, run_attempt: 1, workflow_id: file === 'ci.yml' ? 10 : file === 'staging.yml' ? 11 : 12,
    check_suite_id: id + 100, path: `.github/workflows/${file}`, head_branch: 'main', head_sha: merge,
    repository: { id: config.repositoryId, full_name: config.repository }, head_repository: { id: config.repositoryId, full_name: config.repository },
    url: `https://api.github.com/repos/${config.repository}/actions/runs/${id}`, created_at: '2026-10-27T00:01:00Z',
    updated_at: '2026-10-27T00:04:00Z', status: 'completed', conclusion: 'success', event: 'push', ...overrides };
}

test('CI checks the latest main-push run for the merge SHA, not the successful PR head', async () => {
  let badLatest = false;
  const latest = () => workflowFixture('ci.yml', 21, { conclusion: badLatest ? 'failure' : 'success' });
  const api: Transport = async (provider, path) => {
    assert.equal(provider, 'github');
    if (path.endsWith('/actions/workflows/ci.yml')) return { id: 10, path: '.github/workflows/ci.yml', state: 'active' };
    if (path.includes('/actions/workflows/ci.yml/runs?')) return { total_count: 3, workflow_runs: [latest(), workflowFixture('ci.yml', 20), workflowFixture('ci.yml', 22, { head_sha: head, event: 'pull_request' })] };
    if (path.endsWith('/actions/runs/21')) return latest();
    assert.fail(path);
  };
  const checks = new PostMergeChecks(api);
  assert.equal((await checks.ci(task())).runId, 21);
  badLatest = true; assert.equal((await checks.ci(task())).status, 'failure');
});

test('cleanup consumes a trusted official receipt and rechecks source absence', async t => {
  let retained = false, wrongHead = false, wrongTitle = false, wrongControl = false;
  const operation = '20000000-0000-4000-8000-000000000002';
  const run: Record<string, unknown> = workflowFixture('preview.yml', 22, { display_title: `Preview cleanup main ${merge} 22` });
  const getPrefix = `/repos/${config.repository}/`;
  const api: Transport = async (provider, path) => {
    const jobName = run.event === 'push' ? 'preview-cleanup-71' : 'preview';
    assert.equal(provider, 'github');
    if (path === getPrefix + 'actions/workflows/preview.yml') return { id: 12, path: '.github/workflows/preview.yml', state: 'active' };
    if (path.startsWith(getPrefix + 'actions/workflows/preview.yml/runs?')) return { total_count: 1, workflow_runs: [run] };
    if (path === getPrefix + 'actions/runs/22') return run;
    if (path.includes('/attempts/1/jobs?')) return { total_count: 1, jobs: [{ id: 80, name: jobName, run_id: 22, run_attempt: 1,
      head_branch: run.head_branch, head_sha: run.head_sha, status: 'completed', conclusion: 'success',
      check_run_url: `https://api.github.com/repos/${config.repository}/check-runs/80` }] };
    if (path === getPrefix + 'check-runs/80') return { id: 80, name: jobName, head_sha: run.head_sha,
      url: `https://api.github.com/repos/${config.repository}/check-runs/80`, check_suite: { id: 122 },
      app: { slug: 'github-actions', html_url: 'https://github.com/apps/github-actions' }, status: 'completed', conclusion: 'success', output: { annotations_count: 1 } };
    if (path.includes('/check-runs/80/annotations?')) return [{ title: wrongTitle ? 'cake-preview/v1 PR 72'
      : run.event === 'push' ? 'cake-preview/v1 PR 71' : 'cake-preview-receipt/v1', annotation_level: 'notice', message: JSON.stringify({
      protocol: 'cake-preview/v1', action: 'cleanup', source: { ...task().source, sha: wrongHead ? merge : head }, checkedAt: '2026-10-27T00:03:00Z',
      success: true, operation: run.event === 'push' ? null : operation, runId: '22', runAttempt: 1, controlSha: wrongControl ? control : merge }) }];
    assert.fail(path);
  };
  t.mock.method(PreviewService.prototype, 'status', async function (source: Source) {
    assert.equal(source.sha, head);
    return { protocol: 'cake-preview/v1', action: 'status', source, checkedAt: '2026-10-27T00:04:00Z', success: true,
      ...(retained ? { database: { branchId: 'br-retained', endpointId: 'ep-retained', hostDigest: 'd'.repeat(64) } } : {}) };
  });
  t.mock.method(PreviewProvider.prototype, 'deployments', async () => []);
  assert.ok(new PreviewProvider(api));
  const checks = new PostMergeChecks(api);
  assert.equal((await checks.cleanup(task())).status, 'success');
  retained = true; await assert.rejects(checks.cleanup(task()), /RESOURCES_REMAIN/);
  retained = false; wrongHead = true; await assert.rejects(checks.cleanup(task()), /RECEIPT_INVALID/);
  wrongHead = false; wrongTitle = true; await assert.rejects(checks.cleanup(task()), /RECEIPT_INVALID/);
  wrongTitle = false; wrongControl = true; await assert.rejects(checks.cleanup(task()), /CLEANUP_RECEIPT_INVALID/);
  wrongControl = false; run.event = 'pull_request_target';
  assert.equal((await checks.cleanup(task())).code, 'RUN_NOT_CREATED', 'legacy PR-event evidence cannot satisfy the new main-push cleanup');
  run.event = 'workflow_dispatch'; run.display_title = `Preview cleanup PR 71 ${operation}`;
  assert.equal((await checks.cleanup(task())).status, 'success', 'explicit trusted-main recovery remains supported');
});

test('staging binds its official browser receipt to the merge SHA and current alias', async t => {
  const run = workflowFixture('staging.yml', 21), prefix = `/repos/${config.repository}/`;
  const source: Source = { pr: 0, branch: 'cake-main-preview', sha: merge, state: 'open', createdAt: '2026-07-31T09:23:31Z' };
  const database = { branchId: 'br-stage', endpointId: 'ep-stage', hostDigest: 'd'.repeat(64) };
  const deployment = { id: 'dpl_Stage', url: 'https://cake-stage.vercel.app', sha: merge, branch: source.branch, pr: 0,
    generation: '20000000-0000-4000-8000-000000000002', operation: '20000000-0000-4000-8000-000000000003',
    phase: 'application' as const, state: 'READY', createdAt: Date.parse('2026-10-27T00:01:00Z'), database };
  let currentAlias = 'dpl_Stage', completeBrowser = true, duplicateNotice = false;
  const receipt = () => ({ protocol: 'cake-staging/v1', action: 'deploy', source, database, deployment,
    checkedAt: '2026-10-27T00:03:00Z', success: true, controlSha: merge, runId: '21', runAttempt: 1,
    alias: 'https://cake-main-preview-fumin1.vercel.app', browser: {
      verifiedAt: '2026-10-27T00:02:30Z', cases: ['desktop-a', 'desktop-b', 'mobile-a', 'mobile-b', 'read-api'],
      clicks: Array.from({ length: completeBrowser ? 16 : 15 }, (_, i) => [Math.floor(i / 4), i % 4, '2026-10-27T00:02:00Z']),
      checks: Array.from({ length: 12 }, (_, i) => [Math.floor(i / 3), i % 3, '2026-10-27T00:02:00Z']) } });
  const api: Transport = async (provider, path, method = 'GET') => {
    assert.equal(method, 'GET');
    if (provider === 'vercel' && path.startsWith('/v4/aliases/')) return { projectId: config.vercelProjectId, deploymentId: currentAlias };
    assert.equal(provider, 'github');
    if (path === prefix + 'actions/workflows/staging.yml') return { id: 11, path: '.github/workflows/staging.yml', state: 'active' };
    if (path.startsWith(prefix + 'actions/workflows/staging.yml/runs?')) return { total_count: 1, workflow_runs: [run] };
    if (path === prefix + 'actions/runs/21') return run;
    if (path.includes('/attempts/1/jobs?')) return { total_count: 1, jobs: [{ id: 81, name: 'staging', run_id: 21, run_attempt: 1,
      head_sha: merge, head_branch: 'main', status: 'completed', conclusion: 'success',
      check_run_url: `https://api.github.com/repos/${config.repository}/check-runs/81` }] };
    if (path === prefix + 'check-runs/81') return { id: 81, name: 'staging', head_sha: merge, check_suite: { id: 121 },
      url: `https://api.github.com/repos/${config.repository}/check-runs/81`, app: { slug: 'github-actions', html_url: 'https://github.com/apps/github-actions' },
      status: 'completed', conclusion: 'success', output: { annotations_count: duplicateNotice ? 2 : 1 } };
    if (path.includes('/check-runs/81/annotations?')) {
      const notice = { title: 'cake-staging/v1', annotation_level: 'notice', message: JSON.stringify(receipt()) };
      return duplicateNotice ? [notice, notice] : [notice];
    }
    assert.fail(path);
  };
  t.mock.method(StagingProvider.prototype, 'main', async () => source);
  t.mock.method(PreviewService.prototype, 'status', async () => ({ protocol: 'cake-preview/v1', action: 'status', source,
    deployment, database, checkedAt: '2026-10-27T00:04:00Z', success: true }));
  const checks = new PostMergeChecks(api);
  assert.equal((await checks.staging(task())).status, 'success');
  currentAlias = 'dpl_Other'; await assert.rejects(checks.staging(task()), /ALIAS_CHANGED/);
  currentAlias = 'dpl_Stage'; completeBrowser = false; await assert.rejects(checks.staging(task()), /RECEIPT_INVALID/);
  completeBrowser = true; duplicateNotice = true; await assert.rejects(checks.staging(task()), /RECEIPT_INVALID/);
});

test('Issue reporting is repeatable, preserves its body, and closes only final fully automated work', async () => {
  const f = await fixture(), writes: { path: string; body: unknown }[] = [];
  let currentMetadata = metadata, report = result(), comments: Record<string, unknown>[] = [], open: unknown[] = [];
  let issueState = 'open';
  const api: Transport = async (provider, path, method = 'GET', body) => {
    assert.equal(provider, 'github');
    if (method !== 'GET') {
      writes.push({ path, body });
      if (method === 'POST') comments = [{ id: 111, body: (body as { body: string }).body, user: { login: 'github-actions[bot]', type: 'Bot' } }];
      if (path.endsWith('/issues/9')) issueState = 'closed';
      if (path.endsWith('/issues/comments/111')) comments[0].body = (body as { body: string }).body;
      return {};
    }
    if (path.endsWith('/pulls/71')) return rawPr(currentMetadata);
    if (path.endsWith('/issues/9')) return { number: 9, state: issueState, body: 'human-authored issue body' };
    if (path.includes('/issues/9/comments?')) return comments;
    if (path.endsWith('/issues/comments/111')) return comments[0];
    if (path.includes('/pulls?')) return open;
    if (path.endsWith('/branches/main')) return { name: 'main', commit: { sha: merge } };
    assert.fail(path);
  };
  const save = () => writeFile(join(f.directory, 'post-merge-result.json'), JSON.stringify(report));
  try {
    await save(); await publishPostMerge(f.env, api, f.directory);
    assert.equal(writes.filter(w => w.path.endsWith('/issues/9')).length, 1);
    assert.equal(writes.filter(w => w.path.endsWith('/comments')).length, 1);
    await publishPostMerge(f.env, api, f.directory);
    assert.equal(writes.length, 2, 'same run must neither duplicate comments nor repeatedly close');
    for (const change of [{ completesIssue: false }, { manualPostMerge: true }]) {
      currentMetadata = { ...metadata, ...change }; report = result({ task: mergedTask(rawPr(currentMetadata))! });
      comments = []; writes.length = 0; issueState = 'open'; await save(); await publishPostMerge(f.env, api, f.directory);
      assert.equal(issueState, 'open');
    }
    currentMetadata = metadata; report = result(); comments = []; writes.length = 0; issueState = 'open';
    open = [{ body: marker() }]; await save(); await publishPostMerge(f.env, api, f.directory); assert.equal(issueState, 'open');
    open = [{ number: 99, state: 'closed', merged: false, body: '<!-- cake-task/v1 broken -->' }];
    comments = []; issueState = 'open'; await save(); await publishPostMerge(f.env, api, f.directory);
    assert.equal(issueState, 'closed', 'unrelated malformed closed PRs must not block this Issue');
    open = []; comments = []; issueState = 'open'; report = result({ status: 'failed', checks: { ...result().checks, cleanup: { status: 'failure', code: 'CLEANUP_FAILED' } } });
    await save(); await publishPostMerge(f.env, api, f.directory); assert.equal(issueState, 'open');
    assert.ok(!writes.some(w => (w.body as Record<string, unknown>).body === 'human-authored issue body'));
  } finally { await f.cleanup(); }
});

test('the comment writer applies the same history limit as its reader', () => {
  const history = Array.from({ length: 51 }, (_, index) => {
    const entry = result();
    entry.task.source.pr = index + 1;
    return entry;
  });
  assert.throws(() => postMergeComment(result(), false, history), /COMMENT_TOO_LARGE/);
});

test('stale ordering compares generations within one PR and never treats PR numbers as merge order', () => {
  const previous = JSON.parse(postMergeComment(result({ runId: '102', runAttempt: 2 }), false).split(' -->')[0].split('cake-post-merge/v1 ')[1]);
  assert.equal(stalePostMergeResult(previous, result()), true);
  assert.equal(stalePostMergeResult(previous, result({ runId: '102', runAttempt: 3 })), false);
  assert.equal(stalePostMergeResult({ ...previous, mergedAt: '2026-10-28T00:00:00Z', pr: 72 }, result({ runId: '999' })), false);
});

test('a final PR cannot close an Issue while an earlier merged PR is manual, failed, or unconfirmed', async () => {
  for (const earlier of ['manual', 'failed', 'unknown', 'legacy'] as const) {
    const f = await fixture();
    const oldMetadata = { ...metadata, completesIssue: false, manualPostMerge: earlier === 'manual' };
    const oldPr = { ...rawPr(oldMetadata), number: 72, merge_commit_sha: 'd'.repeat(40),
      head: { ...rawPr().head, ref: 'codex/earlier', sha: 'e'.repeat(40) } };
    const oldTask = mergedTask(oldPr)!, currentPr = rawPr();
    let main = oldTask.mergeSha, issueState = 'open', comments: Record<string, unknown>[] = [];
    const api: Transport = async (provider, path, method = 'GET', body) => {
      assert.equal(provider, 'github');
      if (method !== 'GET') {
        if (path.endsWith('/issues/9')) issueState = 'closed';
        else comments = [{ id: 111, body: (body as { body: string }).body, user: { login: 'github-actions[bot]', type: 'Bot' } }];
        return {};
      }
      if (path.endsWith('/pulls/71')) return currentPr;
      if (path.endsWith('/pulls/72')) return oldPr;
      if (path.endsWith('/issues/9')) return { number: 9, state: issueState };
      if (path.includes('/issues/9/comments?')) return comments;
      if (path.endsWith('/issues/comments/111')) return comments[0];
      if (path.includes('/pulls?state=all')) return [oldPr, currentPr];
      if (path.endsWith('/branches/main')) return { name: 'main', commit: { sha: main } };
      assert.fail(path);
    };
    const publish = async (pr: number, runId: string, report: PostMergeResult) => {
      await writeFile(f.eventPath, JSON.stringify({ repository: { id: config.repositoryId, full_name: config.repository }, inputs: { pr: String(pr) } }));
      await writeFile(join(f.directory, 'post-merge-result.json'), JSON.stringify(report));
      await publishPostMerge({ ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: runId }, api, f.directory);
    };
    try {
      if (earlier === 'manual' || earlier === 'failed') {
        const saved = result({ task: oldTask, runId: '101', status: earlier === 'failed' ? 'failed' : 'success',
          checks: earlier === 'failed' ? { ...result().checks, cleanup: { status: 'failure', code: 'CLEANUP_FAILED' } } : result().checks });
        await publish(72, '101', saved);
      } else if (earlier === 'legacy') {
        const legacy = { pr: 72, mergeSha: oldTask.mergeSha, mergedAt: oldTask.mergedAt, runId: '101', runAttempt: 1, status: 'success' };
        comments = [{ id: 111, body: `<!-- cake-post-merge/v1 ${JSON.stringify(legacy)} -->\nlegacy successful result`, user: { login: 'github-actions[bot]', type: 'Bot' } }];
      }
      main = merge;
      await publish(71, '102', result({ runId: '102' }));
      assert.equal(issueState, 'open', earlier);
      const saved = JSON.parse(String(comments[0].body).split(' -->')[0].split('cake-post-merge/v1 ')[1]);
      assert.equal(saved.pr, 71, 'same-second lower-number final PR is the current main representative');
      assert.equal(saved.history.find((entry: PostMergeResult) => entry.task.source.pr === 71).status, 'success');
      if (earlier === 'manual' || earlier === 'failed') {
        assert.ok(saved.history.some((entry: PostMergeResult) => entry.task.source.pr === 72));
        const previousBody = comments[0].body;
        await publish(72, '103', result({ task: oldTask, runId: '103', status: 'timeout' }));
        const updated = JSON.parse(String(comments[0].body).split(' -->')[0].split('cake-post-merge/v1 ')[1]);
        assert.equal(updated.pr, 71, 'an older PR retry must not replace the current main representative');
        assert.equal(updated.history.find((entry: PostMergeResult) => entry.task.source.pr === 72).runId, '103');
        assert.equal(updated.history.find((entry: PostMergeResult) => entry.task.source.pr === 71).runId, '102');
        assert.notEqual(comments[0].body, previousBody);
        const newerBody = comments[0].body;
        await publish(72, '101', result({ task: oldTask, runId: '101' }));
        assert.equal(comments[0].body, newerBody, 'old retries must not overwrite another PR or a newer own result');
      }
    } finally { await f.cleanup(); }
  }
});

test('a successful retry replaces only its PR history and permits a later final PR to close', async () => {
  const f = await fixture();
  const olderMetadata = { ...metadata, completesIssue: false }, oldPr = { ...rawPr(olderMetadata), number: 72,
    merge_commit_sha: 'd'.repeat(40), head: { ...rawPr().head, ref: 'codex/earlier', sha: 'e'.repeat(40) } };
  const oldTask = mergedTask(oldPr)!;
  let main = oldTask.mergeSha, finalMerged = false, comments: Record<string, unknown>[] = [], issueState = 'open';
  const api: Transport = async (_provider, path, method = 'GET', body) => {
    if (method !== 'GET') {
      if (path.endsWith('/issues/9')) issueState = 'closed';
      else comments = [{ id: 111, body: (body as { body: string }).body, user: { login: 'github-actions[bot]', type: 'Bot' } }];
      return {};
    }
    if (path.endsWith('/pulls/71')) return rawPr();
    if (path.endsWith('/pulls/72')) return oldPr;
    if (path.endsWith('/issues/9')) return { number: 9, state: issueState };
    if (path.includes('/issues/9/comments?')) return comments;
    if (path.endsWith('/issues/comments/111')) return comments[0];
    if (path.includes('/pulls?state=all')) return finalMerged ? [oldPr, rawPr()] : [oldPr];
    if (path.endsWith('/branches/main')) return { name: 'main', commit: { sha: main } };
    assert.fail(path);
  };
  const publish = async (pr: number, runId: string, report: PostMergeResult) => {
    await writeFile(f.eventPath, JSON.stringify({ repository: { id: config.repositoryId, full_name: config.repository }, inputs: { pr: String(pr) } }));
    await writeFile(join(f.directory, 'post-merge-result.json'), JSON.stringify(report));
    await publishPostMerge({ ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: runId }, api, f.directory);
  };
  try {
    await publish(72, '101', result({ task: oldTask, runId: '101', status: 'failed',
      checks: { ...result().checks, cleanup: { status: 'failure', code: 'CLEANUP_FAILED' } } }));
    await publish(72, '102', result({ task: oldTask, runId: '102' }));
    assert.equal(issueState, 'open', 'a recovered split PR is not the final PR');
    main = merge; finalMerged = true;
    await publish(71, '103', result({ runId: '103' }));
    assert.equal(issueState, 'closed');
    const saved = JSON.parse(String(comments[0].body).split(' -->')[0].split('cake-post-merge/v1 ')[1]);
    assert.equal(saved.history.length, 2);
    assert.equal(saved.history.find((entry: PostMergeResult) => entry.task.source.pr === 72).runId, '102');
  } finally { await f.cleanup(); }
});

test('workflow splits provider reads from Issue writes and never checks out PR input', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/post-merge.yml', import.meta.url), 'utf8');
  assert.match(workflow, /push:\n    branches: \[main\]/);
  assert.ok(!workflow.includes('pull_request_target'));
  assert.match(workflow, /environment: cake-automation/);
  assert.match(workflow, /if: always\(\) && needs\.prepare\.result == 'success'/);
  assert.match(workflow, /group: cake-post-merge-issue-/);
  assert.match(workflow, /name: post-merge-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}-\$\{\{ matrix.target.pr \}\}/);
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(publish, /max-parallel: 1/);
  assert.match(publish, /issues: write/); assert.ok(!publish.includes('VERCEL_TOKEN')); assert.ok(!publish.includes('NEON_API_KEY'));
  assert.ok(!workflow.includes('ref: ${{ github.event.pull_request.head')); assert.ok(!workflow.includes('contents: write'));
});

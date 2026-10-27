import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../scripts/preview/preview-model';
import { type Transport } from '../../scripts/preview/preview-provider';
import { pushedPullRequests, workflowRunPullRequest } from '../../scripts/preview/pr-event';

type Json = Record<string, unknown>;
const head = 'a'.repeat(40), before = 'b'.repeat(40), merge = 'c'.repeat(40), control = 'd'.repeat(40);
const repo = { id: config.repositoryId, full_name: config.repository };
const prefix = `/repos/${config.repository}/`;
const workflow = { id: 120, name: 'Cake PR Events', path: '.github/workflows/pr-events.yml', state: 'active' };
const pr = (changes: Json = {}): Json => ({ number: 71, state: 'open', merged: false, created_at: '2026-10-26T00:00:00Z',
  head: { ref: 'codex/example', sha: head, repo }, base: { ref: 'main', repo }, ...changes });
const run = (changes: Json = {}): Json => ({ id: 500, workflow_id: workflow.id, name: workflow.name, path: workflow.path,
  run_attempt: 1, event: 'pull_request', status: 'completed', conclusion: 'success', repository: repo, head_repository: repo,
  head_branch: 'codex/example', head_sha: head, created_at: '2026-10-27T00:00:00Z', updated_at: '2026-10-27T00:00:04Z',
  url: `https://api.github.com${prefix}actions/runs/500`, pull_requests: [], ...changes });

function notification() {
  const state = { announced: run(), fresh: run(), workflow: { ...workflow }, prs: [pr()], listed: [run()], listTotal: 1 };
  const calls: string[] = [];
  const env = { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: config.repository, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: control };
  const event = () => ({ action: 'completed', repository: repo, workflow_run: state.announced });
  const api: Transport = async (provider, path, method = 'GET') => {
    assert.equal(provider, 'github'); assert.equal(method, 'GET'); calls.push(path);
    if (path === `${prefix}actions/workflows/pr-events.yml`) return state.workflow;
    if (path === `${prefix}actions/runs/500`) return state.fresh;
    if (path.startsWith(`${prefix}pulls?`)) return state.prs;
    if (path.startsWith(`${prefix}pulls/`)) return state.prs.find(value => String(value.number) === path.split('/').at(-1));
    if (path.startsWith(`${prefix}actions/workflows/pr-events.yml/runs?`)) return { total_count: state.listTotal, workflow_runs: state.listed };
    return assert.fail(path);
  };
  return { state, calls, env, event, api };
}

test('PR notification resolves one current same-repository PR without downloading PR programs or artifacts', async () => {
  const f = notification();
  const result = await workflowRunPullRequest(f.env, f.event(), f.api);
  assert.equal(result!.source.pr, 71);
  assert.equal(result!.source.sha, head);
  assert.equal(result!.raw, f.state.prs[0]);
  assert.ok(f.calls.some(path => path.includes('head=tyask%3Acodex%2Fexample')));
  assert.equal(f.calls.filter(path => path.endsWith('/actions/runs/500')).length, 2);
  assert.ok(f.calls.every(path => !/artifacts|contents|download/.test(path)));
});

test('forks and unrelated branches are ignored before any GitHub or provider operation', async () => {
  const f = notification();
  for (const changes of [{ head_repository: { id: 1, full_name: 'other/Cake' } }, { head_branch: 'feature/example' }]) {
    f.state.announced = run(changes);
    assert.equal(await workflowRunPullRequest(f.env, f.event(), f.api), undefined);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(workflowRunPullRequest({ ...f.env, GITHUB_REF: 'refs/pull/71/merge' }, f.event(), f.api), /UNTRUSTED_CONTEXT/);
  await assert.rejects(workflowRunPullRequest(f.env, { ...f.event(), repository: { id: 1, full_name: config.repository } }, f.api), /UNTRUSTED_CONTEXT/);
});

test('notification cannot impersonate another workflow, change its generation, or report an unfinished run', async () => {
  for (const changes of [{ workflow_id: 121 }, { path: '.github/workflows/ci.yml' }, { event: 'workflow_dispatch' },
    { conclusion: 'failure' }, { status: 'in_progress' }, { head_sha: 'short' }, { run_attempt: 2 }]) {
    const f = notification(); f.state.fresh = run(changes);
    await assert.rejects(workflowRunPullRequest(f.env, f.event(), f.api), /PREVIEW_EVENT_(UNTRUSTED_RUN|RUN_CHANGED)/);
  }
  const f = notification(); f.state.workflow.state = 'disabled_manually';
  await assert.rejects(workflowRunPullRequest(f.env, f.event(), f.api), /WORKFLOW_IDENTITY/);
});

test('old SHA notifications and superseded runs cannot authorize a deployment', async () => {
  const f = notification();
  f.state.prs = [pr({ head: { ref: 'codex/example', sha: merge, repo } })];
  assert.equal(await workflowRunPullRequest(f.env, f.event(), f.api), undefined);
  f.state.prs = [pr()];
  f.state.listed = [run({ id: 501, status: 'queued', conclusion: null }), run()]; f.state.listTotal = 2;
  assert.equal(await workflowRunPullRequest(f.env, f.event(), f.api), undefined);
  f.state.listed = [run({ run_attempt: 2 })]; f.state.listTotal = 1;
  await assert.rejects(workflowRunPullRequest(f.env, f.event(), f.api), /RUN_INVENTORY/);
});

test('latest notification inventory must preserve filters, complete first-page metadata, and newest-first order', async () => {
  for (const listed of [[run({ head_branch: 'codex/other' })], [run({ head_repository: { id: 1, full_name: 'other/Cake' } })],
    [run({ created_at: undefined })], [run({ path: '.github/workflows/other.yml' })],
    [run(), run({ id: 501 })]]) {
    const f = notification(); f.state.listed = listed; f.state.listTotal = listed.length;
    await assert.rejects(workflowRunPullRequest(f.env, f.event(), f.api), /RUN_INVENTORY/);
  }
  const f = notification(); f.state.listTotal = 2;
  await assert.rejects(workflowRunPullRequest(f.env, f.event(), f.api), /RUN_INVENTORY/);
});

test('ambiguous PR inventory, reused branches, and conflicting run associations cannot select another PR', async () => {
  const f = notification();
  f.state.prs = [pr(), pr({ number: 72 })];
  await assert.rejects(workflowRunPullRequest(f.env, f.event(), f.api), /AMBIGUOUS_PR/);
  f.state.prs = [pr({ created_at: '2026-10-28T00:00:00Z' })];
  assert.equal(await workflowRunPullRequest(f.env, f.event(), f.api), undefined);
  f.state.prs = [pr()];
  const bad = { number: 72, head: { ref: 'codex/example', sha: head, repo }, base: { ref: 'main', repo } };
  f.state.announced = run({ pull_requests: [bad] }); f.state.fresh = f.state.announced;
  await assert.rejects(workflowRunPullRequest(f.env, f.event(), f.api), /PR_ASSOCIATION/);
});

test('closed PR metadata stays canonical for cleanup, including a merged-run SHA', async () => {
  const f = notification();
  f.state.prs = [pr({ state: 'closed', merged: false })];
  assert.equal((await workflowRunPullRequest(f.env, f.event(), f.api))!.source.state, 'closed');
  f.state.prs = [pr({ state: 'closed', merged: true, merge_commit_sha: merge })];
  const link = { number: 71, head: { ref: 'codex/example', sha: head, repo }, base: { ref: 'main', repo } };
  f.state.announced = run({ head_sha: merge, pull_requests: [link] }); f.state.fresh = f.state.announced;
  f.state.listed = [f.state.announced];
  const result = await workflowRunPullRequest(f.env, f.event(), f.api);
  assert.equal(result!.source.sha, head);
  assert.equal(result!.raw.merged, true);
});

test('a rerun starting during PR resolution invalidates the completed notification', async () => {
  const f = notification(); let reads = 0;
  const api: Transport = async (provider, path, method, body, missing) => {
    if (path.endsWith('/actions/runs/500') && ++reads === 2) return run({ run_attempt: 2 });
    return f.api(provider, path, method, body, missing);
  };
  await assert.rejects(workflowRunPullRequest(f.env, f.event(), api), /RUN_CHANGED/);
});

function pushFixture() {
  const mergedPr = pr({ state: 'closed', merged: true, merged_at: '2026-10-27T00:00:00Z', merge_commit_sha: merge });
  const state = { commits: [merge], prs: [mergedPr], associated: [mergedPr], comparison: {} as Json };
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: config.repository, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: merge };
  const event = { repository: repo, ref: 'refs/heads/main', before, after: merge, forced: false, created: false, deleted: false };
  const calls: string[] = [];
  const api: Transport = async (provider, path, method = 'GET') => {
    assert.equal(provider, 'github'); assert.equal(method, 'GET'); calls.push(path);
    if (path.startsWith(`${prefix}compare/`)) {
      const page = Number(new URL('https://fixture.invalid' + path).searchParams.get('page'));
      return { status: 'ahead', behind_by: 0, ahead_by: state.commits.length, total_commits: state.commits.length,
        base_commit: { sha: before }, merge_base_commit: { sha: before },
        commits: state.commits.slice((page - 1) * 100, page * 100).map(sha => ({ sha })), ...state.comparison };
    }
    if (path.includes('/commits/')) return state.associated;
    if (path.startsWith(`${prefix}pulls/`)) return state.prs.find(value => String(value.number) === path.split('/').at(-1));
    return assert.fail(path);
  };
  return { state, env, event, calls, api };
}

test('main pushes discover their actual merged task PRs and ignore direct-push associations', async () => {
  const f = pushFixture();
  assert.deepEqual((await pushedPullRequests(f.env, f.event, f.api)).map(value => value.number), [71]);
  f.state.associated = [pr()];
  assert.deepEqual(await pushedPullRequests(f.env, f.event, f.api), []);
  f.state.associated = [pr({ state: 'closed', merged: true, merge_commit_sha: head })];
  assert.deepEqual(await pushedPullRequests(f.env, f.event, f.api), []);
});

test('a push can identify multiple merges without selecting a PR merely mentioned by one commit', async () => {
  const f = pushFixture();
  const firstMerge = 'e'.repeat(40);
  const first = pr({ number: 70, state: 'closed', merged: true, merged_at: '2026-10-26T23:59:00Z', merge_commit_sha: firstMerge,
    head: { ref: 'codex/first', sha: head, repo } });
  const unrelated = pr({ number: 99, state: 'closed', merged: true, merge_commit_sha: 'f'.repeat(40) });
  f.state.commits = [firstMerge, merge]; f.state.prs = [first, ...f.state.prs]; f.state.associated = [...f.state.prs, unrelated];
  assert.deepEqual((await pushedPullRequests(f.env, f.event, f.api)).map(value => value.number), [70, 71]);
  assert.ok(!f.calls.includes(`${prefix}pulls/99`));
});

test('force pushes, repository substitutions and mismatched push heads cannot authorize cleanup', async () => {
  for (const change of [{ forced: true }, { created: true }, { deleted: true }, { after: head }, { before: '0'.repeat(40) },
    { ref: 'refs/heads/codex/example' }]) {
    const f = pushFixture();
    await assert.rejects(pushedPullRequests(f.env, { ...f.event, ...change }, f.api), /UNTRUSTED_PUSH/);
    assert.equal(f.calls.length, 0);
  }
  const f = pushFixture();
  await assert.rejects(pushedPullRequests(f.env, { ...f.event, repository: { id: 1, full_name: config.repository } }, f.api), /UNTRUSTED_CONTEXT/);
});

test('non-forward, truncated, duplicated, and changed PR evidence fails closed', async () => {
  for (const comparison of [{ status: 'diverged' }, { merge_base_commit: { sha: head } }, { total_commits: 2, ahead_by: 2 },
    { commits: [{ sha: merge }, { sha: merge }], total_commits: 2, ahead_by: 2 }]) {
    const f = pushFixture(); f.state.comparison = comparison;
    await assert.rejects(pushedPullRequests(f.env, f.event, f.api), /PREVIEW_EVENT_(PUSH_COMPARISON|INCOMPLETE_INVENTORY)/);
  }
  const f = pushFixture(); f.state.prs = [pr({ state: 'closed', merged: true, merged_at: '2026-10-27T00:00:00Z', merge_commit_sha: head })];
  await assert.rejects(pushedPullRequests(f.env, f.event, f.api), /PR_CHANGED/);
});

test('push discovery reads every comparison page before trusting commit membership', async () => {
  const f = pushFixture();
  f.state.commits = Array.from({ length: 101 }, (_, index) => (index + 1).toString(16).padStart(40, '0'));
  const after = f.state.commits.at(-1)!;
  f.state.prs = [pr({ state: 'closed', merged: true, merged_at: '2026-10-27T00:00:00Z', merge_commit_sha: after })];
  f.state.associated = f.state.prs;
  const results = await pushedPullRequests({ ...f.env, GITHUB_SHA: after }, { ...f.event, after }, f.api);
  assert.equal(results.length, 1);
  assert.ok(f.calls.some(path => path.includes('/compare/') && path.endsWith('page=2')));
  assert.equal(f.calls.filter(path => path.includes('/commits/')).length, 101);
});

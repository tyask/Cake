import { array, config, object, source, type Source } from './preview-model';
import { type Transport } from './preview-provider';
import { fullSha, validTaskBranch } from '../task/task-workflow';

type Environment = Readonly<Record<string, string | undefined>>;
type Json = Record<string, unknown>;
const prefix = `/repos/${config.repository}/`;
const collectorFile = '.github/workflows/pr-events.yml';
const collectorName = 'Cake PR Events';
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = (code: string): never => { throw new Error(`PREVIEW_EVENT_${code}`); };
const repository = (value: unknown): boolean => {
  const repo = object(value);
  return repo.id === config.repositoryId && repo.full_name === config.repository;
};

function mainEvent(env: Environment, event: Json, kind: string): void {
  if (env.GITHUB_EVENT_NAME !== kind || env.GITHUB_REPOSITORY !== config.repository
    || env.GITHUB_REF !== 'refs/heads/main' || !fullSha(env.GITHUB_SHA)
    || !repository(event.repository)) fail('UNTRUSTED_CONTEXT');
}

/** GitHub collection pagination is bounded; an incomplete inventory cannot authorize work. */
async function pages(api: Transport, path: string): Promise<Json[]> {
  const rows: Json[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = array(await api('github', `${prefix}${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)).map(object);
    if (batch.length > 100) fail('INCOMPLETE_INVENTORY');
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  return fail('INCOMPLETE_INVENTORY');
}

function collectorRun(value: unknown, workflowId: number): Json {
  const run = object(value);
  // Run names can contain the dynamic run-name. Bind identity to the registered
  // workflow's ID and path instead of its mutable display name.
  if (!positive(run.id) || !positive(run.run_attempt) || run.workflow_id !== workflowId
    || run.path !== collectorFile || run.event !== 'pull_request'
    || run.status !== 'completed' || run.conclusion !== 'success'
    || !repository(run.repository) || !repository(run.head_repository)
    || !validTaskBranch(run.head_branch) || !fullSha(run.head_sha)
    || !time(run.created_at) || !time(run.updated_at) || Date.parse(run.updated_at) < Date.parse(run.created_at)
    || run.url !== `https://api.github.com${prefix}actions/runs/${run.id}`) fail('UNTRUSTED_RUN');
  return run;
}

function boundSource(raw: Json): Source {
  const current = source(raw);
  if (!repository(object(raw.head).repo) || !repository(object(raw.base).repo)) fail('PR_IDENTITY');
  return current;
}

function associatedPr(run: Json, current: Source): void {
  const associated = array(run.pull_requests);
  // GitHub may omit associations on closed PR runs. In that case the complete
  // branch/SHA inventory below, including creation time, must establish one PR.
  if (!associated.length) return;
  if (associated.length !== 1) fail('AMBIGUOUS_PR');
  const link = object(associated[0]), head = object(link.head), base = object(link.base);
  if (link.number !== current.pr || head.ref !== current.branch || head.sha !== current.sha
    || base.ref !== 'main' || object(head.repo).id !== config.repositoryId
    || object(base.repo).id !== config.repositoryId) fail('PR_ASSOCIATION');
}

/**
 * Resolve an unprivileged PR notification using GitHub-owned run metadata only.
 * No artifact, output, PR-provided path, or PR-provided program is consumed.
 */
export async function workflowRunPullRequest(env: Environment, event: Json, api: Transport): Promise<{ source: Source; raw: Json } | undefined> {
  mainEvent(env, event, 'workflow_run');
  if (event.action !== 'completed') return fail('UNTRUSTED_CONTEXT');
  const announced = object(event.workflow_run);
  if (!positive(announced.id)) return fail('UNTRUSTED_RUN');
  // Foreign branches and fork notifications never authorize provider access.
  if (!repository(announced.repository) || !repository(announced.head_repository) || !validTaskBranch(announced.head_branch)) return undefined;
  const workflow = object(await api('github', `${prefix}actions/workflows/pr-events.yml`));
  if (!positive(workflow.id) || workflow.path !== collectorFile || workflow.name !== collectorName || workflow.state !== 'active') return fail('WORKFLOW_IDENTITY');
  const notified = collectorRun(announced, workflow.id);
  const run = collectorRun(await api('github', `${prefix}actions/runs/${notified.id}`), workflow.id);
  if (['id', 'run_attempt', 'workflow_id', 'path', 'event', 'head_sha', 'head_branch', 'status', 'conclusion', 'created_at', 'updated_at']
    .some(key => run[key] !== notified[key])) return fail('RUN_CHANGED');

  const listed = await pages(api, `pulls?state=all&base=main&head=${encodeURIComponent(`${config.repository.split('/')[0]}:${run.head_branch}`)}`);
  const candidates: { source: Source; raw: Json }[] = [];
  const seen = new Set<number>();
  for (const row of listed) {
    if (!positive(row.number) || seen.has(row.number)) return fail('PR_INVENTORY');
    seen.add(row.number);
    const raw = object(await api('github', `${prefix}pulls/${row.number}`));
    const current = boundSource(raw);
    if (raw.number !== row.number || current.branch !== run.head_branch) return fail('PR_INVENTORY');
    if (Date.parse(current.createdAt) > Date.parse(String(run.created_at))) continue;
    const isMergedRun = current.state === 'closed' && raw.merged === true && raw.merge_commit_sha === run.head_sha;
    if (current.sha === run.head_sha || isMergedRun) candidates.push({ source: current, raw });
  }
  if (!candidates.length) return undefined;
  if (candidates.length !== 1) return fail('AMBIGUOUS_PR');
  const selected = candidates[0];
  associatedPr(run, selected.source);

  // A newer notification supersedes this one even if its job is still queued.
  // GitHub returns this collection newest first. If this run is outside the
  // first page, newer work exists and this old notification can be skipped.
  const latest = object(await api('github', `${prefix}actions/workflows/pr-events.yml/runs?branch=${encodeURIComponent(selected.source.branch)}&event=pull_request&per_page=100&page=1`));
  const runs = array(latest.workflow_runs).map(object);
  if (!Number.isSafeInteger(latest.total_count) || Number(latest.total_count) < 0
    || runs.length !== Math.min(Number(latest.total_count), 100)) return fail('RUN_INVENTORY');
  for (let index = 0; index < runs.length; index++) {
    const next = runs[index];
    if (!positive(next.id) || !positive(next.run_attempt) || next.workflow_id !== workflow.id
      || next.path !== collectorFile || next.event !== 'pull_request'
      || next.head_branch !== selected.source.branch || !fullSha(next.head_sha)
      || !repository(next.repository) || !repository(next.head_repository)
      || !time(next.created_at) || !time(next.updated_at) || Date.parse(next.updated_at) < Date.parse(next.created_at)
      || index > 0 && Number(runs[index - 1].id) <= next.id) return fail('RUN_INVENTORY');
  }
  if (runs.some(next => Number(next.id) > Number(run.id))) return undefined;
  const same = runs.filter(next => next.id === run.id);
  if (same.length !== 1 || same[0].run_attempt !== run.run_attempt || same[0].head_sha !== run.head_sha) return fail('RUN_INVENTORY');
  const fresh = collectorRun(await api('github', `${prefix}actions/runs/${run.id}`), workflow.id);
  if (['run_attempt', 'head_sha', 'status', 'conclusion', 'updated_at'].some(key => fresh[key] !== run[key])) return fail('RUN_CHANGED');
  return selected;
}

/** Discover only merged task PRs whose actual merge commit entered main in this push. */
export async function pushedPullRequests(env: Environment, event: Json, api: Transport): Promise<Json[]> {
  mainEvent(env, event, 'push');
  const before = event.before, after = event.after;
  if (event.ref !== 'refs/heads/main' || event.deleted !== false || event.forced !== false || event.created !== false
    || !fullSha(before) || !fullSha(after) || after !== env.GITHUB_SHA
    || before === '0'.repeat(40) || after === '0'.repeat(40)) return fail('UNTRUSTED_PUSH');
  if (before === after) return [];
  const commits: string[] = [];
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const comparison = object(await api('github', `${prefix}compare/${before}...${after}?per_page=100&page=${page}`));
    if (comparison.status !== 'ahead' || comparison.behind_by !== 0 || comparison.ahead_by !== comparison.total_commits
      || !positive(comparison.total_commits) || Number(comparison.total_commits) > 1000
      || object(comparison.base_commit).sha !== before || object(comparison.merge_base_commit).sha !== before
      || page > 1 && comparison.total_commits !== total) return fail('PUSH_COMPARISON');
    total = Number(comparison.total_commits);
    const batch = array(comparison.commits).map(object);
    if (batch.length > 100 || !batch.length) return fail('INCOMPLETE_INVENTORY');
    for (const commit of batch) {
      if (!fullSha(commit.sha) || commits.includes(commit.sha)) return fail('PUSH_COMPARISON');
      commits.push(commit.sha);
    }
    if (commits.length >= total) break;
    if (batch.length < 100 || page === 10) return fail('INCOMPLETE_INVENTORY');
  }
  if (commits.length !== total || commits.at(-1) !== after) return fail('INCOMPLETE_INVENTORY');

  const candidates = new Map<number, Json>();
  for (const sha of commits) {
    const associated = await pages(api, `commits/${sha}/pulls`);
    for (const candidate of associated) {
      const head = object(candidate.head), base = object(candidate.base);
      if (base.ref !== 'main' || !validTaskBranch(head.ref) || head.repo == null
        || !repository(head.repo) || !repository(base.repo) || !commits.includes(String(candidate.merge_commit_sha))) continue;
      if (!positive(candidate.number)) return fail('PR_INVENTORY');
      if (!candidates.has(candidate.number)) candidates.set(candidate.number, candidate);
    }
  }
  const merged: Json[] = [];
  for (const [number, summary] of candidates) {
    const raw = object(await api('github', `${prefix}pulls/${number}`));
    const current = boundSource(raw);
    if (current.pr !== number || current.state !== 'closed' || raw.merged !== true || !time(raw.merged_at)
      || !fullSha(raw.merge_commit_sha) || !commits.includes(raw.merge_commit_sha)
      || raw.merge_commit_sha !== summary.merge_commit_sha || object(raw.head).sha !== object(summary.head).sha) return fail('PR_CHANGED');
    merged.push(raw);
  }
  return merged.sort((a, b) => commits.indexOf(String(a.merge_commit_sha)) - commits.indexOf(String(b.merge_commit_sha)) || Number(a.number) - Number(b.number));
}

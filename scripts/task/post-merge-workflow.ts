import { appendFile, lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, object, array } from '../preview/preview-model';
import { transport, type Transport } from '../preview/preview-provider';
import { pushedPullRequests } from '../preview/pr-event';
import { fullSha } from './task-workflow';
import { PostMergeChecks } from './post-merge-checks';
import { failPostMerge, mergedTask, parsePostMergeResult, parseTaskMetadata, positiveId, sameTask,
  type MergedTask, type PostMergeResult, type CheckName, type PostMergeCheck } from './post-merge-model';

const repoPrefix = `/repos/${config.repository}/`;
const resultFile = 'post-merge-result.json';
const commentPrefix = '<!-- cake-post-merge/v1 ';
const checkNames = ['ci', 'production', 'staging', 'cleanup'] as const;
type Context = { pr: number; controlSha: string; runId: string; runAttempt: number; eventTask?: MergedTask };
type VerificationOptions = { api?: Transport; checks?: PostMergeChecks; wait?: (ms: number) => Promise<void>;
  now?: () => number; maxWaitMs?: number; pollMs?: number; directory?: string };

async function workflowContext(env: Readonly<Record<string, string | undefined>>): Promise<Record<string, unknown>> {
  if (env.GITHUB_REPOSITORY !== config.repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_WORKFLOW_REF !== `${config.repository}/.github/workflows/post-merge.yml@refs/heads/main`
    || !fullSha(env.GITHUB_SHA) || !env.GITHUB_EVENT_PATH || !env.GH_TOKEN
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !positiveId(Number(env.GITHUB_RUN_ID))
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !positiveId(Number(env.GITHUB_RUN_ATTEMPT))) return failPostMerge('UNTRUSTED_WORKFLOW');
  const event = object(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
  if (object(event.repository).full_name !== config.repository || object(event.repository).id !== config.repositoryId) return failPostMerge('UNTRUSTED_EVENT');
  if (!['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')) return failPostMerge('UNTRUSTED_EVENT');
  return event;
}

function dispatchPr(event: Record<string, unknown>): number {
  const input = object(event.inputs).pr;
  if (typeof input !== 'string' || !/^[1-9][0-9]*$/.test(input) || !positiveId(Number(input))) return failPostMerge('INVALID_PR');
  return Number(input);
}

/** A main-only job resolves all tasks before creating the independent PR matrix. */
export async function preparePostMerge(env: Readonly<Record<string, string | undefined>> = process.env,
  api: Transport = transport({ GH_TOKEN: env.GH_TOKEN })): Promise<{ pr: number; issue: number }[]> {
  const event = await workflowContext(env);
  const raws = env.GITHUB_EVENT_NAME === 'push' ? await pushedPullRequests(env, event, api)
    : [await api('github', `${repoPrefix}pulls/${dispatchPr(event)}`)];
  // Keep the verification batch within the Preview cleanup's bounded matrix.
  if (raws.length > 10) return failPostMerge('TASKS_INVALID');
  const tasks = raws.map(mergedTask).filter((task): task is MergedTask => task !== undefined);
  if (new Set(tasks.map(task => task.source.pr)).size !== tasks.length) return failPostMerge('TASKS_INVALID');
  const targets = tasks.map(task => ({ pr: task.source.pr, issue: task.metadata.issue }));
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `targets=${JSON.stringify(targets)}\n`);
  return targets;
}

export async function postMergeContext(env: Readonly<Record<string, string | undefined>>,
  api: Transport = transport({ GH_TOKEN: env.GH_TOKEN })): Promise<Context> {
  const event = await workflowContext(env);
  let pr: number, eventTask: MergedTask | undefined;
  if (env.GITHUB_EVENT_NAME === 'push') {
    const selected = env.CAKE_POST_MERGE_PR;
    if (!selected || !/^[1-9][0-9]*$/.test(selected) || !positiveId(Number(selected))) return failPostMerge('INVALID_PR');
    pr = Number(selected);
    const candidates = await pushedPullRequests(env, event, api);
    const raw = candidates.find(candidate => candidate.number === pr);
    if (!raw || !(eventTask = mergedTask(raw))) return failPostMerge('INVALID_PR');
  } else pr = dispatchPr(event);
  if (env.CAKE_POST_MERGE_PR !== undefined && env.CAKE_POST_MERGE_PR !== String(pr)) return failPostMerge('INVALID_PR');
  if (!positiveId(pr)) return failPostMerge('INVALID_PR');
  return { pr, controlSha: env.GITHUB_SHA!, runId: env.GITHUB_RUN_ID!, runAttempt: Number(env.GITHUB_RUN_ATTEMPT), eventTask };
}

const emptyChecks = (): Record<CheckName, PostMergeCheck> => Object.fromEntries(checkNames.map(name => [name,
  { status: 'pending', code: 'NOT_CHECKED' }])) as Record<CheckName, PostMergeCheck>;
async function freshTask(api: Transport, pr: number): Promise<MergedTask | undefined> {
  return mergedTask(await api('github', `${repoPrefix}pulls/${pr}`));
}

export async function verifyPostMerge(env: Readonly<Record<string, string | undefined>> = process.env, options: VerificationOptions = {}): Promise<PostMergeResult | undefined> {
  const api = options.api ?? transport(env), context = await postMergeContext(env, api), directory = options.directory ?? process.cwd();
  const task = await freshTask(api, context.pr);
  if (!task) return undefined;
  if (context.eventTask && !sameTask(task, context.eventTask)) return failPostMerge('PR_CHANGED');
  const issue = object(await api('github', `${repoPrefix}issues/${task.metadata.issue}`));
  if (issue.number !== task.metadata.issue || issue.pull_request != null) return failPostMerge('ISSUE_INVALID');
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `issue=${task.metadata.issue}\n`);
  const checks = options.checks ?? new PostMergeChecks(api), now = options.now ?? Date.now;
  const wait = options.wait ?? (ms => new Promise(resolveWait => setTimeout(resolveWait, ms)));
  const maxWait = options.maxWaitMs ?? 20 * 60_000, poll = options.pollMs ?? 30_000;
  if (!Number.isFinite(maxWait) || maxWait < 0 || maxWait > 20 * 60_000 || !Number.isFinite(poll) || poll < 1 || poll > 60_000) return failPostMerge('WAIT_INVALID');
  const deadline = now() + maxWait;
  const result: PostMergeResult = { protocol: 'cake-post-merge/v1', task, controlSha: context.controlSha,
    runId: context.runId, runAttempt: context.runAttempt, checkedAt: new Date(now()).toISOString(), status: 'timeout', checks: emptyChecks() };
  try {
    await checks.assertBindings();
    do {
      const current = await freshTask(api, context.pr);
      if (!current || !sameTask(task, current)) return failPostMerge('PR_CHANGED');
      if (await checks.mainSha() !== task.mergeSha) { result.status = 'superseded'; break; }
      result.checks = await checks.all(task);
      if (await checks.mainSha() !== task.mergeSha) { result.status = 'superseded'; break; }
      if (Object.values(result.checks).some(check => check.status === 'failure')) { result.status = 'failed'; break; }
      if (Object.values(result.checks).every(check => check.status === 'success')) { result.status = 'success'; break; }
      if (now() >= deadline) break;
      await wait(Math.min(poll, Math.max(1, deadline - now())));
    } while (now() <= deadline);
  } catch {
    result.status = 'failed';
    // Raw exception text may contain provider responses. Publish only a fixed code.
    result.checks = Object.fromEntries(checkNames.map(name => [name,
      result.checks[name].status === 'success' ? result.checks[name] : { status: 'failure', code: 'VERIFICATION_FAILED' }])) as PostMergeResult['checks'];
  }
  result.checkedAt = new Date(now()).toISOString();
  await writeFile(resolve(directory, resultFile), JSON.stringify(parsePostMergeResult(result), null, 2) + '\n', { mode: 0o600 });
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `## マージ後確認\n\nPR #${task.source.pr} / Issue #${task.metadata.issue}\n\n状態: ${result.status}\n\nMerge SHA: ${task.mergeSha}\n`);
  return result;
}

type CommentMarker = { pr: number; mergeSha: string; mergedAt: string; runId: string; runAttempt: number; status: PostMergeResult['status']; history?: PostMergeResult[] };
function marker(result: PostMergeResult): CommentMarker {
  return { pr: result.task.source.pr, mergeSha: result.task.mergeSha, mergedAt: result.task.mergedAt,
    runId: result.runId, runAttempt: result.runAttempt, status: result.status };
}
function previousMarker(body: unknown): CommentMarker | undefined {
  if (typeof body !== 'string' || !body.startsWith(commentPrefix)) return undefined;
  const end = body.indexOf(' -->');
  if (end < 0 || end > 60_000) return failPostMerge('COMMENT_INVALID');
  try {
    const value = object(JSON.parse(body.slice(commentPrefix.length, end)));
    if (!positiveId(value.pr) || !fullSha(value.mergeSha) || typeof value.mergedAt !== 'string' || !Number.isFinite(Date.parse(value.mergedAt))
      || typeof value.runId !== 'string' || !positiveId(Number(value.runId)) || !positiveId(value.runAttempt)
      || !['success', 'failed', 'timeout', 'superseded'].includes(String(value.status))) return failPostMerge('COMMENT_INVALID');
    if (value.history !== undefined) {
      if (!Array.isArray(value.history) || value.history.length > 50) return failPostMerge('COMMENT_INVALID');
      const history = value.history.map(parsePostMergeResult);
      if (new Set(history.map(entry => entry.task.source.pr)).size !== history.length) return failPostMerge('COMMENT_INVALID');
      const representative = history.find(entry => entry.task.source.pr === value.pr);
      if (!representative || JSON.stringify(marker(representative)) !== JSON.stringify({ pr: value.pr, mergeSha: value.mergeSha,
        mergedAt: value.mergedAt, runId: value.runId, runAttempt: value.runAttempt, status: value.status })) return failPostMerge('COMMENT_INVALID');
      return { ...marker(representative), history };
    }
    // The old single-entry marker lacks source, metadata and check evidence.
    // Retain it only for generation ordering, never as a completed prior PR.
    return value as CommentMarker;
  } catch { return failPostMerge('COMMENT_INVALID'); }
}
export function stalePostMergeResult(previous: CommentMarker, next: PostMergeResult): boolean {
  const current = marker(next);
  if (previous.pr !== current.pr) return false;
  if (previous.mergeSha !== current.mergeSha) return true;
  if (Number(previous.runId) !== Number(current.runId)) return Number(previous.runId) > Number(current.runId);
  return previous.runAttempt > current.runAttempt;
}

export function postMergeComment(result: PostMergeResult, otherWork: boolean, history: PostMergeResult[] = [result]): string {
  if (history.length > 50) return failPostMerge('COMMENT_TOO_LARGE');
  const labels = { success: '成功', failed: '失敗・要対応', timeout: '確認待ち（待機上限）', superseded: '後続のmain更新により未完了' };
  const names = { ci: 'main CI', production: '本番Deployment・alias', staging: '常設Preview・ブラウザ検証', cleanup: 'PR専用Preview・DB削除' };
  const runLink = (run: string | number) => `https://github.com/${config.repository}/actions/runs/${run}`;
  const lines = checkNames.map(name => {
    const check = result.checks[name];
    return `| ${names[name]} | ${check.status} / ${check.code} | ${check.runId ? `[Actions](${runLink(check.runId)})` : check.deploymentId ?? '—'} |`;
  });
  const blocking = result.task.metadata.manualPostMerge ? '人による確認が必要です。Issueは自動完了しません。'
    : !result.task.metadata.completesIssue ? '分割PRの結果です。Issueは継続します。'
    : otherWork ? '同じIssueに未完了または未確認の関連PRがあります。Issueは継続します。'
    : result.status !== 'success' ? '必要な確認が完了していません。Issueは継続します。' : '必要な自動確認が完了しました。';
  const related = history.map(entry => `| #${entry.task.source.pr} | ${entry.task.mergeSha} | ${entry.status} | ${entry.task.metadata.manualPostMerge ? '必要' : 'なし'} | [Actions](${runLink(entry.runId)}) |`);
  const body = `${commentPrefix}${JSON.stringify({ ...marker(result), history })} -->\n## マージ後確認: ${labels[result.status]}\n\n`
    + `- PR: #${result.task.source.pr}\n- PR head SHA: ${result.task.source.sha}\n- Merge SHA: ${result.task.mergeSha}\n`
    + `- Intent: [案件記録](https://github.com/${config.repository}/tree/${result.task.mergeSha}/${result.task.metadata.intent})\n`
    + `- 確認日時: ${result.checkedAt}\n- 実行: [Actions](${runLink(result.runId)})（attempt ${result.runAttempt}）\n\n`
    + `| 確認 | 結果 | 根拠 |\n|---|---|---|\n${lines.join('\n')}\n\n${blocking}\n\n`
    + `### 関連PRの確認履歴\n\n| PR | Merge SHA | 最新結果 | 手動確認 | 根拠 |\n|---|---|---|---|---|\n${related.join('\n')}\n\n`
    + `本番の画面操作・業務データ更新はこの確認に含みません。\n`;
  if (Buffer.byteLength(body) > 60_000) return failPostMerge('COMMENT_TOO_LARGE');
  return body;
}

async function githubPages(api: Transport, path: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = array(await api('github', `${repoPrefix}${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)).map(object);
    if (batch.length > 100) return failPostMerge('INVENTORY_INVALID');
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  return failPostMerge('INVENTORY_INCOMPLETE');
}

type RelatedWork = { merged: MergedTask[]; blocked: boolean };
async function relatedWork(api: Transport, current: MergedTask): Promise<RelatedWork> {
  const pulls = await githubPages(api, 'pulls?state=all&base=main'), merged: MergedTask[] = [current];
  let blocked = false;
  for (const pr of pulls) {
    let metadata;
    try { metadata = parseTaskMetadata(pr.body ?? ''); }
    // Invalid metadata cannot associate an otherwise unrelated PR with this Issue.
    // A previously associated PR still blocks completion through history reconciliation.
    catch { continue; }
    if (!metadata || metadata.issue !== current.metadata.issue || pr.number === current.source.pr) continue;
    if (!positiveId(pr.number)) { blocked = true; continue; }
    const raw = object(await api('github', `${repoPrefix}pulls/${pr.number}`));
    const actual = parseTaskMetadata(raw.body ?? '');
    if (!actual || actual.issue !== current.metadata.issue) { blocked = true; continue; }
    if (raw.state === 'open') { blocked = true; continue; }
    if (raw.state !== 'closed') { blocked = true; continue; }
    if (raw.merged === true) {
      const task = mergedTask(raw);
      if (!task || task.source.pr !== pr.number) return failPostMerge('RELATED_PR_CHANGED');
      merged.push(task);
    }
  }
  if (new Set(merged.map(task => task.source.pr)).size !== merged.length) return failPostMerge('INVENTORY_INVALID');
  return { merged, blocked };
}

function completedRelatedWork(work: RelatedWork, history: PostMergeResult[]): boolean {
  return !work.blocked && history.every(entry => work.merged.some(task => task.source.pr === entry.task.source.pr)) && work.merged.every(task => {
    const entry = history.find(entry => entry.task.source.pr === task.source.pr);
    return entry?.status === 'success' && !task.metadata.manualPostMerge && sameTask(entry.task, task)
      && Object.values(entry.checks).every(check => check.status === 'success');
  });
}

function representativeResult(history: PostMergeResult[], mainSha: string): PostMergeResult {
  const current = history.filter(entry => entry.task.mergeSha === mainSha);
  const candidates = current.length ? current : history;
  // PR numbers are identifiers, not merge order. A same-second merge is ordered
  // by the actual current main SHA; otherwise show the latest recorded check.
  return [...candidates].sort((a, b) => Date.parse(b.task.mergedAt) - Date.parse(a.task.mergedAt)
    || Date.parse(b.checkedAt) - Date.parse(a.checkedAt) || Number(b.runId) - Number(a.runId))[0];
}

export async function publishPostMerge(env: Readonly<Record<string, string | undefined>> = process.env, api: Transport = transport({ GH_TOKEN: env.GH_TOKEN }), directory = process.cwd()): Promise<void> {
  const context = await postMergeContext(env, api), path = resolve(directory, resultFile), stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 30_000) return failPostMerge('RESULT_INVALID');
  const result = parsePostMergeResult(JSON.parse(await readFile(path, 'utf8')));
  if (result.runId !== context.runId || result.runAttempt !== context.runAttempt || result.controlSha !== context.controlSha
    || result.task.source.pr !== context.pr) return failPostMerge('RESULT_MISMATCH');
  const current = await freshTask(api, context.pr);
  if (!current || !sameTask(current, result.task)) return failPostMerge('PR_CHANGED');
  if (context.eventTask && !sameTask(current, context.eventTask)) return failPostMerge('PR_CHANGED');
  const mainBefore = object(await api('github', `${repoPrefix}branches/main`));
  if (object(mainBefore.commit).sha !== current.mergeSha) result.status = 'superseded';
  const issue = object(await api('github', `${repoPrefix}issues/${current.metadata.issue}`));
  if (issue.number !== current.metadata.issue || issue.pull_request != null) return failPostMerge('ISSUE_INVALID');
  const comments = await githubPages(api, `issues/${current.metadata.issue}/comments`);
  const owned = comments.filter(comment => object(comment.user).login === 'github-actions[bot]' && object(comment.user).type === 'Bot'
    && typeof comment.body === 'string' && comment.body.startsWith(commentPrefix));
  if (owned.length > 1) return failPostMerge('COMMENT_AMBIGUOUS');
  const existing = owned[0], prior = existing && previousMarker(existing.body);
  const history = prior?.history ?? [];
  if (history.some(entry => entry.task.metadata.issue !== current.metadata.issue)) return failPostMerge('COMMENT_INVALID');
  const previous = history.find(entry => entry.task.source.pr === current.source.pr);
  if (previous && stalePostMergeResult(marker(previous), result)
    || !previous && prior && !prior.history && stalePostMergeResult(prior, result)) return;
  const updated = [...history.filter(entry => entry.task.source.pr !== current.source.pr), result];
  const work = await relatedWork(api, current), complete = completedRelatedWork(work, updated);
  const representative = representativeResult(updated, String(object(mainBefore.commit).sha));
  const body = postMergeComment(representative, !complete, updated);
  if (existing) {
    if (!positiveId(existing.id)) return failPostMerge('COMMENT_INVALID');
    // Reject a moved/edited comment rather than overwriting another actor's content.
    const fresh = object(await api('github', `${repoPrefix}issues/comments/${existing.id}`));
    if (fresh.body !== existing.body || object(fresh.user).login !== 'github-actions[bot]') return failPostMerge('COMMENT_CHANGED');
    if (fresh.body !== body) await api('github', `${repoPrefix}issues/comments/${existing.id}`, 'PATCH', { body });
  } else await api('github', `${repoPrefix}issues/${current.metadata.issue}/comments`, 'POST', { body });
  const again = await freshTask(api, context.pr);
  if (!again || !sameTask(again, current)) return failPostMerge('PR_CHANGED');
  if (result.status === 'success' && current.metadata.completesIssue && !current.metadata.manualPostMerge && complete && issue.state === 'open') {
    const main = object(await api('github', `${repoPrefix}branches/main`));
    if (object(main.commit).sha !== current.mergeSha) return;
    if (!completedRelatedWork(await relatedWork(api, current), updated)) return;
    await api('github', `${repoPrefix}issues/${current.metadata.issue}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const run = command === 'verify' ? async () => {
    const result = await verifyPostMerge();
    if (result && result.status !== 'success') process.exitCode = 1;
  } : command === 'publish' ? () => publishPostMerge() : command === 'prepare' ? async () => { await preparePostMerge(); }
    : () => failPostMerge('INVALID_COMMAND');
  Promise.resolve().then(run).catch(() => {
    console.error('Cake: マージ後確認を完了できませんでした。Actionsの実行状態とIssueの報告を確認してください。秘密値・外部応答は表示しません。');
    process.exitCode = 1;
  });
}

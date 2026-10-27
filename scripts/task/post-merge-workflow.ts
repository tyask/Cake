import { appendFile, lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, object, array } from '../preview/preview-model';
import { transport, type Transport } from '../preview/preview-provider';
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

export async function postMergeContext(env: Readonly<Record<string, string | undefined>>): Promise<Context> {
  if (env.GITHUB_REPOSITORY !== config.repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_WORKFLOW_REF !== `${config.repository}/.github/workflows/post-merge.yml@refs/heads/main`
    || !fullSha(env.GITHUB_SHA) || !env.GITHUB_EVENT_PATH || !env.GH_TOKEN
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !positiveId(Number(env.GITHUB_RUN_ID))
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !positiveId(Number(env.GITHUB_RUN_ATTEMPT))) return failPostMerge('UNTRUSTED_WORKFLOW');
  const event = object(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
  if (object(event.repository).full_name !== config.repository || object(event.repository).id !== config.repositoryId) return failPostMerge('UNTRUSTED_EVENT');
  let pr: number, eventTask: MergedTask | undefined;
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
    const raw = object(event.pull_request);
    if (event.action !== 'closed' || raw.merged !== true) return failPostMerge('UNTRUSTED_EVENT');
    pr = Number(raw.number); eventTask = mergedTask(raw);
  } else if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const input = object(event.inputs).pr;
    if (typeof input !== 'string' || !/^[1-9][0-9]*$/.test(input)) return failPostMerge('INVALID_PR');
    pr = Number(input);
  } else return failPostMerge('UNTRUSTED_EVENT');
  if (!positiveId(pr)) return failPostMerge('INVALID_PR');
  return { pr, controlSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID!, runAttempt: Number(env.GITHUB_RUN_ATTEMPT), eventTask };
}

const emptyChecks = (): Record<CheckName, PostMergeCheck> => Object.fromEntries(checkNames.map(name => [name,
  { status: 'pending', code: 'NOT_CHECKED' }])) as Record<CheckName, PostMergeCheck>;
async function freshTask(api: Transport, pr: number): Promise<MergedTask | undefined> {
  return mergedTask(await api('github', `${repoPrefix}pulls/${pr}`));
}

export async function verifyPostMerge(env: Readonly<Record<string, string | undefined>> = process.env, options: VerificationOptions = {}): Promise<PostMergeResult | undefined> {
  const context = await postMergeContext(env), api = options.api ?? transport(env), directory = options.directory ?? process.cwd();
  if (env.GITHUB_EVENT_NAME === 'pull_request_target' && !context.eventTask) return undefined;
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

type CommentMarker = { pr: number; mergeSha: string; mergedAt: string; runId: string; runAttempt: number; status: PostMergeResult['status'] };
function marker(result: PostMergeResult): CommentMarker {
  return { pr: result.task.source.pr, mergeSha: result.task.mergeSha, mergedAt: result.task.mergedAt,
    runId: result.runId, runAttempt: result.runAttempt, status: result.status };
}
function previousMarker(body: unknown): CommentMarker | undefined {
  if (typeof body !== 'string' || !body.startsWith(commentPrefix)) return undefined;
  const end = body.indexOf(' -->');
  if (end < 0 || end > 1000) return failPostMerge('COMMENT_INVALID');
  try {
    const value = object(JSON.parse(body.slice(commentPrefix.length, end)));
    if (!positiveId(value.pr) || !fullSha(value.mergeSha) || typeof value.mergedAt !== 'string' || !Number.isFinite(Date.parse(value.mergedAt))
      || typeof value.runId !== 'string' || !positiveId(Number(value.runId)) || !positiveId(value.runAttempt)
      || !['success', 'failed', 'timeout', 'superseded'].includes(String(value.status))) return failPostMerge('COMMENT_INVALID');
    return value as CommentMarker;
  } catch { return failPostMerge('COMMENT_INVALID'); }
}
export function stalePostMergeResult(previous: CommentMarker, next: PostMergeResult): boolean {
  const current = marker(next);
  if (previous.mergedAt !== current.mergedAt) return previous.mergedAt > current.mergedAt;
  if (previous.pr !== current.pr) return previous.pr > current.pr;
  if (previous.mergeSha !== current.mergeSha) return true;
  if (Number(previous.runId) !== Number(current.runId)) return Number(previous.runId) > Number(current.runId);
  return previous.runAttempt > current.runAttempt;
}

export function postMergeComment(result: PostMergeResult, otherWork: boolean): string {
  const labels = { success: '成功', failed: '失敗・要対応', timeout: '確認待ち（待機上限）', superseded: '後続のmain更新により未完了' };
  const names = { ci: 'main CI', production: '本番Deployment・alias', staging: '常設Preview・ブラウザ検証', cleanup: 'PR専用Preview・DB削除' };
  const runLink = (run: string | number) => `https://github.com/${config.repository}/actions/runs/${run}`;
  const lines = checkNames.map(name => {
    const check = result.checks[name];
    return `| ${names[name]} | ${check.status} / ${check.code} | ${check.runId ? `[Actions](${runLink(check.runId)})` : check.deploymentId ?? '—'} |`;
  });
  const blocking = result.task.metadata.manualPostMerge ? '人による確認が必要です。Issueは自動完了しません。'
    : !result.task.metadata.completesIssue ? '分割PRの結果です。Issueは継続します。'
    : otherWork ? '同じIssueに関連する未マージPRがあります。Issueは継続します。'
    : result.status !== 'success' ? '必要な確認が完了していません。Issueは継続します。' : '必要な自動確認が完了しました。';
  return `${commentPrefix}${JSON.stringify(marker(result))} -->\n## マージ後確認: ${labels[result.status]}\n\n`
    + `- PR: #${result.task.source.pr}\n- PR head SHA: ${result.task.source.sha}\n- Merge SHA: ${result.task.mergeSha}\n`
    + `- Intent: [案件記録](https://github.com/${config.repository}/tree/${result.task.mergeSha}/${result.task.metadata.intent})\n`
    + `- 確認日時: ${result.checkedAt}\n- 実行: [Actions](${runLink(result.runId)})（attempt ${result.runAttempt}）\n\n`
    + `| 確認 | 結果 | 根拠 |\n|---|---|---|\n${lines.join('\n')}\n\n${blocking}\n\n本番の画面操作・業務データ更新はこの確認に含みません。\n`;
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

export async function publishPostMerge(env: Readonly<Record<string, string | undefined>> = process.env, api: Transport = transport({ GH_TOKEN: env.GH_TOKEN }), directory = process.cwd()): Promise<void> {
  const context = await postMergeContext(env), path = resolve(directory, resultFile), stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 30_000) return failPostMerge('RESULT_INVALID');
  const result = parsePostMergeResult(JSON.parse(await readFile(path, 'utf8')));
  if (result.runId !== context.runId || result.runAttempt !== context.runAttempt || result.controlSha !== context.controlSha
    || result.task.source.pr !== context.pr) return failPostMerge('RESULT_MISMATCH');
  const current = await freshTask(api, context.pr);
  if (!current || !sameTask(current, result.task)) return failPostMerge('PR_CHANGED');
  const mainBefore = object(await api('github', `${repoPrefix}branches/main`));
  if (object(mainBefore.commit).sha !== current.mergeSha) result.status = 'superseded';
  const issue = object(await api('github', `${repoPrefix}issues/${current.metadata.issue}`));
  if (issue.number !== current.metadata.issue || issue.pull_request != null) return failPostMerge('ISSUE_INVALID');
  const comments = await githubPages(api, `issues/${current.metadata.issue}/comments`);
  const owned = comments.filter(comment => object(comment.user).login === 'github-actions[bot]' && object(comment.user).type === 'Bot'
    && typeof comment.body === 'string' && comment.body.startsWith(commentPrefix));
  if (owned.length > 1) return failPostMerge('COMMENT_AMBIGUOUS');
  const existing = owned[0], prior = existing && previousMarker(existing.body);
  if (prior && stalePostMergeResult(prior, result)) return;
  const pulls = await githubPages(api, 'pulls?state=open&base=main');
  const otherWork = pulls.some(pr => {
    try { return parseTaskMetadata(pr.body ?? '')?.issue === current.metadata.issue; }
    catch { return true; }
  });
  const body = postMergeComment(result, otherWork);
  if (existing) {
    if (!positiveId(existing.id)) return failPostMerge('COMMENT_INVALID');
    // Reject a moved/edited comment rather than overwriting another actor's content.
    const fresh = object(await api('github', `${repoPrefix}issues/comments/${existing.id}`));
    if (fresh.body !== existing.body || object(fresh.user).login !== 'github-actions[bot]') return failPostMerge('COMMENT_CHANGED');
    if (fresh.body !== body) await api('github', `${repoPrefix}issues/comments/${existing.id}`, 'PATCH', { body });
  } else await api('github', `${repoPrefix}issues/${current.metadata.issue}/comments`, 'POST', { body });
  const again = await freshTask(api, context.pr);
  if (!again || !sameTask(again, current)) return failPostMerge('PR_CHANGED');
  if (result.status === 'success' && current.metadata.completesIssue && !current.metadata.manualPostMerge && !otherWork && issue.state === 'open') {
    const main = object(await api('github', `${repoPrefix}branches/main`));
    if (object(main.commit).sha !== current.mergeSha) return;
    const latestPulls = await githubPages(api, 'pulls?state=open&base=main');
    if (latestPulls.some(pr => {
      try { return parseTaskMetadata(pr.body ?? '')?.issue === current.metadata.issue; } catch { return true; }
    })) return;
    await api('github', `${repoPrefix}issues/${current.metadata.issue}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const run = command === 'verify' ? async () => {
    const result = await verifyPostMerge();
    if (result && result.status !== 'success') process.exitCode = 1;
  } : command === 'publish' ? () => publishPostMerge() : () => failPostMerge('INVALID_COMMAND');
  Promise.resolve().then(run).catch(() => {
    console.error('Cake: マージ後確認を完了できませんでした。Actionsの実行状態とIssueの報告を確認してください。秘密値・外部応答は表示しません。');
    process.exitCode = 1;
  });
}

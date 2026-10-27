import { config, object, source, type Source } from '../preview/preview-model';
import { fullSha } from './task-workflow';

export type TaskMetadata = { issue: number; intent: string; completesIssue: boolean; manualPostMerge: boolean };
export type MergedTask = { source: Source; mergeSha: string; mergedAt: string; metadata: TaskMetadata };
export type PostMergeCheck = { status: 'pending' | 'success' | 'failure'; code: string; runId?: number; deploymentId?: string };
export type CheckName = 'ci' | 'production' | 'staging' | 'cleanup';
export type PostMergeResult = {
  protocol: 'cake-post-merge/v1'; task: MergedTask; controlSha: string; runId: string; runAttempt: number;
  status: 'success' | 'failed' | 'timeout' | 'superseded'; checkedAt: string; checks: Record<CheckName, PostMergeCheck>;
};
export const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export const isoTime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
export const failPostMerge = (code: string): never => { throw new Error(`POST_MERGE_${code}`); };

/** Metadata is data only. It never selects a script, URL, or filesystem input. */
export function parseTaskMetadata(body: unknown): TaskMetadata | undefined {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 1_000_000) return failPostMerge('METADATA_INVALID');
  const markers = body.match(/<!--\s*cake-task\/v1\b/g) ?? [];
  if (!markers.length) return undefined;
  const matches = [...body.matchAll(/<!-- cake-task\/v1 (\{[^\r\n]*\}) -->/g)];
  if (markers.length !== 1 || matches.length !== 1) return failPostMerge('METADATA_INVALID');
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(matches[0][1])); } catch { return failPostMerge('METADATA_INVALID'); }
  if (Object.keys(value).sort().join(',') !== 'completesIssue,intent,issue,manualPostMerge' || !positiveId(value.issue)
    || typeof value.intent !== 'string' || !/^aidlc\/spaces\/default\/intents\/[0-9]{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.intent)
    || value.intent.length > 180 || typeof value.completesIssue !== 'boolean' || typeof value.manualPostMerge !== 'boolean') return failPostMerge('METADATA_INVALID');
  // JSON.parse otherwise accepts duplicate keys, which could disagree with another reader.
  for (const key of ['issue', 'intent', 'completesIssue', 'manualPostMerge']) {
    if ([...matches[0][1].matchAll(new RegExp(`"${key}"\\s*:`, 'g'))].length !== 1) return failPostMerge('METADATA_INVALID');
  }
  return value as TaskMetadata;
}

export function mergedTask(value: unknown): MergedTask | undefined {
  const pr = object(value), metadata = parseTaskMetadata(pr.body ?? '');
  if (!metadata) return undefined;
  const current = source(pr);
  if (pr.merged !== true || current.state !== 'closed' || !fullSha(pr.merge_commit_sha) || !isoTime(pr.merged_at)
    || object(object(pr.base).repo).id !== config.repositoryId || object(object(pr.head).repo).id !== config.repositoryId) return failPostMerge('PR_INVALID');
  return { source: current, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at, metadata };
}

export function sameTask(a: MergedTask, b: MergedTask): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function parsePostMergeResult(value: unknown): PostMergeResult {
  const result = object(value), task = object(result.task), original = object(task.source), metadata = object(task.metadata);
  const parsedMetadata = parseTaskMetadata(`<!-- cake-task/v1 ${JSON.stringify(metadata)} -->`);
  if (result.protocol !== 'cake-post-merge/v1' || !parsedMetadata || !positiveId(original.pr)
    || typeof original.branch !== 'string' || !/^codex\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(original.branch)
    || !fullSha(original.sha) || original.state !== 'closed' || !isoTime(original.createdAt)
    || !fullSha(task.mergeSha) || !isoTime(task.mergedAt) || !fullSha(result.controlSha)
    || typeof result.runId !== 'string' || !/^[1-9][0-9]*$/.test(result.runId) || !positiveId(Number(result.runId))
    || !positiveId(result.runAttempt) || !isoTime(result.checkedAt)
    || !['success', 'failed', 'timeout', 'superseded'].includes(String(result.status))) return failPostMerge('RESULT_INVALID');
  const checks = object(result.checks), publicChecks: Partial<Record<CheckName, PostMergeCheck>> = {};
  if (Object.keys(checks).sort().join(',') !== 'ci,cleanup,production,staging') return failPostMerge('RESULT_INVALID');
  for (const name of ['ci', 'production', 'staging', 'cleanup'] as const) {
    const check = object(checks[name]);
    if (!['pending', 'success', 'failure'].includes(String(check.status)) || typeof check.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(check.code)
      || check.runId !== undefined && !positiveId(check.runId)
      || check.deploymentId !== undefined && (typeof check.deploymentId !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(check.deploymentId))) return failPostMerge('RESULT_INVALID');
    publicChecks[name] = { status: check.status as PostMergeCheck['status'], code: check.code,
      ...(check.runId !== undefined ? { runId: check.runId as number } : {}),
      ...(check.deploymentId !== undefined ? { deploymentId: check.deploymentId as string } : {}) };
  }
  if (result.status === 'success' && Object.values(checks).some(check => object(check).status !== 'success')) return failPostMerge('RESULT_INVALID');
  // Project the exact public schema; provider responses and messages never become a report.
  return { protocol: 'cake-post-merge/v1', task: { source: { pr: original.pr as number, branch: original.branch as string,
    sha: original.sha as string, createdAt: original.createdAt as string, state: 'closed' }, mergeSha: task.mergeSha as string,
    mergedAt: task.mergedAt as string, metadata: parsedMetadata }, controlSha: result.controlSha as string,
  runId: result.runId as string, runAttempt: result.runAttempt as number, status: result.status as PostMergeResult['status'],
  checkedAt: result.checkedAt as string, checks: publicChecks as PostMergeResult['checks'] };
}

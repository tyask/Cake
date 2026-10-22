import { createHash } from 'node:crypto';
import config from '../../preview.config.json';
import { fullSha, previewUrl, validTaskBranch } from '../task/task-workflow';
export { config };
export const protocol = 'cake-preview/v1';
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const object = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('PREVIEW_INVALID_RESPONSE'); return v as Record<string, unknown>; };
export const array = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new Error('PREVIEW_INCOMPLETE_INVENTORY'); return v; };
export const text = (v: unknown): string => { if (typeof v !== 'string' || !v) throw new Error('PREVIEW_INVALID_RESPONSE'); return v; };
export type Source = { pr: number; branch: string; sha: string; createdAt: string; state: 'open' | 'closed' };
export type Database = { branchId: string; endpointId: string; hostDigest: string };
export type Deployment = { id: string; url: string; sha: string; branch: string; pr: number; generation: string; operation: string; phase: 'provisioning' | 'application'; state: string; createdAt: number; database?: Database };
export function hostDigest(host: string): string {
  if (!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(host)) throw new Error('PREVIEW_DATABASE_IDENTITY');
  return createHash('sha256').update(host.toLowerCase().replace(/-pooler(?=\.)/, '')).digest('hex');
}
export function source(value: unknown): Source {
  const pr = object(value), head = object(pr.head), base = object(pr.base);
  if (!Number.isSafeInteger(pr.number) || Number(pr.number) < 1 || object(head.repo).full_name !== config.repository
    || object(base.repo).full_name !== config.repository || base.ref !== 'main' || !validTaskBranch(head.ref) || !fullSha(head.sha)
    || !['open','closed'].includes(String(pr.state)) || !Number.isFinite(Date.parse(String(pr.created_at)))) throw new Error('PREVIEW_PR_MISMATCH');
  return { pr: Number(pr.number), branch: head.ref, sha: head.sha, createdAt: String(pr.created_at), state: pr.state as Source['state'] };
}
export function deployment(value: unknown, expected: Source): Deployment {
  const d = object(value), m = object(d.meta), g = object(d.gitSource);
  if (d.projectId !== config.vercelProjectId || d.target != null || m.cakePreviewProtocol !== protocol || m.cakePreviewRepository !== config.repository
    || m.cakePreviewPr !== String(expected.pr) || g.type !== 'github' || String(g.repoId) !== String(config.repositoryId)
    || g.ref !== expected.branch || !fullSha(g.sha) || !uuid(m.cakePreviewGeneration) || !uuid(m.cakePreviewOperation)
    || !['provisioning','application'].includes(String(m.cakePreviewPhase)) || !/^dpl_[A-Za-z0-9]+$/.test(String(d.id ?? d.uid))
    || m.githubCommitRef !== undefined && m.githubCommitRef !== g.ref || m.githubCommitSha !== undefined && m.githubCommitSha !== g.sha) throw new Error('PREVIEW_DEPLOYMENT_MISMATCH');
  let database: Database | undefined;
  if (m.cakePreviewPhase === 'application') {
    if (!/^br-[a-z0-9-]+$/.test(String(m.cakePreviewDatabaseBranch)) || !/^ep-[a-z0-9-]+$/.test(String(m.cakePreviewDatabaseEndpoint))
      || !/^[a-f0-9]{64}$/.test(String(m.cakePreviewDatabaseDigest)) || m.cakePreviewDatabaseDigest === config.productionHostDigest) throw new Error('PREVIEW_DATABASE_IDENTITY');
    database = { branchId: String(m.cakePreviewDatabaseBranch), endpointId: String(m.cakePreviewDatabaseEndpoint), hostDigest: String(m.cakePreviewDatabaseDigest) };
  }
  const createdAt = Number(d.createdAt ?? d.created);
  if (!Number.isFinite(createdAt) || createdAt < Date.parse(expected.createdAt)) throw new Error('PREVIEW_DEPLOYMENT_MISMATCH');
  return { id: String(d.id ?? d.uid), url: previewUrl(d.url), sha: g.sha, branch: expected.branch, pr: expected.pr,
    generation: m.cakePreviewGeneration, operation: m.cakePreviewOperation, phase: m.cakePreviewPhase as Deployment['phase'], state: text(d.readyState ?? d.state), createdAt, database };
}
export function sameDatabase(a: Database, b: Database): boolean { return a.branchId === b.branchId && a.endpointId === b.endpointId && a.hostDigest === b.hostDigest; }

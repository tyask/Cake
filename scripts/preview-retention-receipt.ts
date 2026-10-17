import { config, sameDatabase, uuid, type Database, type Deployment, type Source } from './preview-model';
import { retentionActions, retentionProtocol, retentionStages, parseRetentionEvidence, sameRetentionEvidence, type RetentionAction, type RetentionEvidence, type RetentionStage } from './preview-retention-model';
import { exactDeploymentIdentity } from './preview-verify-receipt';
import { receiptMaxBytes } from './preview-receipt';
import { fullSha, previewUrl, validTaskBranch } from './task-workflow';

export const retentionReceiptNoticeTitle = retentionProtocol;
export const retentionFailureCodes = ['PREVIEW_RETENTION_PREFLIGHT_FAILED', 'PREVIEW_RETENTION_TARGET_CHANGED', 'PREVIEW_RETENTION_BROWSER_FAILED', 'PREVIEW_RETENTION_WRITE_UNKNOWN', 'PREVIEW_RETENTION_EVIDENCE_CHANGED', 'PREVIEW_RETENTION_UPDATE_FAILED', 'PREVIEW_RETENTION_UPDATE_UNKNOWN', 'PREVIEW_RETENTION_REPLAY'] as const;
export type RetentionResult = {
  protocol: typeof retentionProtocol; action: RetentionAction; source: Source; expectedDeploymentId: string; marker: string;
  baselineRunId?: string; updateRunId?: string; attemptedDeploymentId?: string; deployment?: Deployment; database?: Database; evidence?: RetentionEvidence;
  outcome: 'present' | 'absent' | 'unknown'; writeAttempts: 0 | 1; observedAt?: string; runtimeBeforeAt?: string; runtimeAfterAt?: string;
  checkedAt: string; success: boolean; failure?: { stage: RetentionStage; code: typeof retentionFailureCodes[number] };
};
export type RetentionReceipt = RetentionResult & { operation: string; runId: string; runAttempt: number; controlSha: string };
export type RetentionReceiptRequest = {
  action: RetentionAction; source: Source; expectedDeploymentId: string; expectedDeployment?: Deployment; marker: string;
  baselineRunId?: string; updateRunId?: string; operation: string; runId: string; runAttempt: number; controlSha: string;
  notBefore?: string; notAfter?: string;
};
const invalid = (): never => { throw new Error('PREVIEW_RETENTION_RECEIPT_INVALID'); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return invalid();
  const at = Date.parse(value), canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(at) || new Date(at).toISOString() !== canonical) return invalid();
  return at;
}
function database(value: unknown): Database {
  const db = record(value); keys(db, ['branchId', 'endpointId', 'hostDigest']);
  if (typeof db.branchId !== 'string' || !/^br-[a-z0-9-]+$/.test(db.branchId) || typeof db.endpointId !== 'string' || !/^ep-[a-z0-9-]+$/.test(db.endpointId)
    || typeof db.hostDigest !== 'string' || !/^[a-f0-9]{64}$/.test(db.hostDigest) || db.hostDigest === config.productionHostDigest) invalid();
  return db as Database;
}
function deployment(value: unknown, source: Source, db: Database): Deployment {
  const d = record(value); keys(d, ['id', 'url', 'sha', 'branch', 'pr', 'generation', 'operation', 'phase', 'state', 'createdAt', 'database']);
  let url: string;
  try { url = previewUrl(d.url); } catch { return invalid(); }
  if (typeof d.id !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(d.id) || d.url !== url || d.pr !== source.pr || d.branch !== source.branch || d.sha !== source.sha
    || !uuid(d.generation) || !uuid(d.operation) || d.phase !== 'application' || d.state !== 'READY' || !Number.isSafeInteger(d.createdAt)
    || Number(d.createdAt) < timestamp(source.createdAt) || !sameDatabase(database(d.database), db)) invalid();
  return d as Deployment;
}
function evidence(value: unknown): RetentionEvidence {
  try { return parseRetentionEvidence(value); } catch { return invalid(); }
}
function validate(value: unknown): RetentionReceipt {
  const r = record(value);
  keys(r, ['protocol', 'action', 'source', 'expectedDeploymentId', 'marker', 'outcome', 'writeAttempts', 'checkedAt', 'success', 'operation', 'runId', 'runAttempt', 'controlSha'],
    ['baselineRunId', 'updateRunId', 'attemptedDeploymentId', 'deployment', 'database', 'evidence', 'observedAt', 'runtimeBeforeAt', 'runtimeAfterAt', 'failure']);
  if (r.protocol !== retentionProtocol || !(retentionActions as readonly unknown[]).includes(r.action) || !uuid(r.marker) || !uuid(r.operation)
    || !id(r.runId) || r.runAttempt !== 1 || !fullSha(r.controlSha) || typeof r.success !== 'boolean'
    || typeof r.expectedDeploymentId !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(r.expectedDeploymentId)
    || typeof r.outcome !== 'string' || !['present', 'absent', 'unknown'].includes(r.outcome) || ![0, 1].includes(Number(r.writeAttempts)) || typeof r.writeAttempts !== 'number'
    || r.baselineRunId !== undefined && (!id(r.baselineRunId) || r.baselineRunId === r.runId)
    || r.updateRunId !== undefined && (!id(r.updateRunId) || r.updateRunId === r.runId)) invalid();
  const s = record(r.source); keys(s, ['pr', 'branch', 'sha', 'createdAt', 'state']);
  if (!Number.isSafeInteger(s.pr) || Number(s.pr) < 1 || !validTaskBranch(s.branch) || !fullSha(s.sha) || s.state !== 'open') invalid();
  const createdAt = timestamp(s.createdAt), checkedAt = timestamp(r.checkedAt);
  if (checkedAt < createdAt) invalid();
  const action = r.action as RetentionAction, writes = action === 'retention-prepare' || action === 'retention-update';
  if (r.attemptedDeploymentId !== undefined && (typeof r.attemptedDeploymentId !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(r.attemptedDeploymentId)
    || !['retention-update', 'retention-reconcile'].includes(action) || r.attemptedDeploymentId === r.expectedDeploymentId)) invalid();
  if (writes && r.operation !== r.marker || !writes && r.writeAttempts !== 0) invalid();
  if (action === 'retention-prepare' && (r.baselineRunId !== undefined || r.updateRunId !== undefined)
    || action !== 'retention-prepare' && r.baselineRunId === undefined
    || ['retention-reconcile', 'retention-check'].includes(action) !== (r.updateRunId !== undefined)) invalid();
  const db = r.database === undefined ? undefined : database(r.database);
  if ((r.deployment === undefined) !== (db === undefined)) invalid();
  const rawDeployment = r.deployment === undefined ? undefined : record(r.deployment);
  const anchor = !r.success && ['retention-update', 'retention-reconcile'].includes(action) && rawDeployment?.id === r.expectedDeploymentId;
  if (anchor && !fullSha(rawDeployment?.sha)) invalid();
  const d = rawDeployment === undefined ? undefined : deployment(rawDeployment, anchor ? { ...s, sha: rawDeployment.sha } as Source : s as Source, db!);
  if (action === 'retention-prepare' && r.writeAttempts === 1 && !d) invalid();
  if (d && !['retention-update', 'retention-reconcile'].includes(action) && d.id !== r.expectedDeploymentId) invalid();
  if (d && ['retention-update', 'retention-reconcile'].includes(action) && !anchor && (d.id === r.expectedDeploymentId || d.operation !== r.marker)) invalid();
  if (d && d.id !== r.expectedDeploymentId && r.attemptedDeploymentId !== undefined && r.attemptedDeploymentId !== d.id) invalid();
  const e = r.evidence === undefined ? undefined : evidence(r.evidence);
  if (e && (e.marker !== r.marker || r.outcome !== 'present')) invalid();
  if (r.outcome === 'present' && !e) invalid();
  let previous = createdAt;
  for (const field of ['runtimeBeforeAt', 'observedAt', 'runtimeAfterAt'] as const) if (r[field] !== undefined) {
    const at = timestamp(r[field]); if (at < previous || at > checkedAt) invalid(); previous = at;
  }
  if (r.runtimeAfterAt !== undefined && (r.runtimeBeforeAt === undefined || r.observedAt === undefined)) invalid();
  if (r.success) {
    if (r.failure !== undefined || !d) invalid();
    if (['retention-prepare', 'retention-inspect', 'retention-check'].includes(action) && (r.outcome !== 'present' || !e)) invalid();
    if (['retention-prepare', 'retention-inspect', 'retention-check'].includes(action)
      && (r.observedAt === undefined || r.runtimeBeforeAt === undefined || r.runtimeAfterAt === undefined || r.outcome === 'unknown')) invalid();
    if (writes && r.writeAttempts !== 1) invalid();
  } else {
    const f = record(r.failure); keys(f, ['stage', 'code']);
    if (!(retentionStages as readonly unknown[]).includes(f.stage) || !(retentionFailureCodes as readonly unknown[]).includes(f.code)) invalid();
  }
  return r as RetentionReceipt;
}
const project = (value: unknown, names: readonly string[]): Record<string, unknown> => {
  const input = record(value); return Object.fromEntries(names.filter(name => Object.hasOwn(input, name)).map(name => [name, input[name]]));
};
const databaseFields = ['branchId', 'endpointId', 'hostDigest'];
const evidenceFields = ['marker', 'workspaceId', 'transactionId', 'matchingCount', 'amountYen', 'transactionCount', 'totalAmountYen', 'contentDigest', 'collectionDigest', 'fixtureDigest'];
export function serializeRetentionReceipt(input: unknown): string {
  const r = project(input, ['protocol', 'action', 'source', 'expectedDeploymentId', 'marker', 'baselineRunId', 'updateRunId', 'attemptedDeploymentId', 'deployment', 'database', 'evidence', 'outcome', 'writeAttempts', 'observedAt', 'runtimeBeforeAt', 'runtimeAfterAt', 'checkedAt', 'success', 'failure', 'operation', 'runId', 'runAttempt', 'controlSha']);
  r.source = project(r.source, ['pr', 'branch', 'sha', 'createdAt', 'state']);
  if (r.database !== undefined) r.database = project(r.database, databaseFields);
  if (r.deployment !== undefined) {
    const d = project(r.deployment, ['id', 'url', 'sha', 'branch', 'pr', 'generation', 'operation', 'phase', 'state', 'createdAt', 'database']);
    if (d.database !== undefined) d.database = project(d.database, databaseFields); r.deployment = d;
  }
  if (r.evidence !== undefined) r.evidence = project(r.evidence, evidenceFields);
  if (r.failure !== undefined) r.failure = project(r.failure, ['stage', 'code']);
  const text = JSON.stringify(validate(r));
  if (Buffer.byteLength(text, 'utf8') > receiptMaxBytes) throw new Error('PREVIEW_RETENTION_RECEIPT_TOO_LARGE');
  if (text.includes('***')) invalid(); return text;
}
function rejectDuplicateKeys(text: string): void {
  const scopes: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') scopes.push(new Set()); else if (text[i] === '[') scopes.push(null);
    else if (text[i] === '}' || text[i] === ']') scopes.pop();
    else if (text[i] === '"') {
      const start = i; for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      let next = i + 1; while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === ':') {
        const name = JSON.parse(text.slice(start, i + 1)) as string, scope = scopes.at(-1);
        if (!scope) return invalid(); if (scope.has(name)) invalid(); scope.add(name);
      }
    }
  }
}
export function parseRetentionReceipt(text: string): RetentionReceipt {
  if (Buffer.byteLength(text, 'utf8') > receiptMaxBytes) throw new Error('PREVIEW_RETENTION_RECEIPT_TOO_LARGE');
  if (text.includes('***')) invalid(); let value: unknown;
  try { value = JSON.parse(text); rejectDuplicateKeys(text); } catch { return invalid(); }
  return validate(value);
}
export function retentionReceiptNoticeCommand(receipt: RetentionReceipt): string {
  return `::notice title=${retentionReceiptNoticeTitle}::${serializeRetentionReceipt(receipt).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;
}
export function assertRetentionReceipt(r: RetentionReceipt, expected: RetentionReceiptRequest): void {
  validate(r);
  for (const key of ['action', 'expectedDeploymentId', 'marker', 'baselineRunId', 'updateRunId', 'operation', 'runId', 'runAttempt', 'controlSha'] as const) if (r[key] !== expected[key]) invalid();
  if ((['pr', 'branch', 'sha', 'createdAt', 'state'] as const).some(key => r.source[key] !== expected.source[key])) invalid();
  if (expected.expectedDeployment) {
    const d = expected.expectedDeployment;
    if (!exactDeploymentIdentity(d, d) || d.id !== expected.expectedDeploymentId || d.pr !== r.source.pr || d.branch !== r.source.branch) invalid();
    if (r.deployment && (['retention-update', 'retention-reconcile'].includes(r.action)
      ? d.generation !== r.deployment.generation || !sameDatabase(d.database!, r.database!) || r.deployment.id === d.id && !exactDeploymentIdentity(d, r.deployment)
      : !exactDeploymentIdentity(d, r.deployment))) invalid();
  }
  const start = expected.notBefore === undefined ? timestamp(r.source.createdAt) : timestamp(expected.notBefore), end = expected.notAfter === undefined ? Infinity : timestamp(expected.notAfter);
  for (const at of [r.checkedAt, r.observedAt, r.runtimeBeforeAt, r.runtimeAfterAt]) if (at !== undefined && (timestamp(at) < start || timestamp(at) > end)) invalid();
}
function sameAcceptance(a: RetentionReceipt, b: RetentionReceipt): boolean {
  return a.source.pr === b.source.pr && a.source.branch === b.source.branch && a.source.createdAt === b.source.createdAt && a.marker === b.marker;
}
export function assertRegistrationBaseline(baseline: RetentionReceipt, originalPrepare?: RetentionReceipt): void {
  validate(baseline);
  if (!baseline.success || baseline.outcome !== 'present' || !baseline.evidence || !baseline.deployment || !baseline.database) return invalid();
  if (baseline.action === 'retention-prepare') { if (baseline.writeAttempts !== 1 || originalPrepare !== undefined) invalid(); return; }
  if (baseline.action !== 'retention-inspect' || !originalPrepare) return invalid();
  validate(originalPrepare);
  if (originalPrepare.action !== 'retention-prepare' || originalPrepare.writeAttempts !== 1 || baseline.baselineRunId !== originalPrepare.runId
    || !sameAcceptance(baseline, originalPrepare) || baseline.source.sha !== originalPrepare.source.sha
    || baseline.expectedDeploymentId !== originalPrepare.expectedDeploymentId
    || !originalPrepare.deployment || !exactDeploymentIdentity(baseline.deployment, originalPrepare.deployment)
    || originalPrepare.evidence && !sameRetentionEvidence(baseline.evidence, originalPrepare.evidence)) invalid();
}
export function assertRetentionBaselineTarget(baseline: RetentionReceipt, source: Source, target?: Deployment): void {
  validate(baseline);
  if (!baseline.success || !['retention-prepare', 'retention-inspect'].includes(baseline.action) || baseline.outcome !== 'present' || !baseline.evidence || !baseline.deployment
    || source.state !== 'open' || source.pr !== baseline.source.pr || source.branch !== baseline.source.branch || source.createdAt !== baseline.source.createdAt) return invalid();
  if (target && (!exactDeploymentIdentity(target, target) || target.pr !== source.pr || target.branch !== source.branch
    || target.generation !== baseline.deployment.generation || !sameDatabase(target.database!, baseline.database!))) invalid();
}
export function assertRetentionUpdate(update: RetentionReceipt, baseline: RetentionReceipt, originalUpdate?: RetentionReceipt): void {
  validate(update); assertRetentionBaselineTarget(baseline, update.source, update.deployment);
  if (!update.success || !update.deployment || update.source.sha === baseline.source.sha || update.baselineRunId !== baseline.runId
    || update.expectedDeploymentId !== baseline.deployment!.id || !sameAcceptance(update, baseline)
    || update.evidence && !sameRetentionEvidence(update.evidence, baseline.evidence!)) return invalid();
  if (update.action === 'retention-update') { if (update.writeAttempts !== 1 || originalUpdate !== undefined) invalid(); return; }
  if (update.action !== 'retention-reconcile' || !originalUpdate) return invalid(); validate(originalUpdate);
  if (originalUpdate.action !== 'retention-update' || originalUpdate.writeAttempts !== 1 || update.updateRunId !== originalUpdate.runId
    || originalUpdate.baselineRunId !== baseline.runId || !sameAcceptance(originalUpdate, baseline) || originalUpdate.source.sha !== update.source.sha
    || originalUpdate.expectedDeploymentId !== baseline.deployment!.id
    || originalUpdate.attemptedDeploymentId !== undefined && originalUpdate.attemptedDeploymentId !== update.deployment.id
    || originalUpdate.evidence && !sameRetentionEvidence(originalUpdate.evidence, baseline.evidence!)
    || originalUpdate.deployment && !exactDeploymentIdentity(originalUpdate.deployment,
      originalUpdate.deployment.id === baseline.deployment!.id ? baseline.deployment! : update.deployment)) invalid();
}

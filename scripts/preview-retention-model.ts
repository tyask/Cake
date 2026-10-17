import { createHash } from 'node:crypto';
import { uuid } from './preview-model';

export const retentionProtocol = 'cake-preview-retention/v1';
export const retentionActions = ['retention-prepare', 'retention-inspect', 'retention-update', 'retention-reconcile', 'retention-check'] as const;
export type RetentionAction = typeof retentionActions[number];
export const retentionStages = ['preflight', 'baseline', 'history', 'update', 'reconcile', 'evidence', 'postflight',
  'oidc', 'launch', 'navigation', 'runtime-before', 'login', 'read-before', 'write', 'read-after', 'runtime-after', 'boundary'] as const;
export type RetentionStage = typeof retentionStages[number];
export const retentionWorkspaceId = '00000000-0000-4000-8000-000000000001';
export const retentionAmountYen = 1234;
export const retentionOccurredAt = '2020-01-01T00:00:00.000Z';
export const isRetentionMarker = uuid;
export type RetentionEvidence = {
  marker: string; workspaceId: string; transactionId: string; matchingCount: 1; amountYen: 1234;
  transactionCount: number; totalAmountYen: number; contentDigest: string; collectionDigest: string; fixtureDigest: string;
};
export type RetentionBrowserRequest = { mode: 'prepare' | 'inspect' | 'check'; marker: string; baseline?: RetentionEvidence };
export type RetentionBrowserResult = {
  success: boolean; outcome: 'present' | 'absent' | 'unknown'; writeAttempts: 0 | 1; evidence?: RetentionEvidence;
  observedAt: string; runtimeBeforeAt?: string; runtimeAfterAt?: string; failureStage?: RetentionStage;
};
const invalid = (): never => { throw new Error('PREVIEW_RETENTION_EVIDENCE_INVALID'); };
export function retentionPayload(marker: string) {
  if (!isRetentionMarker(marker)) return invalid();
  return { action: 'saveTransaction', workspaceId: retentionWorkspaceId, occurredAt: retentionOccurredAt,
    merchant: 'Cake retention test', method: 'QA_TEST', type: 'PAYMENT', amountYen: retentionAmountYen,
    actorUserId: 'test-user-a', expenseClass: 'PERSONAL', splitWeights: { 'test-user-a': 1, 'test-user-b': 0 }, memo: `cake-retention:${marker}` } as const;
}
export function parseRetentionEvidence(value: unknown): RetentionEvidence {
  const e = record(value);
  keys(e, ['marker', 'workspaceId', 'transactionId', 'matchingCount', 'amountYen', 'transactionCount', 'totalAmountYen', 'contentDigest', 'collectionDigest', 'fixtureDigest']);
  if (!isRetentionMarker(e.marker) || e.workspaceId !== retentionWorkspaceId || !isUuid(e.transactionId)
    || e.matchingCount !== 1 || e.amountYen !== retentionAmountYen || !integer(e.transactionCount, 1)
    || !integer(e.totalAmountYen, retentionAmountYen) || ![e.contentDigest, e.collectionDigest, e.fixtureDigest].every(digest)) return invalid();
  return e as RetentionEvidence;
}
export function sameRetentionEvidence(a: RetentionEvidence, b: RetentionEvidence): boolean {
  try { return canonical(parseRetentionEvidence(a)) === canonical(parseRetentionEvidence(b)); } catch { return false; }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[]): void {
  if (Object.keys(value).length !== required.length || required.some(key => !Object.hasOwn(value, key))) invalid();
}
function integer(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && Number(value) >= min; }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value); }
/** Object key and collection ordering are explicit; only validated projections call this helper. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

export type RetentionSnapshot = {
  transactionCount: number; totalAmountYen: number; collectionDigest: string; fixtureDigest: string;
  withoutMarkerDigest: string; evidence?: RetentionEvidence;
};
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return invalid();
  return value;
}
function image(value: unknown): string | null { return value === null ? null : text(value, 2048); }
const memberIds = ['test-user-a', 'test-user-b'] as const;
function member(value: unknown) {
  const m = record(value);
  keys(m, ['id', 'email', 'name', 'imageUrl', 'weight', 'role']);
  const index = memberIds.indexOf(m.id as typeof memberIds[number]);
  if (index < 0 || m.email !== (index ? 'test-b@cake.local' : 'test-a@cake.local')
    || m.role !== (index ? 'MEMBER' : 'OWNER') || m.weight !== 1) return invalid();
  return { id: memberIds[index], email: String(m.email), name: text(m.name, 120), imageUrl: image(m.imageUrl), weight: 1, role: String(m.role) };
}
function workspace(value: unknown) {
  const w = record(value);
  keys(w, ['id', 'name', 'type', 'ownerUserId', 'memberCount']);
  if (w.id !== retentionWorkspaceId || w.type !== 'SHARED' || w.ownerUserId !== memberIds[0] || w.memberCount !== 2) return invalid();
  return { id: retentionWorkspaceId, name: text(w.name, 80), type: 'SHARED', ownerUserId: memberIds[0], memberCount: 2 };
}
function transaction(value: unknown, members: ReturnType<typeof member>[]) {
  const t = record(value);
  keys(t, ['id', 'occurredAt', 'merchant', 'method', 'memo', 'type', 'amountYen', 'actorUserId', 'actorName', 'expenseClass', 'splitWeights', 'settledAt', 'externalId', 'source']);
  const actor = members.find(m => m.id === t.actorUserId), weights = record(t.splitWeights);
  keys(weights, memberIds);
  if (!isUuid(t.id) || !actor || t.actorName !== actor.name || !['PAYMENT', 'RECEIPT'].includes(String(t.type))
    || !integer(t.amountYen, 1) || Number(t.amountYen) > 2_147_483_647 || !['PERSONAL', 'SHARED'].includes(String(t.expenseClass))
    || !['MANUAL', 'PAYPAY', 'RECURRING'].includes(String(t.source))
    || !memberIds.every(id => integer(weights[id]) && Number(weights[id]) <= 2_147_483_647)
    || !memberIds.some(id => Number(weights[id]) > 0)
    || t.expenseClass === 'PERSONAL' && memberIds.some(id => weights[id] !== (id === actor.id ? 1 : 0))) return invalid();
  return { id: String(t.id), occurredAt: timestamp(t.occurredAt), merchant: text(t.merchant, 240), method: text(t.method, 120),
    memo: text(t.memo, 2000, true), type: String(t.type), amountYen: Number(t.amountYen), actorUserId: actor.id, actorName: actor.name,
    expenseClass: String(t.expenseClass), splitWeights: { 'test-user-a': Number(weights['test-user-a']), 'test-user-b': Number(weights['test-user-b']) },
    settledAt: t.settledAt === null ? null : timestamp(t.settledAt), externalId: text(t.externalId, 2048), source: String(t.source) };
}
/** No raw application values leave the process: only fixed identifiers, counts and digests. */
export function retentionSnapshot(value: unknown, marker: string): RetentionSnapshot {
  const payload = retentionPayload(marker), app = record(value), selected = record(app.selected), user = record(app.user);
  keys(user, ['id', 'email', 'name', 'imageUrl', 'isAdmin', 'isEnabled']);
  if (user.id !== memberIds[0] || user.email !== 'test-a@cake.local' || user.isAdmin !== true || user.isEnabled !== true
    || !Array.isArray(selected.members) || selected.members.length !== 2 || !Array.isArray(selected.transactions) || !Array.isArray(app.workspaces)) return invalid();
  const shared = workspace(selected.workspace), members = selected.members.map(member).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (members[0].id !== memberIds[0] || members[1].id !== memberIds[1] || user.name !== members[0].name || image(user.imageUrl) !== members[0].imageUrl) return invalid();
  const summaries = app.workspaces.filter(w => record(w).id === retentionWorkspaceId);
  if (summaries.length !== 1 || canonical(workspace(summaries[0])) !== canonical(shared)) return invalid();
  const transactions = selected.transactions.map(t => transaction(t, members)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(transactions.map(t => t.id)).size !== transactions.length) return invalid();
  const totalAmountYen = transactions.reduce((sum, t) => sum + t.amountYen, 0);
  if (!integer(totalAmountYen)) return invalid();
  const markerRows = transactions.filter(t => t.memo.includes(`cake-retention:${marker}`));
  if (transactions.some(t => t.memo.startsWith('cake-retention:') && t.memo !== payload.memo) || markerRows.length > 1) return invalid();
  const fixtureDigest = hash({ workspace: shared, members,
    user: { id: memberIds[0], email: 'test-a@cake.local', name: members[0].name, imageUrl: members[0].imageUrl, isAdmin: true, isEnabled: true } });
  const collectionDigest = hash(transactions), snapshot: RetentionSnapshot = { transactionCount: transactions.length, totalAmountYen,
    collectionDigest, fixtureDigest, withoutMarkerDigest: hash(transactions.filter(t => !markerRows.includes(t))) };
  if (!markerRows.length) return snapshot;
  const t = markerRows[0];
  if (t.occurredAt !== payload.occurredAt || t.merchant !== payload.merchant || t.method !== payload.method || t.type !== payload.type
    || t.amountYen !== payload.amountYen || t.actorUserId !== payload.actorUserId || t.expenseClass !== payload.expenseClass
    || canonical(t.splitWeights) !== canonical(payload.splitWeights) || t.memo !== payload.memo || t.settledAt !== null
    || t.source !== 'MANUAL' || t.externalId !== `manual_${t.id}`) return invalid();
  snapshot.evidence = { marker, workspaceId: retentionWorkspaceId, transactionId: t.id, matchingCount: 1, amountYen: retentionAmountYen,
    transactionCount: transactions.length, totalAmountYen, contentDigest: hash(t), collectionDigest, fixtureDigest };
  return snapshot;
}

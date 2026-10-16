import { config, protocol, sameDatabase, uuid, type Database, type Source } from './preview-model';
import type { Receipt } from './preview-service';
import { fullSha, previewUrl, validTaskBranch } from './task-workflow';

export const receiptNoticeTitle = 'cake-preview-receipt/v1';
// The Actions runner truncates annotation messages at 4,096 characters. A byte
// limit also bounds non-ASCII JSON and is checked before emitting anything.
export const receiptMaxBytes = 4096;
export type OperationReceipt = Receipt & { action: 'deploy' | 'status' | 'cleanup'; operation: string | null; runId: string; runAttempt: number; controlSha: string };
export type ReceiptRequest = {
  action: 'deploy' | 'status' | 'cleanup'; source: Source; operation: string | null;
  runId: string; runAttempt: number; controlSha: string; notBefore?: string; notAfter?: string;
};
const invalid = (): never => { throw new Error('PREVIEW_RECEIPT_INVALID'); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return invalid();
  const time = Date.parse(value), canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(time) || new Date(time).toISOString() !== canonical) return invalid();
  return time;
}
function database(value: unknown): Database {
  const db = record(value);
  keys(db, ['branchId', 'endpointId', 'hostDigest']);
  if (typeof db.branchId !== 'string' || !/^br-[a-z0-9-]+$/.test(db.branchId)
    || typeof db.endpointId !== 'string' || !/^ep-[a-z0-9-]+$/.test(db.endpointId)
    || typeof db.hostDigest !== 'string' || !/^[a-f0-9]{64}$/.test(db.hostDigest)
    || db.hostDigest === config.productionHostDigest) return invalid();
  return db as Database;
}
function validate(value: unknown): OperationReceipt {
  const receipt = record(value);
  keys(receipt, ['protocol', 'action', 'source', 'checkedAt', 'success', 'operation', 'runId', 'runAttempt', 'controlSha'], ['deployment', 'database']);
  if (receipt.protocol !== protocol || receipt.success !== true || typeof receipt.action !== 'string' || !['deploy', 'status', 'cleanup'].includes(receipt.action)
    || !(uuid(receipt.operation) || receipt.operation === null && receipt.action === 'cleanup')
    || typeof receipt.runId !== 'string' || !/^[1-9][0-9]*$/.test(receipt.runId) || !Number.isSafeInteger(Number(receipt.runId))
    || !Number.isSafeInteger(receipt.runAttempt) || Number(receipt.runAttempt) < 1 || !fullSha(receipt.controlSha)) return invalid();
  const source = record(receipt.source);
  keys(source, ['pr', 'branch', 'sha', 'createdAt', 'state']);
  if (!Number.isSafeInteger(source.pr) || Number(source.pr) < 1 || !validTaskBranch(source.branch) || !fullSha(source.sha)
    || typeof source.state !== 'string' || !['open', 'closed'].includes(source.state) || receipt.action === 'cleanup' && source.state !== 'closed'
    || receipt.action === 'deploy' && source.state !== 'open') return invalid();
  const createdAt = timestamp(source.createdAt), checkedAt = timestamp(receipt.checkedAt);
  if (checkedAt < createdAt) return invalid();
  const db = receipt.database === undefined ? undefined : database(receipt.database);
  if (receipt.deployment !== undefined) {
    const d = record(receipt.deployment);
    keys(d, ['id', 'url', 'sha', 'branch', 'pr', 'generation', 'operation', 'phase', 'state', 'createdAt', 'database']);
    let normalizedUrl: string;
    try { normalizedUrl = previewUrl(d.url); } catch { return invalid(); }
    if (d.url !== normalizedUrl || typeof d.id !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(d.id)
      || !uuid(d.generation) || !uuid(d.operation) || d.pr !== source.pr || d.branch !== source.branch || d.sha !== source.sha
      || d.state !== 'READY' || d.phase !== 'application' || typeof d.createdAt !== 'number' || !Number.isFinite(d.createdAt)
      || d.createdAt < createdAt || !db || !sameDatabase(database(d.database), db)) return invalid();
  }
  if (receipt.action === 'deploy' && !receipt.deployment || receipt.action === 'cleanup' && (receipt.deployment !== undefined || db)) return invalid();
  return receipt as OperationReceipt;
}
function project(value: unknown, names: readonly string[]): Record<string, unknown> {
  const input = record(value);
  return Object.fromEntries(names.filter(name => Object.hasOwn(input, name)).map(name => [name, input[name]]));
}
function projectDatabase(value: unknown): Record<string, unknown> { return project(value, ['branchId', 'endpointId', 'hostDigest']); }
/** Project public fields explicitly; provider/private additions never become log output. */
export function serializeReceipt(input: unknown): string {
  const receipt = project(input, ['protocol', 'action', 'source', 'deployment', 'database', 'checkedAt', 'success', 'operation', 'runId', 'runAttempt', 'controlSha']);
  receipt.source = project(receipt.source, ['pr', 'branch', 'sha', 'createdAt', 'state']);
  if (receipt.database !== undefined) receipt.database = projectDatabase(receipt.database);
  if (receipt.deployment !== undefined) {
    const d = project(receipt.deployment, ['id', 'url', 'sha', 'branch', 'pr', 'generation', 'operation', 'phase', 'state', 'createdAt', 'database']);
    if (d.database !== undefined) d.database = projectDatabase(d.database);
    receipt.deployment = d;
  }
  const result = JSON.stringify(validate(receipt));
  if (Buffer.byteLength(result, 'utf8') > receiptMaxBytes) throw new Error('PREVIEW_RECEIPT_TOO_LARGE');
  return result;
}
// JSON.parse accepts duplicate object keys. After syntax validation, inspect only
// string tokens followed by a colon, maintaining a key set for each object.
function rejectDuplicateKeys(text: string): void {
  const scopes: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') scopes.push(new Set());
    else if (c === '[') scopes.push(null);
    else if (c === '}' || c === ']') scopes.pop();
    else if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      let next = i + 1;
      while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const name = JSON.parse(text.slice(start, i + 1)) as string, scope = scopes.at(-1);
        if (!scope) return invalid();
        if (scope.has(name)) invalid();
        scope.add(name);
      }
    }
  }
}
export function parseReceipt(text: string): OperationReceipt {
  if (Buffer.byteLength(text, 'utf8') > receiptMaxBytes) throw new Error('PREVIEW_RECEIPT_TOO_LARGE');
  let parsed: unknown;
  try { parsed = JSON.parse(text); rejectDuplicateKeys(text); } catch { return invalid(); }
  return validate(parsed);
}
/** Bind every public source field and request field to the independently verified run. */
export function assertReceipt(receipt: OperationReceipt, expected: ReceiptRequest): void {
  validate(receipt);
  if (receipt.action !== expected.action || receipt.operation !== expected.operation || receipt.runId !== expected.runId
    || receipt.runAttempt !== expected.runAttempt || receipt.controlSha !== expected.controlSha
    || (['pr', 'branch', 'sha', 'createdAt', 'state'] as const).some(key => receipt.source[key] !== expected.source[key])) invalid();
  const checkedAt = timestamp(receipt.checkedAt);
  if (expected.notBefore !== undefined && checkedAt < timestamp(expected.notBefore)
    || expected.notAfter !== undefined && checkedAt > timestamp(expected.notAfter)) invalid();
}
export function receiptNoticeCommand(receipt: OperationReceipt): string {
  // Escape workflow command data in the documented order; do not escape JSON or
  // interpolate any unvalidated provider response directly into command output.
  const message = serializeReceipt(receipt).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `::notice title=${receiptNoticeTitle}::${message}`;
}

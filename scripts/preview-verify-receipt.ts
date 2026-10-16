import { config, sameDatabase, uuid, type Database, type Deployment, type Source } from './preview-model';
import { receiptMaxBytes } from './preview-receipt';
import { fullSha, previewUrl, validTaskBranch } from './task-workflow';

export const verifyReceiptProtocol = 'cake-preview-verify/v1';
export const verifyReceiptNoticeTitle = verifyReceiptProtocol;
export const verifyBrowserCases = ['desktop-a', 'desktop-b', 'mobile-a', 'mobile-b', 'read-api'] as const;
export const verifyFailureCodes = ['PREVIEW_VERIFY_STATUS_FAILED', 'PREVIEW_VERIFY_TARGET_CHANGED', 'PREVIEW_VERIFY_BROWSER_FAILED', 'PREVIEW_VERIFY_OIDC_UNAVAILABLE'] as const;
export const verifyBrowserStages = ['oidc', 'launch', 'navigation', 'runtime-before', 'login', 'session-app', 'navigation-clicks', 'runtime-after', 'boundary'] as const;
export type VerifyBrowserEvidence = {
  cases: string[];
  clicks: [number, number, string][];
  checks: [number, number, string][];
  verifiedAt: string;
};
export type BrowserEvidenceInput = {
  cases: readonly string[];
  clicks: readonly { case: string; target: string; at: string }[];
  observations?: readonly { case: string; kind: 'runtime-before' | 'session-app' | 'runtime-after'; at: string }[];
  verifiedAt: string;
};
export type VerifyReceipt = {
  protocol: typeof verifyReceiptProtocol; action: 'verify'; source: Source; expectedDeploymentId: string;
  deployment?: Deployment; database?: Database; browser?: VerifyBrowserEvidence;
  checkedAt: string; success: boolean;
  failure?: { stage: 'preflight' | 'browser' | 'postflight'; code: typeof verifyFailureCodes[number]; browserStage?: typeof verifyBrowserStages[number] };
  operation: string; runId: string; runAttempt: number; controlSha: string;
};
export type VerifyReceiptRequest = {
  action: 'verify'; source: Source; expectedDeployment: Deployment; operation: string;
  runId: string; runAttempt: number; controlSha: string; notBefore?: string; notAfter?: string;
};
const invalid = (): never => { throw new Error('PREVIEW_VERIFY_RECEIPT_INVALID'); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
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
function checkedDeployment(value: unknown, source: Source, expectedId: string, db: Database): Deployment {
  const d = record(value);
  keys(d, ['id', 'url', 'sha', 'branch', 'pr', 'generation', 'operation', 'phase', 'state', 'createdAt', 'database']);
  let url: string;
  try { url = previewUrl(d.url); } catch { return invalid(); }
  if (d.id !== expectedId || d.url !== url || d.sha !== source.sha || d.branch !== source.branch || d.pr !== source.pr
    || !uuid(d.generation) || !uuid(d.operation) || d.phase !== 'application' || d.state !== 'READY'
    || !Number.isSafeInteger(d.createdAt) || Number(d.createdAt) < timestamp(source.createdAt)
    || !sameDatabase(database(d.database), db)) return invalid();
  return d as Deployment;
}
/** Compare every public Deployment identity field, including the original operation. */
export function exactDeploymentIdentity(a: Deployment, b: Deployment): boolean {
  try {
    for (const d of [a, b]) {
      if (!/^dpl_[A-Za-z0-9]+$/.test(d.id) || !fullSha(d.sha) || !validTaskBranch(d.branch) || !Number.isSafeInteger(d.pr) || d.pr < 1) return false;
      checkedDeployment(d, { pr: d.pr, sha: d.sha, branch: d.branch, state: 'open', createdAt: new Date(d.createdAt).toISOString() }, d.id, database(d.database));
    }
  } catch { return false; }
  return a.id === b.id && a.url === b.url && a.sha === b.sha && a.branch === b.branch && a.pr === b.pr
    && a.generation === b.generation && a.operation === b.operation && a.phase === 'application' && b.phase === 'application'
    && a.state === 'READY' && b.state === 'READY' && a.createdAt === b.createdAt
    && !!a.database && !!b.database && sameDatabase(a.database, b.database);
}
function browser(value: unknown, complete: boolean, createdAt: number, checkedAt: number): VerifyBrowserEvidence {
  const proof = record(value);
  keys(proof, ['cases', 'clicks', 'checks', 'verifiedAt']);
  const verifiedAt = timestamp(proof.verifiedAt);
  if (verifiedAt < createdAt || verifiedAt > checkedAt || !Array.isArray(proof.cases) || !Array.isArray(proof.clicks) || !Array.isArray(proof.checks)
    || proof.cases.length > 5 || proof.clicks.length > 16 || proof.checks.length > 12
    || proof.cases.some((name, i) => name !== verifyBrowserCases[i])) return invalid();
  const clicks = proof.clicks, checks = proof.checks;
  for (const [list, width] of [[clicks, 4], [checks, 3]] as const) for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!Array.isArray(row) || row.length !== 3 || row[0] !== Math.floor(i / width) || row[1] !== i % width) invalid();
    const at = timestamp(row[2]);
    if (at < createdAt || at > verifiedAt) invalid();
  }
  // Both arrays together must be one prefix of the real browser operation order.
  let click = 0, check = 0, events = 0, previous = createdAt, stopped = false;
  for (let c = 0; c < 4; c++) for (const [kind, index] of [['check', 0], ['click', 0], ['check', 1], ['click', 1], ['click', 2], ['click', 3], ['check', 2]] as const) {
    const row = kind === 'click' ? clicks[click] : checks[check];
    if (!row) { stopped = true; continue; }
    if (stopped || row[0] !== c || row[1] !== index || timestamp(row[2]) < previous) invalid();
    previous = timestamp(row[2]); events++;
    if (kind === 'click') click++; else check++;
  }
  if (click !== clicks.length || check !== checks.length) invalid();
  const completed = Math.min(proof.cases.length, 4);
  if (events < completed * 7 || events > (completed + 1) * 7 || proof.cases.length === 5 && events !== 28
    || complete && (proof.cases.length !== 5 || events !== 28)) invalid();
  return proof as VerifyBrowserEvidence;
}
function validate(value: unknown): VerifyReceipt {
  const receipt = record(value);
  keys(receipt, ['protocol', 'action', 'source', 'expectedDeploymentId', 'checkedAt', 'success', 'operation', 'runId', 'runAttempt', 'controlSha'], ['deployment', 'database', 'browser', 'failure']);
  if (receipt.protocol !== verifyReceiptProtocol || receipt.action !== 'verify' || typeof receipt.success !== 'boolean'
    || typeof receipt.expectedDeploymentId !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(receipt.expectedDeploymentId)
    || !uuid(receipt.operation) || typeof receipt.runId !== 'string' || !/^[1-9][0-9]*$/.test(receipt.runId)
    || !Number.isSafeInteger(Number(receipt.runId)) || receipt.runAttempt !== 1 || !fullSha(receipt.controlSha)) return invalid();
  const s = record(receipt.source);
  keys(s, ['pr', 'branch', 'sha', 'createdAt', 'state']);
  if (!Number.isSafeInteger(s.pr) || Number(s.pr) < 1 || !validTaskBranch(s.branch) || !fullSha(s.sha) || s.state !== 'open') return invalid();
  const createdAt = timestamp(s.createdAt), checkedAt = timestamp(receipt.checkedAt);
  if (checkedAt < createdAt) invalid();
  const db = receipt.database === undefined ? undefined : database(receipt.database);
  if ((receipt.deployment === undefined) !== (db === undefined)) invalid();
  if (receipt.deployment !== undefined) checkedDeployment(receipt.deployment, s as Source, receipt.expectedDeploymentId, db!);
  let stage: unknown;
  if (receipt.success) {
    if (receipt.failure !== undefined || !receipt.deployment || !receipt.browser) invalid();
  } else {
    const failure = record(receipt.failure);
    keys(failure, ['stage', 'code'], ['browserStage']);
    stage = failure.stage;
    if (!['preflight', 'browser', 'postflight'].includes(String(stage)) || !(verifyFailureCodes as readonly unknown[]).includes(failure.code)
      || failure.browserStage !== undefined && (stage !== 'browser' || !(verifyBrowserStages as readonly unknown[]).includes(failure.browserStage))) invalid();
    if (stage === 'preflight' && receipt.browser !== undefined || stage !== 'preflight' && !receipt.deployment
      || stage === 'postflight' && !receipt.browser) invalid();
    if (stage === 'browser' && !['PREVIEW_VERIFY_BROWSER_FAILED', 'PREVIEW_VERIFY_OIDC_UNAVAILABLE'].includes(String(failure.code))
      || stage !== 'browser' && !['PREVIEW_VERIFY_STATUS_FAILED', 'PREVIEW_VERIFY_TARGET_CHANGED'].includes(String(failure.code))) invalid();
  }
  if (receipt.browser !== undefined) browser(receipt.browser, receipt.success || stage === 'postflight', createdAt, checkedAt);
  return receipt as VerifyReceipt;
}
function project(value: unknown, names: readonly string[]): Record<string, unknown> {
  const input = record(value);
  return Object.fromEntries(names.filter(name => Object.hasOwn(input, name)).map(name => [name, input[name]]));
}
const databaseFields = ['branchId', 'endpointId', 'hostDigest'];
export function serializeVerifyReceipt(input: unknown): string {
  const receipt = project(input, ['protocol', 'action', 'source', 'expectedDeploymentId', 'deployment', 'database', 'browser', 'checkedAt', 'success', 'failure', 'operation', 'runId', 'runAttempt', 'controlSha']);
  receipt.source = project(receipt.source, ['pr', 'branch', 'sha', 'createdAt', 'state']);
  if (receipt.database !== undefined) receipt.database = project(receipt.database, databaseFields);
  if (receipt.deployment !== undefined) {
    const d = project(receipt.deployment, ['id', 'url', 'sha', 'branch', 'pr', 'generation', 'operation', 'phase', 'state', 'createdAt', 'database']);
    if (d.database !== undefined) d.database = project(d.database, databaseFields);
    receipt.deployment = d;
  }
  if (receipt.browser !== undefined) receipt.browser = project(receipt.browser, ['cases', 'clicks', 'checks', 'verifiedAt']);
  if (receipt.failure !== undefined) receipt.failure = project(receipt.failure, ['stage', 'code', 'browserStage']);
  const text = JSON.stringify(validate(receipt));
  if (Buffer.byteLength(text, 'utf8') > receiptMaxBytes) throw new Error('PREVIEW_VERIFY_RECEIPT_TOO_LARGE');
  if (text.includes('***')) invalid();
  return text;
}
function rejectDuplicateKeys(text: string): void {
  const scopes: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') scopes.push(new Set());
    else if (text[i] === '[') scopes.push(null);
    else if (text[i] === '}' || text[i] === ']') scopes.pop();
    else if (text[i] === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === ':') {
        const name = JSON.parse(text.slice(start, i + 1)) as string, scope = scopes.at(-1);
        if (!scope) return invalid();
        if (scope.has(name)) invalid();
        scope.add(name);
      }
    }
  }
}
export function parseVerifyReceipt(text: string): VerifyReceipt {
  if (Buffer.byteLength(text, 'utf8') > receiptMaxBytes) throw new Error('PREVIEW_VERIFY_RECEIPT_TOO_LARGE');
  if (text.includes('***')) invalid();
  let value: unknown;
  try { value = JSON.parse(text); rejectDuplicateKeys(text); } catch { return invalid(); }
  return validate(value);
}
export function assertVerifyReceipt(receipt: VerifyReceipt, expected: VerifyReceiptRequest): void {
  validate(receipt);
  if (receipt.action !== expected.action || receipt.operation !== expected.operation || receipt.runId !== expected.runId
    || receipt.runAttempt !== expected.runAttempt || receipt.controlSha !== expected.controlSha || receipt.expectedDeploymentId !== expected.expectedDeployment.id
    || (['pr', 'branch', 'sha', 'createdAt', 'state'] as const).some(key => receipt.source[key] !== expected.source[key])) invalid();
  checkedDeployment(expected.expectedDeployment, expected.source, receipt.expectedDeploymentId, database(expected.expectedDeployment.database));
  if (receipt.deployment && !exactDeploymentIdentity(receipt.deployment, expected.expectedDeployment)) invalid();
  const start = expected.notBefore === undefined ? timestamp(receipt.source.createdAt) : timestamp(expected.notBefore);
  const end = expected.notAfter === undefined ? Infinity : timestamp(expected.notAfter);
  const times = [timestamp(receipt.checkedAt), ...(receipt.browser ? [timestamp(receipt.browser.verifiedAt), ...receipt.browser.clicks.map(row => timestamp(row[2])), ...receipt.browser.checks.map(row => timestamp(row[2]))] : [])];
  if (times.some(at => at < start || at > end)) invalid();
}
export function verifyReceiptNoticeCommand(receipt: VerifyReceipt): string {
  const text = serializeVerifyReceipt(receipt).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `::notice title=${verifyReceiptNoticeTitle}::${text}`;
}
export function browserEvidence(proof: BrowserEvidenceInput): VerifyBrowserEvidence {
  const cases = verifyBrowserCases.slice(0, 4) as readonly string[];
  const result: VerifyBrowserEvidence = {
    cases: [...proof.cases],
    clicks: proof.clicks.map(click => {
      const c = cases.indexOf(click.case), targets = [`ログイン${click.case.at(-1)?.toUpperCase()}`, '取引明細', '設定', 'ホーム'];
      const target = targets.indexOf(click.target);
      if (c < 0 || target < 0) return invalid();
      return [c, target, click.at];
    }),
    checks: (proof.observations ?? []).map(check => {
      const c = cases.indexOf(check.case), kind = ['runtime-before', 'session-app', 'runtime-after'].indexOf(check.kind);
      if (c < 0 || kind < 0) return invalid();
      return [c, kind, check.at];
    }),
    verifiedAt: proof.verifiedAt,
  };
  browser(result, false, 0, timestamp(proof.verifiedAt));
  return result;
}

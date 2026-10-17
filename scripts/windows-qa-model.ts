import { win32 } from 'node:path';
import { config, type Database, type Deployment, type Source } from './preview-model';
import type { OperationReceipt } from './preview-receipt';
import { fullSha, validTaskBranch } from './task-workflow';

export const windowsQaProtocol = 'cake-windows-qa-child/v1';
export type WindowsQaMode = 'preflight' | 'verify';
export type WindowsQaConfig = {
  protocol: 'cake-windows-qa-request/v1'; mode: WindowsQaMode; controlCwd: string; controlSha: string; gitExe: string; ghExe: string;
};
export type WindowsQaRequest = WindowsQaConfig & {
  targetWorktree: string; pr: number; sha: string; deploymentId: string; databaseBranchId: string; generation: string;
};
export const windowsQaCodes = [
  'OK', 'INTERNAL_ERROR', 'UNSAFE_RUNTIME', 'TOKEN_MISSING', 'NETWORK_ERROR', 'AUTH_REJECTED',
  'HTTP_ERROR', 'NON_JSON_RESPONSE', 'RESPONSE_TOO_LARGE', 'OIDC_MISSING', 'OIDC_INVALID',
  'OIDC_IDENTITY_OR_EXPIRY_MISMATCH', 'QA_FAILED', 'QA_CONFIG_REJECTED', 'QA_RUNTIME_REJECTED',
  'QA_TOOL_UNAVAILABLE', 'QA_LOCAL_IDENTITY_REJECTED', 'QA_TARGET_IDENTITY_REJECTED',
  'QA_RESOURCE_IDENTITY_REJECTED', 'QA_COMMAND_REJECTED', 'QA_CONTROL_MAIN_CHANGED',
  'QA_RECEIPT_REJECTED', 'QA_PROOF_REJECTED', 'QA_SCREENSHOTS_REJECTED', 'QA_EVIDENCE_WRITE_FAILED',
  'PREVIEW_API_UNAVAILABLE', 'PREVIEW_PR_CHANGED', 'PREVIEW_MAIN_UNAVAILABLE',
  'PREVIEW_NOT_INSTALLED_ON_MAIN', 'PREVIEW_WORKFLOW_CHANGED', 'PREVIEW_RUN_UNAVAILABLE',
  'PREVIEW_RUN_AMBIGUOUS', 'PREVIEW_RUN_CHANGED', 'PREVIEW_RUN_INCOMPLETE', 'PREVIEW_RUN_FAILED',
  'PREVIEW_JOBS_INCOMPLETE', 'PREVIEW_JOB_AMBIGUOUS', 'PREVIEW_JOB_CHANGED', 'PREVIEW_CHECK_URL',
  'PREVIEW_CHECK_CHANGED', 'PREVIEW_SUITE_CHANGED', 'PREVIEW_ANNOTATIONS_INCOMPLETE',
  'PREVIEW_RECEIPT_AMBIGUOUS', 'PREVIEW_RECEIPT_INVALID', 'PREVIEW_RECEIPT_TOO_LARGE',
  'PREVIEW_CURRENT_DRAFT_PR_REQUIRED', 'PREVIEW_READY_REQUIRED', 'PREVIEW_BROWSER_FAILED',
  'PREVIEW_CHANGED_DURING_VERIFICATION',
] as const;
export function rejectWindowsQa(code: string): never { throw new Error(code); }
export function qaRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) rejectWindowsQa('QA_CONFIG_REJECTED');
  return value as Record<string, unknown>;
}
export const sameWindowsPath = (a: string, b: string) => win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
export const qaUuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const qaTimestamp = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
function localPath(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && win32.isAbsolute(value) &&
    !/[\x00-\x1f]/.test(value) && !value.slice(2).includes(':');
}
export function parseWindowsQaConfig(value: unknown, mode: 'preflight'): WindowsQaConfig;
export function parseWindowsQaConfig(value: unknown, mode: 'verify'): WindowsQaRequest;
export function parseWindowsQaConfig(value: unknown, mode: WindowsQaMode): WindowsQaConfig | WindowsQaRequest {
  const input = qaRecord(value);
  const common = ['protocol', 'mode', 'controlCwd', 'controlSha', 'gitExe', 'ghExe'];
  const required = mode === 'verify' ? [...common, 'targetWorktree', 'pr', 'sha', 'deploymentId', 'databaseBranchId', 'generation'] : common;
  if (Object.keys(input).length !== required.length || required.some(key => !Object.hasOwn(input, key)) ||
    input.protocol !== 'cake-windows-qa-request/v1' || input.mode !== mode || !localPath(input.controlCwd) || !fullSha(input.controlSha) ||
    !localPath(input.gitExe) || win32.basename(input.gitExe).toLowerCase() !== 'git.exe' ||
    !localPath(input.ghExe) || win32.basename(input.ghExe).toLowerCase() !== 'gh.exe') rejectWindowsQa('QA_CONFIG_REJECTED');
  if (mode === 'verify' && (!localPath(input.targetWorktree) || !Number.isSafeInteger(input.pr) || Number(input.pr) < 1 ||
    !fullSha(input.sha) || typeof input.deploymentId !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(input.deploymentId) ||
    typeof input.databaseBranchId !== 'string' || !/^br-[a-z0-9-]+$/.test(input.databaseBranchId) || !qaUuid(input.generation)))
    rejectWindowsQa('QA_CONFIG_REJECTED');
  return input as WindowsQaConfig | WindowsQaRequest;
}

/** Deliberately excludes every application/provider credential and debug/TLS override. */
export function qaCommandEnvironment(environment: NodeJS.ProcessEnv, tools: { gitExe: string; ghExe: string; nodeExe: string }): NodeJS.ProcessEnv {
  const safe = {} as NodeJS.ProcessEnv;
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA',
    'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (environment[key] !== undefined) safe[key] = environment[key];
  }
  if (!safe.SystemRoot) rejectWindowsQa('QA_RUNTIME_REJECTED');
  safe.PATH = [win32.dirname(tools.gitExe), win32.dirname(tools.ghExe), win32.dirname(tools.nodeExe),
    win32.join(safe.SystemRoot, 'System32'), safe.SystemRoot].join(';');
  safe.GH_HOST = 'github.com'; safe.GH_PROMPT_DISABLED = '1';
  safe.GH_NO_UPDATE_NOTIFIER = '1'; safe.GH_NO_EXTENSION_UPDATE_NOTIFIER = '1';
  return safe;
}

export function assertQaSource(value: Source, expected: WindowsQaRequest, branch: string): void {
  if (!validTaskBranch(branch) || value.pr !== expected.pr || value.sha !== expected.sha || value.branch !== branch || value.state !== 'open')
    rejectWindowsQa('QA_TARGET_IDENTITY_REJECTED');
}
function identity(source: Source, deployment: Deployment, database: Database) {
  return JSON.stringify({ source: { pr: source.pr, branch: source.branch, sha: source.sha, createdAt: source.createdAt, state: source.state },
    deployment: { id: deployment.id, url: deployment.url, sha: deployment.sha, branch: deployment.branch, pr: deployment.pr,
      generation: deployment.generation, operation: deployment.operation, phase: deployment.phase, state: deployment.state,
      createdAt: deployment.createdAt }, database: { branchId: database.branchId, endpointId: database.endpointId, hostDigest: database.hostDigest } });
}
/** Used in addition to (never instead of) the existing full notice provenance checks. */
export function pinQaReceipt(receipt: OperationReceipt, expected: WindowsQaRequest, branch: string, wireControlSha: string,
  before?: OperationReceipt): OperationReceipt {
  assertQaSource(receipt.source, expected, branch);
  const d = receipt.deployment, db = receipt.database;
  if (receipt.action !== 'status' || !receipt.success || receipt.runAttempt !== 1 || receipt.controlSha !== wireControlSha || !d || !db ||
    d.id !== expected.deploymentId || d.pr !== expected.pr || d.sha !== expected.sha || d.branch !== branch ||
    d.generation !== expected.generation || d.phase !== 'application' || d.state !== 'READY' || db.branchId !== expected.databaseBranchId ||
    !d.database || d.database.branchId !== db.branchId || d.database.endpointId !== db.endpointId || d.database.hostDigest !== db.hostDigest ||
    before && (!before.deployment || !before.database || identity(receipt.source, d, db) !== identity(before.source, before.deployment, before.database)))
    rejectWindowsQa('QA_RESOURCE_IDENTITY_REJECTED');
  return receipt;
}
export function assertQaDispatch(value: unknown, expected: WindowsQaRequest, wireControlSha: string): string {
  const request = qaRecord(value), inputs = qaRecord(request.inputs);
  if (Object.keys(request).sort().join(',') !== 'inputs,ref' || request.ref !== 'main' ||
    Object.keys(inputs).sort().join(',') !== 'action,controlSha,operation,pr,sha' || inputs.action !== 'status' ||
    inputs.pr !== String(expected.pr) || inputs.sha !== expected.sha || inputs.controlSha !== wireControlSha || !qaUuid(inputs.operation))
    rejectWindowsQa('QA_COMMAND_REJECTED');
  return inputs.operation;
}
export function qaReadApiAllowed(path: string, expected: WindowsQaRequest, wireControlSha?: string): boolean {
  const prefix = `repos/${config.repository}/`;
  if (!path.startsWith(prefix)) return false;
  const tail = path.slice(prefix.length);
  return tail === `pulls/${expected.pr}` || tail === 'branches/main' ||
    Boolean(wireControlSha && tail === `contents/preview.config.json?ref=${wireControlSha}`) ||
    /^actions\/workflows\/preview\.yml$/.test(tail) ||
    /^actions\/workflows\/preview\.yml\/runs\?event=workflow_dispatch&branch=main&per_page=100$/.test(tail) ||
    /^actions\/runs\/[1-9][0-9]*$/.test(tail) ||
    /^actions\/runs\/[1-9][0-9]*\/attempts\/1\/jobs\?per_page=100&page=[1-9][0-9]*$/.test(tail) ||
    /^check-(?:suites|runs)\/[1-9][0-9]*$/.test(tail) ||
    /^check-runs\/[1-9][0-9]*\/annotations\?per_page=100&page=[1-9][0-9]*$/.test(tail);
}
export function summarizeQaProof(value: unknown, expected: WindowsQaRequest, branch: string, pin: OperationReceipt,
  startedAt: string, complete: boolean, now = Date.now()) {
  const proof = qaRecord(value);
  assertQaSource(proof.source as Source, expected, branch);
  const d = proof.deployment as Deployment;
  if (!pin.deployment || !pin.database || !d?.database || identity(proof.source as Source, d, d.database) !==
    identity(pin.source, pin.deployment, pin.database) || proof.protocol !== 'cake-preview-browser/v1' ||
    !Array.isArray(proof.cases) || !Array.isArray(proof.clicks) || !Array.isArray(proof.observations) ||
    !qaTimestamp(proof.verifiedAt) || complete && proof.success !== true) rejectWindowsQa('QA_PROOF_REJECTED');
  const cases = ['desktop-a', 'desktop-b', 'mobile-a', 'mobile-b'], expectedCases = [...cases, 'read-api'];
  if (proof.cases.some((entry, index) => entry !== expectedCases[index]) || proof.cases.length > 5 ||
    proof.clicks.length > 16 || proof.observations.length > 12 || complete && proof.cases.length !== 5)
    rejectWindowsQa('QA_PROOF_REJECTED');
  const validTime = (entry: unknown) => qaTimestamp(entry) && Date.parse(entry) >= Date.parse(startedAt) - 1000 && Date.parse(entry) <= now + 1000;
  for (let i = 0; i < proof.clicks.length; i++) {
    const click = qaRecord(proof.clicks[i]), caseName = cases[Math.floor(i / 4)];
    if (click.case !== caseName || click.target !== [`ログイン${caseName.endsWith('a') ? 'A' : 'B'}`, '取引明細', '設定', 'ホーム'][i % 4] ||
      !validTime(click.at)) rejectWindowsQa('QA_PROOF_REJECTED');
  }
  for (let i = 0; i < proof.observations.length; i++) {
    const observation = qaRecord(proof.observations[i]);
    if (observation.case !== cases[Math.floor(i / 3)] ||
      observation.kind !== ['runtime-before', 'session-app', 'runtime-after'][i % 3] || !validTime(observation.at)) rejectWindowsQa('QA_PROOF_REJECTED');
  }
  if (complete && (proof.clicks.length !== 16 || proof.observations.length !== 12 || !validTime(proof.verifiedAt)))
    rejectWindowsQa('QA_PROOF_REJECTED');
  return { clickCount: proof.clicks.length, caseCount: proof.cases.length, observationCount: proof.observations.length };
}
export function oidcChecks(token: unknown, now = Date.now()) {
  const result = { oidcProjectMatches: false, oidcOwnerMatches: false, oidcDevelopment: false, oidcExpiryValid: false };
  if (typeof token !== 'string' || token.length > 32768 || token.split('.').length !== 3 ||
    token.split('.').some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return result;
  try {
    const claims = qaRecord(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')));
    result.oidcProjectMatches = claims.project_id === config.vercelProjectId;
    result.oidcOwnerMatches = claims.owner_id === config.vercelTeamId;
    result.oidcDevelopment = claims.environment === 'development';
    result.oidcExpiryValid = Number.isSafeInteger(claims.exp) && Number(claims.exp) * 1000 >= now + 60_000;
  } catch { /* Claim text never crosses the public result boundary. */ }
  return result;
}

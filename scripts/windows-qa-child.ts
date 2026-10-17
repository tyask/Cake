// Invoked only by the locally built, hash-pinned DPAPI broker. No secret argv/files.
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runPreviewCommand } from './preview-command';
import { parseReceipt, type OperationReceipt } from './preview-receipt';
import { config, source as previewSource } from './preview-model';
import type { WorkflowCommandResult } from './task-workflow';
import { fullSha } from './task-workflow';
import { assertQaDispatch, assertQaSource, oidcChecks, parseWindowsQaConfig, pinQaReceipt, qaCommandEnvironment,
  qaReadApiAllowed, qaRecord, qaTimestamp, rejectWindowsQa, sameWindowsPath, summarizeQaProof, windowsQaCodes,
  windowsQaProtocol, type WindowsQaConfig, type WindowsQaMode, type WindowsQaRequest } from './windows-qa-model';

type PublicStatus = { runId: string; runAttempt: number; controlSha: string; operation: string | null;
  checkedAt: string; noticePinned: true; observedAt: string };
const startedAt = new Date().toISOString(), started = performance.now();
const output = process.stdout.write.bind(process.stdout);
// Existing library logs are public, but arbitrary output is never forwarded.
console.log = console.info = console.warn = console.error = () => undefined;
let mode: WindowsQaMode = 'preflight', stage = 'configuration';
let settings: WindowsQaConfig | undefined, request: WindowsQaRequest | undefined;
let branch = '', wireControlSha: string | undefined, pathsValidated = false, qaCompleted = false, oidcReady = false;
let boundaryFailure: string | undefined;
let dispatchCount = 0, screenshotCount = 0;
let pin: OperationReceipt | undefined;
const operations: string[] = [], statuses: PublicStatus[] = [];
const checks = { oidcProjectMatches: false, oidcOwnerMatches: false, oidcDevelopment: false, oidcExpiryValid: false };
const counts = { statusDispatchCount: 0, statusReceiptCount: 0, clickCount: 0, caseCount: 0, observationCount: 0, screenshotCount: 0, elapsedMs: 0 };
const result = { protocol: windowsQaProtocol, mode: mode as WindowsQaMode, success: false, code: 'QA_FAILED', ...checks, counts };
const browserStages = new Set(['oidc', 'launch', 'navigation', 'runtime-before', 'login', 'session-app', 'navigation-clicks', 'runtime-after', 'boundary']);

async function canonicalFile(file: string, maxBytes = 4_000_000) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes || !sameWindowsPath(await realpath(file), file))
    rejectWindowsQa('QA_LOCAL_IDENTITY_REJECTED');
}
async function fixedSpawn(command: 'git' | 'gh', args: readonly string[], cwd: string): Promise<WorkflowCommandResult> {
  const s = settings!;
  return new Promise((accept, reject) => {
    const child = spawn(command === 'git' ? s.gitExe : s.ghExe, [...args], { cwd,
      env: qaCommandEnvironment(process.env, { ...s, nodeExe: process.execPath }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', overflow = false;
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > 4_000_000) { overflow = true; child.kill(); }
      else stdout += chunk;
    });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new Error('QA_TOOL_UNAVAILABLE')); });
    child.once('close', (status, signal) => { clearTimeout(timer); accept({ status: overflow ? 1 : status, signal, stdout }); });
  });
}
async function gitText(cwd: string, args: readonly string[]) {
  const response = await fixedSpawn('git', args, cwd);
  if (response.status !== 0 || response.signal) rejectWindowsQa('QA_LOCAL_IDENTITY_REJECTED');
  return response.stdout.trim();
}
async function checkCheckout(cwd: string, sha: string, expectedBranch?: string) {
  if (!sameWindowsPath(await realpath(cwd), cwd) || !sameWindowsPath(await gitText(cwd, ['rev-parse', '--show-toplevel']), cwd) ||
    await gitText(cwd, ['rev-parse', 'HEAD']) !== sha || await gitText(cwd, ['status', '--porcelain=v1', '--untracked-files=all']) !== '' ||
    !/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)tyask\/Cake(?:\.git)?$/.test(await gitText(cwd, ['remote', 'get-url', 'origin'])) ||
    expectedBranch !== undefined && await gitText(cwd, ['branch', '--show-current']) !== expectedBranch)
    rejectWindowsQa('QA_LOCAL_IDENTITY_REJECTED');
}
async function checkEvidenceDirectory() {
  const directory = join(request!.targetWorktree, '.cake');
  try { await mkdir(directory, { recursive: false }); }
  catch (error) { if (!error || typeof error !== 'object' || (error as { code?: string }).code !== 'EEXIST') throw error; }
  if (!(await lstat(directory)).isDirectory() || !sameWindowsPath(await realpath(directory), directory)) rejectWindowsQa('QA_LOCAL_IDENTITY_REJECTED');
  const files = ['verification.json', 'preview.json', ...['desktop-a', 'desktop-b', 'mobile-a', 'mobile-b'].flatMap(caseName =>
    ['transactions', 'settings', 'home'].map(screen => `${caseName}-${screen}.png`))];
  for (const file of files) {
    try { await canonicalFile(join(directory, file), file.endsWith('.png') ? 64 * 1024 * 1024 : 262144); }
    catch (error) { if (!error || typeof error !== 'object' || (error as { code?: string }).code !== 'ENOENT') throw error; }
  }
}
async function progress(next: string) {
  stage = next;
  if (!pathsValidated || !request) return;
  // A unique, public-only file cannot follow a pre-existing progress-file link.
  try {
    await writeFile(join(request.targetWorktree, '.cake', `windows-qa-progress-${randomUUID()}.json`), JSON.stringify({
      protocol: 'cake-windows-qa-progress/v1', stage, startedAt, updatedAt: new Date().toISOString(),
      implementationSha: request.controlSha, runtimeSha: request.sha, pr: request.pr, successConfirmed: false,
      statusDispatchCount: dispatchCount, statusReceiptCount: statuses.length,
    }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch { /* Optional progress never substitutes for formal evidence. */ }
}
async function validateDispatch(args: readonly string[]) {
  if (!request || !wireControlSha || args.length !== 6 || args[0] !== 'api' ||
    args[1] !== `repos/${config.repository}/actions/workflows/preview.yml/dispatches` ||
    args[2] !== '--method' || args[3] !== 'POST' || args[4] !== '--input' || dispatchCount >= 2) rejectWindowsQa('QA_COMMAND_REJECTED');
  const file = args[5], fromTmp = relative(tmpdir(), file);
  if (!isAbsolute(file) || fromTmp.startsWith('..') || isAbsolute(fromTmp) ||
    !/^cake-preview-[^\\/]+[\\/]request\.json$/.test(fromTmp)) rejectWindowsQa('QA_COMMAND_REJECTED');
  await canonicalFile(file, 4096);
  const operation = assertQaDispatch(JSON.parse(await readFile(file, 'utf8')), request, wireControlSha);
  if (operations.includes(operation)) rejectWindowsQa('QA_COMMAND_REJECTED');
  operations.push(operation); dispatchCount++;
  await progress(dispatchCount === 1 ? 'status-before' : 'status-after');
}
const gitArguments = new Set([
  ['rev-parse', '--show-toplevel'], ['rev-parse', 'HEAD'], ['branch', '--show-current'],
  ['status', '--porcelain=v1', '--untracked-files=all'], ['remote', 'get-url', 'origin'],
].map(value => JSON.stringify(value)));
async function checkedExecutor(command: 'git' | 'gh', args: readonly string[], cwd: string): Promise<WorkflowCommandResult> {
  if (!request || !sameWindowsPath(cwd, request.targetWorktree)) rejectWindowsQa('QA_COMMAND_REJECTED');
  const prArguments = ['pr', 'list', '--repo', config.repository, '--base', 'main', '--head', branch,
    '--state', 'open', '--json', 'url,number,headRefOid,isDraft'];
  if (command === 'git') { if (!gitArguments.has(JSON.stringify(args))) rejectWindowsQa('QA_COMMAND_REJECTED'); }
  else if (command === 'gh') {
    if (JSON.stringify(args) === JSON.stringify(prArguments)) { /* Existing saved gh identity only. */ }
    else if (args[0] === 'api' && args[1]?.endsWith('/dispatches')) await validateDispatch(args);
    else if (args.length !== 2 || args[0] !== 'api' || !qaReadApiAllowed(args[1], request, wireControlSha)) rejectWindowsQa('QA_COMMAND_REJECTED');
  } else rejectWindowsQa('QA_COMMAND_REJECTED');
  const response = await fixedSpawn(command, args, cwd);
  if (response.status !== 0 || response.signal || command !== 'gh' || args[0] !== 'api' || args.length !== 2) return response;
  if (args[1] === `repos/${config.repository}/branches/main`) {
    const sha = qaRecord(qaRecord(JSON.parse(response.stdout)).commit).sha;
    if (!fullSha(sha) || wireControlSha && sha !== wireControlSha) rejectWindowsQa('QA_CONTROL_MAIN_CHANGED');
    wireControlSha = sha;
  } else if (args[1] === `repos/${config.repository}/pulls/${request.pr}`) {
    assertQaSource(previewSource(JSON.parse(response.stdout)), request, branch);
    if (dispatchCount === 1 && statuses.length === 1 && !oidcReady) {
      await progress('oidc');
      await preflight(true);
      oidcReady = true;
      await progress('browser');
    }
  } else if (/\/annotations\?/.test(args[1])) {
    const annotations: unknown = JSON.parse(response.stdout);
    if (!Array.isArray(annotations)) rejectWindowsQa('QA_RECEIPT_REJECTED');
    for (const value of annotations) {
      const annotation = qaRecord(value);
      if (annotation.title !== 'cake-preview-receipt/v1') continue;
      if (annotation.annotation_level !== 'notice' || typeof annotation.message !== 'string' || !wireControlSha) rejectWindowsQa('QA_RECEIPT_REJECTED');
      const receipt = pinQaReceipt(parseReceipt(annotation.message), request, branch, wireControlSha, pin);
      if (dispatchCount < 1 || statuses.length !== dispatchCount - 1 || receipt.operation !== operations[dispatchCount - 1] || !qaTimestamp(receipt.checkedAt))
        rejectWindowsQa('QA_RECEIPT_REJECTED');
      pin ??= receipt;
      statuses.push({ runId: receipt.runId, runAttempt: 1, controlSha: receipt.controlSha, operation: receipt.operation,
        checkedAt: receipt.checkedAt, noticePinned: true, observedAt: new Date().toISOString() });
    }
  }
  return response;
}
async function executor(command: 'git' | 'gh', args: readonly string[], cwd: string): Promise<WorkflowCommandResult> {
  try { return await checkedExecutor(command, args, cwd); }
  catch (error) {
    // Existing requestReceipt intentionally sanitizes API exceptions. Preserve
    // our already-public boundary code so token expiry/denial stays actionable.
    if (error instanceof Error && (windowsQaCodes as readonly string[]).includes(error.message)) boundaryFailure ??= error.message;
    throw error;
  }
}
async function readProof(complete: boolean) {
  const path = join(request!.targetWorktree, '.cake', 'verification.json');
  await canonicalFile(path, 262144);
  return summarizeQaProof(JSON.parse(await readFile(path, 'utf8')), request!, branch, pin!, startedAt, complete);
}
async function screenshots() {
  for (const caseName of ['desktop-a', 'desktop-b', 'mobile-a', 'mobile-b']) for (const screen of ['transactions', 'settings', 'home']) {
    const file = join(request!.targetWorktree, '.cake', `${caseName}-${screen}.png`);
    await canonicalFile(file, 64 * 1024 * 1024);
    const info = await lstat(file);
    if (info.size < 8 || info.mtimeMs < Date.parse(startedAt) - 1000) rejectWindowsQa('QA_SCREENSHOTS_REJECTED');
    const handle = await open(file, 'r');
    try {
      const signature = Buffer.alloc(8); await handle.read(signature, 0, 8, 0);
      if (signature.toString('hex') !== '89504e470d0a1a0a') rejectWindowsQa('QA_SCREENSHOTS_REJECTED');
    } finally { await handle.close(); }
    screenshotCount++;
  }
}
async function invalidateProof() {
  if (!pathsValidated || !request) return;
  const file = join(request.targetWorktree, '.cake', 'verification.json');
  try {
    try { await canonicalFile(file, 262144); }
    catch (error) { if (!error || typeof error !== 'object' || (error as { code?: string }).code !== 'ENOENT') throw error; }
    await writeFile(file, JSON.stringify({ protocol: 'cake-preview-browser/v1', success: false, verifiedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch { /* Final failure cannot become a successful proof. */ }
}
async function preflight(retainForBrowser = false) {
  let token = process.env.VERCEL_TOKEN; delete process.env.VERCEL_TOKEN;
  if (!token) rejectWindowsQa('TOKEN_MISSING');
  let response: Response;
  try {
    const url = new URL(`https://api.vercel.com/v3/env/pull/${config.vercelProjectId}/development`);
    url.searchParams.set('teamId', config.vercelTeamId);
    response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(20_000) });
  } catch { rejectWindowsQa('NETWORK_ERROR'); }
  finally { token = undefined; }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* No body is logged. */ }
    rejectWindowsQa(response.status === 401 || response.status === 403 ? 'AUTH_REJECTED' : 'HTTP_ERROR');
  }
  if (!response.body) rejectWindowsQa('NON_JSON_RESPONSE');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  let body: Record<string, unknown>;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); rejectWindowsQa('RESPONSE_TOO_LARGE'); }
      chunks.push(part.value);
    }
    body = qaRecord(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
  } catch (error) {
    if (error instanceof Error && error.message === 'RESPONSE_TOO_LARGE') throw error;
    rejectWindowsQa('NON_JSON_RESPONSE');
  } finally { reader.releaseLock(); }
  const oidc = body.env && typeof body.env === 'object' && !Array.isArray(body.env) ? qaRecord(body.env).VERCEL_OIDC_TOKEN : undefined;
  if (typeof oidc !== 'string' || !oidc) rejectWindowsQa('OIDC_MISSING');
  Object.assign(result, oidcChecks(oidc));
  if (![result.oidcProjectMatches, result.oidcOwnerMatches, result.oidcDevelopment, result.oidcExpiryValid].every(Boolean))
    rejectWindowsQa('OIDC_IDENTITY_OR_EXPIRY_MISMATCH');
  // Existing verifyBrowser validates these claims again and sends the OIDC only
  // to the pinned Preview origin. Its Chromium environment excludes credentials.
  if (retainForBrowser) process.env.VERCEL_OIDC_TOKEN = oidc;
}

async function main() {
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--broker-mode' || !['preflight', 'verify'].includes(args[1]) ||
    args[2] !== '--broker-config' || !isAbsolute(args[3])) rejectWindowsQa('QA_CONFIG_REJECTED');
  mode = args[1] as WindowsQaMode; result.mode = mode;
  if (process.platform !== 'win32' || !process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || process.env.NODE_OPTIONS || process.env.DEBUG || process.env.NODE_DEBUG || process.env.PWDEBUG ||
    process.env.CAKE_BROWSER_EXECUTABLE) rejectWindowsQa('QA_RUNTIME_REJECTED');
  await canonicalFile(args[3], 16384);
  const input: unknown = JSON.parse(await readFile(args[3], 'utf8'));
  settings = mode === 'verify' ? parseWindowsQaConfig(input, 'verify') : parseWindowsQaConfig(input, 'preflight');
  await canonicalFile(settings.gitExe, 64 * 1024 * 1024); await canonicalFile(settings.ghExe, 128 * 1024 * 1024);
  await checkCheckout(settings.controlCwd, settings.controlSha);
  if (!sameWindowsPath(process.cwd(), settings.controlCwd)) rejectWindowsQa('QA_LOCAL_IDENTITY_REJECTED');
  stage = mode === 'preflight' ? 'oidc' : 'local-identity';
  if (mode === 'preflight') await preflight();
  else {
    request = settings as WindowsQaRequest;
    branch = await gitText(request.targetWorktree, ['branch', '--show-current']);
    await checkCheckout(request.targetWorktree, request.sha, branch);
    await checkEvidenceDirectory(); pathsValidated = true;
    await progress('status-before');
    await runPreviewCommand('verify', [], request.targetWorktree, executor);
    qaCompleted = true; await progress('proof-validation');
    if (dispatchCount !== 2 || statuses.length !== 2 || statuses[0].runId === statuses[1].runId || statuses[0].operation === statuses[1].operation)
      rejectWindowsQa('QA_RECEIPT_REJECTED');
    await checkCheckout(request.controlCwd, request.controlSha);
    await checkCheckout(request.targetWorktree, request.sha, branch);
    Object.assign(counts, await readProof(true)); await screenshots();
  }
  result.success = true; result.code = 'OK'; stage = 'complete';
} catch (error) {
  const safe = error && typeof error === 'object' ? error as { message?: unknown; stage?: unknown } : {};
  result.code = boundaryFailure ?? (typeof safe.message === 'string' && (windowsQaCodes as readonly string[]).includes(safe.message) ? safe.message : 'QA_FAILED');
  if (typeof safe.stage === 'string' && browserStages.has(safe.stage)) stage = safe.stage;
  if (pathsValidated && pin) { try { Object.assign(counts, await readProof(false)); } catch { /* Unvalidated proof is never echoed. */ } }
  await invalidateProof();
} finally {
  delete process.env.VERCEL_TOKEN; delete process.env.VERCEL_OIDC_TOKEN;
  counts.statusDispatchCount = dispatchCount; counts.statusReceiptCount = statuses.length; counts.screenshotCount = screenshotCount;
  counts.elapsedMs = Math.min(3_600_000, Math.max(0, Math.round(performance.now() - started)));
  if (pathsValidated && request) {
    try {
      await writeFile(join(request.targetWorktree, '.cake', `windows-qa-launch-${randomUUID()}.json`), JSON.stringify({
        ...result, stage, startedAt, finishedAt: new Date().toISOString(), implementationSha: request.controlSha,
        runtimeSha: request.sha, pr: request.pr, deploymentId: request.deploymentId, databaseBranchId: request.databaseBranchId,
        generation: request.generation, url: pin?.deployment?.url ?? null, qaCommandCompleted: qaCompleted,
        beforeStatus: statuses[0] ?? null, afterStatus: statuses[1] ?? null, proofPath: join(request.targetWorktree, '.cake', 'verification.json'),
      }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch { result.success = false; result.code = 'QA_EVIDENCE_WRITE_FAILED'; await invalidateProof(); }
  }
  process.exitCode = result.success ? 0 : 1;
  output(JSON.stringify(result) + '\n');
}
}
void main().catch(() => { process.exitCode = 1; });

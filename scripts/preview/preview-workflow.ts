import { readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { config, object, source as parseSource, uuid, type Source } from './preview-model';
import { PreviewService } from './preview-service';
import { parseReceipt, receiptNoticeCommand, serializeReceipt, type OperationReceipt } from './preview-receipt';
import { PreviewVerifyService } from './preview-verify-service';
import { transport, type Transport } from './preview-provider';
import { parseVerifyReceipt, serializeVerifyReceipt, verifyReceiptNoticeCommand, verifyReceiptProtocol } from './preview-verify-receipt';
import { fullSha } from '../task/task-workflow';
import { pushedPullRequests, workflowRunPullRequest } from './pr-event';

const cleanupBatchProtocol = 'cake-preview-cleanup-batch/v1';
// Bound the matrix and repeat the bound before provider work.
const maxCleanupBatch = 10;
type EventSources = { workflowRunPullRequest: typeof workflowRunPullRequest; pushedPullRequests: typeof pushedPullRequests };
const eventSources: EventSources = { workflowRunPullRequest, pushedPullRequests };
function credentials(env: Readonly<Record<string, string | undefined>>): void {
  const missing = missingPreviewCredentials(env);
  if (missing.length) {
    console.error(`Cake: cake-automation Environment secrets未設定: ${missing.join(', ')}。main限定Environmentの設定を確認してください。値をチャットやログへ出さないでください。`);
    throw new Error('PREVIEW_CREDENTIALS_MISSING');
  }
}
function sameSource(actual: Source, expected: Source): boolean {
  return (['pr', 'branch', 'sha', 'createdAt', 'state'] as const).every(key => actual[key] === expected[key]);
}
async function saveCleanupBatch(receipts: OperationReceipt[], complete: boolean): Promise<void> {
  await writeFile(resolve('preview-result.json'), JSON.stringify({ protocol: cleanupBatchProtocol, complete, receipts }), { mode: 0o600 });
}
async function summary(env: Readonly<Record<string, string | undefined>>, text: string): Promise<void> {
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text);
}
async function previewEvent(env: Readonly<Record<string, string | undefined>>): Promise<Record<string, unknown>> {
  if (env.GITHUB_REPOSITORY !== config.repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_WORKFLOW_REF !== `${config.repository}/.github/workflows/preview.yml@refs/heads/main`
    || !env.GITHUB_EVENT_PATH || !fullSha(env.GITHUB_SHA)
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !Number.isSafeInteger(Number(env.GITHUB_RUN_ID))
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT))) throw new Error('PREVIEW_UNTRUSTED_WORKFLOW');
  const event = object(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
  if (object(event.repository).full_name !== config.repository) throw new Error('PREVIEW_UNTRUSTED_EVENT');
  return event;
}
function dispatchInput(env: Readonly<Record<string, string | undefined>>, event: Record<string, unknown>) {
  const inputs = object(event.inputs), action = String(inputs.action), pr = Number(inputs.pr), sha = String(inputs.sha), operation = String(inputs.operation);
  if (!fullSha(inputs.controlSha) || inputs.controlSha !== env.GITHUB_SHA) throw new Error('PREVIEW_UNTRUSTED_WORKFLOW');
  if (!uuid(operation)) throw new Error('PREVIEW_INVALID_OPERATION');
  if (typeof inputs.pr !== 'string' || !/^[1-9][0-9]*$/.test(inputs.pr) || !Number.isSafeInteger(pr)
    || !fullSha(sha) || !['deploy', 'status', 'cleanup', 'verify'].includes(action))
    throw new Error(action === 'verify' ? 'PREVIEW_VERIFY_INVALID_TARGET' : 'PREVIEW_INVALID_PR');
  return { inputs, action, pr, sha, operation };
}
async function pushSources(env: Readonly<Record<string, string | undefined>>, event: Record<string, unknown>, api: Transport, sources: EventSources): Promise<Source[]> {
  const pulls = await sources.pushedPullRequests(env, event, api);
  if (pulls.length > maxCleanupBatch) throw new Error('PREVIEW_CLEANUP_BATCH_TOO_LARGE');
  const expected = pulls.map(raw => {
    const current = parseSource(raw);
    if (raw.merged !== true || current.state !== 'closed') throw new Error('PREVIEW_UNTRUSTED_EVENT');
    return current;
  });
  if (new Set(expected.map(current => current.pr)).size !== expected.length) throw new Error('PREVIEW_UNTRUSTED_EVENT');
  return expected;
}
function matrixTarget(env: Readonly<Record<string, string | undefined>>): number {
  const value = env.CAKE_PREVIEW_PR;
  if (!/^[1-9][0-9]*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new Error('PREVIEW_MATRIX_TARGET_INVALID');
  return Number(value);
}

/** Read-only main preparation: resolve PR numbers before taking a per-PR lock or environment secrets. */
export async function preparePreviewWorkflow(env: Readonly<Record<string, string | undefined>> = process.env,
  api: Transport = transport(env), sources: EventSources = eventSources): Promise<number[]> {
  const event = await previewEvent(env);
  let targets: number[];
  if (env.GITHUB_EVENT_NAME === 'push') targets = (await pushSources(env, event, api, sources)).map(current => current.pr);
  else if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const candidate = await sources.workflowRunPullRequest(env, event, api);
    if (!candidate || candidate.raw.merged === true) targets = [];
    else {
      if (candidate.raw.merged !== false) throw new Error('PREVIEW_UNTRUSTED_EVENT');
      targets = [candidate.source.pr];
    }
  } else if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const request = dispatchInput(env, event);
    targets = request.action === 'verify' ? [] : [request.pr];
  } else throw new Error('PREVIEW_UNTRUSTED_EVENT');
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `targets=${JSON.stringify(targets)}\n`);
  return targets;
}

// A rerun must reconcile the same operation instead of creating another deployment.
function automaticOperation(runId: string): string {
  const hash = createHash('sha256').update(`cake-preview-auto/v1:${config.repository}:${runId}`).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
export function missingPreviewCredentials(env: Readonly<Record<string, string | undefined>>): string[] {
  return ['VERCEL_TOKEN','NEON_API_KEY'].filter(name => !env[name]?.trim());
}
export async function runPreviewWorkflow(env: Readonly<Record<string, string | undefined>> = process.env, service = new PreviewService(),
  verifier = new PreviewVerifyService(transport(env)), sources: EventSources = eventSources): Promise<void> {
  // A failed preflight must never leave an older success for the always-notice step.
  await rm(resolve('preview-result.json'), { force: true });
  const event = await previewEvent(env);
  if (env.GITHUB_EVENT_NAME === 'push') {
    const expectedSources = await pushSources(env, event, service.provider.api, sources);
    const expected = expectedSources.find(current => current.pr === matrixTarget(env));
    if (!expected) throw new Error('PREVIEW_PR_CHANGED');
    await saveCleanupBatch([], false);
    credentials(env);
    try {
      const current = await service.provider.pr(expected.pr);
      if (!sameSource(current, expected)) throw new Error('PREVIEW_PR_CHANGED');
      const result = parseReceipt(serializeReceipt({ ...await service.cleanup(current), operation: null,
        runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT), controlSha: env.GITHUB_SHA }));
      await saveCleanupBatch([result], true);
      await summary(env, `Preview cleanup: 成功 / PR #${current.pr}\n\nCommit: ${current.sha}\n\n`);
    } catch (error) {
      await summary(env, `Preview cleanup: 未完了 / PR #${expected.pr}。資源を再照合してください。\n`);
      throw error;
    }
    return;
  }
  let pr: number, action: string, operation: string | undefined, sha: string | undefined, deploymentId: string | undefined;
  let expectedSource: Source | undefined;
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const candidate = await sources.workflowRunPullRequest(env, event, service.provider.api);
    // Merged PRs are cleaned by main's push workflow. Obsolete notifications
    // have no provider work, no credentials requirement and no success receipt.
    if (!candidate || candidate.raw.merged === true) {
      await saveCleanupBatch([], true);
      return;
    }
    if (candidate.raw.merged !== false) throw new Error('PREVIEW_UNTRUSTED_EVENT');
    expectedSource = candidate.source;
    pr = expectedSource.pr; sha = expectedSource.sha;
    if (pr !== matrixTarget(env)) throw new Error('PREVIEW_PR_CHANGED');
    action = expectedSource.state === 'open' ? 'deploy' : 'cleanup';
    if (action === 'deploy') operation = automaticOperation(env.GITHUB_RUN_ID!);
  } else if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const request = dispatchInput(env, event), inputs = request.inputs;
    // A ref can advance between the caller's main/config check and dispatch.
    // Refuse provider access unless this run checked out that exact control SHA.
    ({ pr, action, operation, sha } = request);
    if (action !== 'verify' && pr !== matrixTarget(env)) throw new Error('PREVIEW_PR_CHANGED');
    if (action === 'verify') {
      deploymentId = String(inputs.deploymentId);
      if (typeof inputs.pr !== 'string' || !/^[1-9][0-9]*$/.test(inputs.pr) || !Number.isSafeInteger(pr)
        || !fullSha(sha) || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) throw new Error('PREVIEW_VERIFY_INVALID_TARGET');
      if (env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('PREVIEW_VERIFY_RERUN_UNSUPPORTED');
    }
  } else throw new Error('PREVIEW_UNTRUSTED_EVENT');
  credentials(env);
  const source = await (action === 'verify' ? verifier.provider : service.provider).pr(pr);
  if (source.sha !== sha || !['deploy','status','cleanup','verify'].includes(action)
    || action === 'verify' && source.state !== 'open' || expectedSource && !sameSource(source, expectedSource)) throw new Error('PREVIEW_PR_CHANGED');
  if (action === 'verify') {
    const verified = await verifier.verify(source, deploymentId!, env);
    const result = serializeVerifyReceipt({ ...verified, operation, runId: env.GITHUB_RUN_ID,
      runAttempt: Number(env.GITHUB_RUN_ATTEMPT), controlSha: env.GITHUB_SHA });
    await writeFile(resolve('preview-result.json'), result, { mode: 0o600 });
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
      `Preview verify: ${verified.success ? '成功' : '失敗'} / PR #${source.pr}\n\nCommit: ${source.sha}\n\nExpected Deployment: ${deploymentId}\n${verified.failure ? `\nStage: ${verified.failure.stage} / ${verified.failure.code}\n` : ''}`);
    // Failure still has a projected receipt. The separate always-step emits it,
    // while the run conclusion remains failure and cannot be accepted as success.
    if (!verified.success) throw new Error(verified.failure!.code);
    return;
  }
  const receipt = action === 'deploy' ? await service.deploy(source, operation!, Number(env.GITHUB_RUN_ATTEMPT) > 1)
    : action === 'cleanup' ? await service.cleanup(source) : await service.status(source);
  const result = serializeReceipt({ ...receipt, operation: operation ?? null, runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT), controlSha: env.GITHUB_SHA });
  await writeFile(resolve('preview-result.json'), result, { mode: 0o600 });
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `Preview ${action}: 成功 / PR #${source.pr}\n\nCommit: ${source.sha}\n\n${receipt.deployment ? `Deployment: ${receipt.deployment.id}\n\nURL: ${receipt.deployment.url}\n` : ''}`);
}
// A separate step gets its own annotation allowance and never calls a provider
// or receives provider credentials. The summary is for humans, not receipt I/O.
export async function emitPreviewReceipt(path = resolve('preview-result.json'), emit = console.log): Promise<void> {
  const text = await readFile(path, 'utf8');
  let parsed: Record<string, unknown> | undefined;
  try { parsed = object(JSON.parse(text)); } catch { /* The strict parser below reports malformed input. */ }
  if (parsed?.protocol === cleanupBatchProtocol) {
    if (Object.keys(parsed).some(key => !['protocol', 'complete', 'receipts'].includes(key)) || parsed.complete !== true
      || !Array.isArray(parsed.receipts) || parsed.receipts.length > maxCleanupBatch) throw new Error('PREVIEW_CLEANUP_BATCH_INCOMPLETE');
    const receipts = parsed.receipts.map(raw => parseReceipt(JSON.stringify(raw)));
    if (receipts.some(receipt => receipt.action !== 'cleanup' || receipt.operation !== null)
      || new Set(receipts.map(receipt => receipt.source.pr)).size !== receipts.length) throw new Error('PREVIEW_RECEIPT_INVALID');
    // Validate the entire batch before emitting any success annotations.
    for (const receipt of receipts) {
      const notice = receiptNoticeCommand(receipt);
      emit(notice.replace(/^::notice title=[^:]+::/, `::notice title=cake-preview/v1 PR ${receipt.source.pr}::`));
    }
    return;
  }
  let verify = false;
  try { verify = object(JSON.parse(text)).protocol === verifyReceiptProtocol; } catch { /* The strict legacy parser below reports malformed input. */ }
  emit(verify ? verifyReceiptNoticeCommand(parseVerifyReceipt(text)) : receiptNoticeCommand(parseReceipt(text)));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const run: () => Promise<unknown> = args.length === 0 ? runPreviewWorkflow : args.length === 1 && args[0] === '--notice' ? emitPreviewReceipt
    : args.length === 1 && args[0] === '--prepare' ? preparePreviewWorkflow
    : async () => { throw new Error('PREVIEW_INVALID_COMMAND'); };
  void run().catch(error => {
    const code = error instanceof Error && /^PREVIEW_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PREVIEW_OPERATION_FAILED';
    console.error(`Cake: ${code}。資源状態を再照合してください。外部応答・秘密値は表示しません。`); process.exitCode = 1;
  });
}

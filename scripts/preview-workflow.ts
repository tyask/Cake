import { readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { config, object, uuid } from './preview-model';
import { PreviewService } from './preview-service';
import { parseReceipt, receiptNoticeCommand, serializeReceipt } from './preview-receipt';
import { PreviewVerifyService } from './preview-verify-service';
import { transport } from './preview-provider';
import { parseVerifyReceipt, serializeVerifyReceipt, verifyReceiptNoticeCommand, verifyReceiptProtocol } from './preview-verify-receipt';
import { fullSha, validTaskBranch } from './task-workflow';

// A rerun must reconcile the same operation instead of creating another deployment.
function automaticOperation(runId: string): string {
  const hash = createHash('sha256').update(`cake-preview-auto/v1:${config.repository}:${runId}`).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
export function missingPreviewCredentials(env: Readonly<Record<string, string | undefined>>): string[] {
  return ['VERCEL_TOKEN','NEON_API_KEY'].filter(name => !env[name]?.trim());
}
export async function runPreviewWorkflow(env = process.env, service = new PreviewService(),
  verifier = new PreviewVerifyService(transport(env))): Promise<void> {
  // A failed preflight must never leave an older success for the always-notice step.
  await rm(resolve('preview-result.json'), { force: true });
  if (env.GITHUB_REPOSITORY !== config.repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_WORKFLOW_REF !== `${config.repository}/.github/workflows/preview.yml@refs/heads/main`
    || !env.GITHUB_EVENT_PATH || !fullSha(env.GITHUB_SHA)
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !Number.isSafeInteger(Number(env.GITHUB_RUN_ID))
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT))) throw new Error('PREVIEW_UNTRUSTED_WORKFLOW');
  const event = object(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
  if (object(event.repository).full_name !== config.repository) throw new Error('PREVIEW_UNTRUSTED_EVENT');
  let pr: number, action: string, operation: string | undefined, sha: string | undefined, deploymentId: string | undefined;
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
    const p = object(event.pull_request);
    const automatic = ['opened','synchronize','reopened'].includes(String(event.action));
    if ((!automatic && event.action !== 'closed') || p.state !== (automatic ? 'open' : 'closed')
      || object(object(p.head).repo).full_name !== config.repository
      || object(p.base).ref !== 'main') throw new Error('PREVIEW_UNTRUSTED_EVENT');
    if (automatic && !validTaskBranch(object(p.head).ref)) throw new Error('PREVIEW_UNTRUSTED_EVENT');
    pr = Number(p.number); action = automatic ? 'deploy' : 'cleanup'; sha = String(object(p.head).sha);
    if (automatic) operation = automaticOperation(env.GITHUB_RUN_ID!);
  } else if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const inputs = object(event.inputs);
    // A ref can advance between the caller's main/config check and dispatch.
    // Refuse provider access unless this run checked out that exact control SHA.
    if (!fullSha(inputs.controlSha) || inputs.controlSha !== env.GITHUB_SHA) throw new Error('PREVIEW_UNTRUSTED_WORKFLOW');
    pr = Number(inputs.pr); action = String(inputs.action); operation = String(inputs.operation); sha = String(inputs.sha);
    if (!uuid(operation)) throw new Error('PREVIEW_INVALID_OPERATION');
    if (action === 'verify') {
      deploymentId = String(inputs.deploymentId);
      if (typeof inputs.pr !== 'string' || !/^[1-9][0-9]*$/.test(inputs.pr) || !Number.isSafeInteger(pr)
        || !fullSha(sha) || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) throw new Error('PREVIEW_VERIFY_INVALID_TARGET');
      if (env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('PREVIEW_VERIFY_RERUN_UNSUPPORTED');
    }
  } else throw new Error('PREVIEW_UNTRUSTED_EVENT');
  const missing = missingPreviewCredentials(env);
  if (missing.length) {
    // Only configured names are logged, never credential values or provider responses.
    console.error(`Cake: Repository secrets未設定: ${missing.join(', ')}。既存の資格情報をGitHubのSecrets設定で登録してください。値をチャットやログへ出さないでください。`);
    throw new Error('PREVIEW_CREDENTIALS_MISSING');
  }
  const source = await (action === 'verify' ? verifier.provider : service.provider).pr(pr);
  if (source.sha !== sha || !['deploy','status','cleanup','verify'].includes(action)
    || action === 'verify' && source.state !== 'open') throw new Error('PREVIEW_PR_CHANGED');
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
  let verify = false;
  try { verify = object(JSON.parse(text)).protocol === verifyReceiptProtocol; } catch { /* The strict legacy parser below reports malformed input. */ }
  emit(verify ? verifyReceiptNoticeCommand(parseVerifyReceipt(text)) : receiptNoticeCommand(parseReceipt(text)));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const run = args.length === 0 ? runPreviewWorkflow : args.length === 1 && args[0] === '--notice' ? emitPreviewReceipt
    : async () => { throw new Error('PREVIEW_INVALID_COMMAND'); };
  void run().catch(error => {
    const code = error instanceof Error && /^PREVIEW_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PREVIEW_OPERATION_FAILED';
    console.error(`Cake: ${code}。資源状態を再照合してください。外部応答・秘密値は表示しません。`); process.exitCode = 1;
  });
}

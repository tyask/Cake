import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import capability from '../preview-verify.config.json';
import { config, object, source, sameDatabase, type Deployment, type Source } from './preview-model';
import { fullSha, commandOutput, executeWorkflowCommand, type WorkflowExecutor } from './task-workflow';
import { requestReceipt } from './preview-command';
import { assertPreviewRun, previewWorkflow, readVerifyReceipt, type PreviewGet } from './preview-checks';
import type { VerifyReceipt } from './preview-verify-receipt';
import { remotePreviewProof } from './preview-remote-proof';

type Target = { pr: number; sha: string; deploymentId: string };
type Options = { args?: readonly string[]; cwd?: string; execute?: WorkflowExecutor; wait?: (ms: number) => Promise<void>; log?: (message: string) => void;
  status?: typeof requestReceipt };
export function verificationTarget(args: readonly string[]): Target {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--pr', '--sha', '--deployment'].includes(key) || values.has(key) || !value) throw new Error('PREVIEW_VERIFY_ARGUMENTS');
    values.set(key, value);
  }
  const pr = values.get('--pr'), sha = values.get('--sha'), deploymentId = values.get('--deployment');
  if (values.size !== 3 || !pr || !/^[1-9][0-9]*$/.test(pr) || !Number.isSafeInteger(Number(pr)) || !fullSha(sha)
    || !deploymentId || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) throw new Error('PREVIEW_VERIFY_ARGUMENTS');
  return { pr: Number(pr), sha, deploymentId };
}
export function verificationApi(cwd: string, execute: WorkflowExecutor): PreviewGet {
  return async path => {
    try { return JSON.parse(await commandOutput(execute, 'gh', ['api', `repos/${config.repository}/${path}`], cwd)); }
    catch { throw new Error('PREVIEW_API_UNAVAILABLE'); }
  };
}
/** The trusted control checkout and target PR are deliberately separate identities. */
export async function assertVerificationControl(cwd: string, execute: WorkflowExecutor, get: PreviewGet): Promise<string> {
  const root = await commandOutput(execute, 'git', ['rev-parse', '--show-toplevel'], cwd);
  const head = await commandOutput(execute, 'git', ['rev-parse', 'HEAD'], cwd);
  const status = await commandOutput(execute, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], cwd);
  const origin = await commandOutput(execute, 'git', ['remote', 'get-url', 'origin'], cwd);
  const main = object(await get('branches/main')), sha = object(main.commit).sha;
  if (resolve(root) !== resolve(cwd) || !fullSha(head) || head !== sha || status
    || !/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)tyask\/Cake(?:\.git)?$/.test(origin)) throw new Error('PREVIEW_VERIFY_TRUSTED_MAIN_REQUIRED');
  for (const [path, expected] of [['preview.config.json', config], ['preview-verify.config.json', capability]] as const) {
    const file = object(await get(`contents/${path}?ref=${head}`));
    try {
      if (file.encoding !== 'base64' || file.type !== 'file' || JSON.stringify(JSON.parse(Buffer.from(String(file.content), 'base64').toString())) !== JSON.stringify(expected)) throw new Error();
    } catch { throw new Error('PREVIEW_VERIFY_NOT_INSTALLED_ON_MAIN'); }
  }
  return head;
}
export async function requestCiVerification(expected: Source, deployment: Deployment, controlSha: string, cwd: string,
  execute: WorkflowExecutor = executeWorkflowCommand, wait: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)), log = console.log): Promise<{ workflowId: number; receipt: VerifyReceipt }> {
  const get = verificationApi(cwd, execute);
  if (JSON.stringify(source(await get(`pulls/${expected.pr}`))) !== JSON.stringify(expected)
    || object(object(await get('branches/main')).commit).sha !== controlSha) throw new Error('PREVIEW_PR_CHANGED');
  const workflow = await previewWorkflow(get), operation = randomUUID();
  const request = { action: 'verify' as const, source: expected, expectedDeployment: deployment, operation, controlSha, workflowId: workflow.id };
  const directory = await mkdtemp(join(tmpdir(), 'cake-verify-'));
  try {
    const file = join(directory, 'request.json');
    await writeFile(file, JSON.stringify({ ref: 'main', inputs: { action: 'verify', pr: String(expected.pr), sha: expected.sha, deploymentId: deployment.id, operation, controlSha } }), { mode: 0o600 });
    await commandOutput(execute, 'gh', ['api', `repos/${config.repository}/actions/workflows/preview.yml/dispatches`, '--method', 'POST', '--input', file], cwd, 'PREVIEW_VERIFY_DISPATCH_UNKNOWN');
    let run: Record<string, unknown> | undefined;
    for (let i = 0; i < 300; i++) {
      const runs = object(await get('actions/workflows/preview.yml/runs?event=workflow_dispatch&branch=main&per_page=100')).workflow_runs;
      if (!Array.isArray(runs)) throw new Error('PREVIEW_RUN_UNAVAILABLE');
      const matches = runs.filter(r => r.display_title === `Preview verify PR ${expected.pr} ${operation}`);
      if (matches.length > 1) throw new Error('PREVIEW_RUN_AMBIGUOUS');
      if (matches.length) {
        run = assertPreviewRun(matches[0], request);
        if (i === 0 || i % 12 === 0) log(`Cake: Actions https://github.com/${config.repository}/actions/runs/${run.id}`);
        if (run.status === 'completed') break;
      }
      if (i % 12 === 0) log(`Cake: CIブラウザQAを確認しています。request ${operation}`);
      await wait(5000);
    }
    if (!run || run.status !== 'completed' || !['success', 'failure'].includes(String(run.conclusion))) throw new Error('PREVIEW_VERIFY_RUN_INCOMPLETE');
    const receipt = await readVerifyReceipt(get, Number(run.id), request);
    if (JSON.stringify(source(await get(`pulls/${expected.pr}`))) !== JSON.stringify(expected)
      || object(object(await get('branches/main')).commit).sha !== controlSha) throw new Error('PREVIEW_PR_CHANGED');
    return { workflowId: workflow.id, receipt };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function runCiVerify({ args = [], cwd = process.cwd(), execute = executeWorkflowCommand,
  wait = ms => new Promise(r => setTimeout(r, ms)), log = console.log, status = requestReceipt }: Options = {}): Promise<VerifyReceipt> {
  const target = verificationTarget(args), directory = resolve(cwd, '.cake'), path = join(directory, `verify-${target.pr}.json`);
  // Remove stale success even when source/control validation or dispatch fails.
  await rm(path, { force: true });
  const get = verificationApi(cwd, execute), controlSha = await assertVerificationControl(cwd, execute, get);
  const expected = source(await get(`pulls/${target.pr}`));
  if (expected.state !== 'open' || expected.sha !== target.sha) throw new Error('PREVIEW_PR_CHANGED');
  const before = await status('status', expected, cwd, execute, wait, log);
  if (!before.deployment || !before.database || before.deployment.id !== target.deploymentId
    || before.deployment.state !== 'READY' || before.deployment.phase !== 'application'
    || before.deployment.sha !== expected.sha || before.deployment.pr !== expected.pr || before.deployment.branch !== expected.branch
    || !before.deployment.database || !sameDatabase(before.database, before.deployment.database)) throw new Error('PREVIEW_VERIFY_TARGET_CHANGED');
  const result = await requestCiVerification(expected, before.deployment, controlSha, cwd, execute, wait, log);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(remotePreviewProof(result.workflowId, result.receipt), null, 2) + '\n', { mode: 0o600 });
  log(`Cake: CIブラウザQA ${result.receipt.success ? '成功' : '失敗'}: https://github.com/${config.repository}/actions/runs/${result.receipt.runId}`);
  if (!result.receipt.success) {
    log(`Cake: ${result.receipt.failure!.code} / ${result.receipt.failure!.stage}${result.receipt.failure!.browserStage ? ` / ${result.receipt.failure!.browserStage}` : ''}`);
    throw new Error('PREVIEW_VERIFY_FAILED');
  }
  return result.receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runCiVerify({ args: process.argv.slice(2) }).catch(error => {
  const code = error instanceof Error && /^PREVIEW_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PREVIEW_VERIFY_COMMAND_FAILED';
  console.error(`Cake: ${code}。新しい依頼や再配置を繰り返さず、対象runを確認してください。`); process.exitCode = 1;
});

import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import capability from '../preview-retention.config.json';
import { config, object, source, uuid, sameDatabase, type Deployment, type Source } from './preview-model';
import { commandOutput, executeWorkflowCommand, fullSha, type WorkflowExecutor } from './task-workflow';
import { requestReceipt } from './preview-command';
import { assertVerificationControl, runCiVerify, verificationApi } from './preview-verify-command';
import { exactDeploymentIdentity, parseVerifyReceipt, serializeVerifyReceipt } from './preview-verify-receipt';
import { assertRetentionRun, loadRegistrationBaseline, loadRetentionOriginal, loadRetentionUpdate,
  previewWorkflow, readRetentionReceipt, readVerifyReceipt, type PreviewGet, type RetentionReadRequest } from './preview-checks';
import { parseRetentionReceipt, serializeRetentionReceipt, type RetentionReceipt } from './preview-retention-receipt';
import { sameRetentionEvidence, type RetentionAction } from './preview-retention-model';
import { assertRetentionWriteHistory } from './preview-retention-history';
import type { VerifyReceipt } from './preview-verify-receipt';

export const retentionProofProtocol = 'cake-preview-retention-proof/v1';
export const retentionIntentProtocol = 'cake-preview-retention-intent/v1';
const modes = ['prepare', 'inspect', 'update', 'reconcile', 'check'] as const;
export type RetentionMode = typeof modes[number];
export type RetentionTarget = { mode: RetentionMode; pr: number; sha: string; deploymentId?: string; marker?: string;
  baselinePath?: string; updatePath?: string; runId?: string };
export type RetentionUiReference = { workflowId: number; runId: string; controlSha: string; proofPath: string };
export type RetentionProof = { protocol: typeof retentionProofProtocol; workflowId: number; receipt: RetentionReceipt; uiVerification?: RetentionUiReference };
type Options = { args?: readonly string[]; cwd?: string; execute?: WorkflowExecutor; wait?: (ms: number) => Promise<void>;
  log?: (message: string) => void; status?: typeof requestReceipt; verify?: typeof runCiVerify };
const positiveId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const validWorkflowId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const sameSource = (a: Source, b: Source) => (['pr', 'branch', 'sha', 'createdAt', 'state'] as const).every(key => a[key] === b[key]);
const sameOwner = (a: Source, b: Source) => (['pr', 'branch', 'createdAt', 'state'] as const).every(key => a[key] === b[key]);
const actionFor = (mode: RetentionMode): RetentionAction => `retention-${mode}`;
const writes = (mode: RetentionMode) => mode === 'prepare' || mode === 'update';

export function retentionTarget(args: readonly string[]): RetentionTarget {
  const mode = args[0] as RetentionMode, values = new Map<string, string>();
  if (!modes.includes(mode)) throw new Error('PREVIEW_RETENTION_ARGUMENTS');
  const required = mode === 'prepare' ? ['--pr', '--sha', '--deployment', '--marker']
    : mode === 'inspect' ? ['--pr', '--sha', '--deployment', '--marker', '--run']
      : mode === 'update' ? ['--pr', '--sha', '--baseline']
        : mode === 'reconcile' ? ['--pr', '--sha', '--baseline', '--run']
          : ['--pr', '--sha', '--deployment', '--baseline', '--update'];
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!required.includes(key) || values.has(key) || !value?.trim() || value.startsWith('--') || /[\r\n\0]/.test(value)) throw new Error('PREVIEW_RETENTION_ARGUMENTS');
    values.set(key, value);
  }
  const pr = values.get('--pr'), sha = values.get('--sha'), deploymentId = values.get('--deployment'), marker = values.get('--marker'), runId = values.get('--run');
  if (values.size !== required.length || !positiveId(pr) || !fullSha(sha)
    || deploymentId !== undefined && !/^dpl_[A-Za-z0-9]+$/.test(deploymentId)
    || marker !== undefined && !uuid(marker) || runId !== undefined && !positiveId(runId)) throw new Error('PREVIEW_RETENTION_ARGUMENTS');
  return { mode, pr: Number(pr), sha, ...(deploymentId ? { deploymentId } : {}), ...(marker ? { marker } : {}),
    ...(values.has('--baseline') ? { baselinePath: values.get('--baseline')! } : {}),
    ...(values.has('--update') ? { updatePath: values.get('--update')! } : {}), ...(runId ? { runId } : {}) };
}

export async function assertRetentionControl(cwd: string, execute: WorkflowExecutor, get: PreviewGet): Promise<string> {
  const sha = await assertVerificationControl(cwd, execute, get);
  const file = object(await get(`contents/preview-retention.config.json?ref=${sha}`));
  try {
    if (file.encoding !== 'base64' || file.type !== 'file' || typeof file.content !== 'string' || file.content.length > 20_000
      || JSON.stringify(JSON.parse(Buffer.from(file.content, 'base64').toString())) !== JSON.stringify(capability)) throw new Error();
  } catch { throw new Error('PREVIEW_RETENTION_NOT_INSTALLED_ON_MAIN'); }
  return sha;
}

/** Wrappers are public hints. Duplicate keys cannot be hidden before the strict notice re-read. */
function uniqueJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text), scopes: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') scopes.push(new Set());
    else if (c === '[') scopes.push(null);
    else if (c === '}' || c === ']') scopes.pop();
    else if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, i + 1)) as string, scope = scopes.at(-1);
        if (!scope || scope.has(key)) throw new Error('PREVIEW_RETENTION_PROOF_INVALID');
        scope.add(key);
      }
    }
  }
  return parsed;
}
export function retentionProof(workflowId: number, receipt: RetentionReceipt, uiVerification?: RetentionUiReference): RetentionProof {
  if (!validWorkflowId(workflowId)) throw new Error('PREVIEW_RETENTION_PROOF_INVALID');
  const checked = parseRetentionReceipt(serializeRetentionReceipt(receipt));
  if (checked.action === 'retention-check' && checked.success && !uiVerification) throw new Error('PREVIEW_RETENTION_PROOF_INVALID');
  if (uiVerification && (Object.keys(uiVerification).sort().join(',') !== 'controlSha,proofPath,runId,workflowId'
    || !validWorkflowId(uiVerification.workflowId) || !positiveId(uiVerification.runId) || !fullSha(uiVerification.controlSha)
    || uiVerification.proofPath !== `.cake/verify-${checked.source.pr}.json` || uiVerification.workflowId !== workflowId
    || uiVerification.controlSha !== checked.controlSha || checked.action !== 'retention-check' || !checked.success)) throw new Error('PREVIEW_RETENTION_PROOF_INVALID');
  return { protocol: retentionProofProtocol, workflowId, receipt: checked, ...(uiVerification ? { uiVerification } : {}) };
}
export async function readRetentionProof(path: string): Promise<RetentionProof> {
  try {
    const meta = await lstat(path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 20_000) throw new Error();
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > 20_000 || text.includes('***')) throw new Error();
    const input = object(uniqueJson(text));
    if (input.protocol !== retentionProofProtocol || Object.keys(input).some(key => !['protocol', 'workflowId', 'receipt', 'uiVerification'].includes(key))
      || !Object.hasOwn(input, 'workflowId') || !Object.hasOwn(input, 'receipt')) throw new Error();
    let ui: RetentionUiReference | undefined;
    if (input.uiVerification !== undefined) {
      const value = object(input.uiVerification);
      if (Object.keys(value).sort().join(',') !== 'controlSha,proofPath,runId,workflowId') throw new Error();
      ui = value as RetentionUiReference;
    }
    if (!validWorkflowId(input.workflowId)) throw new Error();
    return retentionProof(input.workflowId, parseRetentionReceipt(JSON.stringify(input.receipt)), ui);
  } catch { throw new Error('PREVIEW_RETENTION_PROOF_INVALID'); }
}
async function revalidateProof(path: string, get: PreviewGet, kind: 'baseline' | 'update', baseline?: RetentionReceipt): Promise<RetentionProof> {
  const saved = await readRetentionProof(path), workflow = await previewWorkflow(get);
  if (saved.workflowId !== workflow.id) throw new Error('PREVIEW_WORKFLOW_CHANGED');
  const fresh = kind === 'baseline' ? await loadRegistrationBaseline(get, Number(saved.receipt.runId))
    : await loadRetentionUpdate(get, Number(saved.receipt.runId), baseline!);
  if (serializeRetentionReceipt(fresh) !== serializeRetentionReceipt(saved.receipt)) throw new Error('PREVIEW_RETENTION_PROOF_CHANGED');
  return retentionProof(workflow.id, fresh);
}

async function publicDirectory(cwd: string): Promise<string> {
  const path = resolve(cwd, '.cake');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const meta = await lstat(path);
  if (!meta.isDirectory() || meta.isSymbolicLink()) throw new Error('PREVIEW_RETENTION_PROOF_INVALID');
  return path;
}
/** Read retries invalidate only this PR/mode's generated files, before a stale
 * control or baseline can leave an older success looking like the new result. */
async function invalidateReadProofs(cwd: string, target: RetentionTarget): Promise<void> {
  if (writes(target.mode)) return;
  const directory = resolve(cwd, '.cake');
  let meta;
  try { meta = await lstat(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('PREVIEW_RETENTION_PROOF_INVALID'); }
  if (!meta.isDirectory() || meta.isSymbolicLink()) throw new Error('PREVIEW_RETENTION_PROOF_INVALID');
  const prefix = `retention-${target.pr}-`, suffix = `-${target.mode}.json`;
  const names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.name.startsWith(prefix) && entry.name.endsWith(suffix)
    && uuid(entry.name.slice(prefix.length, -suffix.length)));
  if (names.some(entry => !entry.isFile() || entry.isSymbolicLink())) throw new Error('PREVIEW_RETENTION_PROOF_INVALID');
  for (const entry of names) await rm(join(directory, entry.name), { force: true });
}
async function assertCurrent(get: PreviewGet, expected: Source, controlSha: string): Promise<void> {
  if (!sameSource(source(await get(`pulls/${expected.pr}`)), expected)
    || object(object(await get('branches/main')).commit).sha !== controlSha) throw new Error('PREVIEW_PR_CHANGED');
}
export async function requestRetention(action: RetentionAction, expected: Source, deploymentId: string, marker: string, controlSha: string,
  cwd: string, execute: WorkflowExecutor, wait: (ms: number) => Promise<void>, log: (message: string) => void,
  references: { baselineRunId?: string; updateRunId?: string } = {}, prepareRunId?: string): Promise<{ workflowId: number; receipt: RetentionReceipt }> {
  const get = verificationApi(cwd, execute);
  await assertCurrent(get, expected, controlSha);
  const workflow = await previewWorkflow(get), operation = ['retention-prepare', 'retention-update'].includes(action) ? marker : randomUUID();
  const request: RetentionReadRequest = { action, source: expected, expectedDeploymentId: deploymentId, marker, operation,
    controlSha, workflowId: workflow.id, ...references };
  let intent: string | undefined;
  if (action === 'retention-prepare' || action === 'retention-update') {
    const mode = action === 'retention-prepare' ? 'prepare' : 'update';
    await assertRetentionWriteHistory(get, { action, pr: expected.pr, marker, ...(prepareRunId ? { prepareRunId } : {}) });
    const directory = await publicDirectory(cwd);
    intent = join(directory, `retention-${expected.pr}-${mode}.intent.json`);
    try {
      await writeFile(intent, JSON.stringify({ protocol: retentionIntentProtocol, action, source: expected, expectedDeploymentId: deploymentId,
        marker, operation, controlSha, workflowId: workflow.id, ...references, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    } catch { throw new Error('PREVIEW_RETENTION_WRITE_INTENT_EXISTS'); }
    log(`Cake: 単発書込intent ${intent} / request ${operation}。失敗時も保持し、inspect/reconcileで元runを照合してください。`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'cake-retention-'));
  try {
    const file = join(directory, 'request.json');
    await writeFile(file, JSON.stringify({ ref: 'main', inputs: { action, pr: String(expected.pr), sha: expected.sha, deploymentId,
      marker, operation, controlSha, ...references } }), { mode: 0o600, flag: 'wx' });
    await commandOutput(execute, 'gh', ['api', `repos/${config.repository}/actions/workflows/preview.yml/dispatches`, '--method', 'POST', '--input', file], cwd, 'PREVIEW_RETENTION_DISPATCH_UNKNOWN');
    let run: Record<string, unknown> | undefined;
    for (let i = 0; i < 300; i++) {
      const response = object(await get('actions/workflows/preview.yml/runs?event=workflow_dispatch&branch=main&per_page=100'));
      if (!Array.isArray(response.workflow_runs)) throw new Error('PREVIEW_RUN_UNAVAILABLE');
      const matches = response.workflow_runs.filter(value => object(value).display_title === `Preview ${action} PR ${expected.pr} ${operation}`);
      if (matches.length > 1) throw new Error('PREVIEW_RUN_AMBIGUOUS');
      if (matches.length) {
        run = assertRetentionRun(matches[0], request);
        if (i === 0 || i % 12 === 0) log(`Cake: Actions https://github.com/${config.repository}/actions/runs/${run.id}`);
        if (intent) {
          const saved = JSON.parse(await readFile(intent, 'utf8'));
          await writeFile(intent, JSON.stringify({ ...saved, runId: String(run.id) }, null, 2) + '\n', { mode: 0o600 });
          intent = undefined;
        }
        if (run.status === 'completed') break;
      }
      if (i % 12 === 0) log(`Cake: retention結果を確認しています。request ${operation}`);
      await wait(5000);
    }
    if (!run || run.status !== 'completed' || !['success', 'failure'].includes(String(run.conclusion))) throw new Error('PREVIEW_RETENTION_RUN_INCOMPLETE');
    const receipt = await readRetentionReceipt(get, Number(run.id), request);
    await assertCurrent(get, expected, controlSha);
    return { workflowId: workflow.id, receipt };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function runRetention({ args = [], cwd = process.cwd(), execute = executeWorkflowCommand,
  wait = ms => new Promise(r => setTimeout(r, ms)), log = console.log, status = requestReceipt, verify = runCiVerify }: Options = {}): Promise<RetentionProof> {
  const target = retentionTarget(args), get = verificationApi(cwd, execute);
  await invalidateReadProofs(cwd, target);
  const controlSha = await assertRetentionControl(cwd, execute, get), expected = source(await get(`pulls/${target.pr}`));
  if (expected.state !== 'open' || expected.sha !== target.sha) throw new Error('PREVIEW_PR_CHANGED');
  let marker = target.marker!, deploymentId = target.deploymentId!, baseline: RetentionReceipt | undefined, updatedDeployment: Deployment | undefined;
  const references: { baselineRunId?: string; updateRunId?: string } = {};
  if (target.baselinePath) {
    baseline = (await revalidateProof(resolve(cwd, target.baselinePath), get, 'baseline')).receipt;
    if (!sameOwner(baseline.source, expected) || baseline.source.sha === expected.sha || !baseline.deployment || !baseline.database) throw new Error('PREVIEW_RETENTION_TARGET_CHANGED');
    marker = baseline.marker; deploymentId = baseline.deployment.id; references.baselineRunId = baseline.runId;
  }
  if (target.mode === 'prepare' || target.mode === 'inspect') {
    const before = await status('status', expected, cwd, execute, wait, log);
    if (!before.deployment || !before.database || before.deployment.id !== deploymentId || before.deployment.state !== 'READY'
      || before.deployment.phase !== 'application' || !sameSource(before.source, expected) || before.deployment.sha !== expected.sha
      || !before.deployment.database || !sameDatabase(before.database, before.deployment.database)) throw new Error('PREVIEW_RETENTION_TARGET_CHANGED');
  }
  if (target.mode === 'inspect') {
    const original = await loadRetentionOriginal(get, Number(target.runId));
    if (original.run.action !== 'retention-prepare' || original.run.pr !== expected.pr || original.run.operation !== marker
      || original.receipt && (!sameSource(original.receipt.source, expected) || original.receipt.expectedDeploymentId !== deploymentId || original.receipt.marker !== marker)) throw new Error('PREVIEW_RETENTION_TARGET_CHANGED');
    references.baselineRunId = target.runId;
  }
  if (target.mode === 'reconcile') {
    const original = await loadRetentionOriginal(get, Number(target.runId));
    if (original.run.action !== 'retention-update' || original.run.pr !== expected.pr || original.run.operation !== marker
      || original.receipt && (!sameSource(original.receipt.source, expected) || original.receipt.expectedDeploymentId !== deploymentId
        || original.receipt.marker !== marker || original.receipt.baselineRunId !== baseline!.runId)) throw new Error('PREVIEW_RETENTION_TARGET_CHANGED');
    references.updateRunId = target.runId;
  }
  if (target.mode === 'check') {
    const updated = (await revalidateProof(resolve(cwd, target.updatePath!), get, 'update', baseline)).receipt;
    if (!sameSource(updated.source, expected) || !updated.deployment || !updated.database || updated.deployment.id !== target.deploymentId) throw new Error('PREVIEW_RETENTION_TARGET_CHANGED');
    deploymentId = updated.deployment.id;
    updatedDeployment = updated.deployment;
    // For check the accepted reconcile run is the reference; its original update is re-read by the chain loader.
    references.updateRunId = updated.runId;
  }
  const mode = target.mode, directory = await publicDirectory(cwd), path = join(directory, `retention-${target.pr}-${marker}-${mode}.json`);
  if (!writes(mode)) await rm(path, { force: true });
  let uiVerification: RetentionUiReference | undefined;
  let ui: VerifyReceipt | undefined;
  if (mode === 'check') {
    ui = parseVerifyReceipt(serializeVerifyReceipt(await verify({ args: ['--pr', String(target.pr), '--sha', target.sha, '--deployment', deploymentId],
      cwd, execute, wait, log, status })));
    if (!ui.success || !sameSource(ui.source, expected) || ui.controlSha !== controlSha || !ui.deployment || !updatedDeployment
      || !exactDeploymentIdentity(ui.deployment, updatedDeployment)) throw new Error('PREVIEW_RETENTION_UI_VERIFY_FAILED');
    await assertCurrent(get, expected, controlSha);
  }
  // The last data observation follows normal UI QA, whose application GETs may have side effects.
  const originalPrepareId = baseline && (baseline.action === 'retention-inspect' ? baseline.baselineRunId : baseline.runId);
  const result = await requestRetention(actionFor(mode), expected, deploymentId, marker, controlSha, cwd, execute, wait, log, references, originalPrepareId);
  if (ui && result.receipt.success) {
    const fresh = await readVerifyReceipt(get, Number(ui.runId), { action: 'verify', source: expected, expectedDeployment: updatedDeployment!,
      operation: ui.operation, controlSha, workflowId: result.workflowId });
    if (!fresh.success || serializeVerifyReceipt(fresh) !== serializeVerifyReceipt(ui) || !result.receipt.deployment
      || !exactDeploymentIdentity(ui.deployment!, result.receipt.deployment)) throw new Error('PREVIEW_RETENTION_UI_VERIFY_FAILED');
    if (!result.receipt.evidence || !baseline?.evidence || !sameRetentionEvidence(result.receipt.evidence, baseline.evidence)) throw new Error('PREVIEW_RETENTION_EVIDENCE_CHANGED');
    uiVerification = { workflowId: result.workflowId, runId: ui.runId, controlSha: ui.controlSha, proofPath: `.cake/verify-${target.pr}.json` };
    await assertCurrent(get, expected, controlSha);
  }
  const proof = retentionProof(result.workflowId, result.receipt, uiVerification);
  await writeFile(path, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  log(`Cake: retention ${mode} ${result.receipt.success ? '成功' : '失敗'}: https://github.com/${config.repository}/actions/runs/${result.receipt.runId}`);
  if (!result.receipt.success) throw new Error(result.receipt.failure!.code);
  return proof;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runRetention({ args: process.argv.slice(2) }).catch(error => {
  const code = error instanceof Error && /^PREVIEW_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PREVIEW_RETENTION_COMMAND_FAILED';
  console.error(`Cake: ${code}。単発書込を繰り返さず、保持したintentと元runをinspect/reconcileで確認してください。`); process.exitCode = 1;
});

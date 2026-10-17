import { config, object, source, uuid, type Source } from './preview-model';
import { assertReceipt, parseReceipt, receiptMaxBytes, receiptNoticeTitle, type OperationReceipt } from './preview-receipt';
import { assertVerifyReceipt, parseVerifyReceipt, verifyReceiptNoticeTitle, type VerifyReceipt, type VerifyReceiptRequest } from './preview-verify-receipt';
import { assertRegistrationBaseline, assertRetentionReceipt, assertRetentionUpdate, parseRetentionReceipt, serializeRetentionReceipt, retentionReceiptNoticeTitle, type RetentionReceipt, type RetentionReceiptRequest } from './preview-retention-receipt';
import { retentionActions, type RetentionAction } from './preview-retention-model';
import { fullSha } from './task-workflow';

export type PreviewGet = (path: string) => Promise<unknown>;
export type PreviewWorkflow = { id: number };
export type ReceiptRequest = {
  action: 'deploy' | 'status' | 'cleanup'; source: Source; operation: string; controlSha: string; workflowId: number;
};
export type VerifyReadRequest = Omit<VerifyReceiptRequest, 'runId' | 'runAttempt' | 'notBefore' | 'notAfter'> & { workflowId: number };
export type RetentionReadRequest = Omit<RetentionReceiptRequest, 'runId' | 'runAttempt' | 'notBefore' | 'notAfter'> & { workflowId: number };
type RunRequest = { action: ReceiptRequest['action'] | 'verify' | RetentionAction; source: Pick<Source, 'pr'>; operation: string; controlSha: string; workflowId: number };
export type RetentionRunContext = { action: RetentionAction; pr: number; operation: string; runId: string; runAttempt: number; controlSha: string; workflowId: number; status: string; conclusion: string | null };
const workflowPath = '.github/workflows/preview.yml';
const apiUrl = (path: string) => `https://api.github.com/repos/${config.repository}/${path}`;
const positiveId = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const timestamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const successful = (v: Record<string, unknown>) => v.status === 'completed' && v.conclusion === 'success';
const completedWith = (v: Record<string, unknown>, conclusion: 'success' | 'failure') => v.status === 'completed' && v.conclusion === conclusion;
const repository = (v: unknown) => {
  const r = object(v); return r.id === config.repositoryId && r.full_name === config.repository;
};
const actionsApp = (v: unknown): Record<string, unknown> => {
  const app = object(v);
  if (!positiveId(app.id) || app.slug !== 'github-actions' || app.html_url !== 'https://github.com/apps/github-actions') throw new Error('PREVIEW_CHECK_CHANGED');
  return app;
};

export async function previewWorkflow(get: PreviewGet): Promise<PreviewWorkflow> {
  const workflow = object(await get('actions/workflows/preview.yml'));
  if (!positiveId(workflow.id) || workflow.path !== workflowPath || workflow.state !== 'active'
    || workflow.url !== apiUrl(`actions/workflows/${workflow.id}`)) throw new Error('PREVIEW_WORKFLOW_CHANGED');
  return { id: workflow.id };
}

export function assertPreviewRun(value: unknown, expected: RunRequest, completed = false): Record<string, unknown> {
  const run = object(value);
  if (!positiveId(run.id) || run.run_attempt !== 1 || run.workflow_id !== expected.workflowId
    || run.head_sha !== expected.controlSha || run.head_branch !== 'main' || run.path !== workflowPath
    || run.event !== 'workflow_dispatch' || run.display_title !== `Preview ${expected.action} PR ${expected.source.pr} ${expected.operation}`
    || !repository(run.repository) || !repository(run.head_repository) || !positiveId(run.check_suite_id)
    || run.url !== apiUrl(`actions/runs/${run.id}`) || run.check_suite_url !== apiUrl(`check-suites/${run.check_suite_id}`)
    || !timestamp(run.created_at) || !timestamp(run.updated_at) || Date.parse(run.created_at) > Date.parse(run.updated_at)
    || completed && !successful(run)) throw new Error('PREVIEW_RUN_CHANGED');
  return run;
}

function checkRunId(value: unknown): number {
  // Never follow an arbitrary URL returned by metadata, including its query or redirects.
  const prefix = apiUrl('check-runs/');
  if (typeof value !== 'string' || !value.startsWith(prefix)) throw new Error('PREVIEW_CHECK_URL');
  const suffix = value.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(suffix) || !positiveId(Number(suffix))) throw new Error('PREVIEW_CHECK_URL');
  return Number(suffix);
}

async function operationJob(get: PreviewGet, run: Record<string, unknown>, expected: RunRequest, conclusion: 'success' | 'failure' | null = 'success'): Promise<Record<string, unknown>> {
  const jobs: Record<string, unknown>[] = [];
  let count: number | undefined;
  for (let page = 1; ; page++) {
    const response = object(await get(`actions/runs/${run.id}/attempts/1/jobs?per_page=100&page=${page}`));
    if (!Number.isSafeInteger(response.total_count) || Number(response.total_count) < 1 || Number(response.total_count) > 1000
      || count !== undefined && response.total_count !== count || !Array.isArray(response.jobs) || response.jobs.length > 100) throw new Error('PREVIEW_JOBS_INCOMPLETE');
    count = Number(response.total_count);
    jobs.push(...response.jobs.map(object));
    if (jobs.length > count || jobs.length < count && response.jobs.length !== 100) throw new Error('PREVIEW_JOBS_INCOMPLETE');
    if (jobs.length === count) break;
  }
  if (jobs.some(job => !positiveId(job.id)) || new Set(jobs.map(job => job.id)).size !== jobs.length
    || new Set(jobs.map(job => job.check_run_url)).size !== jobs.length) throw new Error('PREVIEW_JOBS_INCOMPLETE');
  const candidates = jobs.filter(job => job.name === 'preview');
  if (candidates.length !== 1) throw new Error('PREVIEW_JOB_AMBIGUOUS');
  const job = candidates[0];
  if (job.run_id !== run.id || job.run_attempt !== 1 || job.head_sha !== expected.controlSha || job.head_branch !== 'main'
    || (conclusion === null ? !['queued', 'in_progress', 'completed', 'waiting', 'pending'].includes(String(job.status)) : !completedWith(job, conclusion))
    || job.url !== apiUrl(`actions/jobs/${job.id}`) || job.run_url !== run.url
    || conclusion !== null && (!timestamp(job.started_at) || !timestamp(job.completed_at))
    || job.started_at != null && (!timestamp(job.started_at) || Date.parse(job.started_at) < Date.parse(String(run.created_at)) - 60_000)
    || job.completed_at != null && (!timestamp(job.completed_at) || Date.parse(job.completed_at) > Date.parse(String(run.updated_at)) + 60_000)
    || timestamp(job.started_at) && timestamp(job.completed_at) && Date.parse(job.started_at) > Date.parse(job.completed_at)) throw new Error('PREVIEW_JOB_CHANGED');
  checkRunId(job.check_run_url);
  return job;
}

function assertCheck(value: unknown, run: Record<string, unknown>, job: Record<string, unknown>, app: Record<string, unknown>, conclusion: 'success' | 'failure' | null = 'success', allowEmpty = false): Record<string, unknown> {
  const check = object(value), checkApp = actionsApp(check.app), output = object(check.output);
  if (check.id !== checkRunId(job.check_run_url) || check.url !== job.check_run_url || check.head_sha !== run.head_sha
    || object(check.check_suite).id !== run.check_suite_id || checkApp.id !== app.id || check.name !== job.name
    || (conclusion === null ? !['queued', 'in_progress', 'completed', 'waiting', 'pending'].includes(String(check.status)) : !completedWith(check, conclusion))
    || conclusion !== null && (!timestamp(check.started_at) || !timestamp(check.completed_at))
    || check.started_at != null && (!timestamp(check.started_at) || Math.abs(Date.parse(check.started_at) - Date.parse(String(job.started_at))) > 60_000)
    || check.completed_at != null && (!timestamp(check.completed_at) || Math.abs(Date.parse(check.completed_at) - Date.parse(String(job.completed_at))) > 60_000)
    || timestamp(check.started_at) && timestamp(check.completed_at) && Date.parse(check.started_at) > Date.parse(check.completed_at)) throw new Error('PREVIEW_CHECK_CHANGED');
  if (!Number.isSafeInteger(output.annotations_count) || Number(output.annotations_count) < (allowEmpty ? 0 : 1) || Number(output.annotations_count) > 1000
    || output.annotations_url !== apiUrl(`check-runs/${check.id}/annotations`)) throw new Error('PREVIEW_ANNOTATIONS_INCOMPLETE');
  return check;
}

async function receiptText(get: PreviewGet, check: Record<string, unknown>, title = receiptNoticeTitle, missingCode?: string): Promise<string> {
  const count = Number(object(check.output).annotations_count), annotations: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const response = await get(`check-runs/${check.id}/annotations?per_page=100&page=${page}`);
    if (!Array.isArray(response) || response.length > 100) throw new Error('PREVIEW_ANNOTATIONS_INCOMPLETE');
    annotations.push(...response.map(object));
    if (annotations.length > count || annotations.length < count && response.length !== 100) throw new Error('PREVIEW_ANNOTATIONS_INCOMPLETE');
    if (annotations.length === count) break;
  }
  const receipts = annotations.filter(annotation => annotation.title === title);
  if (receipts.length === 0 && missingCode) throw new Error(missingCode);
  if (receipts.length !== 1) throw new Error('PREVIEW_RECEIPT_AMBIGUOUS');
  const annotation = receipts[0];
  if (annotation.annotation_level !== 'notice' || typeof annotation.message !== 'string' || !annotation.message
    || annotation.message.includes('***')) throw new Error('PREVIEW_RECEIPT_INVALID');
  if (Buffer.byteLength(annotation.message, 'utf8') > receiptMaxBytes) throw new Error('PREVIEW_RECEIPT_TOO_LARGE');
  return annotation.message;
}

function checkSnapshot(check: Record<string, unknown>): string {
  return JSON.stringify({ id: check.id, url: check.url, name: check.name, head_sha: check.head_sha,
    suite: check.check_suite, app: check.app, status: check.status, conclusion: check.conclusion,
    started_at: check.started_at, completed_at: check.completed_at, output: check.output });
}

export async function readPreviewReceipt(get: PreviewGet, runId: number, expected: ReceiptRequest): Promise<OperationReceipt> {
  const runPath = `actions/runs/${runId}`, run = assertPreviewRun(await get(runPath), expected, true);
  if (run.id !== runId) throw new Error('PREVIEW_RUN_CHANGED');
  const job = await operationJob(get, run, expected);
  const suite = object(await get(`check-suites/${run.check_suite_id}`)), app = actionsApp(suite.app);
  if (suite.id !== run.check_suite_id || suite.url !== run.check_suite_url || suite.head_sha !== expected.controlSha
    || suite.head_branch !== 'main' || !repository(suite.repository) || !successful(suite)) throw new Error('PREVIEW_SUITE_CHANGED');
  const checkPath = `check-runs/${checkRunId(job.check_run_url)}`;
  const check = assertCheck(await get(checkPath), run, job, app);
  const receipt = parseReceipt(await receiptText(get, check));
  assertReceipt(receipt, { ...expected, runId: String(runId), runAttempt: 1,
    notBefore: new Date(Date.parse(String(job.started_at)) - 60_000).toISOString(),
    notAfter: new Date(Date.parse(String(job.completed_at)) + 60_000).toISOString() });
  const afterCheck = assertCheck(await get(checkPath), run, job, app);
  if (checkSnapshot(afterCheck) !== checkSnapshot(check)) throw new Error('PREVIEW_CHECK_CHANGED');
  const afterRun = assertPreviewRun(await get(runPath), expected, true);
  if (afterRun.id !== run.id || afterRun.check_suite_id !== run.check_suite_id || afterRun.created_at !== run.created_at
    || afterRun.updated_at !== run.updated_at) throw new Error('PREVIEW_RUN_CHANGED');
  return receipt;
}

function assertNoticeStep(job: Record<string, unknown>): void {
  if (!Array.isArray(job.steps)) throw new Error('PREVIEW_VERIFY_NOTICE_STEP');
  const steps = job.steps.map(object).filter(step => step.name === 'Publish public operation receipt notice');
  if (steps.length !== 1 || !positiveId(steps[0].number) || !successful(steps[0])) throw new Error('PREVIEW_VERIFY_NOTICE_STEP');
}
function jobSnapshot(job: Record<string, unknown>): string {
  return JSON.stringify({ id: job.id, name: job.name, run_id: job.run_id, run_attempt: job.run_attempt, head_sha: job.head_sha,
    head_branch: job.head_branch, status: job.status, conclusion: job.conclusion, url: job.url, run_url: job.run_url,
    check_run_url: job.check_run_url, started_at: job.started_at, completed_at: job.completed_at, steps: job.steps });
}
function suiteSnapshot(suite: Record<string, unknown>): string {
  return JSON.stringify({ id: suite.id, url: suite.url, head_sha: suite.head_sha, head_branch: suite.head_branch,
    repository: suite.repository, app: suite.app, status: suite.status, conclusion: suite.conclusion });
}
/** Verify failures are diagnostics only; legacy operation receipts still require success. */
export async function readVerifyReceipt(get: PreviewGet, runId: number, expected: VerifyReadRequest): Promise<VerifyReceipt> {
  const runPath = `actions/runs/${runId}`, run = assertPreviewRun(await get(runPath), expected);
  if (run.id !== runId || run.status !== 'completed' || !['success', 'failure'].includes(String(run.conclusion))) throw new Error('PREVIEW_RUN_CHANGED');
  const conclusion = run.conclusion as 'success' | 'failure';
  const job = await operationJob(get, run, expected, conclusion);
  assertNoticeStep(job);
  const suitePath = `check-suites/${run.check_suite_id}`, suite = object(await get(suitePath)), app = actionsApp(suite.app);
  const assertSuite = (value: Record<string, unknown>): void => {
    const currentApp = actionsApp(value.app);
    if (value.id !== run.check_suite_id || value.url !== run.check_suite_url || value.head_sha !== expected.controlSha
      || value.head_branch !== 'main' || !repository(value.repository) || currentApp.id !== app.id || !completedWith(value, conclusion)) throw new Error('PREVIEW_SUITE_CHANGED');
  };
  assertSuite(suite);
  const checkPath = `check-runs/${checkRunId(job.check_run_url)}`, check = assertCheck(await get(checkPath), run, job, app, conclusion);
  const receipt = parseVerifyReceipt(await receiptText(get, check, verifyReceiptNoticeTitle));
  assertVerifyReceipt(receipt, { ...expected, runId: String(runId), runAttempt: 1,
    notBefore: new Date(Date.parse(String(job.started_at)) - 60_000).toISOString(),
    notAfter: new Date(Date.parse(String(job.completed_at)) + 60_000).toISOString() });
  if (receipt.success !== (conclusion === 'success')) throw new Error('PREVIEW_VERIFY_RESULT_CHANGED');
  const afterCheck = assertCheck(await get(checkPath), run, job, app, conclusion);
  if (checkSnapshot(afterCheck) !== checkSnapshot(check)) throw new Error('PREVIEW_CHECK_CHANGED');
  const afterSuite = object(await get(suitePath)); assertSuite(afterSuite);
  if (suiteSnapshot(afterSuite) !== suiteSnapshot(suite)) throw new Error('PREVIEW_SUITE_CHANGED');
  const afterJob = await operationJob(get, run, expected, conclusion); assertNoticeStep(afterJob);
  if (jobSnapshot(afterJob) !== jobSnapshot(job)) throw new Error('PREVIEW_JOB_CHANGED');
  const afterRun = assertPreviewRun(await get(runPath), expected);
  if (afterRun.id !== run.id || afterRun.status !== 'completed' || afterRun.conclusion !== conclusion
    || afterRun.check_suite_id !== run.check_suite_id || afterRun.created_at !== run.created_at || afterRun.updated_at !== run.updated_at) throw new Error('PREVIEW_RUN_CHANGED');
  return receipt;
}

export function assertRetentionRun(value: unknown, expected: RetentionReadRequest, completed = false): Record<string, unknown> {
  const run = assertPreviewRun(value, expected);
  if (completed && (run.status !== 'completed' || !['success', 'failure'].includes(String(run.conclusion)))) throw new Error('PREVIEW_RUN_CHANGED');
  return run;
}
/** Retention failures retain diagnostics, while existing readers keep their success requirements. */
export async function readRetentionReceipt(get: PreviewGet, runId: number, expected: RetentionReadRequest): Promise<RetentionReceipt> {
  const runPath = `actions/runs/${runId}`, run = assertRetentionRun(await get(runPath), expected, true);
  if (run.id !== runId) throw new Error('PREVIEW_RUN_CHANGED');
  const conclusion = run.conclusion as 'success' | 'failure';
  const job = await operationJob(get, run, expected, conclusion); assertNoticeStep(job);
  const suitePath = `check-suites/${run.check_suite_id}`, suite = object(await get(suitePath)), app = actionsApp(suite.app);
  const assertSuite = (value: Record<string, unknown>): void => {
    if (value.id !== run.check_suite_id || value.url !== run.check_suite_url || value.head_sha !== expected.controlSha || value.head_branch !== 'main'
      || !repository(value.repository) || actionsApp(value.app).id !== app.id || !completedWith(value, conclusion)) throw new Error('PREVIEW_SUITE_CHANGED');
  };
  assertSuite(suite);
  const checkPath = `check-runs/${checkRunId(job.check_run_url)}`, check = assertCheck(await get(checkPath), run, job, app, conclusion, true);
  const receipt = parseRetentionReceipt(await receiptText(get, check, retentionReceiptNoticeTitle, 'PREVIEW_RETENTION_RECEIPT_MISSING'));
  assertRetentionReceipt(receipt, { ...expected, runId: String(runId), runAttempt: 1,
    notBefore: new Date(Date.parse(String(job.started_at)) - 60_000).toISOString(), notAfter: new Date(Date.parse(String(job.completed_at)) + 60_000).toISOString() });
  if (receipt.success !== (conclusion === 'success')) throw new Error('PREVIEW_RETENTION_RESULT_CHANGED');
  const afterCheck = assertCheck(await get(checkPath), run, job, app, conclusion, true);
  if (checkSnapshot(afterCheck) !== checkSnapshot(check)) throw new Error('PREVIEW_CHECK_CHANGED');
  const afterSuite = object(await get(suitePath)); assertSuite(afterSuite);
  if (suiteSnapshot(afterSuite) !== suiteSnapshot(suite)) throw new Error('PREVIEW_SUITE_CHANGED');
  const afterJob = await operationJob(get, run, expected, conclusion); assertNoticeStep(afterJob);
  if (jobSnapshot(afterJob) !== jobSnapshot(job)) throw new Error('PREVIEW_JOB_CHANGED');
  const afterRun = assertRetentionRun(await get(runPath), expected, true);
  if (runSnapshot(afterRun) !== runSnapshot(run)) throw new Error('PREVIEW_RUN_CHANGED');
  return receipt;
}
function runSnapshot(run: Record<string, unknown>): string {
  return JSON.stringify({ id: run.id, run_attempt: run.run_attempt, workflow_id: run.workflow_id, head_sha: run.head_sha, head_branch: run.head_branch,
    path: run.path, event: run.event, display_title: run.display_title, status: run.status, conclusion: run.conclusion, repository: run.repository,
    head_repository: run.head_repository, check_suite_id: run.check_suite_id, url: run.url, check_suite_url: run.check_suite_url,
    created_at: run.created_at, updated_at: run.updated_at });
}
function contextRequest(run: RetentionRunContext): RunRequest {
  return { action: run.action, source: { pr: run.pr }, operation: run.operation, controlSha: run.controlSha, workflowId: run.workflowId };
}
/** Run metadata alone never establishes a historical target SHA, Deployment or successful write. */
export async function loadRetentionRun(get: PreviewGet, runId: number): Promise<RetentionRunContext> {
  if (!positiveId(runId)) throw new Error('PREVIEW_RUN_CHANGED');
  const workflow = await previewWorkflow(get), path = `actions/runs/${runId}`, value = object(await get(path));
  const title = typeof value.display_title === 'string' ? /^Preview (retention-[a-z]+) PR ([1-9][0-9]*) ([a-f0-9-]+)$/.exec(value.display_title) : null;
  if (!title || !(retentionActions as readonly string[]).includes(title[1]) || !positiveId(Number(title[2])) || !uuid(title[3]) || !fullSha(value.head_sha)) throw new Error('PREVIEW_RUN_CHANGED');
  const result: RetentionRunContext = { action: title[1] as RetentionAction, pr: Number(title[2]), operation: title[3], runId: String(runId), runAttempt: 1,
    controlSha: value.head_sha, workflowId: workflow.id, status: String(value.status), conclusion: value.conclusion === null ? null : String(value.conclusion) };
  const run = assertPreviewRun(value, contextRequest(result)); if (run.id !== runId) throw new Error('PREVIEW_RUN_CHANGED');
  if (!['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(result.status)) throw new Error('PREVIEW_RUN_CHANGED');
  if (value.conclusion !== null && typeof value.conclusion !== 'string'
    || result.status === 'completed' && !['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure'].includes(String(result.conclusion))
    || result.status !== 'completed' && result.conclusion !== null) throw new Error('PREVIEW_RUN_CHANGED');
  const suitePath = `check-suites/${run.check_suite_id}`, suite = object(await get(suitePath));
  const assertSuite = (s: Record<string, unknown>): void => {
    actionsApp(s.app);
    if (s.id !== run.check_suite_id || s.url !== run.check_suite_url || s.head_sha !== result.controlSha || s.head_branch !== 'main' || !repository(s.repository)) throw new Error('PREVIEW_SUITE_CHANGED');
  };
  assertSuite(suite);
  const afterSuite = object(await get(suitePath)); assertSuite(afterSuite);
  if (suiteSnapshot(afterSuite) !== suiteSnapshot(suite) || runSnapshot(assertPreviewRun(await get(path), contextRequest(result))) !== runSnapshot(run)) throw new Error('PREVIEW_RUN_CHANGED');
  return result;
}
/** Missing notices are distinct from malformed, masked, duplicated, or untrusted results. */
export async function loadRetentionOriginal(get: PreviewGet, runId: number): Promise<{ run: RetentionRunContext; receipt?: RetentionReceipt }> {
  const context = await loadRetentionRun(get, runId), expected = contextRequest(context);
  const runPath = `actions/runs/${runId}`, run = assertPreviewRun(await get(runPath), expected);
  if (run.status !== context.status || run.conclusion !== context.conclusion) throw new Error('PREVIEW_RUN_CHANGED');
  const job = await operationJob(get, run, expected, null), suitePath = `check-suites/${run.check_suite_id}`, suite = object(await get(suitePath)), app = actionsApp(suite.app);
  if (suite.id !== run.check_suite_id || suite.url !== run.check_suite_url || suite.head_sha !== context.controlSha || suite.head_branch !== 'main' || !repository(suite.repository)) throw new Error('PREVIEW_SUITE_CHANGED');
  const checkPath = `check-runs/${checkRunId(job.check_run_url)}`, check = assertCheck(await get(checkPath), run, job, app, null, true);
  let text: string | undefined;
  try { text = await receiptText(get, check, retentionReceiptNoticeTitle, 'PREVIEW_RETENTION_RECEIPT_MISSING'); }
  catch (error) { if (!(error instanceof Error) || error.message !== 'PREVIEW_RETENTION_RECEIPT_MISSING') throw error; }
  const afterCheck = assertCheck(await get(checkPath), run, job, app, null, true);
  if (checkSnapshot(afterCheck) !== checkSnapshot(check)) throw new Error('PREVIEW_CHECK_CHANGED');
  const afterJob = await operationJob(get, run, expected, null);
  if (jobSnapshot(afterJob) !== jobSnapshot(job) || suiteSnapshot(object(await get(suitePath))) !== suiteSnapshot(suite)
    || runSnapshot(assertPreviewRun(await get(runPath), expected)) !== runSnapshot(run)) throw new Error('PREVIEW_RUN_CHANGED');
  if (text === undefined) return { run: context };
  const candidate = parseRetentionReceipt(text);
  const current = source(await get(`pulls/${context.pr}`));
  if (current.state !== 'open' || candidate.source.pr !== current.pr || candidate.source.branch !== current.branch || candidate.source.createdAt !== current.createdAt) throw new Error('PREVIEW_PR_CHANGED');
  const receipt = await readRetentionReceipt(get, runId, { action: context.action, source: candidate.source, expectedDeploymentId: candidate.expectedDeploymentId,
    marker: candidate.marker, baselineRunId: candidate.baselineRunId, updateRunId: candidate.updateRunId,
    operation: context.operation, controlSha: context.controlSha, workflowId: context.workflowId });
  if (JSON.stringify(source(await get(`pulls/${context.pr}`))) !== JSON.stringify(current)) throw new Error('PREVIEW_PR_CHANGED');
  return { run: context, receipt };
}
export async function loadRetentionReceipt(get: PreviewGet, runId: number): Promise<RetentionReceipt> {
  const result = await loadRetentionOriginal(get, runId);
  if (!result.receipt) throw new Error('PREVIEW_RETENTION_RECEIPT_MISSING');
  return result.receipt;
}
export async function loadRegistrationBaseline(get: PreviewGet, runId: number): Promise<RetentionReceipt> {
  const baseline = await loadRetentionReceipt(get, runId);
  const original = baseline.action === 'retention-inspect' ? await loadRetentionReceipt(get, Number(baseline.baselineRunId)) : undefined;
  assertRegistrationBaseline(baseline, original); return baseline;
}
export async function loadRetentionUpdate(get: PreviewGet, runId: number, baseline: RetentionReceipt): Promise<RetentionReceipt> {
  const freshBaseline = await loadRegistrationBaseline(get, Number(baseline.runId));
  if (serializeRetentionReceipt(freshBaseline) !== serializeRetentionReceipt(baseline)) throw new Error('PREVIEW_RETENTION_BASELINE_CHANGED');
  const update = await loadRetentionReceipt(get, runId);
  const original = update.action === 'retention-reconcile' ? await loadRetentionReceipt(get, Number(update.updateRunId)) : undefined;
  assertRetentionUpdate(update, freshBaseline, original); return update;
}

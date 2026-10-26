import { config, object, type Source } from './preview-model';
import { assertReceipt, parseReceipt, receiptMaxBytes, receiptNoticeTitle, type OperationReceipt } from './preview-receipt';
import { assertVerifyReceipt, parseVerifyReceipt, verifyReceiptNoticeTitle, type VerifyReceipt, type VerifyReceiptRequest } from './preview-verify-receipt';

export type PreviewGet = (path: string) => Promise<unknown>;
export type PreviewWorkflow = { id: number };
export type ReceiptRequest = {
  action: 'deploy' | 'status' | 'cleanup'; source: Source; operation: string; controlSha: string; workflowId: number;
};
export type VerifyReadRequest = Omit<VerifyReceiptRequest, 'runId' | 'runAttempt' | 'notBefore' | 'notAfter'> & { workflowId: number };
type RunRequest = ReceiptRequest | VerifyReadRequest;
type OperationJobs = { job: Record<string, unknown>; peer?: Record<string, unknown> };
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

function assertJobIdentity(job: Record<string, unknown>, run: Record<string, unknown>, expected: RunRequest): void {
  if (job.run_id !== run.id || job.run_attempt !== 1 || job.head_sha !== expected.controlSha || job.head_branch !== 'main'
    || job.url !== apiUrl(`actions/jobs/${job.id}`) || job.run_url !== run.url) throw new Error('PREVIEW_JOB_CHANGED');
  checkRunId(job.check_run_url);
}

async function operationJob(get: PreviewGet, run: Record<string, unknown>, expected: RunRequest, conclusion: 'success' | 'failure' = 'success'): Promise<OperationJobs> {
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
  const previews = jobs.filter(job => job.name === 'preview'), verifies = jobs.filter(job => job.name === 'preview-verify');
  if (previews.length !== 1 || verifies.length > 1) throw new Error('PREVIEW_JOB_AMBIGUOUS');
  // Old runs have one preview job for every action; a split run must retain both known jobs.
  const job = verifies.length && expected.action === 'verify' ? verifies[0] : previews[0];
  const peer = verifies.length ? expected.action === 'verify' ? previews[0] : verifies[0] : undefined;
  assertJobIdentity(job, run, expected);
  if (!completedWith(job, conclusion)
    || !timestamp(job.started_at) || !timestamp(job.completed_at) || Date.parse(job.started_at) > Date.parse(job.completed_at)
    || Date.parse(job.started_at) < Date.parse(String(run.created_at)) - 60_000
    || Date.parse(job.completed_at) > Date.parse(String(run.updated_at)) + 60_000) throw new Error('PREVIEW_JOB_CHANGED');
  if (peer) {
    assertJobIdentity(peer, run, expected);
    if (peer.status !== 'completed' || peer.conclusion !== 'skipped') throw new Error('PREVIEW_JOB_CHANGED');
  }
  return { job, peer };
}

function assertCheck(value: unknown, run: Record<string, unknown>, job: Record<string, unknown>, app: Record<string, unknown>, conclusion: 'success' | 'failure' = 'success'): Record<string, unknown> {
  const check = object(value), checkApp = actionsApp(check.app), output = object(check.output);
  if (check.id !== checkRunId(job.check_run_url) || check.url !== job.check_run_url || check.head_sha !== run.head_sha
    || object(check.check_suite).id !== run.check_suite_id || checkApp.id !== app.id || !completedWith(check, conclusion) || check.name !== job.name
    || !timestamp(check.started_at) || !timestamp(check.completed_at) || Date.parse(check.started_at) > Date.parse(check.completed_at)
    || Math.abs(Date.parse(check.started_at) - Date.parse(String(job.started_at))) > 60_000
    || Math.abs(Date.parse(check.completed_at) - Date.parse(String(job.completed_at))) > 60_000) throw new Error('PREVIEW_CHECK_CHANGED');
  if (!Number.isSafeInteger(output.annotations_count) || Number(output.annotations_count) < 1 || Number(output.annotations_count) > 1000
    || output.annotations_url !== apiUrl(`check-runs/${check.id}/annotations`)) throw new Error('PREVIEW_ANNOTATIONS_INCOMPLETE');
  return check;
}

async function receiptText(get: PreviewGet, check: Record<string, unknown>, title = receiptNoticeTitle): Promise<string> {
  const count = Number(object(check.output).annotations_count), annotations: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const response = await get(`check-runs/${check.id}/annotations?per_page=100&page=${page}`);
    if (!Array.isArray(response) || response.length > 100) throw new Error('PREVIEW_ANNOTATIONS_INCOMPLETE');
    annotations.push(...response.map(object));
    if (annotations.length > count || annotations.length < count && response.length !== 100) throw new Error('PREVIEW_ANNOTATIONS_INCOMPLETE');
    if (annotations.length === count) break;
  }
  const receipts = annotations.filter(annotation => annotation.title === title);
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
  const jobs = await operationJob(get, run, expected), { job } = jobs;
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
  if (operationJobsSnapshot(await operationJob(get, run, expected)) !== operationJobsSnapshot(jobs)) throw new Error('PREVIEW_JOB_CHANGED');
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
function jobSnapshot(job: Record<string, unknown>, skipped = false): string {
  return JSON.stringify({ id: job.id, name: job.name, run_id: job.run_id, run_attempt: job.run_attempt, head_sha: job.head_sha,
    head_branch: job.head_branch, status: job.status, conclusion: job.conclusion, url: job.url, run_url: job.run_url,
    check_run_url: job.check_run_url,
    ...(!skipped ? { started_at: job.started_at, completed_at: job.completed_at, steps: job.steps } : {}) });
}
function operationJobsSnapshot({ job, peer }: OperationJobs): string {
  return JSON.stringify({ job: jobSnapshot(job), peer: peer && jobSnapshot(peer, true) });
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
  const jobs = await operationJob(get, run, expected, conclusion), { job } = jobs;
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
  const afterJobs = await operationJob(get, run, expected, conclusion); assertNoticeStep(afterJobs.job);
  if (operationJobsSnapshot(afterJobs) !== operationJobsSnapshot(jobs)) throw new Error('PREVIEW_JOB_CHANGED');
  const afterRun = assertPreviewRun(await get(runPath), expected);
  if (afterRun.id !== run.id || afterRun.status !== 'completed' || afterRun.conclusion !== conclusion
    || afterRun.check_suite_id !== run.check_suite_id || afterRun.created_at !== run.created_at || afterRun.updated_at !== run.updated_at) throw new Error('PREVIEW_RUN_CHANGED');
  return receipt;
}

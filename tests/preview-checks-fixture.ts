import { config, protocol, type Source } from '../scripts/preview-model';
import { receiptNoticeTitle } from '../scripts/preview-receipt';
import type { PreviewGet, ReceiptRequest } from '../scripts/preview-checks';

export const receiptSource: Source = { pr: 71, branch: 'codex/test', sha: 'a'.repeat(40), createdAt: '2026-10-16T00:00:00Z', state: 'open' };
export function checksFixture(action: 'deploy' | 'status' | 'cleanup' = 'status') {
  const mainSha = 'b'.repeat(40), operation = '12345678-1234-4234-8234-123456789abc';
  const request: ReceiptRequest = { action, source: receiptSource, operation, controlSha: mainSha, workflowId: 45 };
  const url = (path: string) => `https://api.github.com/repos/${config.repository}/${path}`;
  const repository = { id: config.repositoryId, full_name: config.repository };
  const app = { id: 15368, slug: 'github-actions', html_url: 'https://github.com/apps/github-actions' };
  const started = '2026-10-16T01:00:01Z', completed = '2026-10-16T01:00:04Z';
  const workflow = { id: request.workflowId, path: '.github/workflows/preview.yml', state: 'active', url: url('actions/workflows/45') };
  const run = { id: 123, run_attempt: 1, workflow_id: request.workflowId, head_sha: mainSha, head_branch: 'main',
    path: '.github/workflows/preview.yml', event: 'workflow_dispatch', display_title: `Preview ${action} PR ${receiptSource.pr} ${operation}`,
    status: 'completed', conclusion: 'success', repository, head_repository: repository, check_suite_id: 234,
    url: url('actions/runs/123'), check_suite_url: url('check-suites/234'), created_at: '2026-10-16T01:00:00Z', updated_at: '2026-10-16T01:00:05Z' };
  const job = { id: 456, name: 'preview', run_id: 123, run_attempt: 1, head_sha: mainSha, head_branch: 'main', status: 'completed', conclusion: 'success',
    url: url('actions/jobs/456'), run_url: run.url, check_run_url: url('check-runs/345'), started_at: started, completed_at: completed };
  const jobs = { total_count: 1, jobs: [job] };
  const suite = { id: 234, url: run.check_suite_url, head_sha: mainSha, head_branch: 'main', repository, app, status: 'completed', conclusion: 'success' };
  const check = { id: 345, url: job.check_run_url, name: 'preview', head_sha: mainSha, check_suite: { id: 234 }, app,
    status: 'completed', conclusion: 'success', started_at: started, completed_at: completed,
    output: { annotations_count: 1, annotations_url: url('check-runs/345/annotations') } };
  const receipt = { protocol, success: true, action, source: receiptSource, checkedAt: '2026-10-16T01:00:03Z', operation, controlSha: mainSha, runId: '123', runAttempt: 1 };
  const annotation = { title: receiptNoticeTitle, annotation_level: 'notice', message: JSON.stringify(receipt) };
  const responses = new Map<string, unknown>([
    ['actions/workflows/preview.yml', workflow], ['actions/runs/123', run], ['actions/runs/123/attempts/1/jobs?per_page=100&page=1', jobs],
    ['check-suites/234', suite], ['check-runs/345', check], ['check-runs/345/annotations?per_page=100&page=1', [annotation]],
  ]);
  const calls: string[] = [];
  const get: PreviewGet = async path => {
    calls.push(path);
    if (!responses.has(path)) throw new Error(`Unexpected fixture path: ${path}`);
    return structuredClone(responses.get(path));
  };
  return { get, calls, responses, request, mainSha, operation, workflow, run, jobs, job, suite, check, receipt, annotation };
}

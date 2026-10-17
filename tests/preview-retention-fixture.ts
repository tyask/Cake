import { config, type Deployment } from '../scripts/preview-model';
import { retentionProtocol, retentionSnapshot, type RetentionAction } from '../scripts/preview-retention-model';
import { serializeRetentionReceipt, type RetentionReceipt } from '../scripts/preview-retention-receipt';
import type { PreviewGet, RetentionReadRequest } from '../scripts/preview-checks';
import { checksFixture } from './preview-checks-fixture';
import { retentionAppFixture, retentionDeployment, retentionMarker, retentionSource } from './preview-retention-browser-fixture';

export { retentionAppFixture, retentionDeployment, retentionMarker, retentionSource };
export const retentionMainSha = 'b'.repeat(40);
export const retentionNewSource = { ...retentionSource, sha: 'c'.repeat(40) };
export const retentionNewDeployment: Deployment = { ...retentionDeployment, id: 'dpl_retentionupdated',
  url: 'https://cake-retention-updated.vercel.app', sha: retentionNewSource.sha, operation: retentionMarker,
  createdAt: Date.parse('2026-10-16T01:00:02Z') };

/** Synthetic data only. Fixtures exercise the public projection, never live APIs. */
export function retentionReceiptFixture(action: RetentionAction = 'retention-prepare'): RetentionReceipt {
  const update = ['retention-update', 'retention-reconcile', 'retention-check'].includes(action);
  const browser = ['retention-prepare', 'retention-inspect', 'retention-check'].includes(action);
  const ids = { 'retention-prepare': '123', 'retention-update': '124', 'retention-check': '125', 'retention-inspect': '126', 'retention-reconcile': '127' };
  return { protocol: retentionProtocol, action, source: { ...(update ? retentionNewSource : retentionSource) },
    expectedDeploymentId: action === 'retention-check' ? retentionNewDeployment.id : retentionDeployment.id,
    marker: retentionMarker, ...(action === 'retention-prepare' ? {} : { baselineRunId: '123' }),
    ...(['retention-reconcile', 'retention-check'].includes(action) ? { updateRunId: '124' } : {}),
    deployment: structuredClone(update ? retentionNewDeployment : retentionDeployment), database: { ...retentionDeployment.database! },
    ...(browser ? { evidence: retentionSnapshot(retentionAppFixture(), retentionMarker).evidence!, outcome: 'present' as const,
      runtimeBeforeAt: '2026-10-16T01:00:01.100Z', observedAt: '2026-10-16T01:00:02Z', runtimeAfterAt: '2026-10-16T01:00:02.500Z' }
      : { outcome: 'unknown' as const }),
    writeAttempts: ['retention-prepare', 'retention-update'].includes(action) ? 1 : 0,
    checkedAt: '2026-10-16T01:00:03Z', success: true,
    operation: ['retention-prepare', 'retention-update'].includes(action) ? retentionMarker : '90000000-0000-4000-8000-000000000009',
    runId: ids[action], runAttempt: 1, controlSha: retentionMainSha };
}

/** Complete provenance graph with IDs derived from the run so graphs can merge. */
export function retentionChecksFixture(receipt = retentionReceiptFixture()) {
  const f = checksFixture(), runId = Number(receipt.runId), jobId = runId + 1000, suiteId = runId + 2000, checkId = runId + 3000;
  const url = (path: string) => `https://api.github.com/repos/${config.repository}/${path}`;
  const conclusion = receipt.success ? 'success' : 'failure';
  const started = new Date(Date.parse(receipt.runtimeBeforeAt ?? receipt.checkedAt) - 1000).toISOString();
  const completed = new Date(Date.parse(receipt.checkedAt) + 1000).toISOString();
  Object.assign(f.run, { id: runId, display_title: `Preview ${receipt.action} PR ${receipt.source.pr} ${receipt.operation}`,
    head_sha: receipt.controlSha, check_suite_id: suiteId, url: url(`actions/runs/${runId}`), check_suite_url: url(`check-suites/${suiteId}`), conclusion,
    created_at: new Date(Date.parse(started) - 1000).toISOString(), updated_at: new Date(Date.parse(completed) + 1000).toISOString() });
  Object.assign(f.job, { id: jobId, run_id: runId, head_sha: receipt.controlSha, url: url(`actions/jobs/${jobId}`), run_url: f.run.url,
    check_run_url: url(`check-runs/${checkId}`), conclusion, started_at: started, completed_at: completed,
    steps: [{ name: 'Publish public operation receipt notice', number: 7, status: 'completed', conclusion: 'success' }] });
  Object.assign(f.suite, { id: suiteId, url: f.run.check_suite_url, head_sha: receipt.controlSha, conclusion });
  Object.assign(f.check, { id: checkId, url: f.job.check_run_url, head_sha: receipt.controlSha,
    check_suite: { id: suiteId }, conclusion, started_at: started, completed_at: completed,
    output: { annotations_count: 1, annotations_url: url(`check-runs/${checkId}/annotations`) } });
  f.annotation.title = retentionProtocol;
  f.annotation.message = serializeRetentionReceipt(receipt);
  const responses = new Map<string, unknown>([
    ['actions/workflows/preview.yml', f.workflow], [`actions/runs/${runId}`, f.run],
    [`actions/runs/${runId}/attempts/1/jobs?per_page=100&page=1`, f.jobs], [`check-suites/${suiteId}`, f.suite],
    [`check-runs/${checkId}`, f.check], [`check-runs/${checkId}/annotations?per_page=100&page=1`, [f.annotation]],
  ]);
  const calls: string[] = [];
  const get: PreviewGet = async path => { calls.push(path); if (!responses.has(path)) throw new Error('UNEXPECTED_SYNTHETIC_PATH'); return structuredClone(responses.get(path)); };
  const request: RetentionReadRequest = { action: receipt.action, source: receipt.source, marker: receipt.marker,
    expectedDeploymentId: receipt.expectedDeploymentId, ...(receipt.baselineRunId ? { baselineRunId: receipt.baselineRunId } : {}),
    ...(receipt.updateRunId ? { updateRunId: receipt.updateRunId } : {}), operation: receipt.operation,
    controlSha: receipt.controlSha, workflowId: f.workflow.id };
  return { ...f, receipt, request, responses, calls, get };
}

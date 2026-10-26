import { browserEvidence, verifyReceiptProtocol, type BrowserEvidenceInput, type VerifyReceipt } from '../../../scripts/preview/preview-verify-receipt';
import type { Deployment } from '../../../scripts/preview/preview-model';
import type { VerifyReadRequest } from '../../../scripts/preview/preview-checks';
import { checksFixture, receiptSource } from './preview-checks-fixture';

export function verifyProofFixture(): BrowserEvidenceInput {
  let at = Date.parse('2026-10-16T01:00:01Z');
  const time = () => new Date(at += 50).toISOString();
  const cases = ['desktop-a', 'desktop-b', 'mobile-a', 'mobile-b'];
  const proof: BrowserEvidenceInput = { cases: [...cases, 'read-api'], clicks: [], observations: [], verifiedAt: '2026-10-16T01:00:02.500Z' };
  const clicks = proof.clicks as { case: string; target: string; at: string }[];
  const checks = proof.observations as { case: string; kind: 'runtime-before' | 'session-app' | 'runtime-after'; at: string }[];
  for (const c of cases) {
    checks.push({ case: c, kind: 'runtime-before', at: time() });
    clicks.push({ case: c, target: `ログイン${c.at(-1)!.toUpperCase()}`, at: time() });
    checks.push({ case: c, kind: 'session-app', at: time() });
    for (const target of ['取引明細', '設定', 'ホーム']) clicks.push({ case: c, target, at: time() });
    checks.push({ case: c, kind: 'runtime-after', at: time() });
  }
  return proof;
}
export function verifyReceiptFixture(success = true): VerifyReceipt {
  const database = { branchId: 'br-preview-test', endpointId: 'ep-preview-test', hostDigest: 'd'.repeat(64) };
  const deployment: Deployment = { id: 'dpl_previewtest', url: 'https://cake-preview-test.vercel.app', sha: receiptSource.sha,
    branch: receiptSource.branch, pr: receiptSource.pr, generation: '10000000-0000-4000-8000-000000000001',
    operation: '20000000-0000-4000-8000-000000000002', phase: 'application', state: 'READY', createdAt: Date.parse('2026-10-16T00:02:00Z'), database };
  return { protocol: verifyReceiptProtocol, action: 'verify', source: { ...receiptSource }, expectedDeploymentId: deployment.id,
    deployment, database, browser: browserEvidence(verifyProofFixture()), checkedAt: '2026-10-16T01:00:03Z', success,
    ...(!success ? { failure: { stage: 'browser' as const, code: 'PREVIEW_VERIFY_BROWSER_FAILED' as const, browserStage: 'boundary' as const } } : {}),
    operation: '12345678-1234-4234-8234-123456789abc', runId: '123', runAttempt: 1, controlSha: 'b'.repeat(40) };
}
export function verifyChecksFixture(success = true, splitJobs = false) {
  const base = checksFixture('status', splitJobs), receipt = verifyReceiptFixture(success);
  const request: VerifyReadRequest = { action: 'verify', source: receipt.source, expectedDeployment: receipt.deployment!,
    operation: receipt.operation, controlSha: receipt.controlSha, workflowId: base.workflow.id };
  base.run.display_title = `Preview verify PR ${receipt.source.pr} ${receipt.operation}`;
  if (splitJobs) {
    base.job.name = base.check.name = 'preview-verify';
    base.peer.name = 'preview';
  }
  const conclusion = success ? 'success' : 'failure';
  for (const value of [base.run, base.job, base.check, base.suite]) value.conclusion = conclusion;
  Object.assign(base.job, { steps: [{ name: 'Publish public operation receipt notice', number: 6, status: 'completed', conclusion: 'success' }] });
  base.annotation.title = verifyReceiptProtocol;
  base.annotation.message = JSON.stringify(receipt);
  const sync = () => { base.annotation.message = JSON.stringify(receipt); };
  return { ...base, request, receipt, deployment: receipt.deployment!, sync };
}

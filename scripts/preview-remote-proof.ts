import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserProof } from './preview-browser';
import { previewWorkflow, readVerifyReceipt, type PreviewGet } from './preview-checks';
import { parseVerifyReceipt, serializeVerifyReceipt, verifyBrowserCases, type VerifyReceipt } from './preview-verify-receipt';
import type { Source } from './preview-model';

export type RemotePreviewProof = { protocol: 'cake-preview-remote-proof/v1'; workflowId: number; receipt: VerifyReceipt };
export function remotePreviewProof(workflowId: number, receipt: VerifyReceipt): RemotePreviewProof {
  if (!Number.isSafeInteger(workflowId) || workflowId < 1) throw new Error('PREVIEW_VERIFY_PROOF_INVALID');
  return { protocol: 'cake-preview-remote-proof/v1', workflowId, receipt: parseVerifyReceipt(serializeVerifyReceipt(receipt)) };
}
export async function readRemotePreviewProof(path: string): Promise<RemotePreviewProof> {
  try {
    const meta = await lstat(path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 20_000) throw new Error();
    const proof = JSON.parse(await readFile(path, 'utf8'));
    if (Object.keys(proof).sort().join(',') !== 'protocol,receipt,workflowId' || proof.protocol !== 'cake-preview-remote-proof/v1') throw new Error();
    // Validate the wire representation before projecting any fields away.
    return remotePreviewProof(proof.workflowId, parseVerifyReceipt(JSON.stringify(proof.receipt)));
  } catch { throw new Error('PREVIEW_VERIFY_PROOF_INVALID'); }
}
/** Re-read the original run and notice; a local success flag is never provenance. */
export async function revalidateRemotePreviewProof(path: string, expected: Source, get: PreviewGet): Promise<BrowserProof> {
  const proof = await readRemotePreviewProof(resolve(path)), saved = proof.receipt;
  if (!saved.success || !saved.deployment || !saved.browser || JSON.stringify(saved.source) !== JSON.stringify(expected)) throw new Error('PREVIEW_VERIFY_PROOF_INVALID');
  const workflow = await previewWorkflow(get);
  if (workflow.id !== proof.workflowId) throw new Error('PREVIEW_WORKFLOW_CHANGED');
  const fresh = await readVerifyReceipt(get, Number(saved.runId), { action: 'verify', source: expected,
    expectedDeployment: saved.deployment, operation: saved.operation, controlSha: saved.controlSha, workflowId: proof.workflowId });
  if (!fresh.success || !fresh.deployment || !fresh.browser || serializeVerifyReceipt(fresh) !== serializeVerifyReceipt(saved)) throw new Error('PREVIEW_VERIFY_PROOF_CHANGED');
  return { protocol: 'cake-preview-browser/v1', source: fresh.source, deployment: fresh.deployment,
    cases: [...fresh.browser.cases], verifiedAt: fresh.browser.verifiedAt, success: true,
    clicks: fresh.browser.clicks.map(([c, t, at]) => ({ case: verifyBrowserCases[c], target: [`ログイン${c % 2 ? 'B' : 'A'}`, '取引明細', '設定', 'ホーム'][t], at })),
    observations: fresh.browser.checks.map(([c, k, at]) => ({ case: verifyBrowserCases[c], kind: (['runtime-before', 'session-app', 'runtime-after'] as const)[k], at })) };
}

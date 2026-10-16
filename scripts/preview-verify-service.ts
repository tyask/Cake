import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserVerificationError, browserCases, verifyBrowser, type BrowserProof } from './preview-browser';
import { sameDatabase, type Deployment, type Source } from './preview-model';
import { PreviewProvider, transport, type Transport } from './preview-provider';
import { PreviewService, type Receipt } from './preview-service';
import { browserEvidence, exactDeploymentIdentity, verifyReceiptProtocol, type VerifyReceipt } from './preview-verify-receipt';

export type VerifyResult = Omit<VerifyReceipt, 'operation' | 'runId' | 'runAttempt' | 'controlSha'>;
type BrowserRunner = typeof verifyBrowser;

/** This guard executes before credential lookup or fetch, including OIDC reads.
 * A future status/browser change cannot turn this operation into a writer. */
export function readonlyVerifyTransport(api: Transport = transport()): Transport {
  return async (provider, path, method = 'GET', body, missing = false) => {
    if (method !== 'GET' || body !== undefined) throw new Error('PREVIEW_VERIFY_READ_ONLY');
    return api(provider, path, 'GET', undefined, missing);
  };
}
function sameSource(a: Source, b: Source): boolean {
  return (['pr', 'branch', 'sha', 'createdAt', 'state'] as const).every(key => a[key] === b[key]);
}
function target(receipt: Receipt, source: Source, expectedDeploymentId: string): Deployment | undefined {
  const d = receipt.deployment;
  if (receipt.action !== 'status' || receipt.success !== true || !sameSource(receipt.source, source)
    || !d || d.id !== expectedDeploymentId || d.phase !== 'application' || d.state !== 'READY'
    || d.pr !== source.pr || d.branch !== source.branch || d.sha !== source.sha
    || !d.database || !receipt.database || !sameDatabase(d.database, receipt.database)) return undefined;
  return d;
}
function matchesProof(proof: BrowserProof, source: Source, deployment: Deployment): boolean {
  return proof.protocol === 'cake-preview-browser/v1' && sameSource(proof.source, source)
    && exactDeploymentIdentity(proof.deployment, deployment);
}

export class PreviewVerifyService {
  readonly provider: PreviewProvider;
  readonly statusService: PreviewService;
  readonly api: Transport;
  constructor(api: Transport = transport(), readonly browse: BrowserRunner = verifyBrowser) {
    this.api = readonlyVerifyTransport(api);
    this.provider = new PreviewProvider(this.api);
    this.statusService = new PreviewService(this.provider);
  }
  async verify(source: Source, expectedDeploymentId: string,
    environment: Readonly<Record<string, string | undefined>> = process.env): Promise<VerifyResult> {
    if (source.state !== 'open' || !/^dpl_[A-Za-z0-9]+$/.test(expectedDeploymentId)) throw new Error('PREVIEW_VERIFY_INVALID_TARGET');
    const base = { protocol: verifyReceiptProtocol, action: 'verify', source, expectedDeploymentId } as const;
    const fail = (stage: 'preflight' | 'browser' | 'postflight', code: NonNullable<VerifyReceipt['failure']>['code'],
      fields: Partial<Pick<VerifyResult, 'deployment' | 'database' | 'browser'>> = {},
      browserStage?: NonNullable<VerifyReceipt['failure']>['browserStage']): VerifyResult => ({
      ...base, ...fields, checkedAt: new Date().toISOString(), success: false,
      failure: { stage, code, ...(browserStage ? { browserStage } : {}) },
    });
    let before: Receipt;
    try { before = await this.statusService.status(source); }
    catch { return fail('preflight', 'PREVIEW_VERIFY_STATUS_FAILED'); }
    const deployment = target(before, source, expectedDeploymentId);
    if (!deployment) return fail('preflight', 'PREVIEW_VERIFY_TARGET_CHANGED');
    const fields = { deployment, database: deployment.database! };
    // Images, cookies and browser proof are ephemeral. Only the public projection
    // below is written to the notice; no artifact uploads are involved.
    let directory: string | undefined;
    let proof: BrowserProof | undefined;
    let browserFailure: VerifyResult | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'cake-preview-verify-'));
      proof = await this.browse(source, deployment, directory, environment, undefined, this.api);
      if (!matchesProof(proof, source, deployment) || proof.success !== true || proof.cases.length !== browserCases.length
        || proof.cases.some((name, index) => name !== browserCases[index])) throw new Error('PREVIEW_VERIFY_BROWSER_FAILED');
      // Validate public observations before accepting a successful browser run.
      browserEvidence(proof);
    } catch (error) {
      let observed: Pick<VerifyResult, 'browser'> = {};
      if (error instanceof BrowserVerificationError && matchesProof(error.proof, source, deployment)) {
        try { observed = { browser: browserEvidence(error.proof) }; } catch { /* Incomplete or malformed evidence is never projected. */ }
      }
      const stage = error instanceof BrowserVerificationError ? error.stage : undefined;
      browserFailure = fail('browser', stage === 'oidc' ? 'PREVIEW_VERIFY_OIDC_UNAVAILABLE' : 'PREVIEW_VERIFY_BROWSER_FAILED',
        { ...fields, ...observed }, stage);
    } finally {
      if (directory) {
        try { await rm(directory, { recursive: true, force: true }); }
        catch { browserFailure ??= fail('browser', 'PREVIEW_VERIFY_BROWSER_FAILED', fields, 'boundary'); }
      }
    }
    if (browserFailure) return browserFailure;
    const complete = { ...fields, browser: browserEvidence(proof!) };
    let after: Receipt;
    try { after = await this.statusService.status(source); }
    catch { return fail('postflight', 'PREVIEW_VERIFY_STATUS_FAILED', complete); }
    const current = target(after, source, expectedDeploymentId);
    if (!current || !exactDeploymentIdentity(deployment, current)) return fail('postflight', 'PREVIEW_VERIFY_TARGET_CHANGED', complete);
    return { ...base, ...complete, checkedAt: new Date().toISOString(), success: true };
  }
}

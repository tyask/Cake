import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, object, sameDatabase, type Deployment, type Source } from './preview-model';
import { PreviewProvider, transport, type Transport } from './preview-provider';
import { PreviewService, PreviewUpdateError } from './preview-service';
import { readonlyVerifyTransport } from './preview-verify-service';
import { exactDeploymentIdentity } from './preview-verify-receipt';
import { loadRetentionOriginal, loadRetentionReceipt, type PreviewGet } from './preview-checks';
import { runRetentionBrowser } from './preview-retention-browser';
import { assertRetentionWriteHistory } from './preview-retention-history';
import { isRetentionMarker, parseRetentionEvidence, retentionProtocol, sameRetentionEvidence,
  type RetentionAction, type RetentionBrowserResult, type RetentionStage } from './preview-retention-model';
import { assertRegistrationBaseline, assertRetentionUpdate, type RetentionReceipt, type RetentionResult } from './preview-retention-receipt';

export type RetentionRequest = { action: RetentionAction; source: Source; expectedDeploymentId: string; marker: string;
  baselineRunId?: string; updateRunId?: string; operation: string; runId: string; runAttempt: number; controlSha: string };
type Loaders = { receipt: typeof loadRetentionReceipt; original: typeof loadRetentionOriginal };
const sameSourceScope = (a: Source, b: Source) => a.pr === b.pr && a.branch === b.branch && a.createdAt === b.createdAt && a.state === 'open' && b.state === 'open';
const sameSource = (a: Source, b: Source) => sameSourceScope(a, b) && a.sha === b.sha;
const sameDatabaseGeneration = (a: Deployment, b: Deployment) => a.pr === b.pr && a.branch === b.branch && a.generation === b.generation
  && !!a.database && !!b.database && sameDatabase(a.database, b.database);

export class PreviewRetentionService {
  readonly api: Transport;
  readonly provider: PreviewProvider;
  readonly statusService: PreviewService;
  readonly get: PreviewGet;
  constructor(readonly raw: Transport = transport(), readonly browse = runRetentionBrowser,
    readonly loaders: Loaders = { receipt: loadRetentionReceipt, original: loadRetentionOriginal },
    readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    this.api = readonlyVerifyTransport(raw); this.provider = new PreviewProvider(this.api); this.statusService = new PreviewService(this.provider, wait);
    this.get = path => this.api('github', `/repos/${config.repository}/${path}`);
  }
  private async baseline(request: RetentionRequest): Promise<RetentionReceipt> {
    if (!request.baselineRunId) throw new Error('PREVIEW_RETENTION_BASELINE');
    const baseline = await this.loaders.receipt(this.get, Number(request.baselineRunId));
    if (!baseline.success || baseline.outcome !== 'present' || !baseline.evidence || !baseline.deployment || !baseline.database
      || !sameSourceScope(baseline.source, request.source) || baseline.marker !== request.marker
      || !sameDatabase(baseline.database, baseline.deployment.database!)) throw new Error('PREVIEW_RETENTION_BASELINE');
    parseRetentionEvidence(baseline.evidence);
    let originalPrepare: RetentionReceipt | undefined;
    if (baseline.action === 'retention-prepare') {
      if (baseline.writeAttempts !== 1) throw new Error('PREVIEW_RETENTION_BASELINE');
    } else if (baseline.action === 'retention-inspect' && baseline.baselineRunId) {
      const original = await this.loaders.receipt(this.get, Number(baseline.baselineRunId)); originalPrepare = original;
      if (original.action !== 'retention-prepare' || original.marker !== baseline.marker || original.writeAttempts !== 1
        || !sameSource(original.source, baseline.source) || original.expectedDeploymentId !== baseline.deployment.id
        || original.deployment && !exactDeploymentIdentity(original.deployment, baseline.deployment)
        || original.evidence && !sameRetentionEvidence(original.evidence, baseline.evidence)) throw new Error('PREVIEW_RETENTION_BASELINE');
    } else throw new Error('PREVIEW_RETENTION_BASELINE');
    assertRegistrationBaseline(baseline, originalPrepare);
    return baseline;
  }
  private async updateReference(request: RetentionRequest, baseline: RetentionReceipt): Promise<RetentionReceipt> {
    if (!request.updateRunId) throw new Error('PREVIEW_RETENTION_UPDATE_REFERENCE');
    const accepted = await this.loaders.receipt(this.get, Number(request.updateRunId));
    if (!accepted.success || !['retention-update','retention-reconcile'].includes(accepted.action)
      || !sameSource(accepted.source, request.source) || accepted.marker !== request.marker || accepted.baselineRunId !== request.baselineRunId
      || accepted.expectedDeploymentId !== baseline.deployment!.id || !accepted.deployment || !sameDatabaseGeneration(accepted.deployment, baseline.deployment!)
      || accepted.deployment.id === baseline.deployment!.id || accepted.deployment.operation !== request.marker) throw new Error('PREVIEW_RETENTION_UPDATE_REFERENCE');
    let originalUpdate: RetentionReceipt | undefined;
    if (accepted.action === 'retention-reconcile') {
      if (!accepted.updateRunId) throw new Error('PREVIEW_RETENTION_UPDATE_REFERENCE');
      const original = await this.loaders.receipt(this.get, Number(accepted.updateRunId)); originalUpdate = original;
      if (original.action !== 'retention-update' || original.operation !== request.marker || !sameSource(original.source, request.source)
        || original.marker !== request.marker || original.baselineRunId !== request.baselineRunId
        || original.expectedDeploymentId !== baseline.deployment!.id) throw new Error('PREVIEW_RETENTION_UPDATE_REFERENCE');
    }
    assertRetentionUpdate(accepted, baseline, originalUpdate);
    return accepted;
  }
  async run(request: RetentionRequest, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<RetentionResult> {
    const { action, source, expectedDeploymentId, marker } = request;
    if (request.runAttempt !== 1 || source.state !== 'open' || !isRetentionMarker(marker) || !/^dpl_[A-Za-z0-9]+$/.test(expectedDeploymentId)
      || ['retention-prepare','retention-update'].includes(action) && request.operation !== marker) throw new Error('PREVIEW_RETENTION_INVALID_REQUEST');
    const base = { protocol: retentionProtocol, action, source, expectedDeploymentId, marker,
      ...(request.baselineRunId ? { baselineRunId: request.baselineRunId } : {}), ...(request.updateRunId ? { updateRunId: request.updateRunId } : {}) } as const;
    let fields: Partial<RetentionResult> = {}, writes: 0 | 1 = 0;
    const fail = (stage: RetentionStage, code: NonNullable<RetentionResult['failure']>['code']): RetentionResult => ({
      ...base, outcome: 'unknown', writeAttempts: writes, ...fields, checkedAt: new Date().toISOString(), success: false, failure: { stage, code },
    });
    let baseline: RetentionReceipt | undefined, original: RetentionReceipt | undefined, originalMissing = false;
    try {
      // Referenced historical evidence is always re-read from its actual notice.
      if (['retention-update','retention-reconcile','retention-check'].includes(action)) baseline = await this.baseline(request);
      if (action === 'retention-inspect' || action === 'retention-reconcile') {
        const id = action === 'retention-inspect' ? request.baselineRunId : request.updateRunId;
        if (!id) throw new Error('PREVIEW_RETENTION_BASELINE');
        const loaded = await this.loaders.original(this.get, Number(id));
        const run = object(loaded.run);
        const expectedAction = action === 'retention-inspect' ? 'retention-prepare' : 'retention-update';
        if (run.action !== expectedAction || run.pr !== source.pr || run.operation !== marker) throw new Error('PREVIEW_RETENTION_BASELINE');
        original = loaded.receipt; originalMissing = !original;
        if (original && (original.action !== expectedAction || original.marker !== marker || !sameSource(original.source, source)
          || original.expectedDeploymentId !== expectedDeploymentId || action === 'retention-reconcile' && original.baselineRunId !== request.baselineRunId)) throw new Error('PREVIEW_RETENTION_BASELINE');
      }
      if (baseline && (action !== 'retention-check' && expectedDeploymentId !== baseline.deployment!.id
        || source.sha === baseline.source.sha)) throw new Error('PREVIEW_RETENTION_BASELINE');
      if (action === 'retention-check') {
        const accepted = await this.updateReference(request, baseline!);
        if (accepted.deployment!.id !== expectedDeploymentId) throw new Error('PREVIEW_RETENTION_BASELINE');
      }
    } catch { return fail('baseline', 'PREVIEW_RETENTION_PREFLIGHT_FAILED'); }
    if (action === 'retention-prepare' || action === 'retention-update') {
      try { await assertRetentionWriteHistory(this.get, { action, pr: source.pr, marker, runId: request.runId, controlSha: request.controlSha,
        ...(baseline ? { prepareRunId: baseline.action === 'retention-inspect' ? baseline.baselineRunId : baseline.runId } : {}) }); }
      catch { return fail('history', 'PREVIEW_RETENTION_REPLAY'); }
    }
    if (action === 'retention-update' || action === 'retention-reconcile') {
      const bounded: Transport = async (provider, path, method = 'GET', body, missing = false) => {
        if (method === 'GET' && body === undefined) return this.api(provider, path, 'GET', undefined, missing);
        if (action !== 'retention-update' || writes !== 0 || provider !== 'vercel' || path !== '/v13/deployments?forceNew=1' || method !== 'POST') throw new Error('PREVIEW_RETENTION_WRITE_BUDGET');
        writes = 1; return this.raw(provider, path, method, body, missing);
      };
      try {
        const updater = new PreviewService(new PreviewProvider(bounded), this.wait);
        const updated = await updater.updateOnly(source, baseline!.deployment!, marker, action === 'retention-reconcile');
        if (!updated.deployment || !updated.database || !sameDatabaseGeneration(updated.deployment, baseline!.deployment!)
          || updated.deployment.id === baseline!.deployment!.id || updated.deployment.operation !== marker || updated.deployment.sha !== source.sha) return fail('postflight', 'PREVIEW_RETENTION_TARGET_CHANGED');
        fields = { deployment: updated.deployment, database: updated.database };
        if (originalMissing || action === 'retention-reconcile' && (original?.writeAttempts !== 1
          || original.attemptedDeploymentId !== undefined && original.attemptedDeploymentId !== updated.deployment.id
          || original.deployment && !exactDeploymentIdentity(original.deployment,
            original.deployment.id === baseline!.deployment!.id ? baseline!.deployment! : updated.deployment))) return fail('reconcile', 'PREVIEW_RETENTION_UPDATE_UNKNOWN');
        return { ...base, ...fields, outcome: 'unknown', writeAttempts: writes, checkedAt: new Date().toISOString(), success: true };
      } catch (error) {
        if (error instanceof PreviewUpdateError && original?.attemptedDeploymentId !== undefined
          && original.attemptedDeploymentId !== error.deploymentId) return fail('reconcile', 'PREVIEW_RETENTION_TARGET_CHANGED');
        if (error instanceof PreviewUpdateError && /^dpl_[A-Za-z0-9]+$/.test(error.deploymentId)
          && error.deploymentId !== expectedDeploymentId) fields = { ...fields, attemptedDeploymentId: error.deploymentId };
        const buildFailed = error instanceof Error && error.message === 'PREVIEW_BUILD_FAILED';
        const unknown = !buildFailed && (Number(writes) === 1 || error instanceof Error && /RESULT_UNKNOWN|RESPONSE_UNKNOWN|TIMEOUT/.test(error.message));
        return fail(action === 'retention-reconcile' ? 'reconcile' : 'update', unknown ? 'PREVIEW_RETENTION_UPDATE_UNKNOWN' : 'PREVIEW_RETENTION_UPDATE_FAILED');
      }
    }
    let target: Deployment;
    try {
      const before = await this.statusService.status(source);
      if (!before.deployment || !before.database || before.deployment.id !== expectedDeploymentId
        || !sameDatabase(before.database, before.deployment.database!) || original?.deployment && !exactDeploymentIdentity(original.deployment, before.deployment)
        || baseline?.deployment && !sameDatabaseGeneration(before.deployment, baseline.deployment)) return fail('preflight', 'PREVIEW_RETENTION_TARGET_CHANGED');
      target = before.deployment; fields = { deployment: target, database: before.database };
    } catch { return fail('preflight', 'PREVIEW_RETENTION_PREFLIGHT_FAILED'); }
    let directory: string | undefined, observed: RetentionBrowserResult | undefined, cleanupFailed = false;
    try {
      directory = await mkdtemp(join(tmpdir(), 'cake-retention-'));
      observed = await this.browse(source, target, directory, { mode: action === 'retention-prepare' ? 'prepare' : action === 'retention-inspect' ? 'inspect' : 'check',
        marker, ...(baseline?.evidence ? { baseline: baseline.evidence } : original?.evidence ? { baseline: original.evidence } : {}) }, environment, undefined, this.api);
      writes = observed.writeAttempts;
      const { outcome, evidence, observedAt, runtimeBeforeAt, runtimeAfterAt } = observed;
      if (evidence && evidence.marker !== marker) return fail('evidence', 'PREVIEW_RETENTION_EVIDENCE_CHANGED');
      fields = { ...fields, outcome, ...(evidence ? { evidence: parseRetentionEvidence(evidence) } : {}), observedAt,
        ...(runtimeBeforeAt ? { runtimeBeforeAt } : {}), ...(runtimeAfterAt ? { runtimeAfterAt } : {}) };
      if (action !== 'retention-prepare' && writes !== 0
        || action === 'retention-prepare' && observed.success && writes !== 1
        || baseline?.evidence && evidence && !sameRetentionEvidence(baseline.evidence, evidence)
        || original?.evidence && evidence && !sameRetentionEvidence(original.evidence, evidence)) return fail('evidence', 'PREVIEW_RETENTION_EVIDENCE_CHANGED');
    } catch { return fail('boundary', writes ? 'PREVIEW_RETENTION_WRITE_UNKNOWN' : 'PREVIEW_RETENTION_BROWSER_FAILED'); }
    finally {
      if (directory) try { await rm(directory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) return fail('boundary', writes ? 'PREVIEW_RETENTION_WRITE_UNKNOWN' : 'PREVIEW_RETENTION_BROWSER_FAILED');
    if (!observed.success) return fail(observed.failureStage ?? 'boundary', writes ? 'PREVIEW_RETENTION_WRITE_UNKNOWN' : 'PREVIEW_RETENTION_BROWSER_FAILED');
    try {
      const after = await this.statusService.status(source);
      if (!after.deployment || !after.database || !exactDeploymentIdentity(target, after.deployment) || !sameDatabase(after.database, target.database!)) return fail('postflight', 'PREVIEW_RETENTION_TARGET_CHANGED');
    } catch { return fail('postflight', 'PREVIEW_RETENTION_PREFLIGHT_FAILED'); }
    if (originalMissing || action === 'retention-inspect' && original?.writeAttempts !== 1) return fail('baseline', 'PREVIEW_RETENTION_WRITE_UNKNOWN');
    return { ...base, outcome: observed.outcome, writeAttempts: writes, ...fields, checkedAt: new Date().toISOString(), success: true };
  }
}

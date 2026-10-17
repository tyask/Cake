import { randomUUID } from 'node:crypto';
import { config, deployment, object, protocol, sameDatabase, uuid, type Database, type Deployment, type Source } from './preview-model';
import { PreviewProvider, type Transport } from './preview-provider';
import { assertMainOnlyGitConfig, fullSha } from './task-workflow';
export type Receipt = { protocol: typeof protocol; action: string; source: Source; deployment?: Deployment; database?: Database; checkedAt: string; success: true };
/** A scoped, public identifier survives a failed build without carrying provider
 * responses, credentials, or raw exception messages across the boundary. */
export class PreviewUpdateError extends Error {
  constructor(readonly deploymentId: string, code: 'PREVIEW_BUILD_FAILED' | 'PREVIEW_BUILD_TIMEOUT' | 'PREVIEW_UPDATE_FAILED') {
    if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) throw new Error('PREVIEW_INVALID_DEPLOYMENT');
    super(code); this.name = 'PreviewUpdateError';
  }
}
function sameDeploymentMetadata(a: Deployment, b: Deployment): boolean {
  return (['id','url','sha','branch','pr','generation','operation','phase','createdAt'] as const).every(k => a[k] === b[k])
    && a.phase === 'application' && !!a.database && !!b.database && sameDatabase(a.database, b.database);
}
function samePinnedDeployment(a: Deployment, b: Deployment): boolean {
  return sameDeploymentMetadata(a, b) && a.state === 'READY' && b.state === 'READY';
}
function creationRequest(s: Source, generation: string, operation: string, database?: Database) {
  const phase = database ? 'application' : 'provisioning';
  const env = { AUTH_MODE: 'test', CAKE_PREVIEW_REPOSITORY: config.repository, CAKE_PREVIEW_PR: String(s.pr), CAKE_PREVIEW_GENERATION: generation,
    CAKE_PREVIEW_SOURCE_BRANCH: s.branch, CAKE_PREVIEW_SOURCE_SHA: s.sha, CAKE_PREVIEW_PHASE: phase,
    CAKE_PREVIEW_DATABASE_BRANCH_ID: database?.branchId ?? '', CAKE_PREVIEW_DATABASE_HOST_SHA256: database?.hostDigest ?? '',
    CAKE_PREVIEW_PRODUCTION_HOST_SHA256: config.productionHostDigest };
  return { name: 'cake', project: config.vercelProjectId,
    gitSource: { type: 'github', repoId: config.repositoryId, ref: s.branch, sha: s.sha }, env, build: { env },
    meta: { cakePreviewProtocol: protocol, cakePreviewRepository: config.repository, cakePreviewPr: String(s.pr), cakePreviewGeneration: generation,
      cakePreviewOperation: operation, cakePreviewPhase: phase, ...(database ? { cakePreviewDatabaseBranch: database.branchId,
        cakePreviewDatabaseEndpoint: database.endpointId, cakePreviewDatabaseDigest: database.hostDigest } : {}) } };
}
export function boundedApplicationTransport(api: Transport, expectedBody: unknown, beforeWrite: () => Promise<void>, reconcile = false): Transport {
  let spent = false;
  const expected = JSON.stringify(expectedBody);
  return async (provider, path, method = 'GET', body, missing = false) => {
    if (method === 'GET' && body === undefined) return api(provider, path, 'GET', undefined, missing);
    if (reconcile || spent || provider !== 'vercel' || path !== '/v13/deployments?forceNew=1' || method !== 'POST'
      || JSON.stringify(body) !== expected) throw new Error('PREVIEW_RETENTION_WRITE_BUDGET');
    // Reserve synchronously, before either preflight GETs or the write can yield.
    spent = true;
    await beforeWrite();
    return api(provider, path, 'POST', body, missing);
  };
}
export class PreviewService {
  constructor(readonly provider = new PreviewProvider(), readonly wait: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {}
  private async gitGate(s: Source): Promise<void> {
    const main = object(await this.provider.api('github', `/repos/${config.repository}/branches/main`));
    for (const ref of [String(object(main.commit).sha), s.sha]) {
      const file = object(await this.provider.api('github', `/repos/${config.repository}/contents/vercel.json?ref=${ref}`));
      if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || file.content.length > 100_000) throw new Error('PREVIEW_GIT_GATE');
      assertMainOnlyGitConfig(JSON.parse(Buffer.from(file.content, 'base64').toString()));
    }
  }
  private async inventory(s: Source) {
    const ds = await this.provider.deployments(s);
    if (new Set(ds.map(d => d.generation)).size > 1) throw new Error('PREVIEW_GENERATION_CONFLICT');
    const apps = ds.filter(d => d.database);
    const known = apps.at(-1)?.database;
    if (known && apps.some(d => !sameDatabase(d.database!, known))) throw new Error('PREVIEW_DATABASE_CONFLICT');
    // Native is created after a Vercel request; a small clock skew tolerance does not admit an older PR's DB.
    const notBefore = Math.max(Date.parse(s.createdAt), (ds[0]?.createdAt ?? Date.now()) - 60_000);
    const database = await this.provider.database(s, notBefore, known);
    if (!ds.length && database) throw new Error('PREVIEW_UNOWNED_DATABASE');
    if (known && !database && s.state === 'open') throw new Error('PREVIEW_DATABASE_LOST');
    return { ds, known, database, notBefore };
  }
  async status(s: Source): Promise<Receipt> {
    await this.provider.assertBindings(); await this.provider.assertSource(s);
    const { ds, database } = await this.inventory(s);
    const current = ds.filter(d => d.sha === s.sha && d.phase === 'application' && d.state === 'READY').at(-1);
    if (current && (!database || !sameDatabase(current.database!, database))) throw new Error('PREVIEW_DATABASE_LOST');
    await this.provider.assertSource(s);
    return { protocol, action: 'status', source: s, ...(current ? { deployment: current } : {}), ...(database ? { database } : {}), checkedAt: new Date().toISOString(), success: true };
  }
  private async settle(d: Deployment, s: Source): Promise<Deployment> {
    for (let i = 0; i < 180; i++) {
      await this.provider.assertSource(s, 'open');
      const current = await this.provider.getDeployment(d.id, s);
      if (!current || current.generation !== d.generation || current.operation !== d.operation || current.sha !== d.sha || current.phase !== d.phase) throw new Error('PREVIEW_DEPLOYMENT_CHANGED');
      if (['READY','ERROR','CANCELED'].includes(current.state)) return current;
      await this.wait(3000);
    }
    throw new Error('PREVIEW_BUILD_TIMEOUT');
  }
  private async create(s: Source, generation: string, operation: string, database?: Database): Promise<Deployment> {
    await this.gitGate(s); await this.provider.assertSource(s, 'open');
    if (database) {
      const inventory = await this.inventory(s);
      if (!inventory.database || !sameDatabase(inventory.database, database)) throw new Error('PREVIEW_DATABASE_LOST');
    }
    // The first deployment triggers Native branching and intentionally fails the DB preconnect guard.
    // A second deployment receives only verified public identifiers; Native injects the actual credential.
    const value = await this.provider.api('vercel', '/v13/deployments?forceNew=1', 'POST', creationRequest(s, generation, operation, database));
    return deployment(value, s);
  }
  private async docsOnlyDescendant(s: Source, baseline: Deployment): Promise<void> {
    const comparison = object(await this.provider.api('github', `/repos/${config.repository}/compare/${baseline.sha}...${s.sha}?per_page=100`));
    const files = comparison.files, commits = comparison.commits;
    // GitHub truncates changed files at 300 and paginates commits. Refuse the
    // boundary rather than treating an incomplete comparison as documentation.
    const doc = (path: unknown) => typeof path === 'string' && !path.split('/').some(p => !p || p === '.' || p === '..')
      && (path === 'README.md' || path === 'AGENTS.md' || path.startsWith('docs/'));
    if (comparison.status !== 'ahead' || comparison.behind_by !== 0 || !Number.isSafeInteger(comparison.ahead_by)
      || comparison.ahead_by !== 1 || comparison.total_commits !== 1 || object(comparison.base_commit).sha !== baseline.sha
      || object(comparison.merge_base_commit).sha !== baseline.sha || !Array.isArray(commits) || commits.length !== 1
      || object(commits[0]).sha !== s.sha || !Array.isArray(object(commits[0]).parents) || (object(commits[0]).parents as unknown[]).length !== 1
      || object((object(commits[0]).parents as unknown[])[0]).sha !== baseline.sha || !Array.isArray(files) || files.length < 1 || files.length >= 300
      || files.some(value => { const f = object(value); return !doc(f.filename) || f.previous_filename !== undefined && !doc(f.previous_filename)
        || !['added','removed','modified','renamed','copied','changed'].includes(String(f.status)); })) throw new Error('PREVIEW_RETENTION_DOCS_ONLY_REQUIRED');
  }
  private async updateInventory(s: Source, baseline: Deployment, operation: string, reconcile: boolean): Promise<Deployment | undefined> {
    const { ds, database } = await this.inventory(s);
    const original = ds.find(d => d.id === baseline.id);
    if (!original || !samePinnedDeployment(original, baseline) || !database || !sameDatabase(database, baseline.database!)) throw new Error('PREVIEW_RETENTION_TARGET_CHANGED');
    const candidates = ds.filter(d => d.id !== baseline.id && d.phase === 'application');
    if (candidates.length > (reconcile ? 1 : 0) || candidates.some(d => d.operation !== operation || d.sha !== s.sha
      || d.generation !== baseline.generation || d.createdAt < baseline.createdAt || !d.database || !sameDatabase(d.database, baseline.database!))
      || ds.some(d => d.generation !== baseline.generation || d.phase === 'provisioning' && (!['ERROR','CANCELED'].includes(d.state) || d.createdAt > baseline.createdAt))) throw new Error('PREVIEW_RETENTION_TARGET_CHANGED');
    return candidates[0];
  }
  /** A separate bounded entry point: no provisioning, Neon writer or fallback to
   * deploy(). The budget is consumed before awaiting even an uncertain POST. */
  async updateOnly(s: Source, baseline: Deployment, operation: string, reconcile = false): Promise<Receipt> {
    if (s.state !== 'open' || !uuid(operation) || !fullSha(s.sha) || s.sha === baseline.sha || !samePinnedDeployment(baseline, baseline)
      || baseline.pr !== s.pr || baseline.branch !== s.branch) throw new Error('PREVIEW_RETENTION_INVALID_UPDATE');
    const api = boundedApplicationTransport(this.provider.api, creationRequest(s, baseline.generation, operation, baseline.database),
      async () => { await limited.updateInventory(s, baseline, operation, false); }, reconcile);
    const limited = new PreviewService(new PreviewProvider(api), this.wait);
    await limited.provider.assertBindings(); await limited.provider.assertSource(s, 'open');
    await limited.gitGate(s); await limited.docsOnlyDescendant(s, baseline);
    const candidate = await limited.updateInventory(s, baseline, operation, reconcile);
    if (reconcile && !candidate) throw new Error('PREVIEW_CREATE_RESULT_UNKNOWN');
    const created = candidate ?? await limited.create(s, baseline.generation, operation, baseline.database);
    if (created.id === baseline.id || created.sha !== s.sha || created.branch !== s.branch || created.pr !== s.pr || created.phase !== 'application'
      || created.generation !== baseline.generation || created.operation !== operation || created.createdAt < baseline.createdAt
      || !created.database || !sameDatabase(created.database, baseline.database!)) throw new Error('PREVIEW_DEPLOYMENT_CHANGED');
    try {
      const current = await limited.settle(created, s);
      if (!sameDeploymentMetadata(created, current)) throw new Error('PREVIEW_DEPLOYMENT_CHANGED');
      if (current.state !== 'READY') throw new Error('PREVIEW_BUILD_FAILED');
      const confirmed = await limited.updateInventory(s, baseline, operation, true);
      if (!confirmed || !samePinnedDeployment(current, confirmed)) throw new Error('PREVIEW_RETENTION_TARGET_CHANGED');
      return { ...await limited.status(s), action: 'deploy' };
    } catch (error) {
      const code = error instanceof Error && error.message === 'PREVIEW_BUILD_FAILED' ? 'PREVIEW_BUILD_FAILED'
        : error instanceof Error && error.message === 'PREVIEW_BUILD_TIMEOUT' ? 'PREVIEW_BUILD_TIMEOUT' : 'PREVIEW_UPDATE_FAILED';
      throw new PreviewUpdateError(created.id, code);
    }
  }
  async deploy(s: Source, operation: string, resume = false): Promise<Receipt> {
    if (s.state !== 'open' || !uuid(operation)) throw new Error('PREVIEW_INVALID_REQUEST');
    await this.provider.assertBindings(); await this.gitGate(s); await this.provider.assertSource(s, 'open');
    let { ds, database } = await this.inventory(s);
    const generation = ds[0]?.generation ?? randomUUID();
    for (const pending of ds.filter(d => !['READY','ERROR','CANCELED'].includes(d.state))) await this.settle(pending, s);
    ({ ds, database } = await this.inventory(s));
    const ready = ds.filter(d => d.sha === s.sha && d.phase === 'application' && d.state === 'READY').at(-1);
    if (ready) return { ...await this.status(s), action: 'deploy' };
    if (!ds.length) {
      // On an uncertain request a rerun reconciles metadata, never blindly POSTs again.
      if (resume) throw new Error('PREVIEW_CREATE_RESULT_UNKNOWN');
      const provision = await this.create(s, generation, operation);
      await this.settle(provision, s);
      for (let i = 0; i < 30 && !database; i++) { ({ database } = await this.inventory(s)); if (!database) await this.wait(2000); }
    }
    if (!database) throw new Error('PREVIEW_NATIVE_DATABASE_UNAVAILABLE');
    ({ ds } = await this.inventory(s));
    let application = ds.find(d => d.operation === operation && d.phase === 'application');
    if (!application) {
      if (resume) throw new Error('PREVIEW_CREATE_RESULT_UNKNOWN');
      application = await this.create(s, generation, operation, database);
    }
    const settled = await this.settle(application, s);
    if (settled.state !== 'READY') throw new Error('PREVIEW_BUILD_FAILED');
    return { ...await this.status(s), action: 'deploy' };
  }
  async cleanup(s: Source): Promise<Receipt> {
    if (s.state !== 'closed') throw new Error('PREVIEW_PR_NOT_CLOSED');
    await this.provider.assertBindings(); await this.provider.assertSource(s, 'closed');
    const { ds, database, known, notBefore } = await this.inventory(s);
    if (ds.some(d => !['READY','ERROR','CANCELED'].includes(d.state))) throw new Error('PREVIEW_BUILD_STILL_RUNNING');
    // Retain an immutable provider record until DB deletion is verified, so a failed run can reconcile without a management DB.
    const anchor = ds.filter(d => d.database).at(-1) ?? ds[0];
    for (const d of ds.filter(d => d.id !== anchor?.id)) {
      await this.provider.assertSource(s, 'closed');
      const current = await this.provider.getDeployment(d.id, s, true);
      if (current && (current.generation !== d.generation || current.sha !== d.sha || current.phase !== d.phase)) throw new Error('PREVIEW_DELETE_TARGET_CHANGED');
      if (current) await this.provider.api('vercel', `/v13/deployments/${d.id}`, 'DELETE');
      if (await this.provider.getDeployment(d.id, s, true)) throw new Error('PREVIEW_DELETE_UNCONFIRMED');
    }
    if (database) {
      await this.provider.assertSource(s, 'closed');
      const current = await this.provider.database(s, notBefore, database);
      if (current) await this.provider.api('neon', `/projects/${config.neonProjectId}/branches/${database.branchId}`, 'DELETE');
    }
    if (database ?? known) {
      let gone = false;
      for (let i = 0; i < 30; i++) {
        if (!await this.provider.database(s, notBefore, database ?? known)) { gone = true; break; }
        await this.wait(2000);
      }
      if (!gone) throw new Error('PREVIEW_DATABASE_DELETE_UNCONFIRMED');
    }
    if (anchor) {
      await this.provider.assertSource(s, 'closed');
      const current = await this.provider.getDeployment(anchor.id, s, true);
      if (current && (current.generation !== anchor.generation || current.sha !== anchor.sha)) throw new Error('PREVIEW_DELETE_TARGET_CHANGED');
      if (current) await this.provider.api('vercel', `/v13/deployments/${anchor.id}`, 'DELETE');
      if (await this.provider.getDeployment(anchor.id, s, true)) throw new Error('PREVIEW_DELETE_UNCONFIRMED');
    }
    if ((await this.provider.deployments(s)).length || await this.provider.database(s, notBefore, database ?? known)) throw new Error('PREVIEW_CLEANUP_INCOMPLETE');
    await this.provider.assertSource(s, 'closed');
    return { protocol, action: 'cleanup', source: s, checkedAt: new Date().toISOString(), success: true };
  }
}

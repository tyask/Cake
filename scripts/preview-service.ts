import { randomUUID } from 'node:crypto';
import { config, deployment, object, protocol, sameDatabase, uuid, type Database, type Deployment, type Source } from './preview-model';
import { PreviewProvider } from './preview-provider';
import { assertMainOnlyGitConfig } from './task-workflow';
export type Receipt = { protocol: typeof protocol; action: string; source: Source; deployment?: Deployment; database?: Database; checkedAt: string; success: true };
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
    // A verified application pins the existing DB even when the initial
    // provisioning Deployment is no longer retained. The request-time bound is
    // only needed when establishing ownership of a previously unknown DB.
    const sourceCreatedAt = Date.parse(s.createdAt);
    const notBefore = known ? sourceCreatedAt : Math.max(sourceCreatedAt, (ds[0]?.createdAt ?? Date.now()) - 60_000);
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
    const phase = database ? 'application' : 'provisioning';
    const env = { ...(s.pr === 0 ? { CAKE_PREVIEW_KIND: 'main' } : {}), AUTH_MODE: 'test', CAKE_PREVIEW_REPOSITORY: config.repository, CAKE_PREVIEW_PR: String(s.pr), CAKE_PREVIEW_GENERATION: generation,
      CAKE_PREVIEW_SOURCE_BRANCH: s.branch, CAKE_PREVIEW_SOURCE_SHA: s.sha, CAKE_PREVIEW_PHASE: phase,
      CAKE_PREVIEW_DATABASE_BRANCH_ID: database?.branchId ?? '', CAKE_PREVIEW_DATABASE_HOST_SHA256: database?.hostDigest ?? '',
      CAKE_PREVIEW_PRODUCTION_HOST_SHA256: config.productionHostDigest };
    // The first deployment triggers Native branching and publishes only a DB-free static page.
    // A second deployment receives only verified public identifiers; Native injects the actual credential.
    const value = await this.provider.api('vercel', '/v13/deployments?forceNew=1', 'POST', {
      name: 'cake', project: config.vercelProjectId,
      gitSource: { type: 'github', repoId: config.repositoryId, ref: s.branch, sha: s.sha }, env, build: { env },
      meta: { cakePreviewProtocol: protocol, cakePreviewRepository: config.repository, cakePreviewPr: String(s.pr), cakePreviewGeneration: generation,
        cakePreviewOperation: operation, cakePreviewPhase: phase, ...(database ? { cakePreviewDatabaseBranch: database.branchId,
          cakePreviewDatabaseEndpoint: database.endpointId, cakePreviewDatabaseDigest: database.hostDigest } : {}) },
    });
    return deployment(value, s);
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
      if ((await this.settle(provision, s)).state !== 'READY') throw new Error('PREVIEW_PROVISIONING_BUILD_FAILED');
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

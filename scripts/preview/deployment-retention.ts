import { array, config, deployment, object, protocol, sameDatabase, text, type Deployment, type Source } from './preview-model';
import { fullSha } from '../task/task-workflow';
import { PreviewService } from './preview-service';
import { StagingProvider } from './staging-service';
import staging from '../../staging.config.json';

export const retentionPolicy = { stagingReady: 1, productionReady: 1 } as const;
export type RetentionMode = 'plan' | 'apply';
export type RetentionReceipt = {
  protocol: 'cake-deployment-retention/v1'; mode: RetentionMode; sourceSha: string; checkedAt: string;
  planned: string[]; deleted: string[]; skipped: string[]; retained: number; success: true;
};
export type RetentionAudit = (event: { action: 'plan' | 'deleting' | 'deleted'; ids: readonly string[] }) => void;
type Item = { id: string; kind: 'staging' | 'production'; sha: string; createdAt: number; state: string; fingerprint: string; preview?: Deployment };
const terminal = new Set(['READY', 'ERROR', 'CANCELED']);
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(value)) throw new Error('PREVIEW_RETENTION_INVALID_ID');
  return value;
};

/** Retains live references and ownership anchors; never changes databases or aliases. */
export class DeploymentRetentionService {
  constructor(readonly provider = new StagingProvider(), readonly now = () => Date.now(), readonly audit: RetentionAudit = () => {},
    readonly beforeDelete: () => Promise<void> = async () => {}) {}

  private async inventory(): Promise<Record<string, unknown>[]> {
    const found: Record<string, unknown>[] = [], ids = new Set<string>(), cursors = new Set<number>();
    let until: number | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = object(await this.provider.api('vercel', `/v6/deployments?projectId=${config.vercelProjectId}&limit=100${until === undefined ? '' : `&until=${until}`}`));
      for (const value of array(result.deployments)) {
        const row = object(value), key = id(row.uid ?? row.id);
        if (ids.has(key)) throw new Error('PREVIEW_RETENTION_INCOMPLETE_INVENTORY');
        ids.add(key); found.push(row);
      }
      const next = object(result.pagination).next;
      if (next === null) return found;
      if (!Number.isSafeInteger(next) || Number(next) < 0 || cursors.has(Number(next)) || until !== undefined && Number(next) >= until)
        throw new Error('PREVIEW_RETENTION_INCOMPLETE_INVENTORY');
      until = Number(next); cursors.add(until);
    }
    throw new Error('PREVIEW_RETENTION_INCOMPLETE_INVENTORY');
  }

  private kind(row: Record<string, unknown>): Item['kind'] | undefined {
    const meta = object(row.meta ?? {}), git = object(row.gitSource ?? {});
    if (row.target == null && meta.cakePreviewProtocol === protocol && meta.cakePreviewRepository === config.repository
      && meta.cakePreviewPr === '0' && (meta.githubCommitRef === staging.branch || git.ref === staging.branch)) return 'staging';
    const [owner, repo] = config.repository.split('/');
    if (row.target === 'production' && meta.cakePreviewProtocol === undefined && meta.githubCommitRef === 'main'
      && meta.githubCommitOrg === owner && meta.githubCommitRepo === repo) return 'production';
    return undefined;
  }

  private parse(value: unknown, kind: Item['kind'], source: Source): Item {
    const row = object(value), key = id(row.id ?? row.uid), meta = object(row.meta), git = object(row.gitSource);
    if (row.projectId !== config.vercelProjectId || row.ownerId !== config.vercelTeamId || git.type !== 'github'
      || String(git.repoId) !== String(config.repositoryId) || !fullSha(git.sha)) throw new Error('PREVIEW_RETENTION_IDENTITY');
    const createdAt = Number(row.createdAt ?? row.created), state = text(row.readyState ?? row.state);
    if (!Number.isSafeInteger(createdAt) || createdAt < Date.parse(source.createdAt)) throw new Error('PREVIEW_RETENTION_IDENTITY');
    let preview: Deployment | undefined;
    if (kind === 'staging') preview = deployment(row, source);
    else {
      const [owner, repo] = config.repository.split('/');
      if (row.target !== 'production' || git.ref !== 'main' || meta.githubCommitRef !== 'main' || meta.githubCommitSha !== git.sha
        || meta.githubCommitOrg !== owner || meta.githubCommitRepo !== repo || String(meta.githubRepoId) !== String(config.repositoryId)
        || Object.keys(meta).some(key => key.startsWith('cakePreview'))) throw new Error('PREVIEW_RETENTION_IDENTITY');
    }
    return { id: key, kind, sha: git.sha, createdAt, state, ...(preview ? { preview } : {}),
      fingerprint: JSON.stringify([key, kind, git.sha, createdAt, state, preview?.generation, preview?.operation, preview?.phase, preview?.database]) };
  }

  private async detail(key: string, kind: Item['kind'], source: Source, missing = false): Promise<Item | null> {
    const result = await this.provider.api('vercel', `/v13/deployments/${id(key)}`, 'GET', undefined, missing);
    if (result === null && missing) return null;
    const item = this.parse(result, kind, source);
    if (item.id !== key) throw new Error('PREVIEW_RETENTION_IDENTITY');
    return item;
  }

  private async aliasReferences(): Promise<Set<string>> {
    const protectedIds = new Set<string>(), aliases = new Set<string>(), cursors = new Set<number>();
    let until: number | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = object(await this.provider.api('vercel', `/v4/aliases?projectId=${config.vercelProjectId}&limit=100${until === undefined ? '' : `&until=${until}`}`));
      for (const value of array(result.aliases)) {
        const row = object(value), name = text(row.alias);
        if (row.projectId !== config.vercelProjectId || aliases.has(name)) throw new Error('PREVIEW_RETENTION_ALIAS_INVENTORY');
        aliases.add(name);
        const nested = row.deployment == null ? undefined : object(row.deployment).id;
        if (row.deploymentId != null && nested != null && row.deploymentId !== nested) throw new Error('PREVIEW_RETENTION_ALIAS_INVENTORY');
        protectedIds.add(id(row.deploymentId ?? nested));
      }
      const next = object(result.pagination).next;
      if (next === null) return protectedIds;
      if (!Number.isSafeInteger(next) || Number(next) < 0 || cursors.has(Number(next)) || until !== undefined && Number(next) >= until)
        throw new Error('PREVIEW_RETENTION_ALIAS_INVENTORY');
      until = Number(next); cursors.add(until);
    }
    throw new Error('PREVIEW_RETENTION_ALIAS_INVENTORY');
  }

  private async protection(source: Source, anchor: Deployment): Promise<{ ids: Set<string>; productionId: string }> {
    await this.provider.assertSource(source); await this.provider.assertProtection();
    const project = object(await this.provider.api('vercel', `/v9/projects/${config.vercelProjectId}`));
    if (project.id !== config.vercelProjectId || project.accountId !== config.vercelTeamId || object(project.link).repoId != config.repositoryId)
      throw new Error('PREVIEW_RETENTION_IDENTITY');
    const protectedIds = await this.aliasReferences(), targets = object(project.targets);
    for (const value of Object.values(targets)) if (value != null) protectedIds.add(id(object(value).id));
    if (project.crons != null) {
      const cron = object(project.crons);
      if (cron.deploymentId != null) protectedIds.add(id(cron.deploymentId));
    }
    const productionId = id(object(targets.production).id), production = await this.detail(productionId, 'production', source);
    if (production?.state !== 'READY') throw new Error('PREVIEW_RETENTION_CURRENT_NOT_READY');
    const alias = object(await this.provider.api('vercel', `/v4/aliases/${staging.alias}`));
    if (alias.projectId !== config.vercelProjectId || alias.deploymentId !== anchor.id
      || alias.deployment != null && object(alias.deployment).id !== anchor.id) throw new Error('PREVIEW_RETENTION_STAGING_CHANGED');
    protectedIds.add(anchor.id);
    await this.provider.assertSource(source);
    return { ids: protectedIds, productionId };
  }

  private async anchor(source: Source): Promise<Deployment> {
    const status = await new PreviewService(this.provider).status(source), current = status.deployment;
    if (!current || !current.database || !status.database || !sameDatabase(current.database, status.database)
      || current.state !== 'READY' || current.sha !== source.sha) throw new Error('PREVIEW_RETENTION_STAGING_NOT_READY');
    return current;
  }

  async run(mode: RetentionMode, expectedSha?: string): Promise<RetentionReceipt> {
    if (!['plan', 'apply'].includes(mode)) throw new Error('PREVIEW_RETENTION_MODE');
    if (mode === 'apply') await this.beforeDelete();
    const checkedAt = this.now();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) throw new Error('PREVIEW_RETENTION_CLOCK');
    const source = await this.provider.main();
    if (expectedSha !== undefined && (!fullSha(expectedSha) || source.sha !== expectedSha)) throw new Error('PREVIEW_RETENTION_SOURCE_CHANGED');
    await this.provider.assertBindings(); await this.provider.assertProtection();
    const anchor = await this.anchor(source), references = await this.protection(source, anchor), protectedIds = references.ids;
    const rows = await this.inventory(), managed: Item[] = [];
    for (const row of rows) {
      const kind = this.kind(row);
      if (!kind) continue;
      const item = await this.detail(id(row.uid ?? row.id), kind, source);
      if (!item) throw new Error('PREVIEW_RETENTION_INCOMPLETE_INVENTORY');
      if (item.preview && (item.preview.generation !== anchor.generation || item.preview.database && !sameDatabase(item.preview.database, anchor.database!)))
        throw new Error('PREVIEW_RETENTION_STAGING_CHANGED');
      managed.push(item);
    }
    if (![anchor.id, references.productionId].every(key => managed.some(item => item.id === key)))
      throw new Error('PREVIEW_RETENTION_INCOMPLETE_INVENTORY');
    for (const kind of ['staging', 'production'] as const) {
      const count = kind === 'staging' ? retentionPolicy.stagingReady : retentionPolicy.productionReady;
      for (const item of managed.filter(item => item.kind === kind && item.state === 'READY' && (kind === 'production' || item.preview?.phase === 'application'))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(0, count)) protectedIds.add(item.id);
    }
    const candidates = managed.filter(item => terminal.has(item.state) && !protectedIds.has(item.id))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const planned = candidates.map(item => item.id), deleted: string[] = [], skipped: string[] = [];
    this.audit({ action: 'plan', ids: planned });
    if (mode === 'apply') for (const candidate of candidates) {
      await this.beforeDelete();
      await this.provider.assertSource(source);
      const current = await this.detail(candidate.id, candidate.kind, source, true);
      if (!current) { skipped.push(candidate.id); continue; }
      const references = await this.protection(source, anchor);
      if (references.ids.has(candidate.id)) { skipped.push(candidate.id); continue; }
      if (current.fingerprint !== candidate.fingerprint) throw new Error('PREVIEW_RETENTION_DELETE_TARGET_CHANGED');
      // The transport performs one DELETE only. An unknown response stops the run.
      this.audit({ action: 'deleting', ids: [candidate.id] });
      await this.provider.api('vercel', `/v13/deployments/${candidate.id}`, 'DELETE');
      if (await this.provider.api('vercel', `/v13/deployments/${candidate.id}`, 'GET', undefined, true) !== null)
        throw new Error('PREVIEW_RETENTION_DELETE_UNCONFIRMED');
      if ((await this.inventory()).some(row => id(row.uid ?? row.id) === candidate.id))
        throw new Error('PREVIEW_RETENTION_DELETE_UNCONFIRMED');
      deleted.push(candidate.id); this.audit({ action: 'deleted', ids: [candidate.id] });
    }
    const remaining = await this.inventory();
    if (remaining.some(row => deleted.includes(id(row.uid ?? row.id)))) throw new Error('PREVIEW_RETENTION_DELETE_UNCONFIRMED');
    const after = await this.anchor(source);
    if (after.id !== anchor.id || after.generation !== anchor.generation || !sameDatabase(after.database!, anchor.database!))
      throw new Error('PREVIEW_RETENTION_STAGING_CHANGED');
    await this.protection(source, anchor);
    return { protocol: 'cake-deployment-retention/v1', mode, sourceSha: source.sha, checkedAt: new Date(checkedAt).toISOString(),
      planned, deleted, skipped, retained: remaining.length, success: true };
  }
}

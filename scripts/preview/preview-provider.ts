import { spawnSync } from 'node:child_process';
import { isProductionDatabaseHostDigest } from '../../lib/server/production-database-hosts.mjs';
import { array, config, deployment, hostDigest, object, sameDatabase, source, text, type Database, type Deployment, type Source } from './preview-model';
export type Provider = 'github' | 'vercel' | 'neon';
export type Transport = (provider: Provider, path: string, method?: string, body?: unknown, missing?: boolean) => Promise<unknown>;
export function transport(environment: Readonly<Record<string, string | undefined>> = process.env): Transport {
  return async (provider, path, method = 'GET', body, missing = false) => {
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#]/.test(path)) throw new Error('PREVIEW_INVALID_REQUEST');
    const origins = { github: 'https://api.github.com', vercel: 'https://api.vercel.com', neon: 'https://console.neon.tech/api/v2' };
    let token = environment[provider === 'github' ? 'GH_TOKEN' : provider === 'vercel' ? 'VERCEL_TOKEN' : 'NEON_API_KEY'];
    if (provider === 'github' && !token) token = environment.GITHUB_TOKEN;
    if (provider === 'github' && !token) {
      const r = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 10_000 });
      if (r.status === 0) token = r.stdout.trim();
    }
    if (!token) throw new Error(`PREVIEW_${provider.toUpperCase()}_AUTH_MISSING`);
    const url = new URL(origins[provider] + path);
    if (provider === 'vercel') url.searchParams.set('teamId', config.vercelTeamId);
    let response: Response;
    try { response = await fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error(`PREVIEW_${provider.toUpperCase()}_${method}_RESPONSE_UNKNOWN`); }
    if (response.status === 404 && missing) return null;
    if (!response.ok) throw new Error(`PREVIEW_${provider.toUpperCase()}_${method}_HTTP_${response.status}`);
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new Error('PREVIEW_INVALID_RESPONSE'); }
  };
}
export class PreviewProvider {
  constructor(readonly api: Transport = transport()) {}
  async pr(pr: number): Promise<Source> {
    if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('PREVIEW_INVALID_PR');
    const value = source(await this.api('github', `/repos/${config.repository}/pulls/${pr}`));
    if (value.pr !== pr) throw new Error('PREVIEW_PR_MISMATCH');
    return value;
  }
  async assertSource(expected: Source, state = expected.state): Promise<void> {
    const actual = await this.pr(expected.pr);
    if (actual.state !== state || actual.branch !== expected.branch || actual.sha !== expected.sha || actual.createdAt !== expected.createdAt) throw new Error('PREVIEW_PR_CHANGED');
  }
  async assertBindings(): Promise<void> {
    const repo = object(await this.api('github', `/repos/${config.repository}`));
    const project = object(await this.api('vercel', `/v9/projects/${config.vercelProjectId}`));
    const neon = object(object(await this.api('neon', `/projects/${config.neonProjectId}`)).project);
    const parent = object(object(await this.api('neon', `/projects/${config.neonProjectId}/branches/${config.neonParentBranchId}`)).branch);
    if (repo.id !== config.repositoryId || repo.full_name !== config.repository || project.id !== config.vercelProjectId
      || project.accountId !== config.vercelTeamId || object(project.link).repoId != config.repositoryId
      || neon.id !== config.neonProjectId || parent.id !== config.neonParentBranchId || parent.project_id !== config.neonProjectId) throw new Error('PREVIEW_PROVIDER_BINDING');
  }
  async getDeployment(id: string, expected: Source, missing = false): Promise<Deployment | null> {
    if (!/^dpl_[A-Za-z0-9]+$/.test(id)) throw new Error('PREVIEW_INVALID_DEPLOYMENT');
    const value = await this.api('vercel', `/v13/deployments/${id}`, 'GET', undefined, missing);
    return value === null ? null : deployment(value, expected);
  }
  async deployments(expected: Source): Promise<Deployment[]> {
    const found: Deployment[] = [], seen = new Set<number>(); let until: number | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = object(await this.api('vercel', `/v6/deployments?projectId=${config.vercelProjectId}&limit=100${until === undefined ? '' : `&until=${until}`}`));
      for (const value of array(result.deployments)) {
        const d = object(value), m = object(d.meta ?? {});
        if (m.cakePreviewPr !== String(expected.pr) && m.githubCommitRef !== expected.branch && object(d.gitSource ?? {}).ref !== expected.branch) continue;
        const detail = await this.getDeployment(text(d.uid ?? d.id), expected);
        if (!detail) throw new Error('PREVIEW_INVENTORY_CHANGED');
        found.push(detail);
      }
      const next = object(result.pagination).next;
      if (next === null) return found.sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      if (!Number.isSafeInteger(next) || seen.has(Number(next))) throw new Error('PREVIEW_INCOMPLETE_INVENTORY');
      until = Number(next); seen.add(until);
    }
    throw new Error('PREVIEW_INCOMPLETE_INVENTORY');
  }
  async database(expected: Source, notBefore: number, known?: Database): Promise<Database | null> {
    const branches: Record<string, unknown>[] = []; let cursor: string | undefined; const seen = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const response = object(await this.api('neon', `/projects/${config.neonProjectId}/branches?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      branches.push(...array(response.branches).map(object));
      const next = object(response.pagination ?? {}).cursor;
      if (next == null || next === '') break;
      cursor = text(next); if (seen.has(cursor) || page === 999) throw new Error('PREVIEW_INCOMPLETE_INVENTORY'); seen.add(cursor);
    }
    const endpoints = array(object(await this.api('neon', `/projects/${config.neonProjectId}/endpoints`)).endpoints).map(object);
    const matches = branches.filter(b => b.name === `preview/${expected.branch}` || known && b.id === known.branchId);
    if (!matches.length) {
      if (known) {
        const b = await this.api('neon', `/projects/${config.neonProjectId}/branches/${known.branchId}`, 'GET', undefined, true);
        const e = await this.api('neon', `/projects/${config.neonProjectId}/endpoints/${known.endpointId}`, 'GET', undefined, true);
        if (b !== null || e !== null || endpoints.some(e => e.id === known.endpointId || e.branch_id === known.branchId)) throw new Error('PREVIEW_DATABASE_INVENTORY_CHANGED');
      }
      return null;
    }
    if (matches.length !== 1) throw new Error('PREVIEW_DATABASE_AMBIGUOUS');
    const b = matches[0], candidates = endpoints.filter(e => e.branch_id === b.id);
    if (b.project_id !== config.neonProjectId || b.name !== `preview/${expected.branch}` || b.parent_id !== config.neonParentBranchId
      || b.id === config.neonParentBranchId || !/^br-[a-z0-9-]+$/.test(String(b.id)) || b.default !== false || b.protected !== false
      || !Number.isFinite(Date.parse(String(b.created_at))) || Date.parse(String(b.created_at)) < notBefore || candidates.length !== 1) throw new Error('PREVIEW_DATABASE_IDENTITY');
    const e = candidates[0];
    if (e.project_id !== config.neonProjectId || e.type !== 'read_write' || !/^ep-[a-z0-9-]+$/.test(String(e.id))) throw new Error('PREVIEW_DATABASE_IDENTITY');
    const database = { branchId: String(b.id), endpointId: String(e.id), hostDigest: hostDigest(text(e.host)) };
    if (isProductionDatabaseHostDigest(database.hostDigest) || known && !sameDatabase(database, known)) throw new Error('PREVIEW_DATABASE_IDENTITY');
    // Cross-check list membership with exact provider GETs before trusting IDs.
    const directB = object(object(await this.api('neon', `/projects/${config.neonProjectId}/branches/${database.branchId}`)).branch);
    const directE = object(object(await this.api('neon', `/projects/${config.neonProjectId}/endpoints/${database.endpointId}`)).endpoint);
    for (const k of ['id','project_id','parent_id','name','default','protected','created_at']) if (directB[k] !== b[k]) throw new Error('PREVIEW_DATABASE_INVENTORY_CHANGED');
    for (const k of ['id','project_id','branch_id','type','host']) if (directE[k] !== e[k]) throw new Error('PREVIEW_DATABASE_INVENTORY_CHANGED');
    return database;
  }
}

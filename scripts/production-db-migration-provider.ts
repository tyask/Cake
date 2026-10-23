import { createHash } from 'node:crypto';
import configSource from '../production-migration.config.json';

export const config = Object.freeze(configSource);
export type Binding = typeof config.source;
export type Api = (provider: 'neon' | 'vercel' | 'github', path: string) => Promise<unknown>;
export type Connection = { host: string; port: number; user: string; password: string; database: string };
export class MigrationError extends Error {
  constructor(code: string) { super(`PRODUCTION_MIGRATION_${code}`); this.name = 'MigrationError'; }
}
export const fail = (code: string): never => { throw new MigrationError(code); };
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return fail('INVALID_RESPONSE');
  return value.map(record);
}
export type Environment = Readonly<Record<string, string | undefined>>;
/** Both runners reject malformed or shared credentials before the first provider read. */
export function assertProductionCredentials(environment: Environment): void {
  const sourceKey = environment.NEON_SOURCE_API_KEY, targetKey = environment.NEON_TARGET_API_KEY;
  if (!sourceKey?.trim()) return fail('SOURCE_CREDENTIALS_MISSING');
  if (!targetKey?.trim()) return fail('TARGET_CREDENTIALS_MISSING');
  if (/[\r\n]/.test(sourceKey)) return fail('SOURCE_CREDENTIALS_INVALID');
  if (/[\r\n]/.test(targetKey)) return fail('TARGET_CREDENTIALS_INVALID');
  if (sourceKey.trim() === targetKey.trim()) return fail('CREDENTIALS_NOT_SEPARATED');
  if ([environment.VERCEL_TOKEN,environment.GH_TOKEN].some(value => !value?.trim() || /[\r\n]/.test(value))
    || environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') return fail('CREDENTIALS_MISSING');
}
export function productionApi(environment: Environment, request: typeof fetch = fetch): Api {
  return async (provider, path) => {
    const providerCode = provider === 'neon' ? 'NEON' : provider === 'vercel' ? 'VERCEL' : provider === 'github' ? 'GITHUB' : undefined;
    if (!providerCode) return fail('INVALID_REQUEST');
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#\\]/.test(path)) return fail('INVALID_REQUEST');
    const origin = provider === 'neon' ? 'https://console.neon.tech' : provider === 'vercel' ? 'https://api.vercel.com' : 'https://api.github.com';
    const url = new URL((provider === 'neon' ? '/api/v2' : '') + path, origin);
    if (url.origin !== origin) return fail('INVALID_REQUEST');
    if (provider === 'vercel') url.searchParams.set('teamId', config.vercelTeamId);
    let token: string | undefined;
    if (provider === 'neon') {
      // Credentials follow the canonical project route; aliases and normalization are refused.
      const rawPathname = path.split('?', 1)[0];
      if (url.pathname !== `/api/v2${rawPathname}` || rawPathname.includes('%')) return fail('INVALID_REQUEST');
      const projectId = url.pathname.split('/')[4];
      const binding = projectId === config.source.projectId ? config.source
        : projectId === config.target.projectId ? config.target : undefined;
      if (!binding) return fail('INVALID_REQUEST');
      const base = `/api/v2/projects/${binding.projectId}`;
      if (![base, `${base}/branches`, `${base}/branches/${binding.branchId}`,
        `${base}/endpoints`, `${base}/endpoints/${binding.endpointId}`,
        `${base}/branches/${binding.branchId}/databases/${binding.database}`,
        `${base}/branches/${binding.branchId}/roles/${binding.role}`, `${base}/connection_uri`].includes(url.pathname)) return fail('INVALID_REQUEST');
      token = environment[projectId === config.source.projectId ? 'NEON_SOURCE_API_KEY' : 'NEON_TARGET_API_KEY'];
    } else token = environment[provider === 'vercel' ? 'VERCEL_TOKEN' : 'GH_TOKEN'];
    if (!token?.trim() || /[\r\n]/.test(token)) return fail('CREDENTIALS_MISSING');
    let result: Response;
    try {
      result = await request(url, { method: 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    } catch { return fail(`PROVIDER_${providerCode}_TRANSPORT`); }
    // Only fixed provider labels and a bounded integer status may enter public diagnostics.
    const status = result.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) return fail(`PROVIDER_${providerCode}_INVALID_STATUS`);
    if (!result.ok) return fail(`PROVIDER_${providerCode}_HTTP_${status}`);
    try { return await result.json(); } catch { return fail(`PROVIDER_${providerCode}_JSON`); }
  };
}

export async function assertBinding(api: Api, expected: Binding): Promise<void> {
  const base = `/projects/${expected.projectId}`;
  const project = record(record(await api('neon', base)).project);
  if (project.id !== expected.projectId || project.org_id !== config.organizationId
    || project.region_id !== config.regionId || project.pg_version !== expected.majorVersion) return fail('PROVIDER_BINDING');
  const branches: Record<string, unknown>[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const list = record(await api('neon', `${base}/branches?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    branches.push(...records(list.branches));
    const pagination = list.pagination == null ? {} : record(list.pagination);
    if (pagination.next == null || pagination.next === '') break;
    if (typeof pagination.next !== 'string' || seen.has(pagination.next) || page === 19) return fail('INCOMPLETE_INVENTORY');
    cursor = pagination.next; seen.add(cursor);
  }
  const candidates = branches.filter(branch => branch.id === expected.branchId);
  if (candidates.length !== 1 || branches.filter(branch => branch.default === true).length !== 1) return fail('PROVIDER_BINDING');
  const directBranch = record(record(await api('neon', `${base}/branches/${expected.branchId}`)).branch);
  for (const key of ['id', 'project_id', 'default', 'protected', 'parent_id']) {
    if (directBranch[key] !== candidates[0][key]) return fail('PROVIDER_CHANGED');
  }
  if (directBranch.id !== expected.branchId || directBranch.project_id !== expected.projectId || directBranch.default !== true) return fail('PROVIDER_BINDING');
  const endpoints = records(record(await api('neon', `${base}/endpoints`)).endpoints);
  const writers = endpoints.filter(endpoint => endpoint.branch_id === expected.branchId && endpoint.type === 'read_write');
  if (writers.length !== 1) return fail('PROVIDER_BINDING');
  const endpoint = record(record(await api('neon', `${base}/endpoints/${expected.endpointId}`)).endpoint);
  for (const key of ['id', 'project_id', 'branch_id', 'region_id', 'host', 'type', 'disabled']) {
    if (endpoint[key] !== writers[0][key]) return fail('PROVIDER_CHANGED');
  }
  if (endpoint.id !== expected.endpointId || endpoint.project_id !== expected.projectId || endpoint.branch_id !== expected.branchId
    || endpoint.region_id !== config.regionId || endpoint.type !== 'read_write' || endpoint.disabled !== false
    || !['active', 'idle'].includes(String(endpoint.current_state)) || endpoint.pending_state != null
    || typeof endpoint.host !== 'string' || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(endpoint.host)
    || endpoint.host.includes('-pooler.') || !endpoint.host.startsWith(`${expected.endpointId}.`) || hash(endpoint.host) !== expected.hostDigest) return fail('PROVIDER_BINDING');
  const db = record(record(await api('neon', `${base}/branches/${expected.branchId}/databases/${expected.database}`)).database);
  // Role GET may contain a password; inspect only these public binding fields.
  const role = record(record(await api('neon', `${base}/branches/${expected.branchId}/roles/${expected.role}`)).role);
  if (db.branch_id !== expected.branchId || db.name !== expected.database || db.owner_name !== expected.role
    || role.branch_id !== expected.branchId || role.name !== expected.role) return fail('PROVIDER_BINDING');
}

/** The URI never crosses a process boundary or enters a public receipt. */
export function parseConnection(uri: unknown, expected: Binding): Connection {
  try {
    if (typeof uri !== 'string') throw new Error();
    const url = new URL(uri);
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password), database = decodeURIComponent(url.pathname.slice(1));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash || url.port && url.port !== '5432'
      || user !== expected.role || database !== expected.database || !password || /[\u0000-\u001f\u007f]/.test(password)
      || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) || url.hostname.includes('-pooler.')
      || !url.hostname.startsWith(`${expected.endpointId}.`) || hash(url.hostname) !== expected.hostDigest) throw new Error();
    for (const key of url.searchParams.keys()) {
      if (url.searchParams.getAll(key).length !== 1 || !((key === 'sslmode' || key === 'channel_binding') && url.searchParams.get(key) === 'require')) throw new Error();
    }
    if (url.searchParams.get('sslmode') !== 'require') throw new Error();
    return { host: url.hostname, port: 5432, user, password, database };
  } catch { return fail('CONNECTION_BINDING'); }
}
export async function connection(api: Api, expected: Binding): Promise<Connection> {
  const params = new URLSearchParams({ branch_id: expected.branchId, endpoint_id: expected.endpointId,
    database_name: expected.database, role_name: expected.role, pooled: 'false' });
  return parseConnection(record(await api('neon', `/projects/${expected.projectId}/connection_uri?${params}`)).uri, expected);
}

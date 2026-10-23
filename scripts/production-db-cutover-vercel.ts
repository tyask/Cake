import { createHash } from 'node:crypto';
import { developmentToken } from './preview-browser';
import { assertProductionProjectEnvironment, assertProviderProductionEnvironment, ProductionEnvironmentError, type EnvironmentFailureCode } from './production-db-cutover-environment';
import { config, type Api, type Binding, type Environment } from './production-db-migration-provider';

export const productionSourceStore = 'store_MbDEtSbG9jVS4pDq';
export const productionAliases = ['cake-omega-gilt.vercel.app', 'cake-git-main-fumin1.vercel.app', 'cake-fumin1.vercel.app'] as const;
type Stage = 'preflight' | 'source-scope' | 'target-connect' | 'native-check' | 'create' | 'ready' | 'aliases-before'
  | 'oidc' | 'probe' | 'promote' | 'aliases-after' | 'final' | 'complete';
type Code = 'OK' | 'INVALID_INPUT' | 'CREDENTIALS' | 'INVALID_RESPONSE' | 'HTTP' | 'RESPONSE_UNKNOWN' | 'JSON'
  | 'BINDING' | 'INCOMPLETE_INVENTORY' | 'NATIVE_CONNECTION' | 'BEFORE_WRITE' | 'DUPLICATE_DEPLOYMENT'
  | 'DEPLOYMENT_BINDING' | 'DEPLOYMENT_FAILED' | 'DEPLOYMENT_TIMEOUT' | 'ALIAS_CHANGED' | 'ALIAS_TIMEOUT'
  | 'ENVIRONMENT' | EnvironmentFailureCode | 'OIDC' | 'PROBE' | 'UNEXPECTED';
type Write = 'source' | 'target' | 'deployment' | 'promote';
type WriteState = 'not-started' | 'attempted' | 'acknowledged';
type Alias = { alias: string; deploymentId: string; projectId: string };
type Domain = { name: string; projectId: string; branch: string | null; environment: string | null; redirect: string | null; verified: boolean };
type Connection = { id: string; projectId: string; environments: string[]; prefix: string | null };
type Deployment = { id: string; url: string; sha: string; state: string };
type Routing = { aliases: Alias[]; domains: Domain[]; production: string[] };
type RoutingSummary = { aliases: number; hash: string; domains: number; domainHash: string; production: string[]; known: [string, string][] };
export type ProductionSwitchReport = {
  success: boolean; stage: Stage; code: Code; httpStatus: number | null; responseUnknown: boolean;
  writes: Record<Write, WriteState>; before: RoutingSummary | null; after: RoutingSummary | null;
  deployment: { id: string; url: string; sha: string } | null;
  sourceScopeUpdated: boolean; targetConnected: boolean; nativeVerified: boolean; ready: boolean;
  probed: boolean; promoted: boolean; aliasVerified: boolean; knownAliasesCurrent: boolean; ms: number;
};
export type ProductionSwitchContext = { controlSha: string; operation: string; beforeWrite: () => Promise<void> };
export type ProductionSwitchOptions = { environment?: Environment; request?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number };
class SwitchFailure extends Error {
  constructor(readonly code: Code, readonly status: number | null = null, readonly unknown = false) { super(code); }
}
const fail = (code: Code): never => { throw new SwitchFailure(code); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : fail('INVALID_RESPONSE');
const array = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : fail('INVALID_RESPONSE');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const deploymentId = (value: unknown): string => typeof value === 'string' && /^dpl_[A-Za-z0-9]{1,100}$/.test(value) ? value : fail('INVALID_RESPONSE');
function hostname(value: unknown): string {
  if (typeof value !== 'string' || value.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)
    || value.includes('..') || !value.includes('.')) return fail('INVALID_RESPONSE');
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(item))
    || new Set(value).size !== value.length) return fail('INVALID_RESPONSE');
  return [...value].sort();
}
function summary(value: Routing): RoutingSummary {
  return { aliases: value.aliases.length, hash: digest(value.aliases), domains: value.domains.length, domainHash: digest(value.domains),
    production: value.production, known: productionAliases.map(name => [name, value.aliases.find(alias => alias.alias === name)!.deploymentId]) };
}

/** Fixed production resources only. Raw provider responses and credentials stay in this process. */
export async function runProductionSwitch(context: ProductionSwitchContext, options: ProductionSwitchOptions = {}): Promise<ProductionSwitchReport> {
  const environment = options.environment ?? process.env, request = options.request ?? fetch, now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))), started = now();
  const report: ProductionSwitchReport = { success: false, stage: 'preflight', code: 'UNEXPECTED', httpStatus: null, responseUnknown: false,
    writes: { source: 'not-started', target: 'not-started', deployment: 'not-started', promote: 'not-started' }, before: null, after: null,
    deployment: null, sourceScopeUpdated: false, targetConnected: false, nativeVerified: false, ready: false, probed: false,
    promoted: false, aliasVerified: false, knownAliasesCurrent: false, ms: 0 };
  const token = environment.VERCEL_TOKEN;
  async function discard(response: Response) { try { await response.body?.cancel(); } catch { /* No response body enters diagnostics. */ } }
  async function api(path: string, method = 'GET', body?: unknown, json = true): Promise<unknown> {
    const url = new URL(path, 'https://api.vercel.com');
    if (url.origin !== 'https://api.vercel.com' || !path.startsWith('/') || path.startsWith('//') || /[\\\r\n#]/.test(path)) return fail('BINDING');
    url.searchParams.set('teamId', config.vercelTeamId);
    let response: Response;
    try { response = await request(url, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
      'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) }); }
    catch { throw new SwitchFailure('RESPONSE_UNKNOWN', null, method !== 'GET'); }
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) { await discard(response); throw new SwitchFailure('INVALID_RESPONSE', null, method !== 'GET'); }
    if (!response.ok) { await discard(response); throw new SwitchFailure('HTTP', response.status); }
    if (!json || response.status === 204) { await discard(response); return null; }
    try { return await response.json(); } catch { throw new SwitchFailure('JSON', response.status, method !== 'GET'); }
  }
  async function write(name: Write, path: string, method: string, body?: unknown, json = false, checkEnvironment?: () => Promise<void>) {
    // A failed/unknown mutation is never retried, including when beforeWrite rejects.
    try { await context.beforeWrite(); } catch { return fail('BEFORE_WRITE'); }
    await checkEnvironment?.();
    if (report.writes[name] !== 'not-started') return fail('BINDING');
    report.writes[name] = 'attempted';
    const value = await api(path, method, body, json);
    report.writes[name] = 'acknowledged'; return value;
  }
  async function list(path: string, key: string): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [], cursors = new Set<number>();
    let until: number | undefined;
    for (let page = 0; page < 50; page++) {
      const value = object(await api(`${path}${path.includes('?') ? '&' : '?'}limit=100${until === undefined ? '' : `&until=${until}`}`));
      result.push(...array(value[key]));
      const next = object(value.pagination).next;
      if (next === null) return result;
      if (!Number.isSafeInteger(next) || Number(next) < 0 || cursors.has(Number(next))) return fail('INCOMPLETE_INVENTORY');
      until = Number(next); cursors.add(until);
    }
    return fail('INCOMPLETE_INVENTORY');
  }
  async function project(expectedProduction?: string) {
    const value = object(await api(`/v9/projects/${config.vercelProjectId}`)), link = object(value.link);
    if (value.id !== config.vercelProjectId || value.accountId !== config.vercelTeamId || link.type !== 'github'
      || String(link.repoId) !== String(config.repositoryId)) return fail('BINDING');
    if (expectedProduction !== undefined && value.targets != null && object(object(value.targets).production).id !== expectedProduction) return fail('DEPLOYMENT_BINDING');
    return value;
  }
  const environmentApi: Api = async (provider, path) => {
    if (provider !== 'vercel') return fail('BINDING');
    return api(path);
  };
  async function projectEnvironment(expected: Binding) {
    await assertProductionProjectEnvironment(environmentApi, expected);
  }
  async function candidateEnvironment(id: string) {
    const value = object(await api(`/v3/env/pull/${id}`));
    // CLI env pull --id uses buildEnv: env may contain only runtime decryption keys for large envs.
    // Readable snapshot URLs must agree; hidden Secrets use metadata and the separately checked Native binding.
    await assertProviderProductionEnvironment(environmentApi, value.buildEnv, config.target, 'BUILD');
    if (value.env !== undefined) await assertProviderProductionEnvironment(environmentApi, value.env, config.target, 'RUNTIME', false);
  }
  async function routing(): Promise<Routing> {
    const aliases = (await list(`/v4/aliases?projectId=${config.vercelProjectId}`, 'aliases')).map(row => {
      if (row.projectId !== config.vercelProjectId) return fail('BINDING');
      return { alias: hostname(row.alias), deploymentId: deploymentId(row.deploymentId), projectId: config.vercelProjectId };
    }).sort((a, b) => a.alias.localeCompare(b.alias));
    if (new Set(aliases.map(row => row.alias)).size !== aliases.length) return fail('INCOMPLETE_INVENTORY');
    if (productionAliases.some(name => !aliases.some(row => row.alias === name))) return fail('BINDING');
    const parseDomain = (row: Record<string, unknown>): Domain => {
      if (row.projectId !== config.vercelProjectId || typeof row.verified !== 'boolean'
        || row.gitBranch != null && typeof row.gitBranch !== 'string' || row.customEnvironmentId != null && typeof row.customEnvironmentId !== 'string'
        || row.redirect != null && typeof row.redirect !== 'string') return fail('BINDING');
      return { name: hostname(row.name), projectId: config.vercelProjectId, branch: row.gitBranch as string ?? null,
        environment: row.customEnvironmentId as string ?? null, redirect: row.redirect as string ?? null, verified: row.verified };
    };
    const domains = (await list(`/v9/projects/${config.vercelProjectId}/domains`, 'domains')).map(parseDomain).sort((a,b) => a.name.localeCompare(b.name));
    const production = (await list(`/v9/projects/${config.vercelProjectId}/domains?production=true`, 'domains')).map(parseDomain).sort((a,b) => a.name.localeCompare(b.name));
    if (new Set(domains.map(row => row.name)).size !== domains.length || new Set(production.map(row => row.name)).size !== production.length
      || production.some(row => !same(row, domains.find(domain => domain.name === row.name)))
      || !production.some(row => row.name === productionAliases[0]) || production.some(row => !aliases.some(alias => alias.alias === row.name))) return fail('BINDING');
    return { aliases, domains, production: production.map(row => row.name) };
  }
  async function stores(): Promise<{ source: Connection[]; target: Connection[] }> {
    async function read(id: string, externalResourceId: string) {
      const value = object(object(await api(`/v1/storage/stores/${id}?skip-metadata=true`)).store);
      if (value.id !== id || value.ownerId !== config.vercelTeamId || value.type !== 'integration' || value.status !== 'available'
        || value.externalResourceId !== externalResourceId) return fail('BINDING');
      const connections = array(value.projectsMetadata).map(row => {
        if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(row.id) || typeof row.projectId !== 'string'
          || !/^prj_[A-Za-z0-9]+$/.test(row.projectId) || row.envVarPrefix != null && typeof row.envVarPrefix !== 'string') return fail('INVALID_RESPONSE');
        return { id: row.id, projectId: row.projectId, environments: strings(row.environments), prefix: row.envVarPrefix as string ?? null };
      }).sort((a,b) => a.id.localeCompare(b.id));
      if (new Set(connections.map(row => row.id)).size !== connections.length || value.totalConnectedProjects !== new Set(connections.map(row => row.projectId)).size) return fail('NATIVE_CONNECTION');
      return connections;
    }
    return { source: await read(productionSourceStore, config.source.projectId), target: await read(config.targetStoreId, config.target.projectId) };
  }
  function validateDeployment(value: unknown, expectedId: string, candidate: boolean): Deployment {
    const row = object(value), git = object(row.gitSource), meta = object(row.meta ?? {});
    // Current CLI also accepts team.id when the deployment view omits ownerId.
    const team = row.team == null ? undefined : object(row.team).id;
    if (deploymentId(row.id ?? row.uid) !== expectedId || row.projectId !== config.vercelProjectId || (row.ownerId ?? team) !== config.vercelTeamId
      || team !== undefined && team !== config.vercelTeamId
      || row.target !== 'production' || git.type !== 'github' || String(git.repoId) !== String(config.repositoryId)
      || typeof git.sha !== 'string' || !/^[a-f0-9]{40}$/.test(git.sha)) return fail('DEPLOYMENT_BINDING');
    if (candidate && (git.ref !== 'main' || git.sha !== context.controlSha || meta.cakeProductionCutoverOperation !== context.operation
      || meta.cakeProductionCutoverSha !== context.controlSha)) return fail('DEPLOYMENT_BINDING');
    if (typeof row.url !== 'string') return fail('DEPLOYMENT_BINDING');
    const url = new URL(row.url.startsWith('https://') ? row.url : `https://${row.url}`);
    if (!/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(url.origin) || url.href !== `${url.origin}/`) return fail('DEPLOYMENT_BINDING');
    const state = row.readyState ?? row.state;
    if (typeof state !== 'string' || !['QUEUED','INITIALIZING','BUILDING','READY','ERROR','CANCELED'].includes(state)) return fail('DEPLOYMENT_BINDING');
    return { id: expectedId, url: url.origin, sha: git.sha, state };
  }
  async function deployments(expectedId?: string) {
    const rows = await list(`/v6/deployments?projectId=${config.vercelProjectId}`, 'deployments');
    const ids = rows.map(row => deploymentId(row.uid ?? row.id));
    if (new Set(ids).size !== ids.length) return fail('INCOMPLETE_INVENTORY');
    const matches = rows.filter(row => object(row.meta ?? {}).cakeProductionCutoverOperation === context.operation);
    if (expectedId === undefined ? matches.length !== 0 : matches.length !== 1 || deploymentId(matches[0].uid ?? matches[0].id) !== expectedId) return fail('DUPLICATE_DEPLOYMENT');
    if (matches.some(row => object(row.meta).cakeProductionCutoverSha !== context.controlSha || row.target !== 'production')) return fail('DEPLOYMENT_BINDING');
  }
  function unchangedRouting(before: Routing, current: Routing, candidate?: string, promoted = false) {
    if (!same(before.domains, current.domains) || !same(before.production, current.production)) return fail('ALIAS_CHANGED');
    for (const alias of before.aliases) {
      const actual = current.aliases.find(row => row.alias === alias.alias);
      if (!actual) return fail('ALIAS_CHANGED');
      const required = alias.alias === productionAliases[0] || before.production.includes(alias.alias);
      const allowed = required ? actual.deploymentId === (promoted ? candidate : alias.deploymentId)
        : actual.deploymentId === alias.deploymentId || productionAliases.includes(alias.alias as typeof productionAliases[number]) && actual.deploymentId === candidate;
      if (!allowed) return fail('ALIAS_CHANGED');
    }
    if (current.aliases.some(alias => !before.aliases.some(old => old.alias === alias.alias) && alias.deploymentId !== candidate)) return fail('ALIAS_CHANGED');
  }
  async function probe(deployment: Deployment) {
    report.stage = 'oidc';
    let oidc: string;
    try { oidc = await developmentToken(environment, async (provider, path, method = 'GET') => {
      if (provider !== 'vercel' || path !== `/v3/env/pull/${config.vercelProjectId}/development` || method !== 'GET') return fail('BINDING');
      return api(path);
    }); } catch { return fail('OIDC'); }
    report.stage = 'probe';
    async function get(path: string): Promise<Response> {
      let url = new URL(path, deployment.url);
      for (let hop = 0; hop < 4; hop++) {
        if (url.origin !== deployment.url) return fail('PROBE');
        let response: Response;
        try { response = await request(url, { method: 'GET', redirect: 'manual', headers: { 'x-vercel-trusted-oidc-idp-token': oidc,
          Accept: path === '/' ? 'text/html' : 'application/json' }, signal: AbortSignal.timeout(30_000) }); }
        catch { throw new SwitchFailure('RESPONSE_UNKNOWN'); }
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location'); await discard(response);
          if (!location) return fail('PROBE');
          url = new URL(location, url); continue;
        }
        if (response.status !== 200) { await discard(response); throw new SwitchFailure('PROBE', Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null); }
        return response;
      }
      return fail('PROBE');
    }
    const home = await (await get('/')).text();
    if (home.length > 2_000_000 || !/<title>Cake<\/title>/.test(home) || !home.includes('Cakeにログイン') || !home.includes('Googleでログイン')
      || home.includes('開発・Preview環境専用のログイン')) return fail('PROBE');
    const session: unknown = await (await get('/api/auth/session')).json();
    if (session !== null) return fail('PROBE');
    const providers = object(await (await get('/api/auth/providers')).json());
    if (!same(Object.keys(providers).sort(), ['google']) || object(providers.google).id !== 'google') return fail('PROBE');
    report.probed = true;
  }
  try {
    if (!/^[a-f0-9]{40}$/.test(context.controlSha) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(context.operation)
      || typeof context.beforeWrite !== 'function') return fail('INVALID_INPUT');
    if (!token?.trim() || /[\r\n]/.test(token) || environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') return fail('CREDENTIALS');
    const initialRouting = await routing(); report.before = summary(initialRouting);
    await project();
    const canonical = initialRouting.aliases.find(row => row.alias === productionAliases[0])!.deploymentId;
    const current = validateDeployment(await api(`/v13/deployments/${canonical}?withGitRepoInfo=true`), canonical, false);
    // targets.production may refer to a failed latest deploy; aliases identify the live deployment.
    if (current.state !== 'READY') return fail('DEPLOYMENT_BINDING');
    const before = await stores(), matches = before.source.filter(row => row.projectId === config.vercelProjectId && row.environments.includes('production'));
    if (before.target.length !== 0 || matches.length !== 1) return fail('NATIVE_CONNECTION');
    const source = matches[0], remaining = source.environments.filter(value => value !== 'production');
    const expectedSource = before.source.flatMap(row => row.id !== source.id ? [row] : remaining.length ? [{ ...row, environments: remaining }] : []);
    await deployments();
    if (!same(await stores(), before)) return fail('NATIVE_CONNECTION');
    unchangedRouting(initialRouting, await routing());
    report.stage = 'source-scope';
    await write('source', `/v1/storage/stores/${productionSourceStore}/connections/${source.id}`, remaining.length ? 'PATCH' : 'DELETE',
      remaining.length ? { envVarEnvironments: remaining } : undefined, false, () => projectEnvironment(config.source));
    report.sourceScopeUpdated = true;
    const actual = await stores();
    if (!same(actual.source, expectedSource) || actual.target.length !== 0) return fail('NATIVE_CONNECTION');
    report.stage = 'target-connect';
    await write('target', `/v1/storage/stores/${config.targetStoreId}/connections`, 'POST', {
      projectId: config.vercelProjectId, envVarEnvironments: ['production'], type: 'integration' });
    report.targetConnected = true;
    const verifyNative = async () => {
      const state = await stores();
      if (!same(state.source, expectedSource) || state.target.length !== 1 || state.target[0].projectId !== config.vercelProjectId
        || !same(state.target[0].environments, ['production']) || state.target[0].prefix !== null && state.target[0].prefix !== '') return fail('NATIVE_CONNECTION');
      return state;
    };
    report.stage = 'native-check'; await verifyNative(); report.nativeVerified = true;
    await projectEnvironment(config.target);
    report.stage = 'create';
    const created = object(await write('deployment', '/v13/deployments?forceNew=1', 'POST', {
      name: 'cake', project: config.vercelProjectId, target: 'production', autoAssignCustomDomains: false,
      gitSource: { type: 'github', repoId: config.repositoryId, ref: 'main', sha: context.controlSha },
      meta: { cakeProductionCutoverOperation: context.operation, cakeProductionCutoverSha: context.controlSha },
    }, true, () => projectEnvironment(config.target)));
    const id = deploymentId(created.id ?? created.uid), readyStarted = now();
    report.stage = 'ready';
    let candidate: Deployment | undefined;
    for (let attempt = 0; attempt < 180 && now() - readyStarted <= 600_000; attempt++) {
      candidate = validateDeployment(await api(`/v13/deployments/${id}?withGitRepoInfo=true`), id, true);
      report.deployment = { id: candidate.id, url: candidate.url, sha: candidate.sha };
      if (candidate.state === 'ERROR' || candidate.state === 'CANCELED') return fail('DEPLOYMENT_FAILED');
      if (candidate.state === 'READY') { report.ready = true; break; }
      await sleep(2_000);
    }
    if (!candidate || !report.ready) return fail('DEPLOYMENT_TIMEOUT');
    await candidateEnvironment(id);
    await deployments(id);
    report.stage = 'aliases-before';
    const stagedRouting = await routing(); report.after = summary(stagedRouting);
    unchangedRouting(initialRouting, stagedRouting, id);
    await probe(candidate);
    await project(); await verifyNative(); await deployments(id);
    report.stage = 'aliases-before'; unchangedRouting(initialRouting, await routing(), id);
    report.stage = 'promote';
    await write('promote', `/v10/projects/${config.vercelProjectId}/promote/${id}`, 'POST', {}, false, async () => {
      await projectEnvironment(config.target); await candidateEnvironment(id);
    });
    report.promoted = true;
    report.stage = 'aliases-after'; const aliasStarted = now();
    let finalRouting: Routing | undefined;
    for (let attempt = 0; attempt < 90 && now() - aliasStarted <= 180_000; attempt++) {
      finalRouting = await routing(); report.after = summary(finalRouting);
      if (finalRouting.production.every(name => finalRouting!.aliases.some(row => row.alias === name && row.deploymentId === id))) {
        unchangedRouting(initialRouting, finalRouting, id, true); report.aliasVerified = true; break;
      }
      // Pending promotion may still serve the previous mappings; no unknown mapping is accepted.
      for (const row of finalRouting.aliases) {
        const previous = initialRouting.aliases.find(beforeAlias => beforeAlias.alias === row.alias);
        if (row.deploymentId !== id && (!previous || previous.deploymentId !== row.deploymentId)) return fail('ALIAS_CHANGED');
      }
      await sleep(2_000);
    }
    if (!report.aliasVerified || !finalRouting) return fail('ALIAS_TIMEOUT');
    report.knownAliasesCurrent = productionAliases.every(name => finalRouting!.aliases.some(row => row.alias === name && row.deploymentId === id));
    report.stage = 'final'; await project(id); await verifyNative(); await deployments(id);
    await projectEnvironment(config.target); await candidateEnvironment(id);
    const final = validateDeployment(await api(`/v13/deployments/${id}?withGitRepoInfo=true`), id, true);
    if (final.state !== 'READY') return fail('DEPLOYMENT_BINDING');
    finalRouting = await routing(); unchangedRouting(initialRouting, finalRouting, id, true); report.after = summary(finalRouting);
    report.knownAliasesCurrent = productionAliases.every(name => finalRouting!.aliases.some(row => row.alias === name && row.deploymentId === id));
    report.stage = 'complete'; report.code = 'OK'; report.success = true;
  } catch (error) {
    const failure = error instanceof SwitchFailure ? error
      : new SwitchFailure(error instanceof ProductionEnvironmentError ? error.code : 'UNEXPECTED');
    report.code = failure.code; report.httpStatus = failure.status; report.responseUnknown = failure.unknown;
  }
  report.ms = Math.max(0, Math.round(now() - started)); return report;
}

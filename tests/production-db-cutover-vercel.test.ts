import assert from 'node:assert/strict';
import test from 'node:test';
import { productionAliases, productionSourceStore, runProductionSwitch, type ProductionSwitchReport } from '../scripts/production-db-cutover-vercel';
import { config } from '../scripts/production-db-migration-provider';

const sha = 'a'.repeat(40), operation = '12345678-1234-4123-8123-123456789abc';
const oldId = 'dpl_OldCanonical', otherId = 'dpl_OldGenerated', newId = 'dpl_NewProduction', previewId = 'dpl_Preview';
const privateText = 'private-provider-password-cookie';
const databaseUrl = (target: 'source' | 'target', pooled = true) => `postgresql://neondb_owner:${privateText}@${target === 'source'
  ? 'ep-ancient-flower-az7oh01x.c-3.ap-southeast-1.aws.neon.tech'
  : 'ep-odd-wildflower-a1kwkl1v.ap-southeast-1.aws.neon.tech'}`.replace(/(?=\.)/, pooled ? '-pooler' : '') + '/neondb?sslmode=require&channel_binding=require';
const productionEnvironment = (target: 'source' | 'target') => ({ DATABASE_URL: databaseUrl(target), AUTH_MODE: 'google', VERCEL_ENV: 'production' });
const productionEnvPath = `/v3/env/pull/${config.vercelProjectId}/production`;
const candidateEnvPath = `/v3/env/pull/${newId}`;
const oidcExpiry = Math.floor(Date.now() / 1000) + 3600;
const oidc = (changes = {}) => `header.${Buffer.from(JSON.stringify({ project_id: config.vercelProjectId, owner_id: config.vercelTeamId,
  environment: 'development', exp: oidcExpiry, ...changes })).toString('base64url')}.signature`;
type Call = { url: URL; method: string; body: Record<string, unknown> | undefined; headers: Headers };
type FixtureOptions = {
  mixed?: boolean; stagedBranch?: boolean; staleKnown?: boolean; secret?: boolean;
  productionReference?: string; canonicalState?: 'READY' | 'ERROR' | 'BUILDING';
  before?: (call: Call, state: State) => Response | undefined;
  after?: (call: Call, state: State, response: Response) => Response | undefined;
};
type State = {
  aliases: { alias: string; deploymentId: string; projectId: string }[];
  domains: { name: string; projectId: string; verified: boolean; gitBranch: string | null; customEnvironmentId: null; redirect: null }[];
  source: { id: string; projectId: string; environments: string[] }[];
  target: { id: string; projectId: string; environments: string[] }[];
  candidate: Record<string, unknown> | null; promoted: boolean; calls: Call[]; callbacks: number; time: number;
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(options: FixtureOptions = {}) {
  const state: State = {
    aliases: productionAliases.map((alias, i) => ({ alias, deploymentId: i === 2 ? otherId : oldId, projectId: config.vercelProjectId })),
    domains: [{ name: productionAliases[0], projectId: config.vercelProjectId, verified: true, gitBranch: null, customEnvironmentId: null, redirect: null }],
    source: [{ id: 'conn_source', projectId: config.vercelProjectId, environments: options.mixed ? ['production','preview','development'] : ['production'] },
      { id: 'conn_unrelated', projectId: 'prj_Other', environments: ['preview'] }],
    target: [], candidate: null, promoted: false, calls: [], callbacks: 0, time: Date.now(),
  };
  state.aliases.push({ alias: 'cake-main-preview-fumin1.vercel.app', deploymentId: previewId, projectId: config.vercelProjectId });
  state.domains.push({ name: 'preview.example.test', projectId: config.vercelProjectId, verified: true, gitBranch: 'cake-main-preview', customEnvironmentId: null, redirect: null });
  const old = { id: oldId, projectId: config.vercelProjectId, ownerId: config.vercelTeamId, target: 'production', readyState: options.canonicalState ?? 'READY',
    url: 'cake-old-production.vercel.app', gitSource: { type: 'github', repoId: config.repositoryId, ref: 'main', sha: 'b'.repeat(40) }, meta: {} };
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const call: Call = { url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, headers: new Headers(init?.headers) };
    state.calls.push(call);
    const intercepted = options.before?.(call, state); if (intercepted) return intercepted;
    let response: Response;
    if (url.origin === 'https://cake-new-production.vercel.app') {
      assert.equal(method, 'GET'); assert.equal(init?.redirect, 'manual');
      assert.equal(call.headers.has('authorization'), false); assert.equal(call.headers.get('x-vercel-trusted-oidc-idp-token'), oidc());
      if (url.pathname === '/') response = new Response('<html><title>Cake</title><section aria-label="Cakeにログイン">Googleでログイン</section></html>');
      else if (url.pathname === '/api/auth/session') response = json(null);
      else if (url.pathname === '/api/auth/providers') response = json({ google: { id: 'google', name: 'Google', type: 'oidc' } });
      else throw new Error(`Unexpected candidate route ${url.pathname}`);
    } else {
      assert.equal(url.origin, 'https://api.vercel.com'); assert.equal(url.searchParams.get('teamId'), config.vercelTeamId);
      assert.equal(call.headers.get('authorization'), 'Bearer test-vercel-token'); assert.equal(init?.redirect, 'error');
      assert.equal(call.headers.has('x-vercel-trusted-oidc-idp-token'), false);
      if (url.pathname === '/v4/aliases' && method === 'GET') response = json({ aliases: state.aliases, pagination: { next: null } });
      else if (url.pathname === `/v9/projects/${config.vercelProjectId}/domains`) response = json({ domains: url.searchParams.get('production') === 'true'
        ? state.domains.filter(row => row.gitBranch === null) : state.domains, pagination: { next: null } });
      else if (url.pathname === `/v9/projects/${config.vercelProjectId}`) response = json({ id: config.vercelProjectId, accountId: config.vercelTeamId,
        link: { type: 'github', repoId: config.repositoryId }, targets: { production: { id: state.promoted ? newId : options.productionReference ?? oldId } }, privateText });
      else if (url.pathname === `/v13/deployments/${oldId}`) { assert.equal(url.searchParams.get('withGitRepoInfo'), 'true'); response = json(old); }
      else if (url.pathname === `/v13/deployments/${newId}`) { assert.equal(url.searchParams.get('withGitRepoInfo'), 'true'); response = json(state.candidate); }
      else if (url.pathname === '/v6/deployments') response = json({ deployments: [old, ...(state.candidate ? [state.candidate] : [])], pagination: { next: null } });
      else if (url.pathname === `/v3/env/pull/${config.vercelProjectId}/development`) response = json({ env: { VERCEL_OIDC_TOKEN: oidc(), DATABASE_URL: privateText } });
      else if (url.pathname === productionEnvPath || url.pathname === `${productionEnvPath}/main`) {
        assert.equal(method, 'GET'); assert.equal(url.searchParams.has('gitBranch'), false);
        response = json({ env: productionEnvironment(state.target.some(row => row.environments.includes('production')) ? 'target' : 'source') });
      } else if (url.pathname === `/v10/projects/${config.vercelProjectId}/env`) {
        assert.equal(method, 'GET'); assert.equal(url.searchParams.get('decrypt'), 'false');
        response = json({ envs: options.secret ? [{ key: 'DATABASE_URL', target: ['production'], type: 'encrypted', visibility: 'secret' }] : [] });
      } else if (url.pathname === candidateEnvPath) {
        assert.equal(method, 'GET'); assert.equal(url.searchParams.has('gitBranch'), false);
        assert.ok(state.candidate); response = json({ env: productionEnvironment('target'), buildEnv: productionEnvironment('target') });
      }
      else if (url.pathname === `/v1/storage/stores/${productionSourceStore}` || url.pathname === `/v1/storage/stores/${config.targetStoreId}`) {
        assert.equal(method, 'GET'); assert.equal(url.searchParams.get('skip-metadata'), 'true');
        const source = url.pathname.endsWith(productionSourceStore), connections = source ? state.source : state.target;
        response = json({ store: { id: source ? productionSourceStore : config.targetStoreId, ownerId: config.vercelTeamId, type: 'integration', status: 'available',
          externalResourceId: source ? config.source.projectId : config.target.projectId, totalConnectedProjects: new Set(connections.map(row => row.projectId)).size,
          projectsMetadata: connections, secrets: { password: privateText } } });
      } else if (url.pathname === `/v1/storage/stores/${productionSourceStore}/connections/conn_source`) {
        if (method === 'DELETE') { assert.equal(call.body, undefined); state.source = state.source.filter(row => row.id !== 'conn_source'); }
        else { assert.equal(method, 'PATCH'); state.source.find(row => row.id === 'conn_source')!.environments = call.body!.envVarEnvironments as string[]; }
        response = json({ privateText });
      } else if (url.pathname === `/v1/storage/stores/${config.targetStoreId}/connections`) {
        assert.equal(method, 'POST'); assert.deepEqual(call.body, { projectId: config.vercelProjectId, envVarEnvironments: ['production'], type: 'integration' });
        state.target.push({ id: 'conn_target', projectId: config.vercelProjectId, environments: ['production'] }); response = json({ privateText }, 201);
      } else if (url.pathname === '/v13/deployments' && method === 'POST') {
        assert.equal(url.searchParams.get('forceNew'), '1');
        assert.deepEqual(call.body, { name: 'cake', project: config.vercelProjectId, target: 'production', autoAssignCustomDomains: false,
          gitSource: { type: 'github', repoId: config.repositoryId, ref: 'main', sha },
          meta: { cakeProductionCutoverOperation: operation, cakeProductionCutoverSha: sha } });
        state.candidate = { id: newId, projectId: config.vercelProjectId, ownerId: config.vercelTeamId, url: 'cake-new-production.vercel.app',
          target: 'production', readyState: 'READY', gitSource: call.body!.gitSource, meta: call.body!.meta };
        if (options.stagedBranch) state.aliases.find(row => row.alias === productionAliases[1])!.deploymentId = newId;
        response = json({ id: newId, privateText }, 201);
      } else if (url.pathname === `/v10/projects/${config.vercelProjectId}/promote/${newId}`) {
        assert.equal(method, 'POST'); assert.deepEqual(call.body, {}); state.promoted = true;
        for (const alias of state.aliases) if (state.domains.some(domain => domain.gitBranch === null && domain.name === alias.alias)
          || productionAliases.includes(alias.alias as typeof productionAliases[number]) && !(options.staleKnown && alias.alias === productionAliases[2])) alias.deploymentId = newId;
        response = new Response(null, { status: 204 });
      } else throw new Error(`Unexpected provider route ${method} ${url.pathname}`);
    }
    return options.after?.(call, state, response) ?? response;
  };
  return { state, run: (beforeWrite = async () => { state.callbacks++; }) => runProductionSwitch({ controlSha: sha, operation, beforeWrite }, {
    environment: { VERCEL_TOKEN: 'test-vercel-token' }, request, sleep: async ms => { state.time += ms; }, now: () => state.time,
  }) };
}
const mutations = (state: State) => state.calls.filter(call => call.method !== 'GET');
function sanitized(report: ProductionSwitchReport) {
  assert.ok(!JSON.stringify(report).includes(privateText)); assert.ok(!JSON.stringify(report).includes('test-vercel-token'));
  assert.ok(!JSON.stringify(report).includes(oidc())); assert.ok(Buffer.byteLength(JSON.stringify(report)) < 4096);
}

test('Production接続だけを切り替えて固定SHA候補を検証し、同じ候補を公開する', async () => {
  const f = fixture(), beforePreview = structuredClone(f.state.source[1]), report = await f.run();
  assert.equal(report.success, true); assert.equal(report.stage, 'complete'); assert.equal(report.code, 'OK');
  assert.equal(report.probed, true); assert.equal(report.promoted, true); assert.equal(report.aliasVerified, true); assert.equal(report.knownAliasesCurrent, true);
  assert.equal(f.state.callbacks, 4); assert.equal(mutations(f.state).length, 4);
  assert.deepEqual(f.state.source, [beforePreview]); assert.deepEqual(report.before!.known.map(row => row[1]), [oldId,oldId,otherId]);
  assert.deepEqual(report.after!.known.map(row => row[1]), [newId,newId,newId]);
  assert.equal(f.state.aliases.find(row => row.alias === 'cake-main-preview-fumin1.vercel.app')!.deploymentId, previewId);
  assert.deepEqual(report.deployment, { id: newId, url: 'https://cake-new-production.vercel.app', sha }); sanitized(report);
});

test('Secretの非公開API値はmetadataとNative接続を照合して既存のbuild・probe・公開へ進む', async () => {
  for (const masked of ['', '[SENSITIVE]']) {
    const f = fixture({ secret: true, after: (call, _state, response) => {
      if (call.url.pathname.startsWith(productionEnvPath)) return json({ env: { ...productionEnvironment('source'), DATABASE_URL: masked } });
      if (call.url.pathname === candidateEnvPath) return json({ env: { DATABASE_URL: masked }, buildEnv: { ...productionEnvironment('target'), DATABASE_URL: masked } });
      return response;
    } });
    const report = await f.run();
    assert.equal(report.success, true); assert.equal(report.nativeVerified, true); assert.equal(report.ready, true);
    assert.equal(report.probed, true); assert.equal(report.promoted, true); assert.equal(mutations(f.state).length, 4); sanitized(report);
  }
});

test('Secretでも読める接続不一致・値の欠落・本番guardの違反は変更前に拒否する', async () => {
  for (const env of [{ ...productionEnvironment('target') }, {}, { ...productionEnvironment('source'), DATABASE_URL: '', AUTH_MODE: 'test' }]) {
    const f = fixture({ secret: true, after: (call, _state, response) => call.url.pathname === productionEnvPath ? json({ env }) : response });
    const report = await f.run(); assert.equal(report.success, false); assert.equal(mutations(f.state).length, 0); sanitized(report);
  }
});

test('失敗した直近Production参照があっても、配信中のREADYなcanonicalを基準に切り替える', async () => {
  const f = fixture({ productionReference: 'dpl_FailedLatest' }), report = await f.run();
  assert.equal(report.success, true); assert.equal(report.promoted, true); assert.equal(report.aliasVerified, true);
  assert.equal(report.before!.known[0][1], oldId); assert.equal(report.after!.known[0][1], newId);
  assert.ok(f.state.calls.some(call => call.url.pathname === `/v13/deployments/${oldId}`));
  assert.equal(mutations(f.state).length, 4); sanitized(report);
});

test('配信中のcanonical自身がREADYでなければProduction接続を変更しない', async () => {
  for (const canonicalState of ['ERROR', 'BUILDING'] as const) {
    const f = fixture({ productionReference: 'dpl_FailedLatest', canonicalState }), report = await f.run();
    assert.equal(report.success, false); assert.equal(report.stage, 'preflight'); assert.equal(report.code, 'DEPLOYMENT_BINDING');
    assert.equal(mutations(f.state).length, 0); assert.equal(report.targetConnected, false); sanitized(report);
  }
});

test('mixed scopeはProductionだけ除き、staged branch aliasの更新と旧generated aliasを区別して報告する', async () => {
  const f = fixture({ mixed: true, stagedBranch: true, staleKnown: true }), report = await f.run();
  assert.equal(report.success, true); assert.equal(report.aliasVerified, true); assert.equal(report.knownAliasesCurrent, false);
  assert.deepEqual(mutations(f.state)[0].body, { envVarEnvironments: ['development','preview'] }); assert.equal(mutations(f.state)[0].method, 'PATCH');
  assert.deepEqual(f.state.source.find(row => row.id === 'conn_source')!.environments, ['development','preview']);
  assert.equal(report.after!.known[2][1], otherId); sanitized(report);
});

test('default Productionとmainの実効値、および候補の解決済みsnapshotを各変更境界で照合する', async () => {
  const f = fixture(), report = await f.run(); assert.equal(report.success, true);
  const envCalls = f.state.calls.filter(call => call.url.pathname.startsWith(productionEnvPath));
  assert.deepEqual(envCalls.map(call => call.url.pathname), Array.from({ length: 5 }, () => [productionEnvPath, `${productionEnvPath}/main`]).flat());
  const sourceWrite = f.state.calls.findIndex(call => call.method !== 'GET');
  assert.equal(f.state.calls[sourceWrite - 2].url.pathname, productionEnvPath);
  assert.equal(f.state.calls[sourceWrite - 1].url.pathname, `${productionEnvPath}/main`);
  const create = f.state.calls.findIndex(call => call.url.pathname === '/v13/deployments' && call.method === 'POST');
  assert.equal(f.state.calls[create - 2].url.pathname, productionEnvPath);
  assert.equal(f.state.calls[create - 1].url.pathname, `${productionEnvPath}/main`);
  const promote = f.state.calls.findIndex(call => call.url.pathname.includes('/promote/'));
  assert.equal(f.state.calls[promote - 1].url.pathname, candidateEnvPath);
  assert.equal(f.state.calls.filter(call => call.url.pathname === candidateEnvPath).length, 3); sanitized(report);
});

test('本番URLのendpoint、DB、role、SSL、接続optionとProduction guardを変更前に厳密照合する', async () => {
  const valid = productionEnvironment('source');
  const invalid: Record<string, unknown>[] = [
    {}, { ...valid, DATABASE_URL: '' }, { ...valid, DATABASE_URL: '[SENSITIVE]' }, { ...valid, DATABASE_URL: 1 },
    { ...valid, DATABASE_URL: databaseUrl('target') },
    { ...valid, DATABASE_URL: valid.DATABASE_URL.replace('neondb_owner:', 'other_role:') },
    { ...valid, DATABASE_URL: valid.DATABASE_URL.replace('/neondb?', '/other_database?') },
    { ...valid, DATABASE_URL: valid.DATABASE_URL.replace('sslmode=require', 'sslmode=disable') },
    { ...valid, DATABASE_URL: valid.DATABASE_URL.replace('?sslmode=require&channel_binding=require', '') },
    { ...valid, DATABASE_URL: `${valid.DATABASE_URL}&sslmode=require` },
    { ...valid, DATABASE_URL: `${valid.DATABASE_URL}&host=other.example.test` },
    { ...valid, DATABASE_URL: `${valid.DATABASE_URL}&options=-c%20search_path%3Dother` },
    { ...valid, DATABASE_URL: `${valid.DATABASE_URL}#override` },
    { ...valid, AUTH_MODE: 'test' }, { ...valid, VERCEL_ENV: 'preview' },
    { ...valid, CAKE_PREVIEW_PHASE: '' }, { ...valid, CAKE_PREVIEW_UNKNOWN: 'present' },
    { ...valid, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  ];
  for (const env of invalid) {
    const f = fixture({ after: (call, _state, response) => call.url.pathname === productionEnvPath ? json({ env }) : response });
    const report = await f.run(); assert.match(report.code, /^ENVIRONMENT_(DEFAULT|MAIN|BUILD|RUNTIME)_/); assert.equal(report.success, false);
    assert.equal(mutations(f.state).length, 0); assert.equal(report.writes.source, 'not-started'); sanitized(report);
  }
  const direct = fixture({ after: (call, state, response) => call.url.pathname.startsWith(productionEnvPath)
    ? json({ env: { ...productionEnvironment(state.target.length ? 'target' : 'source'),
      DATABASE_URL: databaseUrl(state.target.length ? 'target' : 'source', false) } }) : response });
  const report = await direct.run(); assert.equal(report.success, true); sanitized(report);
});

test('mainだけのDB overrideもNative変更前に拒否する', async () => {
  const f = fixture({ after: (call, _state, response) => call.url.pathname === `${productionEnvPath}/main`
    ? json({ env: productionEnvironment('target') }) : response });
  const report = await f.run(); assert.match(report.code, /^ENVIRONMENT_(DEFAULT|MAIN|BUILD|RUNTIME)_/); assert.equal(mutations(f.state).length, 0); sanitized(report);
});

test('Native変更後、候補作成直前、公開直前、完了時の実効URL driftでは後続書込みを止める', async () => {
  for (const phase of ['native','create','promote','final'] as const) {
    const f = fixture({ after: (call, state, response) => {
      if (!call.url.pathname.startsWith(productionEnvPath)) return response;
      const drift = phase === 'native' ? state.target.length > 0 : phase === 'create' ? state.callbacks === 3
        : phase === 'promote' ? state.callbacks === 4 && !state.promoted : state.promoted;
      return drift ? json({ env: productionEnvironment('source') }) : response;
    } });
    const report = await f.run(); assert.match(report.code, /^ENVIRONMENT_(DEFAULT|MAIN|BUILD|RUNTIME)_/); assert.equal(report.success, false);
    assert.equal(mutations(f.state).length, phase === 'native' || phase === 'create' ? 2 : phase === 'promote' ? 3 : 4);
    assert.equal(report.promoted, phase === 'final'); sanitized(report);
  }
});

test('候補buildEnvは必須とし、欠落・伏せ字・旧DB・テスト認証snapshotを公開しない', async () => {
  for (const buildEnv of [undefined, {}, { DATABASE_URL: '' }, { DATABASE_URL: '[SENSITIVE]' }, productionEnvironment('source'),
    { ...productionEnvironment('target'), AUTH_MODE: 'test' }, { ...productionEnvironment('target'), CAKE_PREVIEW_KIND: 'main' }]) {
    const f = fixture({ after: (call, _state, response) => call.url.pathname === candidateEnvPath
      ? json({ env: productionEnvironment('target'), buildEnv }) : response });
    const report = await f.run(); assert.match(report.code, /^ENVIRONMENT_(DEFAULT|MAIN|BUILD|RUNTIME)_/); assert.equal(report.ready, true); assert.equal(report.promoted, false);
    assert.equal(mutations(f.state).length, 3); sanitized(report);
  }
});

test('候補runtime envが無し・暗号鍵のみでもbuildEnvを検証し、実在するruntime URLの不一致は拒否する', async () => {
  for (const env of [undefined, {}, { VERCEL_ENV_ENCRYPTION_KEY: privateText }]) {
    const f = fixture({ after: (call, _state, response) => call.url.pathname === candidateEnvPath
      ? json({ env, buildEnv: productionEnvironment('target') }) : response });
    const report = await f.run(); assert.equal(report.success, true); sanitized(report);
  }
  for (const env of [productionEnvironment('source'), { ...productionEnvironment('target'), DATABASE_URL: '[SENSITIVE]' },
    { AUTH_MODE: 'test' }, { CAKE_PREVIEW_PHASE: 'application' }]) {
    const f = fixture({ after: (call, _state, response) => call.url.pathname === candidateEnvPath
      ? json({ env, buildEnv: productionEnvironment('target') }) : response });
    const report = await f.run(); assert.match(report.code, /^ENVIRONMENT_(DEFAULT|MAIN|BUILD|RUNTIME)_/); assert.equal(report.promoted, false);
    assert.equal(mutations(f.state).length, 3); sanitized(report);
  }
});

test('候補snapshotの公開直前と完了時の再照合も省略しない', async () => {
  for (const phase of ['promote','final'] as const) {
    const f = fixture({ after: (call, state, response) => call.url.pathname === candidateEnvPath
      && (phase === 'final' ? state.promoted : state.callbacks === 4 && !state.promoted)
      ? json({ buildEnv: productionEnvironment('source') }) : response });
    const report = await f.run(); assert.match(report.code, /^ENVIRONMENT_(DEFAULT|MAIN|BUILD|RUNTIME)_/); assert.equal(report.success, false);
    assert.equal(report.promoted, phase === 'final'); assert.equal(mutations(f.state).length, phase === 'final' ? 4 : 3); sanitized(report);
  }
});

test('ownerIdを省略する現行Deployment viewのteam.idを照合し、矛盾するteamは拒否する', async () => {
  for (const mismatch of [false,true]) {
    const f = fixture({ before: (call, state) => {
      if (call.url.pathname !== `/v13/deployments/${newId}` || !state.candidate) return undefined;
      const value = { ...state.candidate, ownerId: undefined, team: { id: mismatch ? 'team_Other' : config.vercelTeamId } };
      return json(value);
    } });
    const report = await f.run(); assert.equal(report.success, !mismatch);
    if (mismatch) { assert.equal(report.code, 'DEPLOYMENT_BINDING'); assert.equal(report.promoted, false); }
    sanitized(report);
  }
});

test('全configured Production domainを公開対象に含め、Preview domainの設定を保持する', async () => {
  const f = fixture(); f.state.domains.push({ ...f.state.domains[0], name: 'cake.example.test' });
  f.state.aliases.push({ alias: 'cake.example.test', deploymentId: oldId, projectId: config.vercelProjectId });
  const report = await f.run(); assert.equal(report.success, true); assert.equal(report.before!.domains, 3);
  assert.deepEqual(report.after!.production, ['cake-omega-gilt.vercel.app','cake.example.test']);
  assert.equal(f.state.aliases.find(row => row.alias === 'cake.example.test')!.deploymentId, newId); sanitized(report);
});

test('provider所属、接続の曖昧さ、alias重複、pagination不備は変更前に拒否する', async () => {
  const cases: { modify: FixtureOptions['after']; code: string }[] = [
    { modify: (call, _state, response) => call.url.pathname === `/v9/projects/${config.vercelProjectId}` ? json({ id: config.vercelProjectId,
      accountId: 'team_Other', link: { type: 'github', repoId: config.repositoryId } }) : response, code: 'BINDING' },
    { modify: (call, state, response) => call.url.pathname.endsWith(productionSourceStore) ? json({ store: { id: productionSourceStore, ownerId: config.vercelTeamId,
      type: 'integration', status: 'available', externalResourceId: 'wrong-project', projectsMetadata: state.source, totalConnectedProjects: 2 } }) : response, code: 'BINDING' },
    { modify: (call, state, response) => call.url.pathname === '/v4/aliases' ? json({ aliases: [...state.aliases,state.aliases[0]], pagination: { next: null } }) : response, code: 'INCOMPLETE_INVENTORY' },
    { modify: (call, state, response) => call.url.pathname === '/v4/aliases' ? json({ aliases: state.aliases, pagination: { next: 10 } }) : response, code: 'INCOMPLETE_INVENTORY' },
  ];
  for (const item of cases) { const f = fixture({ after: item.modify }), report = await f.run(); assert.equal(report.success, false); assert.equal(report.code, item.code);
    assert.equal(mutations(f.state).length, 0); sanitized(report); }
  for (const mode of ['target-connected','source-duplicate','missing-alias'] as const) {
    const f = fixture();
    if (mode === 'target-connected') f.state.target.push({ id: 'conn_existing', projectId: 'prj_Other', environments: ['development'] });
    if (mode === 'source-duplicate') f.state.source.push({ id: 'conn_duplicate', projectId: config.vercelProjectId, environments: ['production'] });
    if (mode === 'missing-alias') f.state.aliases.shift();
    const report = await f.run(); assert.equal(report.success, false); assert.equal(mutations(f.state).length, 0); sanitized(report);
  }
});

test('各書込み直前のbinding callback失敗では後続のmutationを行わず、例外本文を公開しない', async () => {
  for (let denied = 1; denied <= 4; denied++) {
    const f = fixture(); const report = await f.run(async () => { if (++f.state.callbacks === denied) throw new Error(privateText); });
    assert.equal(report.success, false); assert.equal(report.code, 'BEFORE_WRITE'); assert.equal(mutations(f.state).length, denied - 1); sanitized(report);
  }
});

test('mutationが処理済みでも応答不明なら再実行も自動復元も行わない', async () => {
  for (let failAt = 1; failAt <= 4; failAt++) {
    const f = fixture({ after: (call, state, response) => { if (call.method !== 'GET' && mutations(state).length === failAt) throw new Error(privateText); return response; } });
    const report = await f.run(); assert.equal(report.success, false); assert.equal(report.responseUnknown, true); assert.equal(report.code, 'RESPONSE_UNKNOWN');
    assert.equal(mutations(f.state).length, failAt); assert.equal(Object.values(report.writes).filter(value => value === 'attempted').length, 1); sanitized(report);
  }
});

test('mutationの503もretryせず、固定codeとHTTP statusだけを返す', async () => {
  const f = fixture({ before: (call) => call.method !== 'GET' ? json({ error: { message: privateText } }, 503) : undefined });
  const report = await f.run(); assert.equal(report.code, 'HTTP'); assert.equal(report.httpStatus, 503); assert.equal(report.responseUnknown, false);
  assert.equal(mutations(f.state).length, 1); sanitized(report);
});

test('既存operation、重複Deployment、候補のSHA不一致とbuild失敗を公開しない', async () => {
  for (const mode of ['existing-operation','duplicate','wrong-sha','wrong-owner','failed'] as const) {
    const f = fixture({ after: (call, state, response) => {
      if (mode === 'existing-operation' && call.url.pathname === '/v6/deployments' && !state.candidate) return json({ deployments: [{ id: 'dpl_Existing', target: 'production',
        meta: { cakeProductionCutoverOperation: operation, cakeProductionCutoverSha: sha } }], pagination: { next: null } });
      if (!state.candidate) return response;
      if (mode === 'duplicate' && call.url.pathname === '/v6/deployments') return json({ deployments: [state.candidate,{ ...state.candidate, id: 'dpl_Duplicate' }], pagination: { next: null } });
      if (call.url.pathname !== `/v13/deployments/${newId}`) return response;
      if (mode === 'wrong-sha') return json({ ...state.candidate, gitSource: { ...(state.candidate.gitSource as object), sha: 'c'.repeat(40) } });
      if (mode === 'wrong-owner') return json({ ...state.candidate, ownerId: 'team_Other' });
      if (mode === 'failed') return json({ ...state.candidate, readyState: 'ERROR', errorMessage: privateText });
      return response;
    } });
    const report = await f.run(); assert.equal(report.success, false); assert.equal(report.promoted, false);
    assert.equal(report.writes.promote, 'not-started'); assert.equal(mutations(f.state).length, mode === 'existing-operation' ? 0 : 3); sanitized(report);
  }
});

test('canonicalの先行公開と不明なbranch aliasへの移動を検出する', async () => {
  for (const mode of ['canonical','branch','unrelated'] as const) {
    const f = fixture({ after: (call, state, response) => {
      if (state.candidate && !state.promoted && call.url.pathname === '/v4/aliases') {
        const aliases = structuredClone(state.aliases), name = mode === 'canonical' ? productionAliases[0] : mode === 'branch' ? productionAliases[1] : 'cake-main-preview-fumin1.vercel.app';
        aliases.find(row => row.alias === name)!.deploymentId = mode === 'canonical' ? newId : 'dpl_Unexpected';
        return json({ aliases, pagination: { next: null } });
      }
      return response;
    } });
    const report = await f.run(); assert.equal(report.success, false); assert.equal(report.code, 'ALIAS_CHANGED'); assert.equal(report.promoted, false); sanitized(report);
  }
});

test('Googleだけのprovider、未認証session、login画面が揃わなければpromoteしない', async () => {
  for (const mode of ['test-login','session','home','oidc'] as const) {
    const f = fixture({ after: (call, _state, response) => {
      if (mode === 'oidc' && call.url.pathname.endsWith('/development')) return json({ env: { VERCEL_OIDC_TOKEN: oidc({ environment: 'production' }) } });
      if (call.url.origin !== 'https://cake-new-production.vercel.app') return response;
      if (mode === 'test-login' && call.url.pathname === '/api/auth/providers') return json({ google: { id: 'google' }, 'test-login': { id: 'test-login' } });
      if (mode === 'session' && call.url.pathname === '/api/auth/session') return json({ user: { id: privateText } });
      if (mode === 'home' && call.url.pathname === '/') return new Response('<title>Cake</title>開発・Preview環境専用のログイン');
      return response;
    } });
    const report = await f.run(); assert.equal(report.success, false); assert.equal(report.probed, false); assert.equal(report.promoted, false); sanitized(report);
  }
});

test('OIDC付きrequestのredirectは候補origin内だけで扱う', async () => {
  const f = fixture({ after: (call, _state, response) => call.url.origin === 'https://cake-new-production.vercel.app' && call.url.pathname === '/'
    ? new Response(null, { status: 302, headers: { location: `https://external.example.test/${privateText}` } }) : response });
  const report = await f.run(); assert.equal(report.code, 'PROBE'); assert.equal(report.promoted, false);
  assert.equal(f.state.calls.some(call => call.url.hostname === 'external.example.test'), false); sanitized(report);
});

test('READYとalias反映の待機は有界で、mutationを繰り返さない', async () => {
  for (const mode of ['build','alias'] as const) {
    const f = fixture({ after: (call, state, response) => {
      if (mode === 'build' && call.url.pathname === `/v13/deployments/${newId}`) return json({ ...state.candidate, readyState: 'BUILDING' });
      if (mode === 'alias' && state.promoted && call.url.pathname === '/v4/aliases') return json({ aliases: state.aliases.map(row => row.alias === productionAliases[0]
        ? { ...row, deploymentId: oldId } : row), pagination: { next: null } });
      return response;
    } });
    const report = await f.run(); assert.equal(report.success, false); assert.equal(report.code, mode === 'build' ? 'DEPLOYMENT_TIMEOUT' : 'ALIAS_TIMEOUT');
    assert.equal(mutations(f.state).length, mode === 'build' ? 3 : 4); assert.ok(f.state.calls.length < 400); sanitized(report);
  }
});

test('公開後のNative driftは公開済み状態を残した失敗として返し、追加操作しない', async () => {
  const f = fixture({ after: (call, state, response) => {
    if (state.promoted && call.url.pathname.endsWith(config.targetStoreId)) return json({ store: { id: config.targetStoreId, ownerId: config.vercelTeamId, type: 'integration',
      status: 'available', externalResourceId: config.target.projectId, totalConnectedProjects: 0, projectsMetadata: [] } });
    return response;
  } });
  const report = await f.run(); assert.equal(report.success, false); assert.equal(report.stage, 'final'); assert.equal(report.code, 'NATIVE_CONNECTION');
  assert.equal(report.promoted, true); assert.equal(report.aliasVerified, true); assert.equal(mutations(f.state).length, 4); sanitized(report);
});

test('不正な入力と資格情報はproviderへ渡さない', async () => {
  let called = false;
  const request: typeof fetch = async () => { called = true; throw new Error(privateText); };
  const invalid = await runProductionSwitch({ controlSha: 'bad', operation, beforeWrite: async () => {} }, { request, environment: { VERCEL_TOKEN: 'fake' } });
  assert.equal(invalid.code, 'INVALID_INPUT');
  const missing = await runProductionSwitch({ controlSha: sha, operation, beforeWrite: async () => {} }, { request, environment: {} });
  assert.equal(missing.code, 'CREDENTIALS'); assert.equal(called, false); sanitized(invalid); sanitized(missing);
});

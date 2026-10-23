import assert from 'node:assert/strict';
import test from 'node:test';
import { productionAliases, productionSourceStore, runProductionSwitch, type ProductionSwitchReport } from '../scripts/production-db-cutover-vercel';
import { config } from '../scripts/production-db-migration-provider';

const sha = 'a'.repeat(40), operation = '12345678-1234-4123-8123-123456789abc';
const oldId = 'dpl_OldCanonical', otherId = 'dpl_OldGenerated', newId = 'dpl_NewProduction', previewId = 'dpl_Preview';
const privateText = 'private-provider-password-cookie';
const oidc = (changes = {}) => `header.${Buffer.from(JSON.stringify({ project_id: config.vercelProjectId, owner_id: config.vercelTeamId,
  environment: 'development', exp: Math.floor(Date.now() / 1000) + 3600, ...changes })).toString('base64url')}.signature`;
type Call = { url: URL; method: string; body: Record<string, unknown> | undefined; headers: Headers };
type FixtureOptions = {
  mixed?: boolean; stagedBranch?: boolean; staleKnown?: boolean;
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
  const old = { id: oldId, projectId: config.vercelProjectId, ownerId: config.vercelTeamId, target: 'production', readyState: 'READY',
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
        link: { type: 'github', repoId: config.repositoryId }, targets: { production: { id: state.promoted ? newId : oldId } }, privateText });
      else if (url.pathname === `/v13/deployments/${oldId}`) { assert.equal(url.searchParams.get('withGitRepoInfo'), 'true'); response = json(old); }
      else if (url.pathname === `/v13/deployments/${newId}`) { assert.equal(url.searchParams.get('withGitRepoInfo'), 'true'); response = json(state.candidate); }
      else if (url.pathname === '/v6/deployments') response = json({ deployments: [old, ...(state.candidate ? [state.candidate] : [])], pagination: { next: null } });
      else if (url.pathname === `/v3/env/pull/${config.vercelProjectId}/development`) response = json({ env: { VERCEL_OIDC_TOKEN: oidc(), DATABASE_URL: privateText } });
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

test('mixed scopeはProductionだけ除き、staged branch aliasの更新と旧generated aliasを区別して報告する', async () => {
  const f = fixture({ mixed: true, stagedBranch: true, staleKnown: true }), report = await f.run();
  assert.equal(report.success, true); assert.equal(report.aliasVerified, true); assert.equal(report.knownAliasesCurrent, false);
  assert.deepEqual(mutations(f.state)[0].body, { envVarEnvironments: ['development','preview'] }); assert.equal(mutations(f.state)[0].method, 'PATCH');
  assert.deepEqual(f.state.source.find(row => row.id === 'conn_source')!.environments, ['development','preview']);
  assert.equal(report.after!.known[2][1], otherId); sanitized(report);
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

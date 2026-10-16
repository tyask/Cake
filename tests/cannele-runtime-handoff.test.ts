import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeHandoff, runtimeHandoffMarker, RuntimeHandoffError, safeHandoffDiagnostic, type HandoffDiagnostic } from '../scripts/cannele-runtime-handoff';

const projectId = 'prj_EgVvFUE4gXVZnMTuw69lQ3mIGYVN';
const teamId = 'team_D1Mcx2TdFWPKcypfu8KzNMub';
const roleName = 'cannele_fixture_runtime';
const bootstrapVercelToken = 'fixture-vercel-bootstrap-token';
const vercelToken = 'fixture-vercel-runtime-token';
const neonApiKey = 'fixture-neon-runtime-key';
const databaseHost = 'ep-fixture.us-east-1.aws.neon.tech';
const databaseUrl = `postgresql://${roleName}:fixture-password@${databaseHost}/neondb?sslmode=require`;
const privateDiagnostic = 'FIXTURE_PRIVATE_PROVIDER_DIAGNOSTIC';
const context = { instanceId: '11111111-1111-4111-8111-111111111111', repositoryId: 1318171856,
  bindingDigest: 'b'.repeat(64), writerEpoch: 1, schemaVersion: 4, schemaChecksum: 'a'.repeat(64) };
const keys = ['CANNELE_REGISTRY_DATABASE_URL', 'CANNELE_REGISTRY_DATABASE_HOST', 'CANNELE_VERCEL_TOKEN', 'CANNELE_NEON_API_KEY'];
const publicKeys = ['CANNELE_API_ORIGIN', 'CANNELE_API_MUTATIONS_ENABLED', 'CANNELE_PROVIDER_OPERATIONS_ENABLED', 'CANNELE_BINDING_JSON'];
const expectedValues: Record<string, string> = { CANNELE_REGISTRY_DATABASE_URL: databaseUrl, CANNELE_REGISTRY_DATABASE_HOST: databaseHost,
  CANNELE_VERCEL_TOKEN: vercelToken, CANNELE_NEON_API_KEY: neonApiKey };
type Env = { id: string; key: string; type: string; target: string[] | string; value?: unknown; comment?: string;
  gitBranch?: string | null; customEnvironmentIds?: string[]; configurationId?: string | null; system?: boolean; visibility?: string };
type Call = { url: URL; method: string; body?: Record<string, unknown> };

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function safeFailure(code?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RuntimeHandoffError);
    assert.match(error.code, /^RUNTIME_HANDOFF_[A-Z_]+$/);
    if (code) assert.equal(error.code, `RUNTIME_HANDOFF_${code}`);
    assert.equal(error.cause, undefined);
    for (const privateValue of [privateDiagnostic, databaseUrl, databaseHost, bootstrapVercelToken, vercelToken, neonApiKey, 'fixture-password']) {
      assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`.includes(privateValue), false);
    }
    return true;
  };
}

function diagnosed(code: string, expected: HandoffDiagnostic) {
  return (error: unknown): boolean => {
    safeFailure(code)(error); assert.ok(error instanceof RuntimeHandoffError);
    assert.deepEqual(error.diagnostic, expected); return true;
  };
}

function fixture() {
  const marker = runtimeHandoffMarker(context, roleName);
  const envs: Env[] = [
    { id: 'env_origin', key: 'CANNELE_API_ORIGIN', type: 'encrypted', visibility: 'config', target: ['production'], value: 'https://cannele-cake.vercel.app' },
    { id: 'env_mutations', key: 'CANNELE_API_MUTATIONS_ENABLED', type: 'encrypted', visibility: 'config', target: ['production'], value: 'false' },
    { id: 'env_provider', key: 'CANNELE_PROVIDER_OPERATIONS_ENABLED', type: 'encrypted', visibility: 'config', target: ['production'], value: 'false' },
    { id: 'env_binding', key: 'CANNELE_BINDING_JSON', type: 'encrypted', visibility: 'config', target: ['production'], value: JSON.stringify({
      instanceId: context.instanceId, bindingDigest: context.bindingDigest, writerEpoch: context.writerEpoch,
      repository: { id: context.repositoryId, fullName: 'tyask/Cake' },
    }) },
    ...['CANNELE_GITHUB_APP_PRIVATE_KEY', 'CANNELE_GITHUB_OAUTH_CLIENT_SECRET', 'CANNELE_AUTH_ENCRYPTION_KEY']
      .map((key, index) => ({ id: `env_auth_${index}`, key, type: 'sensitive', target: ['production'], value: privateDiagnostic })),
  ];
  const calls: Call[] = []; const values = new Map<string, string>(); let sequence = 0;
  const state = {
    envs, calls, values, marker,
    before: undefined as ((call: Call, init: RequestInit | undefined) => Response | undefined) | undefined,
    afterWrite: undefined as ((call: Call, row: Env) => void) | undefined,
    project: { id: projectId, name: 'cannele-cake', accountId: teamId },
    metadata: undefined as (() => unknown) | undefined,
    own(key: string): Env { return { id: `env_owned_${++sequence}`, key, type: 'sensitive', target: ['production'], comment: marker }; },
    factory: () => createRuntimeHandoff({ bootstrapVercelToken, vercelToken, neonApiKey, context, roleName, request }),
  };
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const call = { url, method, ...(body ? { body } : {}) }; calls.push(call);
    assert.equal(url.origin, 'https://api.vercel.com'); assert.equal(url.searchParams.get('teamId'), teamId);
    assert.equal(init?.redirect, 'manual'); assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${bootstrapVercelToken}`);
    assert.ok(![databaseUrl, bootstrapVercelToken, vercelToken, neonApiKey].some(value => url.href.includes(value)));
    const overridden = state.before?.(call, init); if (overridden) return overridden;
    if (method === 'GET' && url.pathname === `/v9/projects/${projectId}`) return response(state.project);
    if (method === 'GET' && url.pathname === `/v10/projects/${projectId}/env`) {
      assert.equal(url.searchParams.get('decrypt'), 'false');
      return response(state.metadata?.() ?? { envs: envs.map(row => {
        const copy = { ...row }; if (copy.type === 'sensitive') delete copy.value;
        else if (copy.type === 'encrypted') copy.value = 'OPAQUE_PUBLIC_CONFIG_CIPHERTEXT';
        return copy;
      }), pagination: { count: envs.length, next: null, prev: null }, hiddenProductionEnvCount: 0 });
    }
    if (method === 'GET' && url.pathname.startsWith(`/v1/projects/${projectId}/env/`)) {
      const row = envs.find(value => value.id === url.pathname.split('/').at(-1)); assert.ok(row);
      assert.ok(publicKeys.includes(row.key), 'Only validated public configuration IDs may be decrypted.');
      assert.notEqual(row.type, 'sensitive'); return response(row);
    }
    if (method === 'POST' && url.pathname === `/v10/projects/${projectId}/env`) {
      assert.ok(body); const key = String(body.key);
      if (envs.some(row => row.key === key)) return response({ error: { message: privateDiagnostic } }, 409);
      const row: Env = { id: `env_created_${++sequence}`, key, type: String(body.type), target: body.target as string[], comment: String(body.comment) };
      envs.push(row); values.set(key, String(body.value)); state.afterWrite?.(call, row);
      return response({ created: row, failed: [] });
    }
    if (method === 'PATCH' && url.pathname.startsWith(`/v9/projects/${projectId}/env/`)) {
      assert.ok(body); const row = envs.find(value => value.id === url.pathname.split('/').at(-1)); assert.ok(row);
      if (body.key !== undefined) assert.equal(body.key, row.key);
      if (body.type !== undefined) row.type = String(body.type);
      if (body.target !== undefined) row.target = body.target as string[];
      if (body.comment !== undefined) row.comment = String(body.comment);
      values.set(row.key, String(body.value)); state.afterWrite?.(call, row);
      return response(row);
    }
    throw new Error('Unexpected fixture handoff request.');
  };
  return state;
}

function writes(calls: Call[]): Call[] { return calls.filter(call => call.method === 'POST' || call.method === 'PATCH'); }
function assertPublished(f: ReturnType<typeof fixture>): void {
  const rows = f.envs.filter(row => keys.includes(row.key));
  assert.equal(rows.length, 4); assert.equal(new Set(rows.map(row => row.key)).size, 4);
  for (const row of rows) {
    assert.equal(row.type, 'sensitive'); assert.deepEqual(row.target, ['production']); assert.equal(row.comment, f.marker);
    assert.equal(f.values.get(row.key), expectedValues[row.key]);
  }
  for (const call of writes(f.calls)) {
    assert.ok(call.body); assert.equal(call.body.type, 'sensitive'); assert.deepEqual(call.body.target, ['production']);
    assert.equal(call.body.comment, f.marker); assert.ok(Object.values(expectedValues).includes(String(call.body.value)));
    assert.ok(keys.includes(String(call.body.key)));
    assert.equal(JSON.stringify(call.body).includes(bootstrapVercelToken), false);
  }
}

test('runtime handoff preflights the fixed disabled API project and creates all four Production sensitive values', async () => {
  const f = fixture(); const handoff = f.factory(); await handoff.preflight();
  assert.equal(writes(f.calls).length, 0); await handoff.publish({ databaseUrl, databaseHost });
  assertPublished(f); assert.equal(f.calls.filter(call => call.method === 'POST').length, 4);
  const firstWrite = f.calls.findIndex(call => call.method !== 'GET'); assert.ok(firstWrite >= 2);
  assert.ok(f.calls.slice(0, firstWrite).some(call => call.url.pathname === `/v9/projects/${projectId}`));
  assert.ok(f.calls.slice(0, firstWrite).some(call => call.url.pathname === `/v10/projects/${projectId}/env`));
  assert.deepEqual(new Set(f.calls.filter(call => call.url.pathname.startsWith(`/v1/projects/${projectId}/env/`))
    .map(call => call.url.pathname.split('/').at(-1))), new Set(['env_origin', 'env_mutations', 'env_provider', 'env_binding']));
  assert.ok(f.calls.every(call => !call.url.searchParams.has('decrypt') || call.url.searchParams.get('decrypt') === 'false'));
});

test('publication requires preflight and rejects unsafe runtime connection inputs before any secret write', async () => {
  const fresh = fixture(); await assert.rejects(fresh.factory().publish({ databaseUrl, databaseHost }), safeFailure('PREFLIGHT_REQUIRED'));
  assert.equal(writes(fresh.calls).length, 0);
  for (const change of [
    { databaseUrl: databaseUrl.replace(roleName, 'other_role') },
    { databaseUrl: databaseUrl.replace(':fixture-password', '') },
    { databaseUrl: databaseUrl.replace('/neondb?', '/other?') },
    { databaseUrl: databaseUrl.replace('sslmode=require', 'sslmode=disable') },
    { databaseUrl: `${databaseUrl}&options=private` },
    { databaseUrl: `${databaseUrl}&sslmode=verify-full` },
    { databaseUrl: `${databaseUrl}#private` },
    { databaseHost: 'ep-other.us-east-1.aws.neon.tech' },
  ]) {
    const f = fixture(); const handoff = f.factory(); await handoff.preflight();
    await assert.rejects(handoff.publish({ databaseUrl, databaseHost, ...change }), safeFailure('INPUT_INVALID'));
    assert.equal(writes(f.calls).length, 0);
  }
});

test('bootstrap authorization is required independently of the runtime token and invalid credentials stop before requests', () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; throw new Error(privateDiagnostic); };
  const valid = { bootstrapVercelToken, vercelToken, neonApiKey, context, roleName, request };
  type Options = Parameters<typeof createRuntimeHandoff>[0];
  for (const value of [undefined, null, false, true, 0, '', ' ', ' token ', '\n']) {
    assert.throws(() => createRuntimeHandoff({ ...valid, bootstrapVercelToken: value } as unknown as Options), safeFailure('INPUT_INVALID'));
  }
  const missing = { ...valid } as Record<string, unknown>; delete missing.bootstrapVercelToken;
  assert.throws(() => createRuntimeHandoff(missing as unknown as Options), safeFailure('INPUT_INVALID'));
  for (const value of [undefined, null, false, '', ' ']) {
    assert.throws(() => createRuntimeHandoff({ ...valid, vercelToken: value } as unknown as Options), safeFailure('INPUT_INVALID'));
  }
  assert.equal(calls, 0);
});

test('a new factory can resume a partial handoff using owned rows and fresh metadata without creating duplicates', async () => {
  const f = fixture();
  f.before = call => {
    if (call.method === 'POST' && f.envs.filter(row => keys.includes(row.key)).length >= 2) return response({ error: { message: privateDiagnostic } }, 503);
    return undefined;
  };
  const first = f.factory(); await first.preflight();
  await assert.rejects(first.publish({ databaseUrl, databaseHost }), safeFailure('WRITE_UNKNOWN'));
  assert.equal(f.envs.filter(row => keys.includes(row.key)).length, 2);
  f.before = undefined; const resumed = f.factory(); await resumed.preflight(); const start = f.calls.length;
  await resumed.publish({ databaseUrl, databaseHost }); assertPublished(f);
  assert.ok(f.calls.slice(start).some(call => call.method === 'PATCH'));
});

test('a lost POST receipt is resolved by owned metadata and an identical-value PATCH', async () => {
  const f = fixture(); let lost: Call | undefined;
  f.afterWrite = call => { if (!lost && call.method === 'POST') { lost = call; throw new Error(privateDiagnostic); } };
  const handoff = f.factory(); await handoff.preflight(); await handoff.publish({ databaseUrl, databaseHost });
  assertPublished(f); assert.ok(lost?.body); const key = String(lost.body.key);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.body?.key === key).length, 1);
  const lostIndex = f.calls.indexOf(lost);
  const recovered = f.calls.findIndex((call, index) => index > lostIndex && call.method === 'PATCH' && call.body?.value === lost!.body!.value);
  assert.ok(recovered > lostIndex);
  assert.ok(f.calls.slice(lostIndex + 1, recovered).some(call => call.method === 'GET' && call.url.pathname.endsWith('/env')));
});

test('an uncommitted lost POST is retried only after metadata proves absence, and repeated failures are bounded', async () => {
  const f = fixture(); let lost: Call | undefined;
  f.before = call => { if (!lost && call.method === 'POST') { lost = call; throw new Error(privateDiagnostic); } return undefined; };
  const handoff = f.factory(); await handoff.preflight(); await handoff.publish({ databaseUrl, databaseHost });
  assertPublished(f); assert.ok(lost?.body);
  const attempts = f.calls.filter(call => call.method === 'POST' && call.body?.key === lost!.body!.key);
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0]!.body, attempts[1]!.body);
  assert.ok(f.calls.slice(f.calls.indexOf(attempts[0]!) + 1, f.calls.indexOf(attempts[1]!))
    .some(call => call.method === 'GET' && call.url.pathname.endsWith('/env')));
  const blocked = fixture(); blocked.before = call => call.method === 'POST' ? response({ error: { message: privateDiagnostic } }, 403) : undefined;
  const denied = blocked.factory(); await denied.preflight();
  await assert.rejects(denied.publish({ databaseUrl, databaseHost }), safeFailure('WRITE_UNKNOWN'));
  const deniedWrites = writes(blocked.calls); assert.ok(deniedWrites.length > 0 && deniedWrites.length <= 3);
  assert.equal(blocked.envs.filter(row => keys.includes(row.key)).length, 0);
});

test('a lost PATCH response is retried with the same secret only after a fresh metadata read', async () => {
  const f = fixture(); for (const key of keys) f.envs.push(f.own(key)); let lost: Call | undefined;
  f.afterWrite = call => { if (!lost && call.method === 'PATCH') { lost = call; throw new Error(privateDiagnostic); } };
  const handoff = f.factory(); await handoff.preflight(); await handoff.publish({ databaseUrl, databaseHost });
  assertPublished(f); assert.ok(lost?.body); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  const index = f.calls.indexOf(lost);
  const retry = f.calls.findIndex((call, next) => next > index && call.method === 'PATCH' && call.url.pathname === lost!.url.pathname);
  assert.ok(retry > index); assert.deepEqual(f.calls[retry]!.body, lost.body);
  assert.ok(f.calls.slice(index + 1, retry).some(call => call.method === 'GET' && call.url.pathname.endsWith('/env')));
});

test('queued PATCH responses cannot acknowledge secret values or advance to another key', async () => {
  const f = fixture(); for (const key of keys) f.envs.push(f.own(key));
  f.before = call => call.method === 'PATCH' ? response({ state: 'QUEUED', jobId: 'fixture-async-job', value: privateDiagnostic }, 202) : undefined;
  const handoff = f.factory(); await handoff.preflight();
  await assert.rejects(handoff.publish({ databaseUrl, databaseHost }), diagnosed('WRITE_UNKNOWN', {
    method: 'PATCH', endpoint: 'SECRET_UPDATE', status: 202, reason: 'HTTP',
  }));
  const attempts = writes(f.calls); assert.equal(attempts.length, 3);
  assert.ok(attempts.every(call => call.method === 'PATCH' && call.url.pathname === attempts[0]!.url.pathname));
  assert.ok(attempts.every(call => call.body?.value === attempts[0]!.body!.value));
  const firstWrite = f.calls.indexOf(attempts[0]!);
  assert.equal(f.calls.slice(firstWrite + 1).some(call => call.url.pathname.startsWith('/v1/')), false);
  assert.equal(f.values.size, 0);
});

test('foreign, ambiguous or externally managed target variables prevent any environment write', async () => {
  for (const change of [
    { comment: 'foreign-owner' }, { type: 'plain' }, { target: ['production', 'preview'] }, { target: ['preview'] },
    { gitBranch: 'codex/foreign' }, { customEnvironmentIds: ['env_custom'] }, { configurationId: 'icfg_integration' },
    { system: true }, { visibility: 'public' },
  ]) {
    const f = fixture(); f.envs.push({ ...f.own(keys[0]!), ...change });
    await assert.rejects(f.factory().preflight(), safeFailure('ENV_CONFLICT')); assert.equal(writes(f.calls).length, 0);
  }
  const duplicate = fixture(); duplicate.envs.push(duplicate.own(keys[0]!), duplicate.own(keys[0]!));
  await assert.rejects(duplicate.factory().preflight(), safeFailure('ENV_CONFLICT')); assert.equal(writes(duplicate.calls).length, 0);
});

test('a target row that becomes foreign after creation is never patched or overwritten', async () => {
  const f = fixture(); f.afterWrite = (call, row) => { if (call.method === 'POST') row.comment = 'foreign-owner'; };
  const handoff = f.factory(); await handoff.preflight();
  await assert.rejects(handoff.publish({ databaseUrl, databaseHost }), safeFailure('ENV_CONFLICT'));
  assert.equal(writes(f.calls).length, 1); assert.equal(writes(f.calls)[0]!.method, 'POST');
  assert.equal(f.envs.find(row => keys.includes(row.key))!.comment, 'foreign-owner');
});

test('sensitive metadata values are ignored while supported manual Production metadata remains usable', async () => {
  const f = fixture();
  for (const row of f.envs) {
    row.target = 'production'; row.gitBranch = null; row.configurationId = null; row.customEnvironmentIds = []; row.system = false;
  }
  for (const key of keys) f.envs.push({ ...f.own(key), target: 'production', visibility: 'secret' });
  f.metadata = () => ({ envs: f.envs.map(row => ({ ...row, value: privateDiagnostic })) });
  const handoff = f.factory(); await handoff.preflight(); await handoff.publish({ databaseUrl, databaseHost }); assertPublished(f);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('public Config metadata is validated before any individual value is requested', async () => {
  for (const change of [{ type: 'sensitive' }, { target: ['preview'] }, { gitBranch: 'codex/foreign' }, { configurationId: 'icfg_integration' }]) {
    const f = fixture(); Object.assign(f.envs.find(row => row.key === 'CANNELE_BINDING_JSON')!, change);
    await assert.rejects(f.factory().preflight(), safeFailure('ENV_CONFLICT'));
    assert.equal(writes(f.calls).length, 0);
    assert.equal(f.calls.filter(call => call.url.pathname.startsWith('/v1/')).length, 0);
  }
});

test('changed disabled flags, binding or foreign metadata after preflight are checked again before publication', async () => {
  for (const kind of ['flags', 'binding', 'foreign'] as const) {
    const f = fixture(); const handoff = f.factory(); await handoff.preflight();
    if (kind === 'flags') f.envs.find(row => row.key === 'CANNELE_API_MUTATIONS_ENABLED')!.value = 'true';
    else if (kind === 'binding') f.envs.find(row => row.key === 'CANNELE_BINDING_JSON')!.value = JSON.stringify({
      instanceId: '22222222-2222-4222-8222-222222222222', bindingDigest: context.bindingDigest, writerEpoch: context.writerEpoch,
      repository: { id: context.repositoryId },
    });
    else f.envs.push({ ...f.own(keys[0]!), comment: 'foreign-owner' });
    await assert.rejects(handoff.publish({ databaseUrl, databaseHost }), safeFailure(kind === 'flags' ? 'NOT_DISABLED' : kind === 'binding' ? 'CONTEXT_MISMATCH' : 'ENV_CONFLICT'));
    assert.equal(writes(f.calls).length, 0);
  }
});

test('project identity, false flags and the four public binding identity fields must match before any write', async () => {
  for (const field of ['id', 'name', 'accountId'] as const) {
    const f = fixture(); f.project[field] = 'wrong-project';
    await assert.rejects(f.factory().preflight(), safeFailure('PROJECT_MISMATCH')); assert.equal(writes(f.calls).length, 0);
  }
  for (const key of ['CANNELE_API_MUTATIONS_ENABLED', 'CANNELE_PROVIDER_OPERATIONS_ENABLED']) {
    for (const value of [undefined, true, 'true', 'False', ' false']) {
      const f = fixture(); f.envs.find(row => row.key === key)!.value = value;
      await assert.rejects(f.factory().preflight(), safeFailure('NOT_DISABLED'));
      assert.equal(writes(f.calls).length, 0);
    }
  }
  for (const field of ['instanceId', 'bindingDigest', 'writerEpoch', 'repository'] as const) {
    const f = fixture(); const row = f.envs.find(env => env.key === 'CANNELE_BINDING_JSON')!;
    const binding = JSON.parse(String(row.value)) as Record<string, unknown>;
    binding[field] = field === 'writerEpoch' ? 2 : field === 'repository' ? { id: 999 } : 'different'; row.value = JSON.stringify(binding);
    await assert.rejects(f.factory().preflight(), safeFailure('CONTEXT_MISMATCH')); assert.equal(writes(f.calls).length, 0);
  }
  const origin = fixture(); origin.envs.find(row => row.key === 'CANNELE_API_ORIGIN')!.value = 'https://foreign.invalid';
  await assert.rejects(origin.factory().preflight(), safeFailure('CONTEXT_MISMATCH')); assert.equal(writes(origin.calls).length, 0);
});

test('redirects, hidden or paginated metadata, malformed JSON, oversized bodies and fetch failures stay sanitized', async () => {
  const cases: Array<(call: Call) => Response | undefined> = [
    () => new Response(null, { status: 302, headers: { location: 'https://foreign.invalid' } }),
    () => new Response(privateDiagnostic, { status: 200 }),
    () => new Response(privateDiagnostic.repeat(100_000), { status: 200 }),
    () => { throw new Error(privateDiagnostic); },
  ];
  for (const before of cases) {
    const f = fixture(); f.before = before;
    await assert.rejects(f.factory().preflight(), safeFailure()); assert.equal(writes(f.calls).length, 0); assert.equal(f.calls.length, 1);
  }
  for (const metadata of [
    { envs: [], pagination: { next: 'hidden' } }, { envs: [], hiddenProductionEnvCount: 1 }, { envs: privateDiagnostic },
  ]) {
    const f = fixture(); f.metadata = () => metadata;
    await assert.rejects(f.factory().preflight(), safeFailure()); assert.equal(writes(f.calls).length, 0);
  }
});

test('handoff markers have a stable ordered context identity and change when the runtime role changes', () => {
  const first = runtimeHandoffMarker(context, roleName);
  const reordered = Object.fromEntries(Object.entries(context).reverse());
  assert.equal(runtimeHandoffMarker(reordered, roleName), first);
  assert.match(first, /[a-f0-9]{64}$/); assert.equal(first.includes(roleName), false);
  assert.notEqual(runtimeHandoffMarker(context, `${roleName}_other`), first);
  assert.throws(() => runtimeHandoffMarker({ ...context, unexpectedCredential: privateDiagnostic }, roleName), safeFailure('INPUT_INVALID'));
  assert.throws(() => runtimeHandoffMarker(context, 'unsafe;role'), safeFailure('INPUT_INVALID'));
});

test('each read failure reports only its fixed GET phase and HTTP status', async () => {
  const phases: Array<{ path: string; endpoint: HandoffDiagnostic['endpoint']; status: number }> = [
    { path: `/v9/projects/${projectId}`, endpoint: 'PROJECT', status: 403 },
    { path: `/v10/projects/${projectId}/env`, endpoint: 'ENV_METADATA', status: 401 },
    { path: `/v1/projects/${projectId}/env/env_binding`, endpoint: 'PUBLIC_BINDING', status: 500 },
    { path: `/v1/projects/${projectId}/env/env_origin`, endpoint: 'PUBLIC_ORIGIN', status: 404 },
    { path: `/v1/projects/${projectId}/env/env_mutations`, endpoint: 'PUBLIC_MUTATIONS', status: 429 },
    { path: `/v1/projects/${projectId}/env/env_provider`, endpoint: 'PUBLIC_PROVIDER', status: 503 },
  ];
  for (const phase of phases) {
    const f = fixture(); f.before = call => call.url.pathname === phase.path
      ? response({ error: { message: privateDiagnostic, token: vercelToken, bootstrapToken: bootstrapVercelToken, databaseUrl } }, phase.status) : undefined;
    await assert.rejects(f.factory().preflight(), diagnosed('REQUEST_FAILED', {
      method: 'GET', endpoint: phase.endpoint, status: phase.status, reason: 'HTTP',
    }));
    assert.equal(writes(f.calls).length, 0); assert.equal(f.calls.at(-1)!.url.pathname, phase.path);
  }
});

test('transport, redirect, empty and invalid response diagnostics never copy provider messages or bodies', async () => {
  const cases: Array<{ code: string; diagnostic: HandoffDiagnostic; before: (call: Call) => Response | undefined }> = [
    { code: 'REQUEST_FAILED', diagnostic: { method: 'GET', endpoint: 'PUBLIC_BINDING', status: null, reason: 'TRANSPORT' },
      before: call => { if (call.url.pathname.endsWith('/env_binding')) {
        const error = new Error(`${privateDiagnostic} ${databaseUrl} ${bootstrapVercelToken} ${vercelToken}`); error.name = 'TimeoutError'; throw error;
      } return undefined; } },
    { code: 'REQUEST_FAILED', diagnostic: { method: 'GET', endpoint: 'ENV_METADATA', status: 307, reason: 'REDIRECT' },
      before: call => call.url.pathname === `/v10/projects/${projectId}/env`
        ? new Response(null, { status: 307, headers: { location: `https://foreign.invalid/${privateDiagnostic}` } }) : undefined },
    { code: 'REQUEST_FAILED', diagnostic: { method: 'GET', endpoint: 'PROJECT', status: 200, reason: 'EMPTY_BODY' },
      before: () => new Response(null, { status: 200 }) },
    { code: 'RESPONSE_INVALID', diagnostic: { method: 'GET', endpoint: 'PROJECT', status: 200, reason: 'INVALID_RESPONSE' },
      before: () => new Response(privateDiagnostic, { status: 200 }) },
    { code: 'RESPONSE_INVALID', diagnostic: { method: 'GET', endpoint: 'PROJECT', status: 200, reason: 'INVALID_RESPONSE' },
      before: () => new Response(privateDiagnostic.repeat(100_000), { status: 200 }) },
  ];
  for (const value of cases) {
    const f = fixture(); f.before = value.before;
    await assert.rejects(f.factory().preflight(), diagnosed(value.code, value.diagnostic));
    assert.equal(writes(f.calls).length, 0);
  }
});

test('an actually aborted request is classified as a timeout without waiting for a real deadline', async t => {
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new Error(privateDiagnostic)));
  const f = fixture(); f.before = (_call, init) => { assert.ok(init?.signal?.aborted); init.signal.throwIfAborted(); return undefined; };
  await assert.rejects(f.factory().preflight(), diagnosed('REQUEST_FAILED', {
    method: 'GET', endpoint: 'PROJECT', status: null, reason: 'TIMEOUT',
  }));
  assert.equal(writes(f.calls).length, 0);
});

test('bounded unknown writes retain the last safe POST or PATCH diagnostic and do not advance', async () => {
  for (const method of ['POST', 'PATCH'] as const) {
    const f = fixture(); if (method === 'PATCH') for (const key of keys) f.envs.push(f.own(key));
    let attempts = 0;
    f.before = call => {
      if (call.method !== method) return undefined;
      attempts++;
      if (method === 'PATCH' && attempts === 2) throw new Error(privateDiagnostic);
      return response({ error: { message: privateDiagnostic, token: neonApiKey } }, attempts === 3 ? 503 : 403);
    };
    const handoff = f.factory(); await handoff.preflight();
    await assert.rejects(handoff.publish({ databaseUrl, databaseHost }), diagnosed('WRITE_UNKNOWN', {
      method, endpoint: method === 'POST' ? 'SECRET_CREATE' : 'SECRET_UPDATE', status: 503, reason: 'HTTP',
    }));
    const mutations = writes(f.calls); assert.equal(attempts, 3); assert.equal(mutations.length, 3);
    assert.ok(mutations.every(call => call.method === method && call.url.pathname === mutations[0]!.url.pathname));
    assert.ok(mutations.every(call => call.body?.value === mutations[0]!.body!.value));
    for (let index = 1; index < mutations.length; index++) {
      assert.ok(f.calls.slice(f.calls.indexOf(mutations[index - 1]!) + 1, f.calls.indexOf(mutations[index]!))
        .some(call => call.method === 'GET' && call.url.pathname === `/v10/projects/${projectId}/env`));
    }
  }
});

test('a metadata failure during write reconciliation keeps its GET diagnostic and stops further writes', async () => {
  const f = fixture(); let attempted = false;
  f.before = call => {
    if (call.method === 'POST') { attempted = true; return response({ error: { message: privateDiagnostic } }, 503); }
    if (attempted && call.url.pathname === `/v10/projects/${projectId}/env`) return response({ error: { message: privateDiagnostic } }, 401);
    return undefined;
  };
  const handoff = f.factory(); await handoff.preflight();
  await assert.rejects(handoff.publish({ databaseUrl, databaseHost }), diagnosed('REQUEST_FAILED', {
    method: 'GET', endpoint: 'ENV_METADATA', status: 401, reason: 'HTTP',
  }));
  assert.equal(writes(f.calls).length, 1);
});

test('safe diagnostics are cloned from exact own scalar fields and reject untrusted values without running getters', () => {
  const valid: HandoffDiagnostic = { method: 'GET', endpoint: 'PROJECT', status: 403, reason: 'HTTP' };
  const clone = safeHandoffDiagnostic(valid); assert.deepEqual(clone, valid); assert.notEqual(clone, valid);
  valid.status = 401; assert.equal(clone!.status, 403);
  for (const [method, endpoint] of [
    ['GET', 'PROJECT'], ['GET', 'ENV_METADATA'], ['GET', 'PUBLIC_BINDING'], ['GET', 'PUBLIC_ORIGIN'],
    ['GET', 'PUBLIC_MUTATIONS'], ['GET', 'PUBLIC_PROVIDER'], ['POST', 'SECRET_CREATE'], ['PATCH', 'SECRET_UPDATE'],
  ] as const) {
    for (const status of [100, 599, null]) for (const reason of ['HTTP', 'REDIRECT', 'TIMEOUT', 'TRANSPORT', 'EMPTY_BODY', 'INVALID_RESPONSE'] as const) {
      const value = { method, endpoint, status, reason }; assert.deepEqual(safeHandoffDiagnostic(value), value);
    }
  }
  const invalid: unknown[] = [null, [], privateDiagnostic, { ...valid, method: 'DELETE' }, { ...valid, method: 'get' },
    { ...valid, endpoint: privateDiagnostic }, { ...valid, reason: privateDiagnostic }, { ...valid, unexpected: privateDiagnostic },
    Object.create(valid), Object.assign(Object.create({ reason: 'HTTP' }), { method: 'GET', endpoint: 'PROJECT', status: 403 }),
    new Proxy({}, { ownKeys() { throw new Error(privateDiagnostic); } }),
  ];
  for (const status of [99, 600, 200.5, '403', undefined, NaN, Infinity]) invalid.push({ ...valid, status });
  const hidden = { ...valid }; Object.defineProperty(hidden, 'privateValue', { value: privateDiagnostic }); invalid.push(hidden);
  const symbol = { ...valid, [Symbol('private')]: privateDiagnostic }; invalid.push(symbol);
  let getters = 0;
  for (const key of ['method', 'endpoint', 'status', 'reason']) {
    const accessor = { ...valid }; Object.defineProperty(accessor, key, { enumerable: true, get() { getters++; throw new Error(privateDiagnostic); } });
    invalid.push(accessor);
  }
  for (const value of invalid) assert.equal(safeHandoffDiagnostic(value), undefined);
  assert.equal(getters, 0);
});

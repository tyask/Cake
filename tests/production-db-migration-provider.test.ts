import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBinding, config, connection, hash, MigrationError, parseConnection, productionApi,
  type Api, type Binding,
} from '../scripts/production-db-migration-provider';

const host = 'ep-fixture.ap-southeast-1.aws.neon.tech';
const expected: Binding = {
  ...config.source,
  projectId: 'fixture-project', branchId: 'br-fixture', endpointId: 'ep-fixture',
  hostDigest: hash(host), database: 'fixture_db', role: 'fixture_owner',
};
const base = `/projects/${expected.projectId}`;
const password = 'fixture:p@ss/word%';
function uri(query = 'sslmode=require&channel_binding=require'): string {
  return `postgresql://${expected.role}:${encodeURIComponent(password)}@${host}/${expected.database}?${query}`;
}

test('parseConnection returns the verified direct connection and decodes only its credentials', () => {
  for (const value of [uri(), uri('sslmode=require').replace('postgresql:', 'postgres:')]) {
    assert.deepEqual(parseConnection(value, expected), {
      host, port: 5432, user: expected.role, password, database: expected.database,
    });
  }
  assert.equal(parseConnection(uri().replace(host, `${host}:5432`), expected).port, 5432);
});

const invalidConnections: [string, unknown, Binding?][] = [
  ['another endpoint', uri().replace('ep-fixture.', 'ep-other.')],
  ['another host with the same endpoint', uri().replace('ap-southeast-1', 'us-east-2')],
  ['a mismatched trusted digest', uri(), { ...expected, hostDigest: '0'.repeat(64) }],
  ['another role', uri().replace(expected.role, 'other_owner')],
  ['another database', uri().replace(`/${expected.database}?`, '/other_db?')],
  ['a pooled hostname', uri().replace('ep-fixture.', 'ep-fixture-pooler.')],
  ['a pooled query parameter', uri('sslmode=require&pooled=true')],
  ['a host override query parameter', uri('sslmode=require&host=elsewhere.invalid')],
  ['a SQL options query parameter', uri('sslmode=require&options=-csearch_path%3Dother')],
  ['an unknown query parameter', uri('sslmode=require&application_name=fixture')],
  ['duplicate sslmode', uri('sslmode=require&sslmode=require')],
  ['duplicate channel_binding', uri('sslmode=require&channel_binding=require&channel_binding=require')],
  ['missing sslmode', uri('channel_binding=require')],
  ['a weaker sslmode', uri('sslmode=prefer')],
  ['a different channel binding policy', uri('sslmode=require&channel_binding=prefer')],
  ['another port', uri().replace(host, `${host}:6543`)],
  ['a fragment', `${uri()}#fixture`],
  ['an unsupported protocol', uri().replace('postgresql:', 'https:')],
  ['an empty password', uri().replace(encodeURIComponent(password), '')],
  ['a control character in a password', uri().replace(encodeURIComponent(password), 'private%0Avalue')],
  ['invalid credential encoding', uri().replace(encodeURIComponent(password), '%ZZ')],
  ['a non-string response', { uri: uri() }],
];
for (const [name, value, binding = expected] of invalidConnections) {
  test(`parseConnection rejects ${name} without exposing the URI`, () => {
    assert.throws(() => parseConnection(value, binding), { message: 'PRODUCTION_MIGRATION_CONNECTION_BINDING' });
  });
}

test('connection requests the explicit branch, endpoint, role, database and unpooled URI', async () => {
  let calls = 0;
  const api: Api = async (provider, path) => {
    calls++;
    assert.equal(provider, 'neon');
    const url = new URL(path, 'https://fixture.invalid');
    assert.equal(url.pathname, `${base}/connection_uri`);
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      branch_id: expected.branchId, endpoint_id: expected.endpointId,
      database_name: expected.database, role_name: expected.role, pooled: 'false',
    });
    return { uri: uri() };
  };
  assert.equal((await connection(api, expected)).host, host);
  assert.equal(calls, 1);
});

const environment = { NEON_API_KEY: 'fixture-neon-token', VERCEL_TOKEN: 'fixture-vercel-token', GH_TOKEN: 'fixture-github-token' };
test('productionApi routes all providers with GET, redirect refusal and separate credentials', async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const request: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return Response.json({ found: true });
  };
  const api = productionApi(environment, request);
  assert.deepEqual(await api('neon', `${base}?limit=1`), { found: true });
  assert.deepEqual(await api('vercel', '/v13/deployments/dpl_fixture?teamId=other&limit=1'), { found: true });
  assert.deepEqual(await api('github', '/repos/fixture/cake/commits/main'), { found: true });
  assert.equal(calls[0].url.href, `https://console.neon.tech/api/v2${base}?limit=1`);
  assert.equal(calls[1].url.origin, 'https://api.vercel.com');
  assert.equal(calls[1].url.pathname, '/v13/deployments/dpl_fixture');
  assert.equal(calls[1].url.searchParams.get('teamId'), config.vercelTeamId);
  assert.equal(calls[1].url.searchParams.getAll('teamId').length, 1);
  assert.equal(calls[1].url.searchParams.get('limit'), '1');
  assert.equal(calls[2].url.href, 'https://api.github.com/repos/fixture/cake/commits/main');
  for (const [index, { init }] of calls.entries()) {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.body, undefined);
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('authorization'), `Bearer ${[environment.NEON_API_KEY, environment.VERCEL_TOKEN, environment.GH_TOKEN][index]}`);
  }
});

test('productionApi rejects alternate origins and malformed routing before making a request', async () => {
  let calls = 0;
  const api = productionApi(environment, async () => { calls++; return Response.json({}); });
  for (const path of ['projects/fixture', '//elsewhere.invalid/projects', 'https://elsewhere.invalid/',
    '/projects/fixture#fragment', '/projects/fixture\\other', '/projects/fixture\r\nheader']) {
    await assert.rejects(api('neon', path), { message: 'PRODUCTION_MIGRATION_INVALID_REQUEST' });
  }
  await assert.rejects(api('private-unrecognized-provider' as Parameters<Api>[0], base), {
    message: 'PRODUCTION_MIGRATION_INVALID_REQUEST',
  });
  assert.equal(calls, 0);
});

test('productionApi rejects missing or multiline credentials before making a request', async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return Response.json({}); };
  for (const token of [undefined, '', ' ', 'private\nvalue', 'private\rvalue']) {
    await assert.rejects(productionApi({ NEON_API_KEY: token }, request)('neon', base), {
      message: 'PRODUCTION_MIGRATION_CREDENTIALS_MISSING',
    });
  }
  await assert.rejects(productionApi({ NEON_API_KEY: environment.NEON_API_KEY }, request)('vercel', '/v9/projects'), {
    message: 'PRODUCTION_MIGRATION_CREDENTIALS_MISSING',
  });
  assert.equal(calls, 0);
});

const privateDetail = `private-provider-detail:${uri()}`;
const privatePath = '/private-request-path?access_token=private-query-token';
function safeProviderFailure(error: unknown, code: string): boolean {
  assert.ok(error instanceof MigrationError);
  assert.equal(error.message, `PRODUCTION_MIGRATION_${code}`);
  assert.equal(error.cause, undefined);
  const visible = `${error}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const secret of [privateDetail, uri(), privatePath, 'private-response-header', 'private-status-text',
    'private-query-token', ...Object.values(environment)]) {
    assert.ok(!visible.includes(secret), 'provider error must not expose request or response details');
  }
  return true;
}

for (const provider of ['neon', 'vercel', 'github'] as const) {
  for (const status of [302, 401, 403, 404, 503]) {
    test(`productionApi reports ${provider} HTTP ${status} without reading or exposing the response body`, async () => {
      let calls = 0;
      const response = new Response(privateDetail, { status, statusText: 'private-status-text',
        headers: { 'x-private-detail': 'private-response-header' } });
      const request: typeof fetch = async () => { calls++; return response; };
      await assert.rejects(productionApi(environment, request)(provider, privatePath), error =>
        safeProviderFailure(error, `PROVIDER_${provider.toUpperCase()}_HTTP_${status}`));
      assert.equal(response.bodyUsed, false);
      assert.equal(calls, 1);
    });
  }

  test(`productionApi distinguishes ${provider} transport failures from invalid JSON without exposing details`, async () => {
    const failures: [string, typeof fetch][] = [
      ['TRANSPORT', async () => { throw new Error(privateDetail, { cause: environment.NEON_API_KEY }); }],
      ['JSON', async () => new Response(privateDetail, { status: 200 })],
    ];
    for (const [kind, request] of failures) {
      await assert.rejects(productionApi(environment, request)(provider, privatePath), error =>
        safeProviderFailure(error, `PROVIDER_${provider.toUpperCase()}_${kind}`));
    }
  });

  test(`productionApi rejects ${provider} invalid status values without reflecting external text`, async () => {
    for (const status of [0, 99, 600, 401.5, NaN, '503', privateDetail]) {
      const response = new Response(privateDetail);
      Object.defineProperty(response, 'status', { value: status });
      const request: typeof fetch = async () => response;
      await assert.rejects(productionApi(environment, request)(provider, privatePath), error =>
        safeProviderFailure(error, `PROVIDER_${provider.toUpperCase()}_INVALID_STATUS`));
      assert.equal(response.bodyUsed, false);
    }
  });
}

type ProviderRecord = Record<string, unknown>;
type Fixture = {
  project: ProviderRecord; branches: ProviderRecord[]; directBranch: ProviderRecord;
  endpoints: ProviderRecord[]; directEndpoint: ProviderRecord; database: ProviderRecord; role: ProviderRecord;
};
function fixture(): Fixture {
  const branch = { id: expected.branchId, project_id: expected.projectId, default: true, protected: true };
  const endpoint = { id: expected.endpointId, project_id: expected.projectId, branch_id: expected.branchId,
    region_id: config.regionId, host, type: 'read_write', disabled: false, current_state: 'idle' };
  return {
    project: { id: expected.projectId, org_id: config.organizationId, region_id: config.regionId, pg_version: expected.majorVersion },
    branches: [branch], directBranch: { ...branch },
    endpoints: [endpoint, { ...endpoint, id: 'ep-replica', type: 'read_only' },
      { ...endpoint, id: 'ep-child', branch_id: 'br-child' }],
    directEndpoint: { ...endpoint },
    database: { branch_id: expected.branchId, name: expected.database, owner_name: expected.role },
    role: { branch_id: expected.branchId, name: expected.role, password: 'private-role-response' },
  };
}
function fixtureApi(data: Fixture, calls: string[] = [], pages?: Map<string, unknown>): Api {
  return async (provider, path) => {
    assert.equal(provider, 'neon');
    calls.push(path);
    const url = new URL(path, 'https://fixture.invalid');
    if (url.pathname === `${base}/branches`) {
      assert.equal(url.searchParams.get('limit'), '100');
      const cursor = url.searchParams.get('cursor') ?? '';
      if (!pages) { assert.equal(cursor, ''); return structuredClone({ branches: data.branches }); }
      assert.ok(pages.has(cursor), 'unexpected pagination cursor');
      return structuredClone(pages.get(cursor));
    }
    const routes: Record<string, unknown> = {
      [base]: { project: data.project },
      [`${base}/branches/${expected.branchId}`]: { branch: data.directBranch },
      [`${base}/endpoints`]: { endpoints: data.endpoints },
      [`${base}/endpoints/${expected.endpointId}`]: { endpoint: data.directEndpoint },
      [`${base}/branches/${expected.branchId}/databases/${expected.database}`]: { database: data.database },
      [`${base}/branches/${expected.branchId}/roles/${expected.role}`]: { role: data.role },
    };
    assert.ok(Object.hasOwn(routes, path), 'unexpected provider route');
    return structuredClone(routes[path]);
  };
}

test('assertBinding reconciles each fixed resource against lists and direct GETs', async () => {
  const calls: string[] = [];
  assert.equal(await assertBinding(fixtureApi(fixture(), calls), expected), undefined);
  assert.deepEqual(calls, [base, `${base}/branches?limit=100`, `${base}/branches/${expected.branchId}`,
    `${base}/endpoints`, `${base}/endpoints/${expected.endpointId}`,
    `${base}/branches/${expected.branchId}/databases/${expected.database}`,
    `${base}/branches/${expected.branchId}/roles/${expected.role}`]);
});

const invalidBindings: [string, (data: Fixture) => void, string?][] = [
  ['another project', data => { data.project.id = 'other-project'; }],
  ['another organization', data => { data.project.org_id = 'org-other'; }],
  ['a missing organization', data => { delete data.project.org_id; }],
  ['another region', data => { data.project.region_id = 'aws-us-east-2'; }],
  ['another major version', data => { data.project.pg_version = expected.majorVersion + 1; }],
  ['a string major version', data => { data.project.pg_version = String(expected.majorVersion); }],
  ['a missing default branch', data => { data.branches[0].default = false; }],
  ['multiple default branches', data => { data.branches.push({ ...data.branches[0], id: 'br-other' }); }],
  ['duplicate expected branches', data => { data.branches.push({ ...data.branches[0], default: false }); }],
  ['a changed direct branch', data => { data.directBranch.protected = false; }, 'PROVIDER_CHANGED'],
  ['a changed parent branch', data => { data.directBranch.parent_id = 'br-other'; }, 'PROVIDER_CHANGED'],
  ['a branch belonging to another project', data => { data.branches[0].project_id = data.directBranch.project_id = 'other-project'; }],
  ['a missing writer', data => { data.endpoints[0].type = 'read_only'; }],
  ['multiple writers', data => { data.endpoints.push({ ...data.endpoints[0], id: 'ep-other' }); }],
  ['a changed direct endpoint', data => { data.directEndpoint.host = 'ep-fixture.us-east-2.aws.neon.tech'; }, 'PROVIDER_CHANGED'],
  ['a disabled endpoint', data => { data.endpoints[0].disabled = data.directEndpoint.disabled = true; }],
  ['an initializing endpoint', data => { data.directEndpoint.current_state = 'init'; }],
  ['an endpoint transition', data => { data.directEndpoint.pending_state = 'active'; }],
  ['another endpoint digest', data => { data.endpoints[0].host = data.directEndpoint.host = 'ep-fixture.us-east-2.aws.neon.tech'; }],
  ['another database branch', data => { data.database.branch_id = 'br-other'; }],
  ['another database name', data => { data.database.name = 'other_db'; }],
  ['another database owner', data => { data.database.owner_name = 'other_owner'; }],
  ['another role branch', data => { data.role.branch_id = 'br-other'; }],
  ['another role name', data => { data.role.name = 'other_owner'; }],
];
for (const [name, change, code = 'PROVIDER_BINDING'] of invalidBindings) {
  test(`assertBinding rejects ${name}`, async () => {
    const data = fixture();
    change(data);
    await assert.rejects(assertBinding(fixtureApi(data), expected), { message: `PRODUCTION_MIGRATION_${code}` });
  });
}

test('assertBinding follows and URL-encodes pagination.next before selecting the default branch', async () => {
  const data = fixture(), calls: string[] = [], cursor = 'page/next+value?=';
  const pages = new Map<string, unknown>([
    ['', { branches: [{ id: 'br-child', default: false }], pagination: { next: cursor } }],
    [cursor, { branches: data.branches, pagination: {} }],
  ]);
  await assertBinding(fixtureApi(data, calls, pages), expected);
  assert.equal(calls[2], `${base}/branches?limit=100&cursor=${encodeURIComponent(cursor)}`);
});

test('assertBinding refuses cyclic, malformed or unbounded pagination before direct resource reads', async () => {
  const data = fixture();
  const cases = [
    new Map<string, unknown>([['', { branches: [], pagination: { next: 17 } }]]),
    new Map<string, unknown>([['', { branches: [], pagination: { next: 'repeat' } }],
      ['repeat', { branches: data.branches, pagination: { next: 'repeat' } }]]),
    new Map<string, unknown>(Array.from({ length: 20 }, (_, page) => [page === 0 ? '' : `page-${page}`,
      { branches: [], pagination: { next: `page-${page + 1}` } }])),
  ];
  for (const pages of cases) {
    const calls: string[] = [];
    await assert.rejects(assertBinding(fixtureApi(data, calls, pages), expected), {
      message: 'PRODUCTION_MIGRATION_INCOMPLETE_INVENTORY',
    });
    assert.ok(calls.slice(1).every(path => path.startsWith(`${base}/branches?`)));
    assert.ok(calls.length <= 21);
  }
});

test('assertBinding rejects malformed provider envelopes rather than trusting typed responses', async () => {
  for (const response of [null, [], { project: null }, { project: [] }]) {
    await assert.rejects(assertBinding(async () => response, expected), {
      message: 'PRODUCTION_MIGRATION_INVALID_RESPONSE',
    });
  }
});

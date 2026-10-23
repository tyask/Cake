import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProductionProjectEnvironment, assertProviderProductionEnvironment, environmentFailureCodes, ProductionEnvironmentError, validateProductionEnvironment,
  type ProductionEnvironmentReason, type ProductionEnvironmentScope,
} from '../scripts/production-db-cutover-environment';
import { config, hash, MigrationError, parseConnection, type Api, type Binding } from '../scripts/production-db-migration-provider';

const host = 'ep-fixture.ap-southeast-1.aws.neon.tech', password = 'private:password@must/not%appear';
const expected: Binding = { ...config.source, endpointId: 'ep-fixture', hostDigest: hash(host), database: 'fixture_db', role: 'fixture_owner' };
const uri = (query = 'sslmode=require&channel_binding=require') => `postgresql://${expected.role}:${encodeURIComponent(password)}@${host}/${expected.database}?${query}`;
const environment = () => ({ DATABASE_URL: uri(), VERCEL_ENV: 'production', AUTH_MODE: 'google', OTHER_SECRET: password });
const scopes: ProductionEnvironmentScope[] = ['DEFAULT', 'MAIN', 'BUILD', 'RUNTIME'];
function safeFailure(error: unknown, scope: ProductionEnvironmentScope, reason: ProductionEnvironmentReason): boolean {
  assert.ok(error instanceof ProductionEnvironmentError);
  assert.equal(error.code, `ENVIRONMENT_${scope}_${reason}`); assert.equal(error.message, error.code);
  assert.ok(environmentFailureCodes.includes(error.code)); assert.equal(error.cause, undefined);
  assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
  for (const secret of [password, encodeURIComponent(password), uri(), host, 'private-unrecognized-variable']) {
    assert.ok(!`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes(secret));
  }
  return true;
}

test('全scopeでdirect・pooled・省略可能なchannel bindingと既定contextを同じ規則で受理する', () => {
  for (const scope of scopes) {
    for (const value of [uri(), uri('sslmode=require'), uri().replace('ep-fixture.', 'ep-fixture-pooler.'),
      uri().replace(host, `${host}:5432`), ` ${uri().replace('postgresql:', 'postgres:')} `]) {
      assert.equal(validateProductionEnvironment({ DATABASE_URL: value }, expected, scope), undefined);
    }
    assert.equal(validateProductionEnvironment(environment(), expected, scope), undefined);
  }
});

const cases: [ProductionEnvironmentReason, unknown, Binding?][] = [
  ['SHAPE', undefined], ['SHAPE', null], ['SHAPE', []], ['SHAPE', 'private-unrecognized-variable'],
  ['VALUE_TYPE', { ...environment(), OTHER_SECRET: null }], ['VALUE_TYPE', { DATABASE_URL: 1 }],
  ['CONTEXT', { ...environment(), VERCEL_ENV: 'preview' }], ['CONTEXT', { ...environment(), VERCEL_ENV: '' }],
  ['TEST_AUTH', { ...environment(), AUTH_MODE: 'test' }], ['TLS', { ...environment(), NODE_TLS_REJECT_UNAUTHORIZED: '0' }],
  ['PREVIEW', { ...environment(), CAKE_PREVIEW_PHASE: '' }], ['PREVIEW', { ...environment(), CAKE_PREVIEW_UNRECOGNIZED: password }],
  ['DATABASE_MISSING', {}], ['DATABASE_EMPTY', { DATABASE_URL: ' \t' }], ['DATABASE_REDACTED', { DATABASE_URL: ' [SENSITIVE] ' }],
  ['URI_INVALID', { DATABASE_URL: password }], ['URI_INVALID', { DATABASE_URL: uri().replace('postgresql:', 'https:') }],
  ['URI_INVALID', { DATABASE_URL: `${uri()}#fragment` }], ['URI_INVALID', { DATABASE_URL: uri().replace(encodeURIComponent(password), '%ZZ') }],
  ['ROLE_MISMATCH', { DATABASE_URL: uri().replace(expected.role, 'other_owner') }],
  ['DATABASE_MISMATCH', { DATABASE_URL: uri().replace(`/${expected.database}?`, '/other_db?') }],
  ['ENDPOINT_MISMATCH', { DATABASE_URL: uri().replace('ep-fixture.', 'ep-other.') }],
  ['HOST_MISMATCH', { DATABASE_URL: uri().replace('ap-southeast-1', 'us-east-2') }],
  ['HOST_MISMATCH', { DATABASE_URL: uri().replace(host, 'other.invalid') }],
  ['HOST_MISMATCH', environment(), { ...expected, hostDigest: '0'.repeat(64) }],
  ['PASSWORD', { DATABASE_URL: uri().replace(encodeURIComponent(password), '') }],
  ['PASSWORD', { DATABASE_URL: uri().replace(encodeURIComponent(password), 'private%0Avalue') }],
  ['PORT', { DATABASE_URL: uri().replace(host, `${host}:6543`) }],
  ['SSLMODE', { DATABASE_URL: uri('channel_binding=require') }], ['SSLMODE', { DATABASE_URL: uri('sslmode=prefer') }],
  ['URL_OPTIONS', { DATABASE_URL: uri('sslmode=require&host=other.invalid') }],
  ['URL_OPTIONS', { DATABASE_URL: uri('sslmode=require&options=-csearch_path%3Dother') }],
  ['URL_OPTIONS', { DATABASE_URL: uri('sslmode=require&application_name=private-unrecognized-variable') }],
  ['URL_OPTIONS', { DATABASE_URL: uri('sslmode=require&sslmode=require') }],
  ['URL_OPTIONS', { DATABASE_URL: uri('sslmode=require&channel_binding=require&channel_binding=require') }],
  ['URL_OPTIONS', { DATABASE_URL: uri('sslmode=require&channel_binding=prefer') }],
];
test('各拒否理由を全scopeの固定codeへ変換し、元の値や例外を保存しない', () => {
  for (const scope of scopes) for (const [reason, value, binding = expected] of cases) {
    assert.throws(() => validateProductionEnvironment(value, binding, scope), error => safeFailure(error, scope, reason));
  }
});

test('runtimeのDATABASE_URL無しは任意扱いでき、実在する値や本番guardは省略しない', () => {
  for (const value of [{}, { VERCEL_ENV_ENCRYPTION_KEY: password }]) {
    validateProductionEnvironment(value, expected, 'RUNTIME', false);
  }
  for (const [reason, value, binding = expected] of cases) {
    if (reason === 'DATABASE_MISSING') continue;
    assert.throws(() => validateProductionEnvironment(value, binding, 'RUNTIME', false), error => safeFailure(error, 'RUNTIME', reason));
  }
});

test('固定code一覧は重複なくfreezeし、不正castのcodeやscopeから秘密値を生成しない', () => {
  assert.ok(Object.isFrozen(environmentFailureCodes));
  assert.equal(new Set(environmentFailureCodes).size, environmentFailureCodes.length);
  for (const scope of scopes) assert.ok(environmentFailureCodes.includes(`ENVIRONMENT_${scope}_CONNECTION`));
  const error = new ProductionEnvironmentError(password as ProductionEnvironmentScope, password as ProductionEnvironmentReason);
  assert.equal(error.code, 'ENVIRONMENT_DEFAULT_SHAPE'); assert.equal(error.message, error.code); assert.equal(error.cause, undefined);
  assert.ok(!JSON.stringify(error).includes(password));
});

test('共有strict parserとdirect接続の受理・拒否を一致させる', () => {
  for (const value of [uri(), uri('sslmode=require'), ...cases.map(item => (item[1] as Record<string, unknown> | undefined)?.DATABASE_URL).filter(value => typeof value === 'string')]) {
    let strict = true, guarded = true;
    try { parseConnection(value, expected); } catch { strict = false; }
    try { validateProductionEnvironment({ DATABASE_URL: value }, expected, 'BUILD'); } catch { guarded = false; }
    assert.equal(guarded, strict);
  }
});

test('project実効値は固定projectのProduction default→mainのGETだけを順に検証する', async () => {
  const calls: [string, string][] = [];
  const api: Api = async (provider, path) => { calls.push([provider, path]); return { env: environment(), privateField: password }; };
  assert.equal(await assertProductionProjectEnvironment(api, expected), undefined);
  assert.deepEqual(calls, [['vercel', `/v3/env/pull/${config.vercelProjectId}/production`],
    ['vercel', `/v3/env/pull/${config.vercelProjectId}/production/main`]]);
});

test('不可視値のSecret metadataが無ければscope付き固定codeで止める', async () => {
  for (const failureAt of [1, 2]) {
    let envReads = 0, metadataReads = 0;
    const api: Api = async (_provider, path) => {
      if (path.includes('/env?')) { metadataReads++; return { envs: [] }; }
      return ++envReads === failureAt ? { env: { DATABASE_URL: '[SENSITIVE]' } } : { env: environment() };
    };
    await assert.rejects(assertProductionProjectEnvironment(api, expected), error => safeFailure(error, failureAt === 1 ? 'DEFAULT' : 'MAIN', 'SECRET_METADATA'));
    assert.equal(envReads, failureAt); assert.equal(metadataReads, 1);
  }
});

test('outer responseとenvのshape不正はscope固定error、API失敗は元MigrationErrorを保つ', async () => {
  for (const response of [undefined, null, [], password, {}, { env: null }, { env: [] }]) {
    let calls = 0;
    await assert.rejects(assertProductionProjectEnvironment(async () => { calls++; return response; }, expected), error => safeFailure(error, 'DEFAULT', 'SHAPE'));
    assert.equal(calls, 1);
  }
  for (const failureAt of [1, 2]) {
    const original = new MigrationError('PROVIDER_VERCEL_HTTP_403'); let calls = 0;
    await assert.rejects(assertProductionProjectEnvironment(async () => {
      if (++calls === failureAt) throw original; return { env: environment() };
    }, expected), error => error === original);
    assert.equal(calls, failureAt);
  }
});


test('APIの不可視値はProduction DATABASE_URLが明示Secretの時だけ許し、実値検査は弱めない', async () => {
  for (const scope of scopes) for (const metadata of [{ type: 'sensitive' }, { type: 'encrypted', visibility: 'secret' }]) {
    const paths: string[] = [];
    const api: Api = async (provider, path) => { assert.equal(provider, 'vercel'); paths.push(path);
      return { envs: [{ id: 'env_fixture', key: 'DATABASE_URL', target: ['production'], ...metadata, value: password }] }; };
    for (const value of ['', '[SENSITIVE]']) await assertProviderProductionEnvironment(api, { ...environment(), DATABASE_URL: value }, expected, scope);
    assert.deepEqual(paths, Array(2).fill(`/v10/projects/${config.vercelProjectId}/env?decrypt=false`));
    await assert.rejects(assertProviderProductionEnvironment(api, { ...environment(), DATABASE_URL: uri().replace('ep-fixture.', 'ep-other.') }, expected, scope), error => safeFailure(error, scope, 'ENDPOINT_MISMATCH'));
    assert.equal(paths.length, 2);
    assert.throws(() => validateProductionEnvironment({ DATABASE_URL: '' }, expected, scope), error => safeFailure(error, scope, 'DATABASE_EMPTY'));
  }
});

test('Secret metadataの欠落・重複・不正scope・非Secret・読取失敗を成功扱いしない', async () => {
  const variable = { id: 'env_fixture', key: 'DATABASE_URL', target: ['production'], type: 'sensitive' };
  const values = [null, [], {}, { envs: null }, { envs: [null] }, { envs: [] }, { envs: [variable, variable] },
    { envs: [{ ...variable, target: ['preview'] }] }, { envs: [{ ...variable, gitBranch: 'main' }] },
    { envs: [{ ...variable, type: 'encrypted', visibility: 'config' }] }, { envs: [{ ...variable, target: null }] }];
  for (const value of values) await assert.rejects(assertProviderProductionEnvironment(async () => value, { DATABASE_URL: '' }, expected, 'BUILD'), error => safeFailure(error, 'BUILD', 'SECRET_METADATA'));
  const original = new MigrationError('PROVIDER_VERCEL_HTTP_403');
  await assert.rejects(assertProviderProductionEnvironment(async () => { throw original; }, { DATABASE_URL: '' }, expected, 'BUILD'), error => error === original);
});

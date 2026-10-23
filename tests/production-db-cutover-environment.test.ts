import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProductionProjectEnvironment, environmentFailureCodes, ProductionEnvironmentError, validateProductionEnvironment,
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

test('defaultの失敗でmainを取得せず、mainの失敗はMAIN codeとする', async () => {
  for (const failureAt of [1, 2]) {
    let calls = 0;
    const api: Api = async () => ++calls === failureAt ? { env: { DATABASE_URL: '[SENSITIVE]' } } : { env: environment() };
    await assert.rejects(assertProductionProjectEnvironment(api, expected), error => safeFailure(error, failureAt === 1 ? 'DEFAULT' : 'MAIN', 'DATABASE_REDACTED'));
    assert.equal(calls, failureAt);
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

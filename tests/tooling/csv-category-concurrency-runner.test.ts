import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { logDatabaseQaResult, runCsvCategoryDatabaseQa } from '../../scripts/qa/db/verify-csv-category-concurrency';
import { config } from '../../scripts/preview/preview-model';

const host = 'ep-fixture.ap-southeast-1.aws.neon.tech';
const fixture = {
  VERCEL_ENV: 'preview', AUTH_MODE: 'test', VERCEL_DEPLOYMENT_ID: 'dpl_fixture',
  VERCEL_GIT_COMMIT_REF: 'codex/csv-categories', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
  VERCEL_GIT_COMMIT_MESSAGE: 'CSVカテゴリの実DB並行検証\n\n[cake-db-qa:csv-categories]',
  CAKE_PREVIEW_PHASE: 'application', CAKE_PREVIEW_REPOSITORY: 'tyask/Cake', CAKE_PREVIEW_PR: '116',
  CAKE_PREVIEW_GENERATION: '00000000-0000-4000-8000-000000000001',
  CAKE_PREVIEW_SOURCE_BRANCH: 'codex/csv-categories', CAKE_PREVIEW_SOURCE_SHA: 'a'.repeat(40),
  CAKE_PREVIEW_DATABASE_BRANCH_ID: 'br-fixture',
  CAKE_PREVIEW_DATABASE_HOST_SHA256: createHash('sha256').update(host).digest('hex'),
  CAKE_PREVIEW_PRODUCTION_HOST_SHA256: config.productionHostDigest,
  CAKE_TEST_DATABASE_URL: 'postgresql://fixture:fixture-secret@ep-fixture-pooler.ap-southeast-1.aws.neon.tech/cake?sslmode=require',
};

test('実DBの長い集約結果はVercelの4KiB制限でも完全に復元して照合できる', () => {
  const result = { protocol: 'cake-csv-category-db-qa/v1', runId: '00000000-0000-4000-8000-000000000001',
    sha: 'a'.repeat(40), success: true, cases: Array.from({ length: 19 }, (_, i) => ({ name: `正規化・並行検証${i}😀`,
      status: 'passed', detail: '日本語の検証結果とcleanup確認'.repeat(20) })), failures: [] };
  const lines: string[] = [];
  logDatabaseQaResult(result, line => lines.push(Buffer.from(line).subarray(0, 4096).toString('utf8')));
  assert.ok(lines.length > 1);
  assert.ok(lines.every(line => Buffer.byteLength(line, 'utf8') <= 3500));
  const parts = lines.map(line => {
    assert.ok(line.startsWith('Cake DB QA result part: '));
    return JSON.parse(line.slice('Cake DB QA result part: '.length));
  });
  const serialized = Buffer.concat(parts.map((part, i) => {
    assert.equal(part.protocol, 'cake-csv-category-db-qa-result-part/v1');
    assert.equal(part.runId, result.runId); assert.equal(part.sha, result.sha);
    assert.equal(part.part, i + 1); assert.equal(part.total, parts.length);
    assert.equal(part.byteLength, parts[0].byteLength); assert.equal(part.sha256, parts[0].sha256);
    return Buffer.from(part.data, 'base64');
  }));
  assert.equal(serialized.length, parts[0].byteLength);
  assert.equal(createHash('sha256').update(serialized).digest('hex'), parts[0].sha256);
  assert.deepEqual(JSON.parse(serialized.toString('utf8')), result);
});

test('短い実DB結果は従来の単一result行で公開する', () => {
  const result = { protocol: 'cake-csv-category-db-qa/v1', runId: 'fixture', success: false, failures: [{ code: '28P01' }] };
  const lines: string[] = [];
  logDatabaseQaResult(result, line => lines.push(line));
  assert.deepEqual(lines, [`Cake DB QA result: ${JSON.stringify(result)}`]);
});

test('実DB並行QAはPreviewの明示要求と専用identityがない場合に接続しない', async () => {
  for (const change of [
    { VERCEL_ENV: 'production' }, { VERCEL_ENV: 'development' }, { AUTH_MODE: 'google' },
    { CAKE_PREVIEW_PHASE: 'provisioning' }, { VERCEL_GIT_COMMIT_MESSAGE: '本文中の[cake-db-qa:csv-categories]だけ' },
    { VERCEL_DEPLOYMENT_ID: undefined }, { CAKE_PREVIEW_SOURCE_SHA: 'b'.repeat(40) },
    { CAKE_PREVIEW_DATABASE_HOST_SHA256: '0'.repeat(64) }, { CAKE_PREVIEW_PRODUCTION_HOST_SHA256: '0'.repeat(64) },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { CAKE_PREVIEW_KIND: 'main' },
  ]) {
    let constructed = false;
    const logs: string[] = [];
    const result = await runCsvCategoryDatabaseQa({ ...fixture, ...change }, {
      createClient: () => { constructed = true; throw new Error('接続禁止'); }, log: value => logs.push(value),
    });
    assert.equal(constructed, false); assert.equal(result.success, false);
    assert.equal(result.failures[0].stage, '接続前のPreview照合');
    assert.ok(!JSON.stringify({ result, logs }).includes('fixture-secret'));
  }
});

test('実DB並行QAは検証済みdirect endpointと厳密TLSを使い、接続エラー本文を公開しない', async () => {
  let ended = false;
  const logs: string[] = [];
  const result = await runCsvCategoryDatabaseQa(fixture, {
    log: value => logs.push(value),
    createClient(settings) {
      assert.equal(settings.host, host); assert.equal(settings.user, 'fixture');
      assert.deepEqual(settings.ssl, { rejectUnauthorized: true, servername: host });
      assert.equal(settings.enableChannelBinding, true);
      return {
        async connect() { throw Object.assign(new Error('fixture-secret postgres://sensitive-sentinel'), { code: '28P01' }); },
        async end() { ended = true; }, on() {}, async query() { assert.fail('接続失敗後はSQLを送らない'); },
      };
    },
  });
  assert.equal(result.success, false); assert.equal(ended, true);
  assert.deepEqual(result.failures, [{ stage: '独立接続とTLS', code: '28P01' }]);
  const publicResult = JSON.stringify({ result, logs });
  for (const secret of ['fixture-secret', 'sensitive-sentinel', 'postgres://']) assert.ok(!publicResult.includes(secret));
});


test('実DB並行QAはクライアントTLS暗号化・証明書検証を確認できない接続でSQLを始めない', async () => {
  for (const stream of [{ encrypted: false, authorized: true }, { encrypted: true, authorized: false }, {}]) {
    let queries = 0, closed = false;
    const result = await runCsvCategoryDatabaseQa(fixture, {
      log() {}, createClient() {
        return { connection: { stream }, async connect() {}, async end() { closed = true; }, on() {},
          async query(statement) {
            queries++;
            assert.ok(statement.startsWith('SET '), 'session timeout設定後、業務SQLの前に止める');
            return { rows: [] };
          },
        };
      },
    });
    assert.equal(result.success, false); assert.equal(closed, true); assert.equal(queries, 2);
    assert.equal(result.failures[0].stage, 'クライアントTLS暗号化・証明書確認');
  }
});

test('正規化の独立行markerも同じ専用DB/TLS境界を使い、文中markerは接続しない', async () => {
  for (const [message, allowed] of [
    ['正規化QA\n\n  [cake-db-qa:merchant-normalization]\t', true],
    ['説明 [cake-db-qa:merchant-normalization]', false],
  ] as const) {
    let connected = false, closed = false;
    const logs: string[] = [];
    const result = await runCsvCategoryDatabaseQa({ ...fixture, VERCEL_GIT_COMMIT_MESSAGE: message }, {
      log: line => logs.push(line), createClient(settings) {
        assert.equal(settings.host, host); assert.equal(settings.ssl.rejectUnauthorized, true);
        connected = true;
        return { async connect() { throw Object.assign(new Error('fixture-secret'), { code: '28P01' }); },
          async end() { closed = true; }, on() {}, async query() { assert.fail('接続失敗後のSQL禁止'); } };
      },
    });
    assert.equal(connected, allowed); assert.equal(closed, allowed); assert.equal(result.success, false);
    assert.equal(result.failures[0].stage, allowed ? '独立接続とTLS' : '接続前のPreview照合');
    assert.ok(!JSON.stringify({ result, logs }).includes('fixture-secret'));
  }
});

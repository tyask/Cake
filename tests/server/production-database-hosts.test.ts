import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isProductionDatabaseHostDigest, productionDatabaseHostDigests } from '../../lib/server/database/production-database-hosts.mjs';

const retainedProductionDigest = '600033d07eb267fe31096a1bb98d0c1809be7a0ef7a895ad3bcbc6daabbbf0f6';
const currentProductionDigest = '68939cf43ff8b955c8fd656808b1c252efe2ed5e4888e0f7a03f73c397f10f78';
const oldHost = 'ep-production-old.ap-southeast-1.aws.neon.tech';
const newHost = 'ep-production-new.ap-southeast-1.aws.neon.tech';
const nativeHost = 'ep-native-preview.ap-southeast-1.aws.neon.tech';
const digest = (host: string) => createHash('sha256').update(host).digest('hex');
const oldDigest = digest(oldHost), newDigest = digest(newHost), nativeDigest = digest(nativeHost);
const migratedConfiguration = { productionHostDigest: newDigest, productionHostDigests: [oldDigest, newDigest] };
const invalid = { message: 'PRODUCTION_DATABASE_HOSTS_INVALID' };

test('複数host設定を省略した従来設定ではscalar一件を保護する', () => {
  assert.deepEqual(productionDatabaseHostDigests({ productionHostDigest: oldDigest }), [oldDigest]);
});

test('本番scalarを切り替えても明示した旧・新hostを両方保護する', () => {
  assert.deepEqual(productionDatabaseHostDigests(migratedConfiguration), [oldDigest, newDigest]);
  assert.deepEqual(productionDatabaseHostDigests({ ...migratedConfiguration, productionHostDigest: oldDigest }), [oldDigest, newDigest]);
});

test('設定objectとscalarが欠落・型不正なら有効な配列があっても拒否する', () => {
  for (const configuration of [null, false, 1, 'configuration', [], {}, { productionHostDigests: [oldDigest] },
    Object.create({ productionHostDigest: oldDigest })]) {
    assert.throws(() => productionDatabaseHostDigests(configuration), invalid);
  }
  for (const value of [undefined, null, 1, [], {}, '', oldDigest.toUpperCase(), oldDigest.slice(1), `${oldDigest}0`, ` ${oldDigest}`, 'g'.repeat(64)]) {
    assert.throws(() => productionDatabaseHostDigests({ productionHostDigest: value, productionHostDigests: [oldDigest] }), invalid);
  }
});

test('明示した保護集合は非空配列とし各hashの型・形式と重複を検証する', () => {
  for (const value of [null, oldDigest, {}, new Set([oldDigest]), [], new Array(1), Object.assign(new Array(2), { 0: oldDigest }), [oldDigest, oldDigest],
    [oldDigest, undefined], [oldDigest, null], [oldDigest, 1], [oldDigest, {}], [oldDigest, []],
    [oldDigest, ''], [oldDigest, newDigest.toUpperCase()], [oldDigest, newDigest.slice(1)],
    [oldDigest, `${newDigest}0`], [oldDigest, `${newDigest}\n`], [oldDigest, 'g'.repeat(64)]]) {
    assert.throws(() => productionDatabaseHostDigests({ productionHostDigest: oldDigest, productionHostDigests: value }), invalid);
  }
});

test('保護集合から現在のscalarを除外した設定は拒否する', () => {
  assert.throws(() => productionDatabaseHostDigests({ productionHostDigest: newDigest, productionHostDigests: [oldDigest] }), invalid);
});

test('source設定は現用・保持旧本番hashを保護しNative Previewを保護集合へ混ぜない', () => {
  const configured = productionDatabaseHostDigests();
  assert.ok(configured.includes(retainedProductionDigest));
  assert.ok(configured.includes(currentProductionDigest));
  for (const value of configured) assert.equal(isProductionDatabaseHostDigest(value), true);
  for (const value of [nativeDigest, undefined, null, 1, {}, [], configured[0].toUpperCase(), ` ${configured[0]}`]) {
    assert.equal(isProductionDatabaseHostDigest(value), false);
  }
});

const fixtureSources = [
  'lib/server/database/production-database-hosts.mjs', 'lib/server/database/database-connection.mjs', 'lib/server/database/database-environment.ts',
  'lib/shared/transaction-record.ts', 'lib/shared/domain-values.ts',
  'lib/server/database/preview-fixture-base.mjs', 'lib/server/database/preview-fixture-reference.mjs',
  'scripts/preview/preview-model.ts', 'scripts/preview/preview-provider.ts', 'scripts/build/preview-provisioning.ts',
  'scripts/preview/preview-receipt.ts', 'scripts/preview/preview-verify-receipt.ts', 'scripts/task/task-workflow.ts',
  'scripts/qa/db/verify-csv-category-concurrency.ts', 'scripts/qa/db/csv-category-concurrency-scenarios.ts',
  'scripts/qa/db/merchant-normalization-scenarios.ts', 'scripts/qa/db/merchant-normalization-migration-scenario.ts',
  'scripts/db/preview-sample-data.ts',
  'staging.config.json',
];

/** Change source configuration only inside a fresh module graph and child process. */
function runWithSourceConfiguration(configuration: Record<string, unknown>, body: string): void {
  const directory = mkdtempSync(join(tmpdir(), 'cake-production-hosts-'));
  const root = new URL('../../', import.meta.url);
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  try {
    for (const name of fixtureSources) {
      const target = join(directory, name);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(new URL(name, root), target);
    }
    symlinkSync(fileURLToPath(new URL('node_modules', root)), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const source = JSON.parse(readFileSync(new URL('preview.config.json', root), 'utf8'));
    writeFileSync(join(directory, 'preview.config.json'), JSON.stringify({ ...source, ...configuration }));
    writeFileSync(join(directory, 'fixture.mts'), body);
    const result = spawnSync(process.execPath, ['--import', loader, join(directory, 'fixture.mts')], {
      cwd: directory, encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const fixturePrelude = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { databaseConnectionString } from './lib/server/database/database-connection.mjs';
import { isProductionDatabaseHostDigest } from './lib/server/database/production-database-hosts.mjs';
import { config, deployment, protocol } from './scripts/preview/preview-model.ts';
import { PreviewProvider } from './scripts/preview/preview-provider.ts';
import { provisioningBuild } from './scripts/build/preview-provisioning.ts';
import { parseReceipt, serializeReceipt } from './scripts/preview/preview-receipt.ts';
import { parseVerifyReceipt, serializeVerifyReceipt } from './scripts/preview/preview-verify-receipt.ts';
const oldHost = ${JSON.stringify(oldHost)}, newHost = ${JSON.stringify(newHost)}, nativeHost = ${JSON.stringify(nativeHost)};
const digest = host => createHash('sha256').update(host).digest('hex');
const oldDigest = digest(oldHost), newDigest = digest(newHost), nativeDigest = digest(nativeHost);
const operation = '20000000-0000-4000-8000-000000000002';
const generation = '10000000-0000-4000-8000-000000000001';
const source = { pr: 71, branch: 'codex/test', sha: 'a'.repeat(40), createdAt: '2026-10-16T00:00:00Z', state: 'open' };
const environment = {
  VERCEL_ENV: 'preview', AUTH_MODE: 'test', CAKE_PREVIEW_PHASE: 'application',
  CAKE_PREVIEW_REPOSITORY: config.repository, CAKE_PREVIEW_PR: String(source.pr),
  CAKE_PREVIEW_GENERATION: generation, CAKE_PREVIEW_DATABASE_BRANCH_ID: 'br-native',
  CAKE_PREVIEW_SOURCE_BRANCH: source.branch, VERCEL_GIT_COMMIT_REF: source.branch,
  CAKE_PREVIEW_SOURCE_SHA: source.sha, VERCEL_GIT_COMMIT_SHA: source.sha,
  CAKE_PREVIEW_PRODUCTION_HOST_SHA256: newDigest,
};
const database = hostDigest => ({ branchId: 'br-native', endpointId: 'ep-native', hostDigest });
const application = hostDigest => ({
  id: 'dpl_Native123', url: 'https://cake-native.vercel.app', sha: source.sha, branch: source.branch,
  pr: source.pr, generation, operation, phase: 'application', state: 'READY',
  createdAt: Date.parse('2026-10-16T00:02:00Z'), database: database(hostDigest),
});
const receipt = hostDigest => ({
  protocol, action: 'deploy', source, deployment: application(hostDigest), database: database(hostDigest),
  checkedAt: '2026-10-16T00:05:00Z', success: true, operation, runId: '123', runAttempt: 1, controlSha: 'b'.repeat(40),
});
const verifyReceipt = hostDigest => ({
  ...receipt(hostDigest), protocol: 'cake-preview-verify/v1', action: 'verify', expectedDeploymentId: 'dpl_Native123',
  success: false, failure: { stage: 'browser', code: 'PREVIEW_VERIFY_BROWSER_FAILED' },
});
`;

test('sourceの旧・新hostは注入された本番hashを偽装してもruntimeで拒否しNativeだけ許可する', () => {
  runWithSourceConfiguration(migratedConfiguration, fixturePrelude + `
    for (const host of [oldHost, newHost, nativeHost]) {
      const url = 'postgresql://user:private@' + host.replace('.', '-pooler.') + '/cake?sslmode=require';
      const input = { ...environment, CAKE_TEST_DATABASE_URL: url, CAKE_PREVIEW_DATABASE_HOST_SHA256: digest(host),
        CAKE_PREVIEW_PRODUCTION_HOST_SHA256: 'f'.repeat(64) };
      if (host === nativeHost) {
        assert.equal(isProductionDatabaseHostDigest(digest(host)), false);
        assert.equal(databaseConnectionString(input), url);
      } else {
        assert.equal(isProductionDatabaseHostDigest(digest(host)), true);
        assert.throws(() => databaseConnectionString(input), error => {
          assert.match(String(error), /PreviewとDB/);
          assert.ok(!String(error).includes('private') && !String(error).includes('postgresql://'));
          return true;
        });
      }
    }
  `);
});

test('不正なsource設定ではmodule読込時に停止する', () => {
  runWithSourceConfiguration({ productionHostDigest: newDigest, productionHostDigests: [oldDigest] }, `
    import assert from 'node:assert/strict';
    await assert.rejects(import('./lib/server/database/production-database-hosts.mjs'), { message: 'PRODUCTION_DATABASE_HOSTS_INVALID' });
  `);
});

test('準備用buildはsource集合内の旧・新本番hashだけを受理する', () => {
  runWithSourceConfiguration(migratedConfiguration, fixturePrelude + `
    const input = { ...environment, CAKE_PREVIEW_PHASE: 'provisioning',
      CAKE_PREVIEW_DATABASE_BRANCH_ID: '', CAKE_PREVIEW_DATABASE_HOST_SHA256: '' };
    for (const value of [oldDigest, newDigest]) {
      assert.equal(provisioningBuild({ ...input, CAKE_PREVIEW_PRODUCTION_HOST_SHA256: value }), true);
    }
    for (const value of [nativeDigest, 'f'.repeat(64), undefined]) {
      assert.throws(() => provisioningBuild({ ...input, CAKE_PREVIEW_PRODUCTION_HOST_SHA256: value }), /Preview準備用ビルド/);
    }
  `);
});

test('Deployment metadataと通常・検証receiptは旧・新本番hashを拒否しNativeを受理する', () => {
  runWithSourceConfiguration(migratedConfiguration, fixturePrelude + `
    const metadata = hostDigest => ({
      id: 'dpl_Native123', url: 'cake-native.vercel.app', projectId: config.vercelProjectId, target: null,
      gitSource: { type: 'github', repoId: config.repositoryId, ref: source.branch, sha: source.sha },
      meta: { cakePreviewProtocol: protocol, cakePreviewRepository: config.repository, cakePreviewPr: String(source.pr),
        cakePreviewGeneration: generation, cakePreviewOperation: operation, cakePreviewPhase: 'application',
        cakePreviewDatabaseBranch: 'br-native', cakePreviewDatabaseEndpoint: 'ep-native', cakePreviewDatabaseDigest: hostDigest },
      createdAt: Date.parse('2026-10-16T00:02:00Z'), readyState: 'READY',
    });
    assert.deepEqual(deployment(metadata(nativeDigest), source), application(nativeDigest));
    assert.deepEqual(parseReceipt(serializeReceipt(receipt(nativeDigest))), receipt(nativeDigest));
    assert.deepEqual(parseVerifyReceipt(serializeVerifyReceipt(verifyReceipt(nativeDigest))), verifyReceipt(nativeDigest));
    for (const value of [oldDigest, newDigest]) {
      assert.throws(() => deployment(metadata(value), source), { message: 'PREVIEW_DATABASE_IDENTITY' });
      assert.throws(() => parseReceipt(JSON.stringify(receipt(value))), { message: 'PREVIEW_RECEIPT_INVALID' });
      assert.throws(() => serializeReceipt(receipt(value)), { message: 'PREVIEW_RECEIPT_INVALID' });
      assert.throws(() => parseVerifyReceipt(JSON.stringify(verifyReceipt(value))), { message: 'PREVIEW_VERIFY_RECEIPT_INVALID' });
      assert.throws(() => serializeVerifyReceipt(verifyReceipt(value)), { message: 'PREVIEW_VERIFY_RECEIPT_INVALID' });
    }
  `);
});

test('Native provider一覧照合は旧・新本番endpointを拒否し専用Previewを受理する', () => {
  runWithSourceConfiguration(migratedConfiguration, fixturePrelude + `
    for (const host of [oldHost, newHost, nativeHost]) {
      const branch = { id: 'br-native', project_id: config.neonProjectId, name: 'preview/' + source.branch,
        parent_id: config.neonParentBranchId, default: false, protected: false, created_at: '2026-10-16T00:01:00Z' };
      const endpoint = { id: 'ep-native', project_id: config.neonProjectId, branch_id: branch.id, type: 'read_write', host };
      const calls = [];
      const provider = new PreviewProvider(async (provider, path, method = 'GET') => {
        calls.push([provider, path, method]);
        assert.equal(provider, 'neon');
        assert.equal(method, 'GET');
        if (path.includes('/branches?')) return { branches: [branch], pagination: {} };
        if (path.endsWith('/endpoints')) return { endpoints: [endpoint] };
        if (path.endsWith('/branches/br-native')) return { branch };
        if (path.endsWith('/endpoints/ep-native')) return { endpoint };
        assert.fail('Unexpected fixture request');
      });
      if (host === nativeHost) {
        assert.deepEqual(await provider.database(source, Date.parse(source.createdAt)), database(nativeDigest));
        assert.equal(calls.length, 4);
      } else {
        await assert.rejects(provider.database(source, Date.parse(source.createdAt)), { message: 'PREVIEW_DATABASE_IDENTITY' });
        assert.equal(calls.length, 2);
      }
    }
  `);
});

test('実DB QA runnerは旧・新の本番hash注入だけを接続前照合で受理する', () => {
  runWithSourceConfiguration(migratedConfiguration, fixturePrelude + `
    const { runCsvCategoryDatabaseQa } = await import('./scripts/qa/db/verify-csv-category-concurrency.ts');
    for (const marker of ['[cake-db-qa:csv-categories]', '[cake-db-qa:merchant-normalization]']) {
      for (const value of [oldDigest, newDigest, nativeDigest, 'f'.repeat(64), undefined]) {
        const allowed = value === oldDigest || value === newDigest;
        let clients = 0, ended = 0, queries = 0;
        const logs = [];
        const input = { ...environment, VERCEL_DEPLOYMENT_ID: 'dpl_Native123', VERCEL_GIT_COMMIT_MESSAGE: marker,
          CAKE_TEST_DATABASE_URL: 'postgresql://fixture:private-password@' + nativeHost.replace('.', '-pooler.') + '/cake?sslmode=require',
          CAKE_PREVIEW_DATABASE_HOST_SHA256: nativeDigest, CAKE_PREVIEW_PRODUCTION_HOST_SHA256: value };
        const result = await runCsvCategoryDatabaseQa(input, {
          log: line => logs.push(line),
          createClient(settings) {
            clients++;
            assert.equal(settings.host, nativeHost);
            assert.equal(settings.password, 'private-password');
            assert.deepEqual(settings.ssl, { rejectUnauthorized: true, servername: nativeHost });
            assert.equal(settings.enableChannelBinding, true);
            return {
              async connect() { throw Object.assign(new Error('private-password postgresql://private-fixture'), { code: '28P01' }); },
              async end() { ended++; }, on() {}, async query() { queries++; assert.fail('接続失敗後のSQL禁止'); },
            };
          },
        });
        assert.equal(clients, allowed ? 1 : 0);
        assert.equal(ended, clients);
        assert.equal(queries, 0);
        assert.equal(result.success, false);
        assert.equal(result.failures[0].stage, allowed ? '独立接続とTLS' : '接続前のPreview照合');
        if (allowed) assert.deepEqual(result.failures, [{ stage: '独立接続とTLS', code: '28P01' }]);
        const publicResult = JSON.stringify({ result, logs });
        for (const secret of ['private-password', 'private-fixture', 'postgresql://']) assert.ok(!publicResult.includes(secret));
      }
    }
  `);
});

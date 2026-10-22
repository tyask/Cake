import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { databaseConnectionString, previewDatabaseGuardSql, previewDatabaseIdentity } from '../lib/database-environment';
import { config, hostDigest } from './preview-model';
import { verifyCsvCategoryConcurrency, type CsvCategoryConcurrencyReport, type CsvCategoryDatabase } from './csv-category-concurrency-scenarios';
import { verifyMerchantNormalizationScenarios, type MerchantNormalizationReport } from './merchant-normalization-scenarios';
import { verifyMerchantNormalizationMigration, type MerchantNormalizationMigrationReport } from './merchant-normalization-migration-scenario';

const requestMarker = '[cake-db-qa:csv-categories]';
const normalizationMarker = '[cake-db-qa:merchant-normalization]';
type Environment = Readonly<Record<string, string | undefined>>;
type QaClient = CsvCategoryDatabase & { connect(): Promise<void>; end(): Promise<void>; on(name: 'error', listener: () => void): unknown;
  connection?: { stream?: { encrypted?: boolean; authorized?: boolean } } };
type ClientSettings = { host: string; port: number; user: string; password: string; database: string; ssl: { rejectUnauthorized: true; servername: string };
  enableChannelBinding: true; connectionTimeoutMillis: number; query_timeout: number; application_name: string };
type Options = { createClient?: (settings: ClientSettings) => QaClient; log?: (message: string) => void };
const failureCode = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^(?:[0-9A-Z]{5}|E[A-Z_]{1,30})$/.test(code) ? code : 'QA_VALIDATION_FAILED';
};

/** Connections, provider tokens and business rows never appear in the returned/logged evidence. */
export async function runCsvCategoryDatabaseQa(env: Environment, options: Options = {}) {
  const started = performance.now(), clients: QaClient[] = [];
  const log = options.log ?? console.log;
  let stage = '接続前のPreview照合', success = false, scenario: CsvCategoryConcurrencyReport | undefined;
  let normalization: MerchantNormalizationReport | undefined, normalizationMigration: MerchantNormalizationMigrationReport | undefined;
  let normalizationEvidence: { migrationSha256: string; scenarioSha256: string; unicodeVersion: string } | undefined;
  let baseline: Map<string, unknown> | undefined;
  let baselinePreserved = false, connectionError = false, closeSucceeded = true;
  const failures: { stage: string; code: string }[] = [];
  const publicIdentity: Record<string, unknown> = {};
  let tablesVerified = 0, migrationsVerified = 0, functionsVerified = 0, serverVersion = '';
  const runId = randomUUID(), prefix = `verify-csv-category-${runId}`;
  async function snapshot(client: QaClient) {
    const names = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => String(row.tablename));
    assert.ok(names.length > 0 && names.length <= 100 && names.every(name => /^[a-z_][a-z0-9_]*$/.test(name)));
    const data = new Map<string, unknown>();
    for (const name of names) {
      const rows = (await client.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM public."${name}" t`)).rows;
      assert.equal(rows.length, 1); data.set(name, rows[0].data);
    }
    return data;
  }
  try {
    assert.equal(env.VERCEL_ENV, 'preview'); assert.equal(env.AUTH_MODE, 'test');
    assert.equal(env.CAKE_PREVIEW_PHASE, 'application');
    const markers = env.VERCEL_GIT_COMMIT_MESSAGE?.split(/\r?\n/).map(line => line.trim()) ?? [];
    const normalizationRequested = markers.includes(normalizationMarker);
    assert.ok(normalizationRequested || markers.includes(requestMarker));
    assert.match(env.VERCEL_DEPLOYMENT_ID ?? '', /^dpl_[A-Za-z0-9]+$/);
    assert.equal(env.CAKE_PREVIEW_PRODUCTION_HOST_SHA256, config.productionHostDigest);
    assert.ok(!env.CAKE_PREVIEW_KIND && env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    const identity = previewDatabaseIdentity(env); assert.ok(identity);
    const connection = databaseConnectionString(env), url = new URL(connection);
    assert.equal(identity.databaseHost.split('.')[0], url.hostname.replace(/-pooler(?=\.)/, '').split('.')[0]);
    Object.assign(publicIdentity, { pr: identity.pr, sha: env.CAKE_PREVIEW_SOURCE_SHA, branch: identity.sourceBranch,
      deploymentId: env.VERCEL_DEPLOYMENT_ID, generation: identity.generation, databaseBranchId: identity.branchId,
      databaseEndpointId: identity.databaseHost.split('.')[0], databaseHostDigest: hostDigest(identity.databaseHost) });
    log(`Cake DB QA start: ${JSON.stringify({ protocol: 'cake-csv-category-db-qa/v1', runId, prefix, ...publicIdentity })}`);
    stage = '独立接続とTLS';
    for (let index = 0; index < 3; index++) {
      // Use the validated endpoint's direct host: transaction poolers cannot pin a session.
      // Construct explicit fields so URL SSL options cannot weaken certificate verification.
      const settings: ClientSettings = { host: identity.databaseHost, port: 5432, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
        database: identity.databaseName, ssl: { rejectUnauthorized: true, servername: identity.databaseHost }, enableChannelBinding: true,
        connectionTimeoutMillis: 15000, query_timeout: 45000, application_name: `cake-csv-category-qa-${runId}-${index}` };
      const client = options.createClient ? options.createClient(settings) : new Client(settings) as unknown as QaClient;
      clients.push(client); client.on('error', () => { connectionError = true; }); await client.connect();
      await client.query("SET statement_timeout='30000ms'"); await client.query("SET lock_timeout='15000ms'");
      // Neon terminates client TLS at its proxy; pg_stat_ssl describes the internal
      // proxy-to-backend hop. Verify the actual Node TLS socket and certificate here.
      stage = 'クライアントTLS暗号化・証明書確認';
      assert.equal(client.connection?.stream?.encrypted, true);
      assert.equal(client.connection?.stream?.authorized, true);
      stage = '各接続の既存marker照合';
      // This DO block is autocommitted before any scenario transaction; its advisory lock is released.
      await client.query(previewDatabaseGuardSql(identity, false));
      const lock = (await client.query("SELECT count(*)::int AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'")).rows;
      assert.equal(lock[0].n, 0);
      stage = '独立接続とTLS';
    }
    assert.equal(new Set((await Promise.all(clients.map(client => client.query('SELECT pg_backend_pid() AS pid')))).map(value => value.rows[0].pid)).size, 3);
    stage = '適用migrationと実関数照合';
    serverVersion = String((await clients[0].query("SELECT current_setting('server_version') AS version")).rows[0].version);
    const directory = new URL('../db/migrations/', import.meta.url);
    const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    const applied = (await clients[0].query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(row => String(row.name));
    assert.deepEqual(applied, files); migrationsVerified = files.length;
    const migration = await readFile(new URL('018_import_categories.sql', directory), 'utf8');
    for (const name of ['cake_assert_transaction_categories','cake_transaction_category_guard','cake_inserted_transaction_categories_guard']) {
      const delimiter = `$${name}$`, pieces = migration.split(delimiter);
      assert.equal(pieces.length, 3);
      const actual = (await clients[0].query("SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1", [name])).rows;
      assert.equal(actual.length, 1); assert.equal(String(actual[0].prosrc).trim(), pieces[1].trim()); functionsVerified++;
    }
    stage = '既存テスト利用者と非対象データ取得';
    const users = (await clients[0].query("SELECT id,email,is_enabled,is_admin FROM app_users WHERE id IN ('test-user-a','test-user-b') ORDER BY id")).rows;
    assert.deepEqual(users, [
      { id: 'test-user-a', email: 'test-a@cake.local', is_enabled: true, is_admin: true },
      { id: 'test-user-b', email: 'test-b@cake.local', is_enabled: true, is_admin: false },
    ]);
    baseline = await snapshot(clients[0]); tablesVerified = baseline.size;
    stage = '並行シナリオ';
    let emitted = 0;
    scenario = await verifyCsvCategoryConcurrency(clients[0], clients[1], 'test-user-a', 'test-user-b', {
      prefix, expectedHead: env.CAKE_PREVIEW_SOURCE_SHA!, observer: clients[2],
      onProgress(value) {
        while (emitted < value.cases.length && value.cases[emitted].status !== 'running') {
          log(`Cake DB QA case: ${JSON.stringify({ protocol: 'cake-csv-category-db-qa/v1', runId, sha: env.CAKE_PREVIEW_SOURCE_SHA, ...value.cases[emitted++] })}`);
        }
      },
    });
    assert.equal(scenario.success, true);
    if (normalizationRequested) {
      stage = '取引先正規化の実関数照合';
      const normalizationSql = await readFile(new URL('019_merchant_normalization.sql', directory), 'utf8');
      const functionBody = normalizationSql.split('$cake_normalize_merchant$');
      assert.equal(functionBody.length, 3);
      const actual = (await clients[0].query("SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='cake_normalize_merchant'")).rows;
      assert.equal(actual.length, 1); assert.equal(String(actual[0].prosrc).trim(), functionBody[1].trim()); functionsVerified++;
      normalizationEvidence = {
        migrationSha256: createHash('sha256').update(normalizationSql).digest('hex'),
        scenarioSha256: createHash('sha256').update(await readFile(new URL('./merchant-normalization-scenarios.ts', import.meta.url))).digest('hex'),
        unicodeVersion: String((await clients[0].query('SELECT unicode_version() AS version')).rows[0].version),
      };
      stage = '取引先正規化の実DBシナリオ';
      normalization = await verifyMerchantNormalizationScenarios(clients[0], {
        actorA: 'test-user-a', actorB: 'test-user-b', prefix: `verify-merchant-${runId}`,
        async runCase(name, run) {
          const at = performance.now();
          await run();
          log(`Cake DB QA normalization case: ${JSON.stringify({ protocol: 'cake-csv-category-db-qa/v1', runId, sha: env.CAKE_PREVIEW_SOURCE_SHA,
            name, status: 'passed', seconds: (performance.now() - at) / 1000 })}`);
        },
      });
      assert.equal(normalization.success, true);
      stage = '取引先正規化の実migration・DDL待機';
      normalizationMigration = await verifyMerchantNormalizationMigration(clients[0], clients[1], clients[2], normalizationSql, { prefix: `verify-merchant-${runId}` });
      assert.equal(normalizationMigration.success, true);
      log(`Cake DB QA normalization migration: ${JSON.stringify({ protocol: 'cake-csv-category-db-qa/v1', runId, sha: env.CAKE_PREVIEW_SOURCE_SHA, ...normalizationMigration })}`);
      stage = '取引先正規化の既存全行照合';
      const invalid = (await clients[0].query('SELECT count(*)::int AS n FROM transactions WHERE merchant_normalized IS DISTINCT FROM cake_normalize_merchant(merchant)')).rows;
      assert.equal(invalid[0].n, 0);
    }
    stage = '後片付け後の全既存データ照合';
    assert.deepEqual(await snapshot(clients[0]), baseline); baselinePreserved = true;
    stage = '終了marker照合';
    for (const client of clients) await client.query(previewDatabaseGuardSql(identity, false));
    assert.equal(connectionError, false); success = true;
  } catch (error) {
    failures.push({ stage, code: failureCode(error) });
    // Scenarios clean up their own IDs before returning. Never delete unrelated data here.
    if (baseline && clients[0]) {
      try { assert.deepEqual(await snapshot(clients[0]), baseline); baselinePreserved = true; }
      catch { failures.push({ stage: '非対象データ最終照合', code: 'BASELINE_NOT_VERIFIED' }); }
    }
  } finally {
    const closed = await Promise.allSettled(clients.map(client => client.end()));
    closeSucceeded = closed.every(value => value.status === 'fulfilled');
    if (!closeSucceeded) failures.push({ stage: '接続終了', code: 'CLOSE_FAILED' });
  }
  const result = { protocol: 'cake-csv-category-db-qa/v1', runId, prefix, ...publicIdentity,
    success: success && closeSucceeded && failures.length === 0, serverVersion, node: process.version,
    elapsedMs: Math.round(performance.now() - started), migrationsVerified, functionsVerified, tablesVerified,
    baselinePreserved, tlsVerified: clients.length === 3 && serverVersion !== '', closeSucceeded, failures,
    normalization: normalization ?? null, normalizationMigration: normalizationMigration ?? null, normalizationEvidence: normalizationEvidence ?? null,
    scenario: scenario ? { success: scenario.success, head: scenario.head, sourceSha256: scenario.sourceSha256, migrationSha256: scenario.migrationSha256,
      backendPids: scenario.backendPids, sqlContract: scenario.sqlContract, failures: scenario.failures, cleanup: scenario.cleanup, seconds: scenario.seconds,
      cases: scenario.cases.map(item => ({ name: item.name, status: item.status, lockWaitObserved: item.wait?.observed ?? false, cleanup: item.cleanup })) } : null };
  log(`Cake DB QA result: ${JSON.stringify(result)}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCsvCategoryDatabaseQa(process.env).then(result => { if (!result.success) process.exitCode = 1; }, () => {
    console.error('Cake DB QA: 実DB並行検証を完了できませんでした。秘密値・生例外は表示しません。'); process.exitCode = 1;
  });
}

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBinding, assertProductionCredentials, config, connection, fail, hash, MigrationError, productionApi, record,
  type Api, type Connection, type Environment } from './production-db-migration-provider';
import { appTables, databaseClient, inventory, startSnapshot, type Snapshot, type Sql } from './production-db-migration-inventory';
import { assertCurrentMain, assertUnconnectedTarget, childEnvironment } from './production-db-migration';
import { verifyProductionSchemaScenarios, type ProductionSchemaScenarioReport } from './production-db-schema-scenarios';

export const schemaQaProtocol = 'cake-production-db-schema-qa/v1' as const;
export const schemaQaWorkflow = '.github/workflows/production-db-schema-qa.yml';
export const migration019 = Object.freeze({ name: '019_merchant_normalization.sql',
  sha256: '007fd328d1c4d94525c6e22a05af544811ec108874b047aaf51595b2b83a87ad' });
export type SchemaQaContext = { controlSha: string; operation: string; runId: string; runAttempt: number };
const stages = ['credentials','main-check','source-binding','target-binding','target-store','target-connection','target-connect',
  'target-preflight','pre-write-bindings','scenarios','target-verification','post-bindings','session-cleanup','completed'] as const;
export type SchemaQaReceipt = SchemaQaContext & { protocol: typeof schemaQaProtocol; configHash: string;
  targetProject: string; targetBranch: string; targetEndpoint: string; targetHostDigest: string; migrationSha256: string;
  startedAt: string; checkedAt: string; success: boolean; stage: typeof stages[number]; code: string; sqlstate: string | null;
  report?: ProductionSchemaScenarioReport; sessionsClosed: boolean };
export type SchemaQaDependencies = { api: Api; client: (connection: Connection) => Sql; head: () => string; now: () => string;
  inspect: typeof inventory; begin: typeof startSnapshot; receiptPath: string; binding: typeof assertBinding;
  resolveConnection: typeof connection; scenarios: typeof verifyProductionSchemaScenarios };
const resultPath = resolve('.cake/production-db-schema-qa-result.json');
const fullSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const decimal = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fixedCodes = new Set(['FAILED','SOURCE_CREDENTIALS_MISSING','TARGET_CREDENTIALS_MISSING','SOURCE_CREDENTIALS_INVALID',
  'TARGET_CREDENTIALS_INVALID','CREDENTIALS_NOT_SEPARATED','CREDENTIALS_MISSING','MAIN_CHANGED','TARGET_CONNECTED',
  'INVALID_RESPONSE','INVALID_REQUEST','PROVIDER_BINDING','PROVIDER_CHANGED','INCOMPLETE_INVENTORY','CONNECTION_BINDING',
  'DATABASE_BINDING','INVALID_INVENTORY','UNKNOWN_STRUCTURE','AUTH_STRUCTURE','AUTH_DATA_PRESENT','UNSUPPORTED_SCHEMA',
  'UNSUPPORTED_PRIVILEGES','UNSUPPORTED_EXTENSION','MANAGED_DEFAULT_ACL','DATABASE_LIMIT','INVALID_IDENTIFIER',
  'SCHEMA_QA_LEDGER','SCHEMA_QA_PREREQUISITES','SCHEMA_QA_DATASET','SCHEMA_QA_MIGRATION_SOURCE','SCHEMA_QA_SCENARIOS_FAILED',
  'SCHEMA_QA_TARGET_CHANGED','SCHEMA_QA_SESSION_CLEANUP','SCHEMA_QA_INDEPENDENT_SESSIONS'].map(code => `PRODUCTION_MIGRATION_${code}`));
function allowedCode(code: unknown): code is string {
  return typeof code === 'string' && (code === 'OK' || fixedCodes.has(code)
    || /^PRODUCTION_MIGRATION_PROVIDER_(?:NEON|VERCEL|GITHUB)_(?:HTTP_[1-5][0-9]{2}|TRANSPORT|INVALID_STATUS|JSON)$/.test(code));
}
function publicCode(error: unknown): string {
  return error instanceof MigrationError && allowedCode(error.message) ? error.message : 'PRODUCTION_MIGRATION_FAILED';
}
function publicSqlstate(error: unknown): string | null {
  const value = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value) ? value : null;
}

/** No provider or SQL access is allowed before this exact main/dispatch provenance check. */
export function schemaQaContext(environment: Environment, rawEvent: unknown, head: string): SchemaQaContext {
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== config.repository
    || environment.GITHUB_REPOSITORY_ID !== String(config.repositoryId) || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.GITHUB_WORKFLOW_REF !== `${config.repository}/${schemaQaWorkflow}@refs/heads/main`
    || !fullSha(environment.GITHUB_SHA) || head !== environment.GITHUB_SHA || !decimal(environment.GITHUB_RUN_ID)
    || environment.GITHUB_RUN_ATTEMPT !== '1') return fail('UNTRUSTED_WORKFLOW');
  const event = record(rawEvent), repository = record(event.repository), inputs = record(event.inputs);
  if (repository.full_name !== config.repository || repository.id !== config.repositoryId
    || Object.keys(inputs).length !== 2 || Object.keys(inputs).some(key => !['controlSha','operation'].includes(key))
    || !fullSha(inputs.controlSha) || inputs.controlSha !== environment.GITHUB_SHA || !uuid(inputs.operation)) return fail('UNTRUSTED_WORKFLOW');
  return { controlSha: inputs.controlSha, operation: inputs.operation, runId: environment.GITHUB_RUN_ID, runAttempt: 1 };
}

const scenarioStages = ['pre','snapshot','scratch','copy','race','schema','repeat','rollback','restore'];
function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail('INVALID_RECEIPT');
  return Number(value);
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return fail('INVALID_RECEIPT');
  return value;
}
function numbers(value: unknown, maximum: number): number[] {
  if (!Array.isArray(value) || value.length > maximum) return fail('INVALID_RECEIPT');
  return value.map(nonnegative);
}
/** Rebuild the report field-by-field so nested raw errors or rows cannot enter a notice. */
export function projectSchemaQaReport(value: ProductionSchemaScenarioReport): ProductionSchemaScenarioReport {
  if (!Array.isArray(value.cases) || value.cases.length > 10 || !Array.isArray(value.failures) || value.failures.length > 12) return fail('INVALID_RECEIPT');
  if (value.hashes !== null && (!value.hashes || typeof value.hashes !== 'object' || Array.isArray(value.hashes))) return fail('INVALID_RECEIPT');
  const hashes = value.hashes && Object.fromEntries(['data','schema','acl','ledger','owners'].map(key => {
    const member = value.hashes![key as keyof NonNullable<typeof value.hashes>];
    if (typeof member !== 'string' || !/^[a-f0-9]{64}$/.test(member)) return fail('INVALID_RECEIPT');
    return [key, member];
  })) as ProductionSchemaScenarioReport['hashes'];
  const report: ProductionSchemaScenarioReport = { success: boolean(value.success), cases: value.cases.map(item => {
    if (!scenarioStages.includes(item.n)) return fail('INVALID_RECEIPT');
    return { n: item.n, ms: nonnegative(item.ms) };
  }), pids: numbers(value.pids, 3), counts: numbers(value.counts, appTables.length), hashes,
  scratch: value.scratch === null ? null : { success: boolean(value.scratch.success), cases: nonnegative(value.scratch.cases), ms: nonnegative(value.scratch.ms),
    waitMs: nonnegative(value.scratch.waitMs), exclusive: boolean(value.scratch.exclusive), cleanup: value.scratch.cleanup === null ? null : numbers(value.scratch.cleanup, 4), restored: boolean(value.scratch.restored) },
  race: value.race === null ? null : { queries: numbers(value.race.queries, 2), reads: numbers(value.race.reads, 2), writer: nonnegative(value.race.writer),
    waiter: nonnegative(value.race.waiter), ddl: boolean(value.race.ddl), advisory: boolean(value.race.advisory), ms: nonnegative(value.race.ms) },
  repeat: value.repeat === null ? null : { reads: nonnegative(value.repeat.reads), queries: nonnegative(value.repeat.queries) },
  unchanged: { scratch: boolean(value.unchanged.scratch), migration: boolean(value.unchanged.migration), repeat: boolean(value.unchanged.repeat) },
  mismatches: value.mismatches === null ? null : nonnegative(value.mismatches), restored: boolean(value.restored),
  failures: value.failures.map(item => {
    if (!scenarioStages.includes(item.stage) || item.sqlstate !== null && (typeof item.sqlstate !== 'string' || !/^[0-9A-Z]{5}$/.test(item.sqlstate))) return fail('INVALID_RECEIPT');
    return { stage: item.stage, sqlstate: item.sqlstate };
  }), ms: nonnegative(value.ms) };
  if (report.success && (report.pids.length !== 3 || report.pids.some(pid => pid === 0) || new Set(report.pids).size !== 3
    || report.counts.length !== appTables.length || report.counts[appTables.indexOf('schema_migrations')] !== 18
    || JSON.stringify(report.cases.map(item => item.n)) !== '["scratch","copy","race","schema","repeat"]'
    || !report.hashes || report.failures.length || !report.restored
    || !report.scratch?.success || report.scratch.cases !== 3 || !report.scratch.restored || !report.scratch.exclusive || report.scratch.cleanup?.length !== 4
    || report.scratch.cleanup.some(count => count !== 0) || report.mismatches !== 0
    || Object.values(report.unchanged).some(value => value !== true) || !report.race?.ddl || !report.race.advisory
    || JSON.stringify(report.race.reads) !== '[1,1]' || JSON.stringify(report.race.queries) !== '[3,3]'
    || !report.pids.slice(0,2).includes(report.race.writer) || !report.pids.slice(0,2).includes(report.race.waiter)
    || report.race.writer === report.race.waiter || report.repeat?.reads !== 0 || report.repeat.queries !== 2)) return fail('INVALID_RECEIPT');
  return report;
}
export function serializeSchemaQaReceipt(value: SchemaQaReceipt): string {
  const result: SchemaQaReceipt = { protocol: schemaQaProtocol, controlSha: value.controlSha, operation: value.operation,
    runId: value.runId, runAttempt: value.runAttempt, configHash: hash(JSON.stringify(config)), targetProject: config.target.projectId,
    targetBranch: config.target.branchId, targetEndpoint: config.target.endpointId, targetHostDigest: config.target.hostDigest,
    migrationSha256: migration019.sha256, startedAt: value.startedAt, checkedAt: value.checkedAt, success: boolean(value.success),
    stage: value.stage, code: value.code, sqlstate: value.sqlstate, report: value.report === undefined ? undefined : projectSchemaQaReport(value.report),
    sessionsClosed: boolean(value.sessionsClosed) };
  if (value.protocol !== result.protocol || value.configHash !== result.configHash || value.targetProject !== result.targetProject
    || value.targetBranch !== result.targetBranch || value.targetEndpoint !== result.targetEndpoint || value.targetHostDigest !== result.targetHostDigest
    || value.migrationSha256 !== result.migrationSha256 || !fullSha(result.controlSha) || !uuid(result.operation) || !decimal(result.runId)
    || result.runAttempt !== 1 || !stages.includes(result.stage) || !allowedCode(result.code)
    || result.sqlstate !== null && (typeof result.sqlstate !== 'string' || !/^[0-9A-Z]{5}$/.test(result.sqlstate))
    || [result.startedAt,result.checkedAt].some(time => !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)
    || Date.parse(result.checkedAt) < Date.parse(result.startedAt)
    || result.success && (result.code !== 'OK' || result.stage !== 'completed' || result.sqlstate !== null || !result.report?.success || !result.sessionsClosed)) return fail('INVALID_RECEIPT');
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text) > 4096) return fail('RECEIPT_TOO_LARGE');
  return text;
}

const prerequisitesSql = `SELECT
  EXISTS(SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname='pg_catalog' AND c.collname='pg_unicode_fast') AS unicode_fast,
  EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='cake_normalize_merchant') AS function_exists,
  EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='transactions' AND a.attname='merchant_normalized' AND NOT a.attisdropped) AS column_exists,
  to_regclass('public.transactions_workspace_merchant_normalized_idx') IS NOT NULL AS index_exists`;
function assertDataset(snapshot: Snapshot, ledger: string[]): void {
  if (snapshot.empty || JSON.stringify(snapshot.tables) !== JSON.stringify(appTables) || snapshot.summary.publicTables !== appTables.length
    || snapshot.summary.authRows !== 0 || Math.floor(snapshot.summary.version / 10000) !== config.target.majorVersion
    || JSON.stringify(snapshot.extensions) !== '["pgcrypto","plpgsql"]') return fail('SCHEMA_QA_DATASET');
  if (JSON.stringify(snapshot.ledger) !== JSON.stringify(ledger) || snapshot.summary.counts[appTables.indexOf('schema_migrations')] !== ledger.length) return fail('SCHEMA_QA_LEDGER');
}
export async function runSchemaQa(environment: Environment = process.env, overrides: Partial<SchemaQaDependencies> = {}): Promise<SchemaQaReceipt> {
  await mkdir(resolve('.cake'), { recursive: true, mode: 0o700 });
  const dependencies: SchemaQaDependencies = { api: productionApi(environment), client: databaseClient,
    head: () => execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8', env: childEnvironment(), stdio: ['ignore','pipe','ignore'] }).trim(),
    now: () => new Date().toISOString(), inspect: inventory, begin: startSnapshot, receiptPath: resultPath,
    binding: assertBinding, resolveConnection: connection, scenarios: verifyProductionSchemaScenarios, ...overrides };
  await rm(dependencies.receiptPath, { force: true });
  if (!environment.GITHUB_EVENT_PATH) return fail('UNTRUSTED_WORKFLOW');
  const request = schemaQaContext(environment, JSON.parse(await readFile(environment.GITHUB_EVENT_PATH, 'utf8')), dependencies.head());
  const receipt: SchemaQaReceipt = { ...request, protocol: schemaQaProtocol, configHash: hash(JSON.stringify(config)),
    targetProject: config.target.projectId, targetBranch: config.target.branchId, targetEndpoint: config.target.endpointId,
    targetHostDigest: config.target.hostDigest, migrationSha256: migration019.sha256, startedAt: dependencies.now(), checkedAt: dependencies.now(),
    success: false, stage: 'credentials', code: 'PRODUCTION_MIGRATION_FAILED', sqlstate: null, sessionsClosed: true };
  const clients: Sql[] = [];
  const bindings = async () => {
    await assertCurrentMain(dependencies.api, { ...request, action: 'inventory' });
    await dependencies.binding(dependencies.api, config.source); await dependencies.binding(dependencies.api, config.target);
    await assertUnconnectedTarget(dependencies.api);
  };
  try {
    assertProductionCredentials(environment);
    receipt.stage = 'main-check'; await assertCurrentMain(dependencies.api, { ...request, action: 'inventory' });
    receipt.stage = 'source-binding'; await dependencies.binding(dependencies.api, config.source);
    receipt.stage = 'target-binding'; await dependencies.binding(dependencies.api, config.target);
    receipt.stage = 'target-store'; await assertUnconnectedTarget(dependencies.api);
    receipt.stage = 'target-connection';
    // Source is intentionally never passed to connection() or databaseClient().
    const targetConnection = await dependencies.resolveConnection(dependencies.api, config.target);
    for (let index = 0; index < 3; index++) clients.push(dependencies.client(targetConnection));
    if (new Set(clients).size !== 3) return fail('SCHEMA_QA_INDEPENDENT_SESSIONS');
    receipt.stage = 'target-connect';
    for (const client of clients) await client.connect();
    const observer = clients[2];
    receipt.stage = 'target-preflight';
    await dependencies.begin(observer, config.target);
    const before = await dependencies.inspect(observer, config.target);
    const expectedLedger = (await readdir(resolve('db/migrations'))).filter(name => /^0(?:0[1-9]|1[0-8])_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (expectedLedger.length !== 18) return fail('SCHEMA_QA_LEDGER');
    assertDataset(before, expectedLedger);
    const prerequisites = (await observer.query(prerequisitesSql)).rows;
    if (prerequisites.length !== 1 || prerequisites[0].unicode_fast !== true || prerequisites[0].function_exists !== false
      || prerequisites[0].column_exists !== false || prerequisites[0].index_exists !== false) return fail('SCHEMA_QA_PREREQUISITES');
    await observer.query('ROLLBACK');
    const sql = await readFile(resolve('db/migrations', migration019.name), 'utf8');
    if (hash(sql) !== migration019.sha256) return fail('SCHEMA_QA_MIGRATION_SOURCE');
    receipt.stage = 'pre-write-bindings'; await bindings();
    receipt.stage = 'scenarios';
    receipt.report = projectSchemaQaReport(await dependencies.scenarios(clients[0], clients[1], observer, { ...migration019, sql }, { beforePublicMigration: bindings }));
    if (!receipt.report.success) return fail('SCHEMA_QA_SCENARIOS_FAILED');
    receipt.stage = 'target-verification';
    await dependencies.begin(observer, config.target);
    const after = await dependencies.inspect(observer, config.target);
    assertDataset(after, [...expectedLedger, migration019.name]);
    for (const key of ['authSchemaHash','defaultAclHash','localeHash','roleHash','extensionsHash','extensionAclHash'] as const) {
      if (before.summary[key] !== after.summary[key]) return fail('SCHEMA_QA_TARGET_CHANGED');
    }
    await observer.query('ROLLBACK');
    receipt.stage = 'post-bindings'; await bindings();
    receipt.success = true; receipt.stage = 'completed'; receipt.code = 'OK';
  } catch (error) {
    receipt.success = false; receipt.code = publicCode(error); receipt.sqlstate = publicSqlstate(error);
  } finally {
    for (const client of new Set(clients)) {
      try { await client.query('ROLLBACK'); } catch { receipt.sessionsClosed = false; }
      try { await client.end(); } catch { receipt.sessionsClosed = false; }
    }
    if (!receipt.sessionsClosed) { receipt.success = false; receipt.stage = 'session-cleanup'; receipt.code = 'PRODUCTION_MIGRATION_SCHEMA_QA_SESSION_CLEANUP'; }
    receipt.checkedAt = dependencies.now();
  }
  await writeFile(dependencies.receiptPath, serializeSchemaQaReceipt(receipt), { mode: 0o600 });
  return receipt;
}
export async function schemaQaNotice(emit = console.log): Promise<void> {
  const text = serializeSchemaQaReceipt(JSON.parse(await readFile(resultPath, 'utf8')) as SchemaQaReceipt);
  emit(`::notice title=${schemaQaProtocol}::${text.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A')}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--notice') return schemaQaNotice();
    if (args.length) return fail('INVALID_COMMAND');
    if (!(await runSchemaQa()).success) return fail('OPERATION_FAILED');
  })().catch(error => {
    console.error(`Cake: ${publicCode(error)}。秘密値・SQL・外部応答は表示しません。`); process.exitCode = 1;
  });
}

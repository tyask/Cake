import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBinding, config, connection, fail, hash, MigrationError, productionApi, record, type Api, type Connection, type Environment } from './production-db-migration-provider';
import { appTables, assertCopy, databaseClient, inventory, startSnapshot, type Inventory, type Snapshot, type Sql } from './production-db-migration-inventory';

export type Action = 'inventory' | 'rehearsal';
export type Context = { action: Action; controlSha: string; operation: string; runId: string; runAttempt: number };
export type Receipt = Context & { protocol: typeof config.protocol; configHash: string; sourceProject: string; targetProject: string;
  startedAt: string; checkedAt: string; success: boolean; stage: string; code: string;
  source?: Inventory; target?: Inventory; restored: boolean; temporaryFilesRemoved: boolean };
export type Command = (program: 'pg_dump' | 'pg_restore' | 'psql', args: string[], connection?: Connection) => Promise<string>;
export type Dependencies = { api: Api; client: (connection: Connection) => Sql; command: Command; head: () => string; now: () => string;
  inspect: typeof inventory; begin: typeof startSnapshot; receiptPath: string; binding: typeof assertBinding; resolveConnection: typeof connection };
const resultPath = resolve('.cake/production-migration-result.json');
const fullSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const decimal = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
export function context(environment: Environment, rawEvent: unknown, head: string): Context {
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== config.repository
    || environment.GITHUB_REF !== 'refs/heads/main' || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.GITHUB_WORKFLOW_REF !== `${config.repository}/${config.workflow}@refs/heads/main`
    || !fullSha(environment.GITHUB_SHA) || head !== environment.GITHUB_SHA
    || !decimal(environment.GITHUB_RUN_ID) || !decimal(environment.GITHUB_RUN_ATTEMPT)) return fail('UNTRUSTED_WORKFLOW');
  const event = record(rawEvent), repository = record(event.repository), inputs = record(event.inputs);
  if (repository.full_name !== config.repository || repository.id !== config.repositoryId
    || Object.keys(inputs).some(key => !['action','controlSha','operation'].includes(key))
    || !['inventory','rehearsal'].includes(String(inputs.action)) || !fullSha(inputs.controlSha) || inputs.controlSha !== environment.GITHUB_SHA
    || typeof inputs.operation !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(inputs.operation)
    || inputs.action === 'rehearsal' && environment.GITHUB_RUN_ATTEMPT !== '1') return fail('UNTRUSTED_WORKFLOW');
  return { action: inputs.action as Action, controlSha: inputs.controlSha, operation: inputs.operation,
    runId: environment.GITHUB_RUN_ID, runAttempt: Number(environment.GITHUB_RUN_ATTEMPT) };
}

/** The children receive neither provider credentials nor inherited PG/options. */
export function childEnvironment(connection?: Connection, environment: Environment = process.env): NodeJS.ProcessEnv {
  const safe = Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR'].flatMap(key => environment[key] === undefined ? [] : [[key,environment[key]]]));
  return { ...safe, NODE_ENV: 'production', ...(connection ? { PGHOST: connection.host, PGPORT: String(connection.port), PGUSER: connection.user,
    PGPASSWORD: connection.password, PGDATABASE: connection.database, PGSSLMODE: 'verify-full', PGCHANNELBINDING: 'require',
    PGCONNECT_TIMEOUT: '20', PGAPPNAME: 'cake-production-db-migration', PGPASSFILE: '/dev/null', PGSSLROOTCERT: 'system' } : {}) };
}
export const runCommand: Command = async (program, args, credentials) => {
  if (!['pg_dump','pg_restore','psql'].includes(program)) return fail('INVALID_COMMAND');
  return new Promise<string>((resolveCommand, reject) => {
    let output = '', tooLarge = false;
    const child = spawn(program, args, { shell: false, env: childEnvironment(credentials), stdio: ['ignore','pipe','pipe'], timeout: 600_000 });
    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > 1_048_576) { tooLarge = true; child.kill(); }
      else output += chunk.toString('utf8');
    });
    // Never retain or print pg stderr: failures can contain SQL, rows or credentials.
    child.stderr.on('data', () => undefined);
    child.on('error', () => reject(new MigrationError('PG_COMMAND_FAILED')));
    child.on('close', code => code === 0 && !tooLarge ? resolveCommand(output) : reject(new MigrationError('PG_COMMAND_FAILED')));
  });
};

export async function assertUnconnectedTarget(api: Api): Promise<void> {
  const response = record(await api('vercel', `/v1/storage/stores/${config.targetStoreId}?skip-metadata=true`));
  // Storage responses can include secrets; select only the binding and connection count.
  const store = record(response.store);
  if (store.id !== config.targetStoreId || store.ownerId !== config.vercelTeamId || store.type !== 'integration'
    || store.externalResourceId !== config.target.projectId || store.status !== 'available' || store.totalConnectedProjects !== 0
    || !Array.isArray(store.projectsMetadata) || store.projectsMetadata.length !== 0) return fail('TARGET_CONNECTED');
}
export async function assertCurrentMain(api: Api, expected: Context): Promise<void> {
  const value = record(await api('github', `/repos/${config.repository}/git/ref/heads/main`));
  if (value.ref !== 'refs/heads/main' || record(value.object).type !== 'commit' || record(value.object).sha !== expected.controlSha) return fail('MAIN_CHANGED');
}
export function restoreList(raw: string): string {
  let schema = 0, extension = 0;
  const defaults = new Set<string>();
  const result = raw.split(/\r?\n/).map(line => {
    if (/^\d+; \d+ \d+ SCHEMA - public (?:pg_database_owner|neondb_owner)$/.test(line)) { schema++; return `;${line}`; }
    if (/^\d+; \d+ \d+ EXTENSION - pgcrypto(?: .*)?$/.test(line)) { extension++; return `;${line}`; }
    const managed = line.match(/^\d+; \d+ \d+ DEFAULT ACL public DEFAULT PRIVILEGES FOR (TABLES|SEQUENCES) cloud_admin$/);
    if (managed) { if (defaults.has(managed[1])) return fail('DUMP_CONTENT'); defaults.add(managed[1]); return `;${line}`; }
    // Keep Cake ACL/COMMENT, including the pgcrypto comment, but never another schema or database.
    const selected = /^\d+; \d+ \d+ (?:(?:TABLE DATA|TABLE|FUNCTION|INDEX|TRIGGER|FK CONSTRAINT|CONSTRAINT|ACL|COMMENT) public .+|(?:ACL|COMMENT) - (?:SCHEMA public|EXTENSION pgcrypto) .*|ENCODING - ENCODING.*|STDSTRINGS - STDSTRINGS.*|SEARCHPATH - SEARCHPATH.*)$/;
    if (line && !line.startsWith(';') && (!selected.test(line) || /\bneon_auth\b|DEFAULT ACL/.test(line))) return fail('DUMP_CONTENT');
    return line;
  });
  if (schema !== 1 || extension !== 1 || defaults.size !== 2) return fail('DUMP_CONTENT');
  return result.join('\n');
}
export function assertEmptyTarget(source: Snapshot, target: Snapshot): void {
  if (!target.empty || target.tables.length || target.ledger.length) return fail('TARGET_NOT_EMPTY');
  if (source.tables.length !== appTables.length || JSON.stringify(source.tables) !== JSON.stringify(appTables)
    || JSON.stringify(source.extensions) !== JSON.stringify(['pgcrypto','plpgsql'])
    || JSON.stringify(target.extensions) !== JSON.stringify(['plpgsql'])) return fail('UNEXPECTED_DATASET');
  if (source.summary.localeHash !== target.summary.localeHash || source.summary.roleHash !== target.summary.roleHash
    || source.schemaOwner !== target.schemaOwner) return fail('DATABASE_COMPATIBILITY');
}

function projectedInventory(value: Inventory | undefined): Inventory | undefined {
  if (!value) return undefined;
  const output: Inventory = { counts: [...value.counts], dataHash: value.dataHash, schemaHash: value.schemaHash, aclHash: value.aclHash,
    ledgerHash: value.ledgerHash, authSchemaHash: value.authSchemaHash, authRows: value.authRows, publicTables: value.publicTables,
    version: value.version, bytes: value.bytes, localeHash: value.localeHash, roleHash: value.roleHash, extensionsHash: value.extensionsHash,
    defaultAclHash: value.defaultAclHash, extensionAclHash: value.extensionAclHash };
  for (const [key, member] of Object.entries(output)) {
    if (key === 'counts') {
      if (!Array.isArray(member) || member.length > appTables.length || member.some(count => !Number.isSafeInteger(count) || count < 0)) return fail('INVALID_RECEIPT');
    } else if (key.endsWith('Hash')) {
      if (typeof member !== 'string' || !/^[a-f0-9]{64}$/.test(member)) return fail('INVALID_RECEIPT');
    } else if (!Number.isSafeInteger(member) || Number(member) < 0) return fail('INVALID_RECEIPT');
  }
  return output;
}
export function serializeReceipt(value: Receipt): string {
  const result: Receipt = { protocol: config.protocol, action: value.action, controlSha: value.controlSha, operation: value.operation,
    runId: value.runId, runAttempt: value.runAttempt, configHash: hash(JSON.stringify(config)), sourceProject: config.source.projectId,
    targetProject: config.target.projectId, startedAt: value.startedAt, checkedAt: value.checkedAt, success: value.success,
    stage: value.stage, code: value.code, source: projectedInventory(value.source), target: projectedInventory(value.target),
    restored: value.restored, temporaryFilesRemoved: value.temporaryFilesRemoved };
  if (value.protocol !== config.protocol || value.configHash !== result.configHash || value.sourceProject !== config.source.projectId || value.targetProject !== config.target.projectId
    || !['inventory','rehearsal'].includes(result.action) || !fullSha(result.controlSha) || !decimal(result.runId)
    || !Number.isSafeInteger(result.runAttempt) || result.runAttempt < 1
    || !/^[a-f0-9-]{36}$/.test(result.operation) || !['bindings','main-check','source-binding','target-binding','target-store',
      'source-connection','target-connection','source-connect','target-connect','source-inventory','target-inventory',
      'dump','restore','copy-verification','post-bindings','completed'].includes(result.stage)
    || !/^(OK|PRODUCTION_MIGRATION_(?:[A-Z_]+|PROVIDER_(?:NEON|VERCEL|GITHUB)_HTTP_[1-5][0-9]{2}))$/.test(result.code)
    || [result.startedAt,result.checkedAt].some(time => !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)
    || typeof result.success !== 'boolean' || typeof result.restored !== 'boolean' || typeof result.temporaryFilesRemoved !== 'boolean'
    || result.success && (result.code !== 'OK' || result.stage !== 'completed' || !result.source || !result.target || !result.temporaryFilesRemoved
      || result.action === 'rehearsal' && !result.restored)) return fail('INVALID_RECEIPT');
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text) > 4096) return fail('RECEIPT_TOO_LARGE');
  return text;
}

export async function runMigration(environment: Environment = process.env, overrides: Partial<Dependencies> = {}): Promise<Receipt> {
  await mkdir(resolve('.cake'), { recursive: true, mode: 0o700 });
  const dependencies: Dependencies = { api: productionApi(environment), client: databaseClient, command: runCommand,
    head: () => execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8', env: childEnvironment(), stdio: ['ignore','pipe','ignore'] }).trim(),
    now: () => new Date().toISOString(), inspect: inventory, begin: startSnapshot, receiptPath: resultPath,
    binding: assertBinding, resolveConnection: connection, ...overrides };
  await rm(dependencies.receiptPath, { force: true });
  // No provider call or connection-URI retrieval precedes this provenance check.
  if (!environment.GITHUB_EVENT_PATH) return fail('UNTRUSTED_WORKFLOW');
  const request = context(environment, JSON.parse(await readFile(environment.GITHUB_EVENT_PATH, 'utf8')), dependencies.head());
  const receipt: Receipt = { ...request, protocol: config.protocol, configHash: hash(JSON.stringify(config)), sourceProject: config.source.projectId,
    targetProject: config.target.projectId, startedAt: dependencies.now(), checkedAt: dependencies.now(), success: false, stage: 'bindings',
    code: 'PRODUCTION_MIGRATION_FAILED', restored: false, temporaryFilesRemoved: true };
  let sourceClient: Sql | undefined, targetClient: Sql | undefined, directory: string | undefined;
  try {
    if (!environment.NEON_API_KEY?.trim() || !environment.VERCEL_TOKEN?.trim() || !environment.GH_TOKEN?.trim() || environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') return fail('CREDENTIALS_MISSING');
    receipt.stage = 'main-check';
    await assertCurrentMain(dependencies.api, request);
    receipt.stage = 'source-binding';
    await dependencies.binding(dependencies.api, config.source);
    receipt.stage = 'target-binding';
    await dependencies.binding(dependencies.api, config.target);
    receipt.stage = 'target-store';
    await assertUnconnectedTarget(dependencies.api);
    receipt.stage = 'source-connection';
    const sourceConnection = await dependencies.resolveConnection(dependencies.api, config.source);
    receipt.stage = 'target-connection';
    const targetConnection = await dependencies.resolveConnection(dependencies.api, config.target);
    sourceClient = dependencies.client(sourceConnection); targetClient = dependencies.client(targetConnection);
    receipt.stage = 'source-connect';
    await sourceClient.connect();
    receipt.stage = 'target-connect';
    await targetClient.connect();
    receipt.stage = 'source-inventory';
    const snapshot = await dependencies.begin(sourceClient, config.source);
    const source = await dependencies.inspect(sourceClient, config.source); receipt.source = source.summary;
    const expectedLedger = (await readdir(resolve('db/migrations'))).filter(name => /^0(?:0[1-9]|1[0-8])_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (expectedLedger.length !== 18 || JSON.stringify(source.ledger) !== JSON.stringify(expectedLedger)) return fail('MIGRATION_LEDGER');
    receipt.stage = 'target-inventory';
    await dependencies.begin(targetClient, config.target);
    const before = await dependencies.inspect(targetClient, config.target); receipt.target = before.summary;
    if (request.action === 'rehearsal') {
      assertEmptyTarget(source, before);
      const available = (await targetClient.query("SELECT version FROM pg_available_extension_versions WHERE name='pgcrypto' AND version='1.3'")).rows;
      if (available.length !== 1 || available[0].version !== '1.3') return fail('EXTENSION_VERSION');
      receipt.stage = 'dump';
      for (const program of ['pg_dump','pg_restore','psql'] as const) {
        if (!/^(?:pg_dump|pg_restore|psql) \(PostgreSQL\) 18\.[0-9]+(?:[ .-]|$)/.test(await dependencies.command(program, ['--version']))) return fail('PG_VERSION');
      }
      directory = await mkdtemp(join(tmpdir(), 'cake-production-rehearsal-')); await chmod(directory, 0o700);
      receipt.temporaryFilesRemoved = false;
      const archive = join(directory, 'database.dump'), list = join(directory, 'restore.list'), sqlFile = join(directory, 'restore.sql');
      // Precreate with restrictive permissions; pg_dump preserves the existing file mode.
      await writeFile(archive, '', { mode: 0o600 });
      await dependencies.command('pg_dump', ['--format=custom','--schema=public','--extension=pgcrypto','--strict-names',
        '--lock-wait-timeout=20s',`--snapshot=${snapshot}`,`--file=${archive}`], sourceConnection);
      await writeFile(list, restoreList(await dependencies.command('pg_restore', ['--list', archive])), { mode: 0o600 });
      await writeFile(sqlFile, '', { mode: 0o600 });
      // Preserve all Cake owner/ACL statements. Only the two verified cloud_admin defaults stay local.
      await dependencies.command('pg_restore', ['--exit-on-error',`--use-list=${list}`,`--file=${sqlFile}`,archive]);
      // The read-only target probe must end before the restore transaction begins.
      await targetClient.query('ROLLBACK');
      await dependencies.binding(dependencies.api, config.source); await dependencies.binding(dependencies.api, config.target);
      await assertUnconnectedTarget(dependencies.api);
      await dependencies.begin(targetClient, config.target);
      const latest = await dependencies.inspect(targetClient, config.target); assertEmptyTarget(source, latest);
      if (latest.summary.authSchemaHash !== before.summary.authSchemaHash || latest.summary.defaultAclHash !== before.summary.defaultAclHash) return fail('TARGET_CHANGED');
      await targetClient.query('ROLLBACK');
      receipt.stage = 'restore';
      await assertCurrentMain(dependencies.api, request);
      // psql -1 wraps the command AND file in one transaction; ON_ERROR_STOP rolls everything back.
      await dependencies.command('psql', ['-X','--single-transaction','--set=ON_ERROR_STOP=1',
        '--command=CREATE EXTENSION pgcrypto WITH SCHEMA public VERSION \'1.3\'',`--file=${sqlFile}`], targetConnection);
      receipt.restored = true;
      receipt.stage = 'copy-verification';
      await dependencies.begin(targetClient, config.target);
      const after = await dependencies.inspect(targetClient, config.target); receipt.target = after.summary;
      assertCopy(source, after);
      if (after.summary.authSchemaHash !== before.summary.authSchemaHash || after.summary.defaultAclHash !== before.summary.defaultAclHash) return fail('AUTH_STRUCTURE_CHANGED');
      // Release the source keeper, then prove Auth is still unused in a fresh snapshot.
      await sourceClient.query('ROLLBACK');
      await dependencies.begin(sourceClient, config.source);
      await dependencies.inspect(sourceClient, config.source);
    }
    receipt.stage = 'post-bindings';
    await assertCurrentMain(dependencies.api, request);
    await dependencies.binding(dependencies.api, config.source); await dependencies.binding(dependencies.api, config.target);
    await assertUnconnectedTarget(dependencies.api);
    receipt.success = true; receipt.stage = 'completed'; receipt.code = 'OK';
  } catch (error) {
    receipt.success = false;
    receipt.code = error instanceof MigrationError ? error.message : 'PRODUCTION_MIGRATION_FAILED';
  } finally {
    for (const sql of [targetClient,sourceClient]) {
      if (!sql) continue;
      try { await sql.query('ROLLBACK'); } catch { receipt.success = false; receipt.code = 'PRODUCTION_MIGRATION_SESSION_CLEANUP'; }
      try { await sql.end(); } catch { receipt.success = false; receipt.code = 'PRODUCTION_MIGRATION_SESSION_CLEANUP'; }
    }
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }); receipt.temporaryFilesRemoved = true; }
      catch { receipt.success = false; receipt.code = 'PRODUCTION_MIGRATION_TEMP_CLEANUP'; }
    }
    receipt.checkedAt = dependencies.now();
  }
  await writeFile(dependencies.receiptPath, serializeReceipt(receipt), { mode: 0o600 });
  return receipt;
}

export async function notice(emit = console.log): Promise<void> {
  const raw = JSON.parse(await readFile(resultPath, 'utf8')) as Receipt;
  // Re-project, validate and cap the receipt in the credential-free publication step.
  const text = serializeReceipt(raw);
  emit(`::notice title=${config.protocol}::${text.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A')}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  void (async () => {
    if (args.length === 1 && args[0] === '--notice') return notice();
    if (args.length) return fail('INVALID_COMMAND');
    const receipt = await runMigration();
    if (!receipt.success) return fail('OPERATION_FAILED');
  })().catch(error => {
    const code = error instanceof MigrationError ? error.message : 'PRODUCTION_MIGRATION_FAILED';
    console.error(`Cake: ${code}。秘密値・SQL・外部応答は表示しません。`); process.exitCode = 1;
  });
}

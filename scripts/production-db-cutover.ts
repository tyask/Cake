import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBinding, assertProductionCredentials, config, connection, hash, MigrationError, productionApi, record,
  type Api, type Environment } from './production-db-migration-provider';
import { assertCurrentMain, assertUnconnectedTarget, childEnvironment } from './production-db-migration';
import { runFinalCopy, projectFinalCopyReport, isFinalCopyPublicCode, type FinalCopyReport } from './production-db-final-copy';
import { productionAliases, runProductionSwitch, type ProductionSwitchReport } from './production-db-cutover-vercel';

export const cutoverProtocol = 'cake-production-db-cutover/v1';
export const cutoverWorkflow = '.github/workflows/production-db-cutover.yml';
export const accessAssumption = 'no-production-db-access';
type Context = { controlSha: string; operation: string; runId: string; runAttempt: number };
type CopyEvidence = Omit<FinalCopyReport, 'cases' | 'source' | 'target'> & {
  snapshot: FinalCopyReport['source']; targetDataHash: string | null;
};
type RoutingEvidence = { aliases: number; hash: string; domains: number; domainHash: string; productionCount: number; known: string[] };
type SwitchEvidence = Omit<ProductionSwitchReport, 'before' | 'after'> & {
  before: RoutingEvidence | null; after: RoutingEvidence | null;
};
const stages = ['credentials','bindings','connections','copy','switch','post-bindings','completed'] as const;
export type CutoverReceipt = Context & { protocol: typeof cutoverProtocol; configHash: string; accessAssumption: typeof accessAssumption;
  sourceProject: string; sourceBranch: string; sourceEndpoint: string; targetProject: string; targetBranch: string; targetEndpoint: string;
  startedAt: string; checkedAt: string; success: boolean; stage: typeof stages[number]; code: string;
  copy?: CopyEvidence; deployment?: SwitchEvidence };
export type CutoverDependencies = { api: Api; head: () => string; now: () => string; receiptPath: string;
  binding: typeof assertBinding; resolveConnection: typeof connection; copy: typeof runFinalCopy; switch: typeof runProductionSwitch };
const resultPath = resolve('.cake/production-cutover-result.json');
const fullSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const decimal = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const invalid = (): never => { throw new Error('PRODUCTION_CUTOVER_INVALID_RECEIPT'); };
const nonnegative = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : invalid();
const digest = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : invalid();
const boolean = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid();
const contextCodes = new Set(['SOURCE_CREDENTIALS_MISSING','TARGET_CREDENTIALS_MISSING','SOURCE_CREDENTIALS_INVALID',
  'TARGET_CREDENTIALS_INVALID','CREDENTIALS_NOT_SEPARATED','CREDENTIALS_MISSING','INVALID_REQUEST'].map(code => `PRODUCTION_MIGRATION_${code}`));
function publicCode(code: string): boolean {
  return code === 'PRODUCTION_CUTOVER_FAILED' || isFinalCopyPublicCode(code) || contextCodes.has(code)
    || code.startsWith('PRODUCTION_CUTOVER_SWITCH_') && switchCodes.includes(code.slice('PRODUCTION_CUTOVER_SWITCH_'.length));
}

/** The approved operation assumes no Production DB traffic; it does not claim a SQL fence. */
export function cutoverContext(environment: Environment, rawEvent: unknown, head: string): Context {
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== config.repository
    || environment.GITHUB_REPOSITORY_ID !== String(config.repositoryId) || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.GITHUB_WORKFLOW_REF !== config.repository + '/' + cutoverWorkflow + '@refs/heads/main'
    || !fullSha(environment.GITHUB_SHA) || head !== environment.GITHUB_SHA || !decimal(environment.GITHUB_RUN_ID)
    || environment.GITHUB_RUN_ATTEMPT !== '1') throw new Error('PRODUCTION_CUTOVER_UNTRUSTED_WORKFLOW');
  const event = record(rawEvent), repository = record(event.repository), inputs = record(event.inputs);
  if (repository.full_name !== config.repository || repository.id !== config.repositoryId
    || Object.keys(inputs).length !== 2 || Object.keys(inputs).some(key => !['controlSha','operation'].includes(key))
    || inputs.controlSha !== head || !uuid(inputs.operation)) throw new Error('PRODUCTION_CUTOVER_UNTRUSTED_WORKFLOW');
  return { controlSha: head, operation: inputs.operation, runId: environment.GITHUB_RUN_ID, runAttempt: 1 };
}
function copyEvidence(value: FinalCopyReport): CopyEvidence {
  const result = projectFinalCopyReport(value);
  return { success: result.success, stage: result.stage, code: result.code, sqlstate: result.sqlstate, ms: result.ms,
    snapshot: result.source, targetDataHash: result.target?.hashes.data ?? null, beforeTargetDataHash: result.beforeTargetDataHash,
    targetTouched: result.targetTouched, restored: result.restored, migrated: result.migrated, verified: result.verified,
    sourceUnchanged: result.sourceUnchanged, restoreStatus: result.restoreStatus,
    temporaryFilesRemoved: result.temporaryFilesRemoved, sessionsClosed: result.sessionsClosed };
}
function restoreCopy(value: CopyEvidence): CopyEvidence {
  if (!value || typeof value !== 'object') return invalid();
  const target = value.snapshot === null || value.targetDataHash === null ? null
    : { counts: value.snapshot.counts, hashes: { ...value.snapshot.hashes, data: digest(value.targetDataHash) } };
  return copyEvidence({ ...value, cases: [], source: value.snapshot, target });
}
const switchStages = ['preflight','source-scope','target-connect','native-check','create','ready','aliases-before','oidc','probe','promote','aliases-after','final','complete'];
const switchCodes = ['OK','INVALID_INPUT','CREDENTIALS','INVALID_RESPONSE','HTTP','RESPONSE_UNKNOWN','JSON','BINDING','INCOMPLETE_INVENTORY',
  'NATIVE_CONNECTION','ENVIRONMENT','BEFORE_WRITE','DUPLICATE_DEPLOYMENT','DEPLOYMENT_BINDING','DEPLOYMENT_FAILED','DEPLOYMENT_TIMEOUT','ALIAS_CHANGED','ALIAS_TIMEOUT','OIDC','PROBE','UNEXPECTED'];
const writeState = (value: unknown): 'not-started' | 'attempted' | 'acknowledged' =>
  value === 'not-started' || value === 'attempted' || value === 'acknowledged' ? value : invalid();
function routingEvidence(value: RoutingEvidence | null): RoutingEvidence | null {
  if (value === null) return null;
  if (!value || !Array.isArray(value.known) || value.known.length !== productionAliases.length
    || value.known.some(id => typeof id !== 'string' || !/^dpl_[A-Za-z0-9]{1,100}$/.test(id))) return invalid();
  return { aliases: nonnegative(value.aliases), hash: digest(value.hash), domains: nonnegative(value.domains),
    domainHash: digest(value.domainHash), productionCount: nonnegative(value.productionCount), known: [...value.known] };
}
function projectSwitch(value: SwitchEvidence): SwitchEvidence {
  if (!value || !switchStages.includes(value.stage) || !switchCodes.includes(value.code)
    || value.httpStatus !== null && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599)) return invalid();
  const result: SwitchEvidence = { success: boolean(value.success), stage: value.stage, code: value.code, httpStatus: value.httpStatus,
    responseUnknown: boolean(value.responseUnknown), writes: {
      source: writeState(value.writes?.source), target: writeState(value.writes?.target),
      deployment: writeState(value.writes?.deployment), promote: writeState(value.writes?.promote),
    }, before: routingEvidence(value.before), after: routingEvidence(value.after), deployment: null,
    sourceScopeUpdated: boolean(value.sourceScopeUpdated), targetConnected: boolean(value.targetConnected),
    nativeVerified: boolean(value.nativeVerified), ready: boolean(value.ready), probed: boolean(value.probed),
    promoted: boolean(value.promoted), aliasVerified: boolean(value.aliasVerified),
    knownAliasesCurrent: boolean(value.knownAliasesCurrent), ms: nonnegative(value.ms) };
  if (value.deployment !== null) {
    const deployment = value.deployment;
    if (!/^dpl_[A-Za-z0-9]{1,100}$/.test(deployment.id) || !fullSha(deployment.sha)) return invalid();
    const url = new URL(deployment.url);
    if (url.origin !== deployment.url || url.protocol !== 'https:' || !/^[a-z0-9-]+\.vercel\.app$/.test(url.hostname)) return invalid();
    result.deployment = { id: deployment.id, url: deployment.url, sha: deployment.sha };
  }
  if (result.success && (result.stage !== 'complete' || result.code !== 'OK' || result.responseUnknown || !result.deployment
    || !result.before || !result.after || !result.sourceScopeUpdated || !result.targetConnected || !result.nativeVerified
    || !result.ready || !result.probed || !result.promoted || !result.aliasVerified
    || Object.values(result.writes).some(state => state !== 'acknowledged') || result.httpStatus !== null)) return invalid();
  return result;
}
function switchEvidence(value: ProductionSwitchReport): SwitchEvidence {
  const routing = (item: ProductionSwitchReport['before']): RoutingEvidence | null => item === null ? null : {
    aliases: item.aliases, hash: item.hash, domains: item.domains, domainHash: item.domainHash,
    productionCount: item.production.length, known: productionAliases.map(alias => item.known.find(pair => pair[0] === alias)?.[1] ?? ''),
  };
  return projectSwitch({ ...value, before: routing(value.before), after: routing(value.after) });
}

/** Rebuild both nested reports; raw provider/SQL/errors are never published. */
export function serializeCutoverReceipt(value: CutoverReceipt): string {
  const result: CutoverReceipt = { protocol: cutoverProtocol, controlSha: value.controlSha, operation: value.operation,
    runId: value.runId, runAttempt: value.runAttempt, configHash: hash(JSON.stringify(config)), accessAssumption,
    sourceProject: config.source.projectId, sourceBranch: config.source.branchId, sourceEndpoint: config.source.endpointId,
    targetProject: config.target.projectId, targetBranch: config.target.branchId, targetEndpoint: config.target.endpointId,
    startedAt: value.startedAt, checkedAt: value.checkedAt, success: boolean(value.success), stage: value.stage, code: value.code,
    copy: value.copy === undefined ? undefined : restoreCopy(value.copy),
    deployment: value.deployment === undefined ? undefined : projectSwitch(value.deployment) };
  for (const key of ['protocol','configHash','accessAssumption','sourceProject','sourceBranch','sourceEndpoint','targetProject','targetBranch','targetEndpoint'] as const) {
    if (value[key] !== result[key]) return invalid();
  }
  if (!fullSha(result.controlSha) || !uuid(result.operation) || !decimal(result.runId) || result.runAttempt !== 1
    || !stages.includes(result.stage) || !publicCode(result.code) || !result.success && result.code === 'OK'
    || [result.startedAt,result.checkedAt].some(time => !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)
    || Date.parse(result.startedAt) > Date.parse(result.checkedAt)
    || result.deployment?.deployment && result.deployment.deployment.sha !== result.controlSha
    || result.success && (result.stage !== 'completed' || result.code !== 'OK' || !result.copy?.success || !result.deployment?.success)) return invalid();
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text) > 4096) return invalid();
  return text;
}

export async function runCutover(environment: Environment = process.env, overrides: Partial<CutoverDependencies> = {}): Promise<CutoverReceipt> {
  const dependencies: CutoverDependencies = { api: productionApi(environment),
    head: () => execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',env:childEnvironment(),stdio:['ignore','pipe','ignore']}).trim(),
    now: () => new Date().toISOString(), receiptPath: resultPath, binding: assertBinding,
    resolveConnection: connection, copy: runFinalCopy, switch: runProductionSwitch, ...overrides };
  await mkdir(resolve(dependencies.receiptPath, '..'), { recursive: true, mode: 0o700 });
  await rm(dependencies.receiptPath, { force: true });
  if (!environment.GITHUB_EVENT_PATH) throw new Error('PRODUCTION_CUTOVER_UNTRUSTED_WORKFLOW');
  const request = cutoverContext(environment,JSON.parse(await readFile(environment.GITHUB_EVENT_PATH,'utf8')),dependencies.head());
  const receipt: CutoverReceipt = { ...request, protocol: cutoverProtocol, configHash: hash(JSON.stringify(config)), accessAssumption,
    sourceProject: config.source.projectId, sourceBranch: config.source.branchId, sourceEndpoint: config.source.endpointId,
    targetProject: config.target.projectId, targetBranch: config.target.branchId, targetEndpoint: config.target.endpointId,
    startedAt: dependencies.now(), checkedAt: dependencies.now(), success: false, stage: 'credentials', code: 'PRODUCTION_CUTOVER_FAILED' };
  const bindings = async () => {
    await assertCurrentMain(dependencies.api,{...request,action:'inventory'});
    await dependencies.binding(dependencies.api,config.source); await dependencies.binding(dependencies.api,config.target);
  };
  const isolated = async () => { await bindings(); await assertUnconnectedTarget(dependencies.api); };
  try {
    assertProductionCredentials(environment);
    receipt.stage = 'bindings'; await isolated();
    receipt.stage = 'connections';
    const source = await dependencies.resolveConnection(dependencies.api,config.source);
    const target = await dependencies.resolveConnection(dependencies.api,config.target);
    receipt.stage = 'copy';
    receipt.copy = copyEvidence(await dependencies.copy({ source, target, beforeWrite: isolated, afterWrite: isolated }));
    if (!receipt.copy.success) receipt.code = receipt.copy.code;
    else {
      receipt.stage = 'switch';
      receipt.deployment = switchEvidence(await dependencies.switch({ ...request, beforeWrite: bindings }, { environment }));
      if (!receipt.deployment.success) receipt.code = 'PRODUCTION_CUTOVER_SWITCH_' + receipt.deployment.code;
      else {
        receipt.stage = 'post-bindings'; await bindings();
        receipt.success = true; receipt.stage = 'completed'; receipt.code = 'OK';
      }
    }
  } catch (error) {
    receipt.success = false;
    receipt.code = error instanceof MigrationError && publicCode(error.message)
      ? error.message : 'PRODUCTION_CUTOVER_FAILED';
  }
  receipt.checkedAt = dependencies.now();
  await writeFile(dependencies.receiptPath,serializeCutoverReceipt(receipt),{mode:0o600});
  return receipt;
}
async function notice() {
  const text = serializeCutoverReceipt(JSON.parse(await readFile(resultPath,'utf8')) as CutoverReceipt);
  console.log('::notice title=' + cutoverProtocol + '::' + text.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    if (process.argv.length === 3 && process.argv[2] === '--notice') return notice();
    if (process.argv.length !== 2) throw new Error('PRODUCTION_CUTOVER_ARGUMENTS');
    if (!(await runCutover()).success) process.exitCode = 1;
  })().catch(() => { console.error('Production DB切替を確認できません。対象runの正式receiptを確認してください。'); process.exitCode = 1; });
}

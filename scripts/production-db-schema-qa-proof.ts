import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, hash } from './production-db-migration-provider';
import { schemaQaProtocol, schemaQaWorkflow, serializeSchemaQaReceipt, type SchemaQaReceipt } from './production-db-schema-qa';
import { childEnvironment } from './production-db-migration';

export type Request = { runId: number; controlSha: string; operation: string };
export type Get = (path: string) => Promise<unknown>;
type ObjectValue = Record<string, unknown>;
class ReadError extends Error { constructor(code: string) { super(code); this.name = 'ReadError'; } }
const fail = (code: string): never => { throw new ReadError(code); };
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_RESPONSE');
  return value as ObjectValue;
};
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const api = (path: string) => `https://api.github.com/repos/${config.repository}/${path}`;
const time = (value: unknown): number => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return fail('INVALID_TIME');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== (value.includes('.') ? value : value.replace('Z','.000Z'))) return fail('INVALID_TIME');
  return parsed;
};
const repository = (value: unknown): boolean => {
  const repo = object(value); return repo.id === config.repositoryId && repo.full_name === config.repository;
};
const completed = (value: ObjectValue, conclusion: unknown): boolean => value.status === 'completed' && value.conclusion === conclusion;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as ObjectValue)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
function distinctJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let index=0; index<tokens.length; index++) {
    const token = tokens[index];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[index+1] === ':') {
      const keys = stack.at(-1), key: unknown = JSON.parse(token);
      if (!keys || typeof key !== 'string' || keys.has(key)) return fail('DUPLICATE_JSON_KEY');
      keys.add(key);
    }
  }
  return parsed;
}
export function parseArguments(args: string[]): Request {
  if (args.length !== 3 || !/^[1-9][0-9]*$/.test(args[0]) || !positive(Number(args[0]))
    || !/^[a-f0-9]{40}$/.test(args[1])
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args[2])) return fail('INVALID_ARGUMENTS');
  return { runId: Number(args[0]), controlSha: args[1], operation: args[2] };
}
function workflow(value: unknown): ObjectValue {
  const current = object(value);
  if (!positive(current.id) || current.path !== schemaQaWorkflow || current.state !== 'active'
    || current.url !== api(`actions/workflows/${current.id}`)) return fail('WORKFLOW_CHANGED');
  return current;
}
function run(value: unknown, expected: Request, definition: ObjectValue): ObjectValue {
  const current = object(value);
  if (current.id !== expected.runId || current.run_attempt !== 1
    || current.workflow_id !== definition.id || current.event !== 'workflow_dispatch' || current.path !== schemaQaWorkflow
    || current.head_branch !== 'main' || current.head_sha !== expected.controlSha
    || current.display_title !== `Production DB schema QA ${expected.operation}`
    || !repository(current.repository) || !repository(current.head_repository) || !positive(current.check_suite_id)
    || current.url !== api(`actions/runs/${expected.runId}`) || current.check_suite_url !== api(`check-suites/${current.check_suite_id}`)
    || current.status !== 'completed' || !['success','failure'].includes(String(current.conclusion))
    || time(current.created_at) > time(current.updated_at)) return fail('RUN_CHANGED');
  return current;
}
async function collection(get: Get, path: string, key: string): Promise<ObjectValue[]> {
  const found: ObjectValue[] = []; let total: number | undefined;
  for (let page=1; page<=10; page++) {
    const response = object(await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
    if (!Number.isSafeInteger(response.total_count) || Number(response.total_count) < 1 || Number(response.total_count) > 1000
      || total !== undefined && total !== response.total_count || !Array.isArray(response[key]) || response[key].length > 100) return fail('INCOMPLETE_COLLECTION');
    total = Number(response.total_count); const values = response[key] as unknown[];
    found.push(...values.map(object));
    if (found.length > total || found.length < total && values.length !== 100) return fail('INCOMPLETE_COLLECTION');
    if (found.length === total) {
      if (found.some(value => !positive(value.id)) || new Set(found.map(value => value.id)).size !== found.length) return fail('DUPLICATE_COLLECTION');
      return found;
    }
  }
  return fail('INCOMPLETE_COLLECTION');
}
async function uniqueOperation(get: Get, expected: Request, definition: ObjectValue): Promise<string> {
  const values = await collection(get, `actions/workflows/${definition.id}/runs?event=workflow_dispatch&branch=main`, 'workflow_runs');
  const candidates = values.filter(value => value.display_title === `Production DB schema QA ${expected.operation}`);
  if (candidates.length !== 1 || candidates[0].id !== expected.runId) return fail('DUPLICATE_OPERATION_RUN');
  return canonical(candidates[0]);
}
function checkId(value: unknown): number {
  if (typeof value !== 'string' || !value.startsWith(api('check-runs/'))) return fail('CHECK_URL');
  const suffix = value.slice(api('check-runs/').length);
  if (!/^[1-9][0-9]*$/.test(suffix) || !positive(Number(suffix))) return fail('CHECK_URL');
  return Number(suffix);
}
async function job(get: Get, current: ObjectValue): Promise<ObjectValue> {
  const jobs = await collection(get, `actions/runs/${current.id}/attempts/${current.run_attempt}/jobs`, 'jobs');
  if (jobs.length !== 1 || jobs[0].name !== 'schema-qa') return fail('JOB_AMBIGUOUS');
  const value = jobs[0];
  if (value.run_id !== current.id || value.run_attempt !== current.run_attempt || value.head_sha !== current.head_sha || value.head_branch !== 'main'
    || value.url !== api(`actions/jobs/${value.id}`) || value.run_url !== current.url || !completed(value,current.conclusion)
    || time(value.started_at) > time(value.completed_at) || time(value.started_at) < time(current.created_at)-60_000
    || time(value.completed_at) > time(current.updated_at)+60_000) return fail('JOB_CHANGED');
  checkId(value.check_run_url);
  if (!Array.isArray(value.steps)) return fail('NOTICE_STEP');
  for (const [name, conclusion] of [['Publish the public receipt','success'],['Verify the fixed Production schema candidate',current.conclusion]]) {
    const steps = value.steps.map(object).filter(step => step.name === name);
    if (steps.length !== 1 || !positive(steps[0].number) || !completed(steps[0],conclusion)) return fail('NOTICE_STEP');
  }
  return value;
}
function actionsApp(value: unknown): ObjectValue {
  const app = object(value);
  if (!positive(app.id) || app.slug !== 'github-actions' || app.html_url !== 'https://github.com/apps/github-actions') return fail('ACTIONS_APP');
  return app;
}
function suite(value: unknown, current: ObjectValue): ObjectValue {
  const selected = object(value); actionsApp(selected.app);
  if (selected.id !== current.check_suite_id || selected.url !== current.check_suite_url || selected.head_sha !== current.head_sha
    || selected.head_branch !== 'main' || !repository(selected.repository) || !completed(selected,current.conclusion)) return fail('SUITE_CHANGED');
  return selected;
}
function check(value: unknown, current: ObjectValue, selectedJob: ObjectValue, selectedSuite: ObjectValue): ObjectValue {
  const selected = object(value), app = actionsApp(selected.app), output = object(selected.output);
  if (selected.id !== checkId(selectedJob.check_run_url) || selected.url !== selectedJob.check_run_url || selected.name !== selectedJob.name
    || selected.head_sha !== current.head_sha || object(selected.check_suite).id !== selectedSuite.id
    || app.id !== actionsApp(selectedSuite.app).id || !completed(selected,current.conclusion)
    || time(selected.started_at) > time(selected.completed_at)
    || Math.abs(time(selected.started_at)-time(selectedJob.started_at)) > 60_000
    || Math.abs(time(selected.completed_at)-time(selectedJob.completed_at)) > 60_000
    || !positive(output.annotations_count) || Number(output.annotations_count) > 1000
    || output.annotations_url !== api(`check-runs/${selected.id}/annotations`)) return fail('CHECK_CHANGED');
  return selected;
}
async function annotation(get: Get, selected: ObjectValue): Promise<string> {
  const all: ObjectValue[] = [], count = Number(object(selected.output).annotations_count);
  for (let page=1; page<=10; page++) {
    const values = await get(`check-runs/${selected.id}/annotations?per_page=100&page=${page}`);
    if (!Array.isArray(values) || values.length > 100) return fail('INCOMPLETE_ANNOTATIONS');
    all.push(...values.map(object));
    if (all.length > count || all.length < count && values.length !== 100) return fail('INCOMPLETE_ANNOTATIONS');
    if (all.length === count) break;
  }
  if (all.length !== count) return fail('INCOMPLETE_ANNOTATIONS');
  const notices = all.filter(value => value.title === schemaQaProtocol);
  if (notices.length !== 1 || notices[0].annotation_level !== 'notice' || typeof notices[0].message !== 'string') return fail('NOTICE_AMBIGUOUS');
  const text = notices[0].message;
  if (!text || Buffer.byteLength(text)>4096 || text.includes('***')) return fail('INVALID_RECEIPT');
  return text;
}
export function receiptText(text: string, expected: Request, current: ObjectValue, selectedJob: ObjectValue): SchemaQaReceipt {
  if (!text || Buffer.byteLength(text)>4096 || text.includes('***')) return fail('INVALID_RECEIPT');
  const raw = distinctJson(text);
  const receipt = JSON.parse(serializeSchemaQaReceipt(raw as SchemaQaReceipt)) as SchemaQaReceipt;
  // No unexpected fields, masked secrets, duplicate JSON keys or unknown report members are accepted.
  if (canonical(raw) !== canonical(receipt) || receipt.runId !== String(expected.runId)
    || receipt.controlSha !== expected.controlSha || receipt.operation !== expected.operation || receipt.runAttempt !== current.run_attempt
    || receipt.success !== (current.conclusion === 'success') || !receipt.success && receipt.code === 'OK'
    || time(receipt.startedAt)>time(receipt.checkedAt)
    || time(receipt.startedAt)<time(selectedJob.started_at)-60_000 || time(receipt.checkedAt)>time(selectedJob.completed_at)+60_000) return fail('RECEIPT_CONTEXT');
  return receipt;
}
function snapshot(value: ObjectValue, keys: string[]): string {
  return canonical(Object.fromEntries(keys.map(key => [key,value[key] ?? null])));
}
export async function readProductionSchemaQaReceipt(get: Get, expected: Request) {
  const definition = workflow(await get('actions/workflows/production-db-schema-qa.yml'));
  const current = run(await get(`actions/runs/${expected.runId}`),expected,definition);
  const operation = await uniqueOperation(get,expected,definition);
  const selectedJob = await job(get,current), selectedSuite = suite(await get(`check-suites/${current.check_suite_id}`),current);
  const selectedCheck = check(await get(`check-runs/${checkId(selectedJob.check_run_url)}`),current,selectedJob,selectedSuite);
  const text = await annotation(get,selectedCheck), receipt = receiptText(text,expected,current,selectedJob);
  const afterCheck = check(await get(`check-runs/${selectedCheck.id}`),current,selectedJob,selectedSuite);
  if (snapshot(selectedCheck,['id','url','name','head_sha','check_suite','app','status','conclusion','started_at','completed_at','output'])
    !==snapshot(afterCheck,['id','url','name','head_sha','check_suite','app','status','conclusion','started_at','completed_at','output'])
    || await annotation(get,afterCheck)!==text) return fail('CHECK_CHANGED');
  const afterSuite = suite(await get(`check-suites/${current.check_suite_id}`),current);
  if (snapshot(selectedSuite,['id','url','head_sha','head_branch','repository','app','status','conclusion'])
    !==snapshot(afterSuite,['id','url','head_sha','head_branch','repository','app','status','conclusion'])) return fail('SUITE_CHANGED');
  const afterJob = await job(get,current);
  if (canonical(selectedJob)!==canonical(afterJob)) return fail('JOB_CHANGED');
  const afterRun = run(await get(`actions/runs/${expected.runId}`),expected,definition);
  if (snapshot(current,['id','workflow_id','run_attempt','head_sha','head_branch','path','event','display_title','repository','head_repository','check_suite_id','url','check_suite_url','status','conclusion','created_at','updated_at'])
    !==snapshot(afterRun,['id','workflow_id','run_attempt','head_sha','head_branch','path','event','display_title','repository','head_repository','check_suite_id','url','check_suite_url','status','conclusion','created_at','updated_at'])) return fail('RUN_CHANGED');
  if (canonical(definition)!==canonical(workflow(await get('actions/workflows/production-db-schema-qa.yml')))
    || operation!==await uniqueOperation(get,expected,definition)) return fail('OPERATION_CHANGED');
  return { protocol: 'cake-production-db-schema-qa-proof/v1', workflowId: Number(definition.id), runId: expected.runId,
    runAttempt: Number(current.run_attempt), jobId: Number(selectedJob.id), checkId: Number(selectedCheck.id), suiteId: Number(selectedSuite.id),
    verifiedAt: new Date().toISOString(), success: receipt.success, receipt };
}

function githubGet(): Get {
  // Only the GitHub credential and OS/TLS/proxy selectors reach gh.
  const keys = ['PATH','HOME','USER','LANG','LC_ALL','XDG_CONFIG_HOME','GH_CONFIG_DIR','GH_TOKEN','GITHUB_TOKEN',
    'HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS'];
  const environment: NodeJS.ProcessEnv = { NODE_ENV: 'production', ...Object.fromEntries(keys.flatMap(key => process.env[key]===undefined?[]:[[key,process.env[key]]])) };
  return async path => {
    if (!/^[A-Za-z0-9_./?=&%-]+$/.test(path) || path.startsWith('/') || path.includes('..')) return fail('INVALID_GET_PATH');
    try { return JSON.parse(execFileSync('gh',['api','--hostname','github.com','--method','GET',`repos/${config.repository}/${path}`],
      { encoding:'utf8',env:environment,stdio:['ignore','pipe','pipe'],timeout:30_000,maxBuffer:2_097_152 })); }
    catch { return fail('GITHUB_GET_FAILED'); }
  };
}
async function main() {
  const expected = parseArguments(process.argv.slice(2));
  const directory = resolve(process.cwd(), '.cake'), worktree = process.cwd();
  const head = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',env:childEnvironment(),stdio:['ignore','pipe','pipe']}).trim();
  const clean = execFileSync('git',['status','--porcelain=v1','--untracked-files=all'],{encoding:'utf8',env:childEnvironment(),stdio:['ignore','pipe','pipe']}).trim();
  if (head !== expected.controlSha || clean) return fail('CONTROL_CHANGED');
  const sourceConfig: unknown = JSON.parse(await readFile(join(worktree,'production-migration.config.json'),'utf8'));
  if (canonical(sourceConfig)!==canonical(config) || hash(JSON.stringify(sourceConfig))!==hash(JSON.stringify(config))) return fail('CONFIG_CHANGED');
  const proof = await readProductionSchemaQaReceipt(githubGet(),expected);
  await mkdir(directory,{recursive:true,mode:0o700});
  const path = join(directory,`production-schema-qa-${expected.runId}-receipt.json`);
  await writeFile(path,JSON.stringify(proof,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({ runId:expected.runId,runAttempt:proof.runAttempt,success:proof.success,
    stage:proof.receipt.stage,code:proof.receipt.code,path }));
  if (!proof.success) process.exitCode=2;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  void main().catch(error=>{
    console.error(JSON.stringify({success:false,code:error instanceof ReadError?error.message:'RECEIPT_READ_FAILED'})); process.exitCode=1;
  });
}

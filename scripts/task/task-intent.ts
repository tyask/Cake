import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { CAKE_REPOSITORY, commandOutput, executeWorkflowCommand, validTaskBranch } from './task-workflow';

export const taskIntentProtocol = 'cake-intent/v1';
export const taskIntentRoot = 'aidlc/spaces/default/intents';
export const taskIntentRegistry = 'aidlc/spaces/default/intents.json';
const registryProtocol = 'cake-intent-registry/v1';
const phases = ['Initialization', 'Ideation', 'Inception', 'Construction', 'Operation'] as const;
const statuses = ['running', 'blocked', 'paused', 'frozen'] as const;
export type IntentPhase = typeof phases[number];
export type IntentStatus = typeof statuses[number];
export type IntentApproval = { planHash: string; planFile: string; actor: string; recordedAt: string; reply: string };
type IntentEvent = { action: string; recordedAt: string; note: string; planHash: string };
export type TaskIntentRecord = {
  protocol: typeof taskIntentProtocol;
  id: string;
  repository: typeof CAKE_REPOSITORY;
  issue: number;
  issueUrl: string;
  branch: string;
  branches: string[];
  recordDir: string;
  phase: IntentPhase;
  status: IntentStatus;
  planHash: string;
  approval: IntentApproval | null;
  frozen: boolean;
  createdAt: string;
  updatedAt: string;
  events: IntentEvent[];
};
type RegistryRow = Pick<TaskIntentRecord, 'id' | 'issue' | 'branch' | 'branches' | 'recordDir'>;
type Registry = { protocol: typeof registryProtocol; intents: RegistryRow[] };
export type TaskIntentOptions = {
  args?: readonly string[]; cwd?: string; branch?: string; now?: () => Date; log?: (message: string) => void;
};

const error = (code: string): never => { throw new Error(code); };
const isId = (value: unknown): value is string => typeof value === 'string' && /^\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 67;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const isText = (value: unknown, max = 100_000): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');

function intentId(value: string): string {
  const id = value.startsWith(`${taskIntentRoot}/`) ? value.slice(taskIntentRoot.length + 1) : value;
  if (!isId(id)) error('CAKE_INTENT_INVALID_ID');
  return id;
}

/** Refuse symbolic links anywhere along a record or input path. */
async function safePath(cwd: string, input: string): Promise<string> {
  const root = await realpath(cwd), target = resolve(root, input), path = relative(root, target);
  if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) error('CAKE_INTENT_PATH_OUTSIDE_WORKTREE');
  let current = root;
  for (const part of path.split(sep)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) error('CAKE_INTENT_SYMLINK');
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') throw caught;
    }
  }
  return target;
}

async function textFile(cwd: string, input: string, max = 1_000_000): Promise<string> {
  const path = await safePath(cwd, input), metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > max) error('CAKE_INTENT_INVALID_TEXT_FILE');
  const value = await readFile(path, 'utf8');
  if (!isText(value, max)) error('CAKE_INTENT_INVALID_TEXT_FILE');
  // Reject recognizable secrets rather than publishing them in committed history.
  if (/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^\s/:]+:[^\s@]+@)/.test(value)) error('CAKE_INTENT_SECRET_CONTENT');
  // Match the repository's LF contract before hashing or committing user-authored input.
  return value.replaceAll('\r\n', '\n');
}

async function jsonFile(cwd: string, path: string): Promise<unknown> {
  const value = await textFile(cwd, path);
  try { return JSON.parse(value); } catch { return error('CAKE_INTENT_INVALID_JSON'); }
}

async function registry(cwd: string): Promise<Registry> {
  let value: Registry;
  try { value = await jsonFile(cwd, taskIntentRegistry) as Registry; }
  catch (caught) { if ((caught as NodeJS.ErrnoException).code === 'ENOENT') return { protocol: registryProtocol, intents: [] }; throw caught; }
  if (!value || value.protocol !== registryProtocol || !Array.isArray(value.intents)) error('CAKE_INTENT_INVALID_REGISTRY');
  const ids = new Set(), issues = new Set(), branches = new Set();
  for (const row of value.intents) {
    if (!row || !isId(row.id) || !Number.isSafeInteger(row.issue) || row.issue < 1 || !validTaskBranch(row.branch)
      || !Array.isArray(row.branches) || !row.branches.includes(row.branch) || new Set(row.branches).size !== row.branches.length
      || row.branches.some(branch => !validTaskBranch(branch) || branches.has(branch))
      || row.recordDir !== `${taskIntentRoot}/${row.id}` || ids.has(row.id) || issues.has(row.issue)) error('CAKE_INTENT_INVALID_REGISTRY');
    ids.add(row.id); issues.add(row.issue); row.branches.forEach(branch => branches.add(branch));
  }
  return value;
}

function validateRecord(value: unknown, row: RegistryRow): TaskIntentRecord {
  const record = value as TaskIntentRecord;
  if (!record || record.protocol !== taskIntentProtocol || record.repository !== CAKE_REPOSITORY
    || record.id !== row.id || record.issue !== row.issue || record.branch !== row.branch || record.recordDir !== row.recordDir
    || JSON.stringify(record.branches) !== JSON.stringify(row.branches)
    || record.issueUrl !== `https://github.com/${CAKE_REPOSITORY}/issues/${row.issue}` || !phases.includes(record.phase)
    || !statuses.includes(record.status) || !isHash(record.planHash) || typeof record.frozen !== 'boolean'
    || (record.frozen !== (record.status === 'frozen')) || !isDate(record.createdAt) || !isDate(record.updatedAt)
    || !Array.isArray(record.events) || record.events.some(event => !event || !isText(event.action, 80) || !isText(event.note)
      || !isDate(event.recordedAt) || !isHash(event.planHash))) error('CAKE_INTENT_INVALID_RECORD');
  const approval = record.approval;
  if (approval !== null && (!approval || !isHash(approval.planHash) || !isText(approval.actor, 120)
    || approval.planFile !== `plans/${approval.planHash}.md` || /[\r\n]/.test(approval.actor)
    || !isDate(approval.recordedAt) || !isText(approval.reply)
    || !record.events.some(event => event.action === 'APPROVE' && event.planHash === approval.planHash))) error('CAKE_INTENT_INVALID_APPROVAL');
  return record;
}

async function currentBranch(cwd: string, supplied?: string): Promise<string> {
  const branch = supplied ?? await commandOutput(executeWorkflowCommand, 'git', ['branch', '--show-current'], cwd);
  if (!validTaskBranch(branch)) error('CAKE_INTENT_INVALID_BRANCH');
  return branch;
}

/** expectedBranch comes from the PR command's independently checked clean task head. */
export async function readTaskIntent(cwd: string, intent?: string, expectedBranch?: string): Promise<TaskIntentRecord | null> {
  const index = await registry(cwd);
  const branch = expectedBranch ?? (intent ? undefined : await currentBranch(cwd));
  const id = intent ? intentId(intent) : undefined;
  const row = index.intents.find(item => id ? item.id === id : branch !== undefined && item.branches.includes(branch));
  if (!row) return null;
  const record = validateRecord(await jsonFile(cwd, `${row.recordDir}/cake-intent.json`), row);
  if (branch !== undefined && !record.branches.includes(branch)) error('CAKE_INTENT_BRANCH_MISMATCH');
  for (const planHash of new Set(record.events.filter(event => event.action === 'APPROVE').map(event => event.planHash))) {
    if (hash(await textFile(cwd, `${record.recordDir}/plans/${planHash}.md`)) !== planHash) error('CAKE_INTENT_APPROVAL_PLAN_CHANGED');
  }
  return record;
}

async function assertApproval(cwd: string, record: TaskIntentRecord): Promise<void> {
  const actual = hash(await textFile(cwd, `${record.recordDir}/plan.md`));
  if (actual !== record.planHash || !record.approval || record.approval.planHash !== actual) error('CAKE_INTENT_PLAN_APPROVAL_REQUIRED');
}

export async function assertTaskIntentReady(cwd: string, intent?: string, expectedBranch?: string): Promise<TaskIntentRecord> {
  const record = await readTaskIntent(cwd, intent, expectedBranch);
  if (!record) return error('CAKE_INTENT_REQUIRED');
  await assertApproval(cwd, record);
  if (!record.frozen) error('CAKE_INTENT_FREEZE_REQUIRED');
  return record;
}

export function renderTaskIntentLinks(record: TaskIntentRecord): string {
  return `- 関連Issue：${record.issueUrl}\n- Intent：\`${record.recordDir}\`\n- 承認済み計画SHA-256：\`${record.planHash}\``;
}

function quote(value: string): string { return value.trim().split('\n').map(line => `> ${line}`).join('\n'); }
function stateMarkdown(record: TaskIntentRecord): string {
  return `# ${record.id}\n\nCake運用層の進捗表示。公式AI-DLCエンジンのstate/receiptではない。\n正本は cake-intent.json。\n\n`
    + `${renderTaskIntentLinks(record)}\n- Primary branch：\`${record.branch}\`\n- Branches：${record.branches.map(branch => `\`${branch}\``).join(', ')}\n- Phase：${record.phase}\n- Status：${record.status}\n- 記録更新日時：${record.updatedAt}\n`
    + `- 計画承認：${record.approval?.planHash === record.planHash ? '記録あり（対象計画のhash一致はCLIで検査）' : '未承認'}\n`
    + `- 記録凍結：${record.frozen ? '済み。以後の検証・Ready・Operation結果はIssue/PR/Actionsに保存する。' : '未凍結'}\n\n`
    + `## 再開\n\n計画・承認・直近の監査記録を確認し、statusで状態を読み取る。\n凍結後の修正はreopen、計画変更はplanで記録し、必要な再承認・再レビュー・再検証を行う。\n`;
}
function auditMarkdown(record: TaskIntentRecord): string {
  return '# Cake workflow audit\n\nCake運用の記録。公式エンジンの承認receiptではない。日時は記録日時。\n\n'
    + record.events.map(event => `## ${event.action}\n\n- 記録日時：${event.recordedAt}\n- 計画SHA-256：\`${event.planHash}\`\n\n${quote(event.note)}\n`).join('\n');
}

async function atomicText(cwd: string, path: string, value: string): Promise<void> {
  const file = await safePath(cwd, path);
  await mkdir(dirname(file), { recursive: true });
  const temporary = resolve(dirname(file), `.cake-${process.pid}-${randomUUID()}.tmp`);
  try { await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

async function save(cwd: string, record: TaskIntentRecord): Promise<void> {
  validateRecord(record, { id: record.id, issue: record.issue, branch: record.branch, branches: record.branches, recordDir: record.recordDir });
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > 1_000_000) error('CAKE_INTENT_RECORD_TOO_LARGE');
  await atomicText(cwd, `${record.recordDir}/cake-intent.json`, serialized);
  await atomicText(cwd, `${record.recordDir}/aidlc-state.md`, stateMarkdown(record));
  await atomicText(cwd, `${record.recordDir}/audit/cake.md`, auditMarkdown(record));
}

async function locked<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const path = await safePath(cwd, `${taskIntentRoot}/.cake-lock`);
  await mkdir(dirname(path), { recursive: true });
  try { await mkdir(path); } catch (caught) { if ((caught as NodeJS.ErrnoException).code === 'EEXIST') error('CAKE_INTENT_BUSY'); throw caught; }
  try { return await operation(); } finally { await rm(path, { recursive: true, force: true }); }
}

function argumentsMap(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  const flags = ['--issue', '--name', '--plan-file', '--intent', '--actor', '--reply-file', '--at', '--phase', '--status', '--note-file'];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!flags.includes(key) || values.has(key) || !value || value.startsWith('--')) error('CAKE_INTENT_INVALID_ARGUMENTS');
    values.set(key, value);
  }
  return values;
}
function value(values: Map<string, string>, key: string): string { return values.get(key) ?? error('CAKE_INTENT_MISSING_ARGUMENT'); }
function assertFlags(values: Map<string, string>, allowed: string[]): void {
  if ([...values.keys()].some(key => !allowed.includes(key))) error('CAKE_INTENT_INVALID_ARGUMENTS');
}
function japanDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('');
}

export async function runTaskIntent({ args = [], cwd = process.cwd(), branch, now = () => new Date(), log = console.log }: TaskIntentOptions = {}): Promise<TaskIntentRecord | null> {
  const action = args[0], values = argumentsMap(args.slice(1));
  if (!['init', 'approve', 'plan', 'progress', 'freeze', 'reopen', 'attach', 'status'].includes(action)) error('CAKE_INTENT_INVALID_ACTION');
  if (action === 'status') {
    assertFlags(values, ['--intent']);
    const record = await readTaskIntent(cwd, values.get('--intent'), await currentBranch(cwd, branch));
    log(record ? JSON.stringify({ id: record.id, issue: record.issue, phase: record.phase, status: record.status,
      frozen: record.frozen, planApproved: record.approval?.planHash === hash(await textFile(cwd, `${record.recordDir}/plan.md`)), updatedAt: record.updatedAt }) : 'Cake: 対応するIntentはありません。');
    return record;
  }
  return locked(cwd, async () => {
    const at = now().toISOString(), current = await currentBranch(cwd, branch);
    if (action === 'init') {
      assertFlags(values, ['--issue', '--name', '--plan-file']);
      const name = value(values, '--name'), issueText = value(values, '--issue'), issue = Number(issueText);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 60 || !/^[1-9][0-9]*$/.test(issueText) || !Number.isSafeInteger(issue)) error('CAKE_INTENT_INVALID_ARGUMENTS');
      const id = `${japanDate(now())}-${name}`, index = await registry(cwd);
      if (index.intents.some(row => row.id === id || row.issue === issue || row.branches.includes(current))) error('CAKE_INTENT_ALREADY_EXISTS');
      const plan = await textFile(cwd, value(values, '--plan-file')), recordDir = `${taskIntentRoot}/${id}`;
      try { await lstat(await safePath(cwd, recordDir)); error('CAKE_INTENT_ALREADY_EXISTS'); }
      catch (caught) { if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') throw caught; }
      const record: TaskIntentRecord = { protocol: taskIntentProtocol, id, repository: CAKE_REPOSITORY, issue,
        issueUrl: `https://github.com/${CAKE_REPOSITORY}/issues/${issue}`, branch: current, branches: [current], recordDir,
        phase: 'Inception', status: 'running', planHash: hash(plan), approval: null, frozen: false, createdAt: at, updatedAt: at,
        events: [{ action: 'CREATED', recordedAt: at, note: 'Issueに対応する計画を記録した。承認は別途記録する。', planHash: hash(plan) }] };
      await atomicText(cwd, `${recordDir}/plan.md`, plan);
      await save(cwd, record);
      index.intents.push({ id, issue, branch: current, branches: [current], recordDir });
      await atomicText(cwd, taskIntentRegistry, `${JSON.stringify(index, null, 2)}\n`);
      log(`Cake: Intent ${id} を作成しました。`);
      return record;
    }
    const record = await readTaskIntent(cwd, value(values, '--intent'), action === 'attach' ? undefined : current);
    if (!record) return error('CAKE_INTENT_REQUIRED');
    let note: string;
    if (action === 'attach') {
      assertFlags(values, ['--intent', '--note-file']);
      await assertApproval(cwd, record);
      const index = await registry(cwd);
      if (index.intents.some(row => row.id !== record.id && row.branches.includes(current))) error('CAKE_INTENT_BRANCH_ALREADY_ASSIGNED');
      if (record.branches.includes(current)) error('CAKE_INTENT_BRANCH_ALREADY_ASSIGNED');
      note = `関連branchを追加：${current}\n${await textFile(cwd, value(values, '--note-file'), 90_000)}`;
      record.branches.push(current); record.frozen = false; record.status = 'running'; record.phase = 'Construction';
      const row = index.intents.find(row => row.id === record.id)!;
      row.branches = [...record.branches];
      record.updatedAt = at;
      record.events.push({ action: 'ATTACH', recordedAt: at, note, planHash: record.planHash });
      await save(cwd, record);
      await atomicText(cwd, taskIntentRegistry, `${JSON.stringify(index, null, 2)}\n`);
      log(`Cake: Intent ${record.id} に関連branchを記録しました。`);
      return record;
    } else if (action === 'plan') {
      assertFlags(values, ['--intent', '--plan-file']);
      const plan = await textFile(cwd, value(values, '--plan-file'));
      record.planHash = hash(plan); record.approval = null; record.frozen = false; record.status = 'running'; record.phase = 'Inception';
      await atomicText(cwd, `${record.recordDir}/plan.md`, plan);
      note = '計画を更新した。前の承認は新しい計画を許可しないため再承認が必要。';
    } else if (action === 'reopen') {
      assertFlags(values, ['--intent', '--note-file']);
      note = await textFile(cwd, value(values, '--note-file'), 90_000);
      record.frozen = false; record.status = 'running'; record.phase = 'Construction';
    } else {
      if (record.frozen) error('CAKE_INTENT_FROZEN');
      if (action === 'approve') {
        assertFlags(values, ['--intent', '--actor', '--reply-file', '--at']);
        const actor = value(values, '--actor'), reply = await textFile(cwd, value(values, '--reply-file'), 90_000);
        if (!isText(actor, 120) || /[\r\n]/.test(actor)) error('CAKE_INTENT_INVALID_ACTOR');
        const plan = await textFile(cwd, `${record.recordDir}/plan.md`), actual = hash(plan);
        if (actual !== record.planHash) error('CAKE_INTENT_PLAN_CHANGED');
        const recordedAt = values.get('--at') ?? at;
        if (!isDate(recordedAt)) error('CAKE_INTENT_INVALID_DATE');
        const planFile = `plans/${record.planHash}.md`;
        await atomicText(cwd, `${record.recordDir}/${planFile}`, plan);
        record.approval = { actor, reply, recordedAt: new Date(recordedAt).toISOString(), planHash: record.planHash, planFile };
        note = `承認者：${actor}\n承認の記録日時：${record.approval.recordedAt}\n承認対象本文：[${planFile}](../${planFile})\n利用者の実際の回答：\n${reply.trim()}`;
      } else if (action === 'progress') {
        assertFlags(values, ['--intent', '--phase', '--status', '--note-file']);
        const phase = value(values, '--phase') as IntentPhase, status = value(values, '--status') as IntentStatus;
        if (!phases.includes(phase) || !['running', 'blocked', 'paused'].includes(status)) error('CAKE_INTENT_INVALID_PROGRESS');
        if (phase === 'Construction' || phase === 'Operation') await assertApproval(cwd, record);
        note = await textFile(cwd, value(values, '--note-file'), 90_000);
        record.phase = phase; record.status = status;
      } else {
        assertFlags(values, ['--intent']);
        await assertApproval(cwd, record);
        record.frozen = true; record.status = 'frozen';
        note = '最終レビュー・検証前にGit管理対象の記録を凍結した。検証結果・Ready・Operation結果はIssue/PR/Actionsに保存する。';
      }
    }
    record.updatedAt = at;
    record.events.push({ action: action.toUpperCase(), recordedAt: at, note, planHash: record.planHash });
    await save(cwd, record);
    log(`Cake: Intent ${record.id} の${action}を記録しました。`);
    return record;
  });
}

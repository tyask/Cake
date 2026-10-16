import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const CAKE_REPOSITORY = 'tyask/Cake';
export type WorkflowCommand = 'git' | 'gh';
export type WorkflowCommandResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string };
export type WorkflowExecutor = (command: WorkflowCommand, args: readonly string[], cwd: string) => Promise<WorkflowCommandResult>;
export type TaskHead = { cwd: string; branch: string; sha: string };
export type TaskPullRequest = { url: string; number: number; headRefOid: string; isDraft: boolean };
const fail = () => new Error('Cakeの対象ブランチ・commit・PRを確認できません。外部応答は表示しません。');
export const executeWorkflowCommand: WorkflowExecutor = (command, args, cwd) => new Promise((resolveResult, reject) => {
  const child = spawn(command, [...args], { cwd, env: { ...process.env, GH_HOST: 'github.com' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', overflow = false;
  const timer = setTimeout(() => child.kill(), 60_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { if (stdout.length + chunk.length > 4_000_000) { overflow = true; child.kill(); } else stdout += chunk; });
  child.stderr.resume();
  child.once('error', () => { clearTimeout(timer); reject(fail()); });
  child.once('close', (status, signal) => { clearTimeout(timer); resolveResult({ status: overflow ? 1 : status, signal, stdout }); });
});
export async function commandOutput(execute: WorkflowExecutor, command: WorkflowCommand, args: readonly string[], cwd: string, message = fail().message): Promise<string> {
  try { const result = await execute(command, args, cwd); if (result.status !== 0 || result.signal) throw fail(); return result.stdout.trim(); }
  catch { throw new Error(message); }
}
export function validTaskBranch(value: unknown): value is string {
  return typeof value === 'string' && /^codex\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 66
    && !['codex/main', 'codex/preview', 'codex/production'].includes(value);
}
export function fullSha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value); }
export function previewUrl(value: unknown): string {
  if (typeof value !== 'string' || /\s/.test(value)) throw fail();
  const url = new URL(value.startsWith('https://') ? value : `https://${value}`);
  if (!/^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/.test(url.href) || url.username || url.password || url.port || url.search || url.hash) throw fail();
  return url.origin;
}
export function pullRequestUrl(value: unknown): string {
  if (typeof value !== 'string' || !/^https:\/\/github\.com\/tyask\/Cake\/pull\/[1-9][0-9]*$/.test(value)) throw fail();
  return value;
}
export async function cleanTaskHead(cwd: string, execute = executeWorkflowCommand): Promise<TaskHead> {
  const root = await commandOutput(execute, 'git', ['rev-parse', '--show-toplevel'], cwd);
  const branch = await commandOutput(execute, 'git', ['branch', '--show-current'], root);
  const sha = await commandOutput(execute, 'git', ['rev-parse', 'HEAD'], root);
  const status = await commandOutput(execute, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], root);
  const origin = await commandOutput(execute, 'git', ['remote', 'get-url', 'origin'], root);
  if (!validTaskBranch(branch) || !fullSha(sha) || status || !/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)tyask\/Cake(?:\.git)?$/.test(origin)) throw fail();
  return { cwd: root, branch, sha };
}
export function assertMainOnlyGitConfig(value: unknown): void {
  const v = value as { git?: { deploymentEnabled?: Record<string, boolean> } };
  const rules = v?.git?.deploymentEnabled;
  if (!rules || rules['**'] !== false || rules.main !== true || Object.entries(rules).some(([k, v]) => k !== 'main' && v !== false)) throw fail();
}
export async function assertTaskGitGate(head: TaskHead, execute = executeWorkflowCommand): Promise<string> {
  assertMainOnlyGitConfig(JSON.parse(await readFile(resolve(head.cwd, 'vercel.json'), 'utf8')));
  const main = JSON.parse(await commandOutput(execute, 'gh', ['api', `repos/${CAKE_REPOSITORY}/branches/main`], head.cwd));
  if (main.name !== 'main' || !fullSha(main.commit?.sha)) throw fail();
  const config = JSON.parse(await commandOutput(execute, 'gh', ['api', `repos/${CAKE_REPOSITORY}/contents/vercel.json?ref=${main.commit.sha}`], head.cwd));
  if (config.encoding !== 'base64' || config.type !== 'file') throw fail();
  assertMainOnlyGitConfig(JSON.parse(Buffer.from(config.content, 'base64').toString()));
  return main.commit.sha;
}
export async function taskPullRequests(head: TaskHead, execute = executeWorkflowCommand): Promise<TaskPullRequest[]> {
  const values = JSON.parse(await commandOutput(execute, 'gh', ['pr', 'list', '--repo', CAKE_REPOSITORY, '--base', 'main', '--head', head.branch, '--state', 'open', '--json', 'url,number,headRefOid,isDraft'], head.cwd));
  if (!Array.isArray(values) || values.length > 1) throw fail();
  return values.map(v => { if (!Number.isSafeInteger(v.number) || v.number < 1 || !fullSha(v.headRefOid) || typeof v.isDraft !== 'boolean') throw fail(); return { ...v, url: pullRequestUrl(v.url) }; });
}

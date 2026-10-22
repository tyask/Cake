import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWindowsQaConfig } from './windows-qa-model';
import { parseWindowsQaResult } from './windows-qa-result';

export type WindowsQaOptions = {
  mode: 'help' | 'status' | 'input' | 'preflight' | 'self-test' | 'verify';
  targetWorktree?: string; pr?: number; sha?: string; deploymentId?: string;
  databaseBranchId?: string; generation?: string;
};
const rejected = () => new Error('WINDOWS_QA_ARGUMENTS_REJECTED');
export function parseWindowsQaArgs(args: readonly string[], cwd: string): WindowsQaOptions {
  if (args.length === 1 && ['--help', 'help', '-h'].includes(args[0])) return { mode: 'help' };
  const [mode, ...rest] = args;
  if (!['status', 'input', 'preflight', 'self-test', 'verify'].includes(mode)) throw rejected();
  if (mode !== 'verify') { if (rest.length) throw rejected(); return { mode: mode as WindowsQaOptions['mode'] }; }
  const names = ['--pr', '--sha', '--deployment', '--database', '--generation', '--target-worktree'];
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const [key, value] = rest.slice(i, i + 2);
    if (!names.includes(key) || values.has(key) || !value || value.startsWith('--') || /[\r\n\0]/.test(value)) throw rejected();
    values.set(key, value);
  }
  if (names.slice(0, 5).some(name => !values.has(name)) || !/^[1-9][0-9]*$/.test(values.get('--pr')!) ||
    !Number.isSafeInteger(Number(values.get('--pr'))) || !/^[a-f0-9]{40}$/.test(values.get('--sha')!) ||
    !/^dpl_[A-Za-z0-9]+$/.test(values.get('--deployment')!) || !/^br-[a-z0-9-]+$/.test(values.get('--database')!) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(values.get('--generation')!)) throw rejected();
  return { mode: 'verify', targetWorktree: resolve(cwd, values.get('--target-worktree') ?? '.'), pr: Number(values.get('--pr')),
    sha: values.get('--sha'), deploymentId: values.get('--deployment'), databaseBranchId: values.get('--database'), generation: values.get('--generation') };
}

/** Source literals, never shell command construction. */
export function csharpVerbatim(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('WINDOWS_QA_PATH_REJECTED');
  return '@"' + value.replaceAll('"', '""') + '"';
}
export function brokerArguments(mode: string, selfTestRoot: string): string[] {
  if (mode === 'self-test') return ['--self-test', selfTestRoot];
  if (!['status', 'input', 'preflight', 'verify'].includes(mode)) throw rejected();
  return ['--' + mode];
}
export function safeWindowsToolEnvironment(environment: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const safe = {} as NodeJS.ProcessEnv;
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'HOMEDRIVE', 'HOMEPATH', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (environment[key]) safe[key] = environment[key];
  }
  for (const key of ['NODE_USE_SYSTEM_CA', 'NODE_USE_ENV_PROXY']) if (environment[key] === '1') safe[key] = '1';
  return safe;
}

type Executed = { code: number | null; stdout: string; interrupted: boolean };
async function execute(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<Executed> {
  return new Promise((accept, reject) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', overflow = false, interrupted = false;
    const stop = () => {
      interrupted = true;
      const windows = env.SystemRoot ?? env.WINDIR;
      if (process.platform === 'win32' && windows && child.pid) {
        const killer = spawn(join(windows, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          { env, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
      } else child.kill();
    };
    const timer = setTimeout(stop, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (stdout.length + chunk.length > 1_000_000) { overflow = true; stop(); } else stdout += chunk; });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new Error('WINDOWS_QA_TOOL_UNAVAILABLE')); });
    child.once('close', code => { clearTimeout(timer); accept({ code: overflow ? 1 : code, stdout, interrupted }); });
  });
}
async function gitValue(git: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execute(git, args, cwd, env, 30_000);
  if (result.code !== 0) throw new Error('WINDOWS_QA_CHECKOUT_REJECTED');
  return result.stdout.trim();
}
function executable(name: string, fallback: string, environment: NodeJS.ProcessEnv): string {
  const fromPath = (environment.PATH ?? environment.Path ?? '').split(';').filter(Boolean).map(part => join(part, name));
  const found = [...fromPath, fallback].find(file => isAbsolute(file) && existsSync(file));
  if (!found) throw new Error('WINDOWS_QA_TOOL_UNAVAILABLE');
  return found;
}
const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

export async function runWindowsQa(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const options = parseWindowsQaArgs(args, cwd);
  if (options.mode === 'help') {
    console.log('npm.cmd run qa:windows -- status|input|preflight|self-test\nnpm.cmd run qa:windows -- verify --pr <N> --sha <full-sha> --deployment <id> --database <branch-id> --generation <uuid> [--target-worktree <path>]\nSee docs/windows-qa-credentials.md. No token values are accepted as arguments.');
    return;
  }
  if (process.platform !== 'win32') throw new Error('WINDOWS_QA_WINDOWS_REQUIRED');
  const env = safeWindowsToolEnvironment(process.env);
  const programs = process.env.ProgramFiles ?? 'C:\\Program Files';
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const git = executable('git.exe', join(programs, 'Git', 'cmd', 'git.exe'), process.env);
  const gh = executable('gh.exe', join(programs, 'GitHub CLI', 'gh.exe'), process.env);
  env.PATH = [dirname(process.execPath), dirname(git), dirname(gh), join(windows, 'System32'), windows].join(';');
  const control = await gitValue(git, ['rev-parse', '--show-toplevel'], cwd, env);
  const controlSha = await gitValue(git, ['rev-parse', 'HEAD'], control, env);
  if (!/^[a-f0-9]{40}$/.test(controlSha) || resolve(dirname(fileURLToPath(import.meta.url)), '../../..') !== resolve(control)) throw new Error('WINDOWS_QA_CHECKOUT_REJECTED');
  const tools = join(control, '.cake', 'windows-tools');
  await mkdir(tools, { recursive: true });
  const operation = await mkdtemp(join(tools, 'run-'));
  const configPath = join(operation, 'request.json');
  const common = { protocol: 'cake-windows-qa-request/v1', mode: options.mode === 'verify' ? 'verify' : 'preflight', controlCwd: control, controlSha, gitExe: git, ghExe: gh };
  const request = options.mode === 'verify' ? { ...common, targetWorktree: options.targetWorktree, pr: options.pr, sha: options.sha,
    deploymentId: options.deploymentId, databaseBranchId: options.databaseBranchId, generation: options.generation } : common;
  if (options.mode === 'verify') parseWindowsQaConfig(request, 'verify');
  else parseWindowsQaConfig(request, 'preflight');
  await writeFile(configPath, JSON.stringify(request) + '\n', { flag: 'wx' });
  const sourceRoot = join(control, 'scripts', 'qa', 'windows', 'windows-token-helper');
  const childPath = join(control, 'scripts', 'qa', 'windows', 'windows-qa-child.ts');
  const dummyPath = join(sourceRoot, 'dummy-child.mjs');
  const loader = join(control, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const fields: Record<string, string> = { ControlRoot: control, ControlSha: controlSha, SourceRoot: sourceRoot, TestBase: tools,
    NodeExe: process.execPath, GitExe: git, GhExe: gh, LoaderPath: loader, LoaderSha256: await hash(loader),
    ChildPath: childPath, ChildSha256: await hash(childPath), ConfigPath: configPath, ConfigSha256: await hash(configPath),
    DummyChildPath: dummyPath, DummyChildSha256: await hash(dummyPath) };
  const buildInfo = join(operation, 'BuildInfo.cs');
  await writeFile(buildInfo, 'namespace CakeQaHelper { internal static class BuildInfo {\n' +
    Object.entries(fields).map(([key, value]) => `internal const string ${key} = ${csharpVerbatim(value)};`).join('\n') + '\n} }\n', { flag: 'wx' });
  const compiler = ['Framework64', 'Framework'].map(folder => join(windows, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe')).find(existsSync);
  if (!compiler) throw new Error('WINDOWS_QA_COMPILER_UNAVAILABLE');
  const exe = join(operation, 'CakeWindowsTokenHelper.exe');
  const sources = (await readdir(sourceRoot)).filter(name => name.endsWith('.cs')).sort().map(name => join(sourceRoot, name));
  const compiled = await execute(compiler, ['/nologo', '/target:exe', '/codepage:65001', '/out:' + exe, '/win32manifest:' + join(sourceRoot, 'helper.manifest'),
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Security.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Core.dll', buildInfo, ...sources], control, env, 60_000);
  if (compiled.code !== 0) throw new Error('WINDOWS_QA_BUILD_FAILED');
  // The broker's shorter timeout kills its own Node/browser tree and invalidates
  // its proof. Leave room for all bounded pre/post Git checks before this limit.
  const result = await execute(exe, brokerArguments(options.mode, join(operation, 'dummy-store')), control, env, 4_300_000);
  if (result.interrupted) throw new Error('WINDOWS_QA_RESULT_REJECTED');
  let parsed: Record<string, unknown>;
  try { parsed = parseWindowsQaResult(JSON.parse(result.stdout), result.code, options.mode); }
  catch { throw new Error('WINDOWS_QA_RESULT_REJECTED'); }
  // Broker results are fixed projections; raw child output and exceptions never reach this layer.
  const publicPath = join(operation, 'result.json');
  await writeFile(publicPath, JSON.stringify(parsed, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...parsed, resultPath: publicPath }));
  if (!parsed.success) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runWindowsQa().catch(error => {
  const codes = new Set(['WINDOWS_QA_ARGUMENTS_REJECTED', 'WINDOWS_QA_PATH_REJECTED', 'WINDOWS_QA_TOOL_UNAVAILABLE',
    'WINDOWS_QA_CHECKOUT_REJECTED', 'WINDOWS_QA_WINDOWS_REQUIRED', 'WINDOWS_QA_COMPILER_UNAVAILABLE', 'WINDOWS_QA_BUILD_FAILED', 'WINDOWS_QA_RESULT_REJECTED']);
  const code = error instanceof Error && codes.has(error.message) ? error.message : 'WINDOWS_QA_FAILED';
  console.error(JSON.stringify({ protocol: 'cake-windows-qa-error/v1', success: false, code,
    help: 'See docs/windows-qa-credentials.md; no credentials or raw errors are displayed.' }));
  process.exitCode = 1;
});

import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CanneleIntegrationError, executeConfigurationGit, gitOutput, loadReviewedCanneleConfiguration,
  type CakeCanneleConfiguration, type ConfigurationGit } from './cannele-config';

export type CakeCommand = 'auth' | 'slots' | 'reserve' | 'status' | 'preview' | 'publish' | 'verify' | 'release' | 'task-pr';
type Environment = Readonly<Record<string, string | undefined>>;
export type SharedLauncher = (args: readonly string[], cwd: string, environment: Environment, stage: 'generate' | 'command') => number;
const launchShared: SharedLauncher = (args, cwd, environment, stage) => {
  const selectedEnvironment = environment.NODE_ENV;
  const nodeEnvironment = selectedEnvironment === 'development' || selectedEnvironment === 'test' || selectedEnvironment === 'production'
    ? selectedEnvironment : process.env.NODE_ENV;
  const result = spawnSync(process.execPath, [...args], { cwd, env: { ...environment, NODE_ENV: nodeEnvironment }, encoding: 'utf8',
    stdio: stage === 'generate' ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'inherit', 'pipe'],
    timeout: stage === 'generate' ? 120_000 : 20 * 60_000, maxBuffer: 65_536 });
  if (result.error || result.signal || result.status === null) throw new CanneleIntegrationError('CANNELE_CHILD_UNAVAILABLE');
  return result.status;
};

function allowedArguments(command: CakeCommand, args: readonly string[]): string[] {
  if (command === 'auth') {
    if (args.length !== 1 || !['login', 'status', 'logout'].includes(args[0])) throw new CanneleIntegrationError('CANNELE_AUTH_ARGUMENTS_INVALID');
    return ['auth', args[0]];
  }
  if (command === 'task-pr') return ['qa', 'ready', ...args];
  if (command === 'verify') {
    if (args.length && !(args.length === 2 && (args[0] === '--url-kind' && ['unique', 'fixed'].includes(args[1]) || args[0] === '--url' && /^https:\/\//.test(args[1])))) throw new CanneleIntegrationError('CANNELE_VERIFY_ARGUMENTS_INVALID');
  } else if (command === 'release') {
    if (args.length && !(args.length === 1 && args[0] === '--confirm-open-pr')) throw new CanneleIntegrationError('CANNELE_LEGACY_ARGUMENTS_REJECTED');
  } else if (args.length) throw new CanneleIntegrationError('CANNELE_LEGACY_ARGUMENTS_REJECTED');
  return ['qa', command, ...args];
}

/** Only the reviewed exact Cannele commit can receive the local session and
 * Vercel CLI environment. Node errors and subprocess stderr are not printed. */
export function runPinnedSharedCli({ configuration, command, args, cwd, environment = process.env, git = executeConfigurationGit, launch = launchShared }:
  { configuration: CakeCanneleConfiguration; command: CakeCommand; args: readonly string[]; cwd: string; environment?: Environment; git?: ConfigurationGit; launch?: SharedLauncher }): number {
  if (!configuration.enabled || !configuration.sourceRevision || !configuration.profile) throw new CanneleIntegrationError('CANNELE_NOT_CONFIGURED');
  const forwarded = allowedArguments(command, args);
  const configuredDirectory = environment.CANNELE_SOURCE_DIR;
  if (!configuredDirectory?.trim()) throw new CanneleIntegrationError('CANNELE_SOURCE_DIR_REQUIRED');
  let source: string;
  try { source = realpathSync(resolve(cwd, configuredDirectory)); } catch { throw new CanneleIntegrationError('CANNELE_SOURCE_UNAVAILABLE'); }
  try {
    if (realpathSync(gitOutput(git, source, ['rev-parse', '--show-toplevel'])) !== source || gitOutput(git, source, ['rev-parse', 'HEAD']) !== configuration.sourceRevision
      || gitOutput(git, source, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new CanneleIntegrationError('CANNELE_SOURCE_REVISION_MISMATCH');
  } catch (error) {
    if (error instanceof CanneleIntegrationError) throw error;
    throw new CanneleIntegrationError('CANNELE_SOURCE_UNAVAILABLE');
  }
  const entry = join(source, 'src/cli/index.ts'), generator = join(source, 'scripts/generate-contracts.ts'), loader = join(source, 'node_modules/tsx/dist/loader.mjs');
  for (const path of [entry, generator, loader]) {
    let info; try { info = lstatSync(path); } catch { throw new CanneleIntegrationError('CANNELE_SOURCE_UNAVAILABLE'); }
    if (!info.isFile() || info.isSymbolicLink()) throw new CanneleIntegrationError('CANNELE_SOURCE_UNAVAILABLE');
  }
  const configuredGlobal = environment.CANNELE_VERCEL_GLOBAL_CONFIG;
  if (configuredGlobal !== undefined && !configuredGlobal.trim()) throw new CanneleIntegrationError('CANNELE_ENV_INVALID');
  const handoffEnvironment: Environment = { ...environment, CANNELE_SOURCE_DIR: source,
    ...(configuredGlobal === undefined ? {} : { CANNELE_VERCEL_GLOBAL_CONFIG: resolve(cwd, configuredGlobal) }) };
  // Generated schema files are ignored in Git. Regenerate from the pinned YAML
  // and migrations instead of trusting leftover generated files in the checkout.
  const importLoader = pathToFileURL(loader).href;
  if (launch(['--import', importLoader, generator], source, handoffEnvironment, 'generate') !== 0) throw new CanneleIntegrationError('CANNELE_GENERATION_FAILED');
  const directory = mkdtempSync(join(tmpdir(), 'cake-cannele-'));
  try {
    chmodSync(directory, 0o700);
    const configFile = join(directory, 'config.json');
    const adapterModule = join(resolve(cwd), 'scripts/cannele-adapter.mjs');
    const info = lstatSync(adapterModule);
    if (!info.isFile() || info.isSymbolicLink()) throw new CanneleIntegrationError('CANNELE_ADAPTER_UNAVAILABLE');
    writeFileSync(configFile, `${JSON.stringify({ protocol: 'cannele-cli/v1', profile: configuration.profile, adapterModule })}\n`, { mode: 0o600, flag: 'wx' });
    return launch(['--import', importLoader, entry, '--config', configFile, '--cwd', resolve(cwd), ...forwarded], source, handoffEnvironment, 'command');
  } catch (error) {
    if (error instanceof CanneleIntegrationError) throw error;
    throw new CanneleIntegrationError('CANNELE_CHILD_UNAVAILABLE');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function legacy(command: CakeCommand, args: readonly string[], cwd: string): Promise<number> {
  if (command === 'preview') return (await (await import('./task-preview-registry')).runTaskPreviewRegistry({ args, cwd })).status === 'FULL' ? 2 : 0;
  if (command === 'verify') { await (await import('./qa-verify')).runQaVerify({ args, cwd }); return 0; }
  if (command === 'task-pr') { await (await import('./task-pr-registry')).runTaskPrRegistry({ args, cwd }); return 0; }
  if (['reserve', 'status', 'publish', 'release'].includes(command)) return (await (await import('./qa-client')).runQaClient({ args: [command, ...args], cwd })).status === 'full' ? 2 : 0;
  throw new CanneleIntegrationError('CANNELE_DISABLED');
}

export async function runCakeCommand({ command, args = [], cwd = process.cwd(), environment = process.env,
  load = () => loadReviewedCanneleConfiguration({ cwd }), shared = runPinnedSharedCli, runLegacy = legacy }:
  { command: CakeCommand; args?: readonly string[]; cwd?: string; environment?: Environment;
    load?: () => CakeCanneleConfiguration; shared?: typeof runPinnedSharedCli; runLegacy?: typeof legacy }): Promise<number> {
  const configuration = load();
  if (!configuration.enabled || command === 'task-pr' && args.includes('--draft')) return runLegacy(command, args, cwd);
  return shared({ configuration, command, args, cwd, environment });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commands: CakeCommand[] = ['auth', 'slots', 'reserve', 'status', 'preview', 'publish', 'verify', 'release', 'task-pr'];
  const command = process.argv[2] as CakeCommand;
  void (async () => {
    if (!commands.includes(command)) throw new CanneleIntegrationError('CANNELE_COMMAND_INVALID');
    process.exitCode = await runCakeCommand({ command, args: process.argv.slice(3) });
  })().catch(error => {
    const code = error instanceof CanneleIntegrationError && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'CANNELE_COMMAND_FAILED';
    console.error(`Cake: 操作を完了できませんでした (${code})。mainの設定、固定したCannele checkout、現在のQA状態を確認してください。`);
    process.exitCode = 1;
  });
}

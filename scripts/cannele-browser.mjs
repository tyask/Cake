import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const caseIds = Object.freeze(['desktop-a', 'desktop-b', 'mobile-a', 'mobile-b', 'read-api']);
const modulePath = fileURLToPath(import.meta.url);
const fail = () => { const error = new Error('CakeのQA画面・API確認を完了できませんでした。'); error.code = 'CAKE_BROWSER_FAILED'; return error; };
const safeKeys = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'CAKE_BROWSER_EXECUTABLE'];
function safeEnvironment(environment) {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0' || environment.DEBUG || environment.PWDEBUG) throw fail();
  return Object.fromEntries(safeKeys.flatMap(key => typeof environment[key] === 'string' ? [[key, environment[key]]] : []));
}
function publicInput(proof, options) {
  const profile = options.profile, source = options.source;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const providerId = /^[A-Za-z0-9_-]{1,200}$/;
  if (!proof || !profile || !source || profile.appId !== 'cake' || profile.repository?.fullName !== 'tyask/Cake'
    || profile.vercelProjectId !== 'prj_Z37vquodhpRd08ZTAtYnP0qa59jD' || profile.vercelTeamId !== 'team_D1Mcx2TdFWPKcypfu8KzNMub'
    || source.sourceSha !== proof.sourceSha || source.prNumber !== proof.prNumber || resolve(source.cwd) !== resolve(options.cwd)
    || !uuid.test(proof.leaseId) || !uuid.test(profile.instanceId) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(source.branch)
    || !Number.isSafeInteger(proof.prNumber) || proof.prNumber < 1 || !Number.isSafeInteger(proof.leaseVersion) || proof.leaseVersion < 1
    || !Number.isFinite(Date.parse(proof.checkedAt)) || !providerId.test(proof.database?.branchId) || !providerId.test(proof.database?.endpointId)
    || proof.urlKind === 'fixed' && !providerId.test(proof.aliasId)
    || !/^[a-f0-9]{40}$/.test(proof.sourceSha) || !/^qa[123]$/.test(proof.slot)
    || !/^dpl_[A-Za-z0-9]+$/.test(proof.deploymentId) || !['unique', 'fixed'].includes(proof.urlKind)
    || proof.database?.projectId !== profile.neonProjectId || !/^[a-f0-9]{64}$/.test(proof.databaseHostDigest)
    || !/^[a-f0-9]{64}$/.test(proof.productionHostDigest) || proof.databaseHostDigest === proof.productionHostDigest) throw fail();
  const url = new URL(proof.url);
  if (url.protocol !== 'https:' || url.origin !== proof.url || !/^[a-z0-9-]+\.vercel\.app$/.test(url.hostname)
    || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
    || proof.urlKind === 'fixed' && proof.url !== `https://cake-${proof.slot}-fumin.vercel.app`) throw fail();
  // Copy an explicit public allowlist before creating a child handoff file.
  return {
    proof: { ...Object.fromEntries(['leaseId', 'slot', 'prNumber', 'sourceSha', 'deploymentId', 'databaseHostDigest',
      'productionHostDigest', 'urlKind', 'url', 'leaseVersion', 'checkedAt', 'aliasId'].flatMap(key => proof[key] === undefined ? [] : [[key, proof[key]]])),
      database: { projectId: proof.database.projectId, branchId: proof.database.branchId, endpointId: proof.database.endpointId } },
    profile: { appId: profile.appId, repository: { fullName: profile.repository.fullName }, instanceId: profile.instanceId,
      vercelProjectId: profile.vercelProjectId, vercelTeamId: profile.vercelTeamId, neonProjectId: profile.neonProjectId },
    cwd: resolve(options.cwd), source: { cwd: resolve(source.cwd), branch: source.branch, sourceSha: source.sourceSha, prNumber: source.prNumber },
  };
}
async function browserDependencies() {
  const smoke = await tsImport('./qa-verify.ts', import.meta.url);
  const { chromium } = await import('playwright');
  return { options: smoke.browserOptions, smoke: smoke.browserSmoke, launch: options => chromium.launch(options) };
}
async function pinnedLauncher(environment, cwd) {
  if (!environment.CANNELE_SOURCE_DIR || process.env.CANNELE_VERCEL_CREATION_GUARD === '1') throw fail();
  const root = resolve(cwd, environment.CANNELE_SOURCE_DIR);
  const require = createRequire(pathToFileURL(join(root, 'package.json')));
  const entry = join(dirname(require.resolve('vercel/package.json')), 'dist/index.js');
  const guardPath = join(root, 'src/cli/vercel-fetch-guard.mjs');
  const guard = await import(pathToFileURL(guardPath).href);
  guard.verifyPinnedSource(entry);
  return { entry, guardPath };
}
const execute = (command, args, options) => new Promise(resolveResult => {
  const grouped = process.platform !== 'win32';
  const child = spawn(command, args, { cwd: options.cwd, env: options.environment, shell: false,
    detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const timer = setTimeout(() => {
    try { if (grouped && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { child.kill(); }
  }, 7 * 60_000);
  child.once('error', () => { clearTimeout(timer); resolveResult({ status: null }); });
  child.once('close', status => { clearTimeout(timer); resolveResult({ status }); });
});

/** API session credentials remain in the parent. Only an origin-scoped Vercel
 * development OIDC header reaches the existing Cake browser smoke runner.
 */
export function createCakeBrowserVerifier(dependencies = {}) {
  return async (proof, options) => {
    let directory;
    try {
      const input = publicInput(proof, options);
      const environment = options.environment ?? process.env;
      const inherited = safeEnvironment(environment);
      const token = environment.VERCEL_OIDC_TOKEN;
      if (token !== undefined) {
        if (!token || typeof token !== 'string' || /\s/.test(token) || token.length > 16_000) throw fail();
        const browser = await (dependencies.browser ?? browserDependencies)();
        await browser.smoke(input.proof.url, token, browser.options(inherited), browser.launch, () => undefined,
          { browserTimeoutMs: 5 * 60_000, caseTimeoutMs: 60_000, shutdownTimeoutMs: 5_000, apiTimeoutMs: 15_000 });
        return { cases: [...caseIds] };
      }
      const launcher = await (dependencies.launcher ?? pinnedLauncher)(environment, input.cwd);
      directory = await mkdtemp(join(tmpdir(), 'cake-cannele-browser-')); await chmod(directory, 0o700);
      const inputFile = join(directory, 'input.json'), resultFile = join(directory, 'result.json');
      await writeFile(inputFile, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
      const args = ['--import', pathToFileURL(launcher.guardPath).href, launcher.entry, '--api', 'https://api.vercel.com',
        'env', 'run', '--environment', 'development', '--project', input.profile.vercelProjectId,
        '--scope', input.profile.vercelTeamId,
        ...(environment.CANNELE_VERCEL_GLOBAL_CONFIG ? ['--global-config', resolve(input.cwd, environment.CANNELE_VERCEL_GLOBAL_CONFIG)] : []),
        '--', process.execPath, modulePath, '--child', inputFile, resultFile];
      const result = await (dependencies.execute ?? execute)(process.execPath, args, { cwd: directory,
        environment: { ...inherited, CI: '1', NO_COLOR: '1', VERCEL_CLI_USE_NATIVE_BINARY: '0' } });
      if (result.status !== 0) throw fail();
      const info = await lstat(resultFile);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 4096) throw fail();
      const receipt = JSON.parse(await readFile(resultFile, 'utf8'));
      if (receipt.protocol !== 'cake-cannele-browser/v1' || Object.keys(receipt).length !== 2
        || JSON.stringify(receipt.cases) !== JSON.stringify(caseIds)) throw fail();
      return { cases: [...caseIds] };
    } catch { throw fail(); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  };
}
export const verifyCakeBrowser = createCakeBrowserVerifier();

async function child(inputFile, resultFile) {
  if (basename(inputFile) !== 'input.json' || basename(resultFile) !== 'result.json' || dirname(inputFile) !== dirname(resultFile)) throw fail();
  const [directory, file] = await Promise.all([lstat(dirname(inputFile)), lstat(inputFile)]);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700
    || !file.isFile() || file.isSymbolicLink() || (file.mode & 0o777) !== 0o600 || file.size > 65_536 || !process.env.VERCEL_OIDC_TOKEN) throw fail();
  const input = JSON.parse(await readFile(inputFile, 'utf8'));
  const result = await verifyCakeBrowser(input.proof, { ...input, environment: process.env });
  await writeFile(resultFile, JSON.stringify({ protocol: 'cake-cannele-browser/v1', cases: result.cases }), { flag: 'wx', mode: 0o600 });
}
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  const args = process.argv.slice(2);
  void (async () => { if (args.length !== 3 || args[0] !== '--child') throw fail(); await child(args[1], args[2]); })()
    .catch(() => { console.error('Cake: QA browser confirmation failed.'); process.exitCode = 1; });
}

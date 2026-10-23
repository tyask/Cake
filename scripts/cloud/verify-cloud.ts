import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright';
import type { BootstrapData, TransactionRecord } from '../../lib/shared/types';
import { CloudStartupError, startCloudServer } from './dev-cloud';

const executeFile = promisify(execFile);
const workspaceId = '00000000-0000-4000-8000-000000000001';
export const cloudBrowserStages = ['arguments', 'source-before', 'server', 'launch', 'context', 'navigation', 'login', 'session-app', 'workspace',
  'home', 'transactions', 'analytics', 'settings', 'create', 'edit', 'autosave', 'reload', 'delete', 'preservation', 'boundary',
  'cleanup', 'source-after', 'proof', 'interrupted'] as const;
type Stage = typeof cloudBrowserStages[number];
type Source = { sha: string; branch: string; clean: boolean };
type Check = { name: string; at: string };
type Case = {
  name: string; user: 'a' | 'b'; mobile: boolean; status: 'not-run' | 'running' | 'passed' | 'failed'; success: boolean;
  durationMs: number; checks: Check[]; screenshots: string[]; blockedExternalRequests: number;
  initialTransactionCount?: number; initialCategoryCount?: number; existingTransactionIdsPreserved?: boolean;
  createdTransactionId?: string; remainingTestTransactions?: number; failureStage?: Stage;
};
export type CloudBrowserProof = {
  protocol: 'cake-cloud-browser/v1'; success: boolean; startedAt: string; finishedAt: string; durationMs: number;
  source: { before: Source | null; after: Source | null; unchanged: boolean };
  environment: { platform: string; arch: string; node: string; npm: string | null; chromium: string | null };
  cases: Case[]; failure?: { stage: Stage; case?: string };
  resources: { browserContexts: number; browsers: number; servers: number | null; databases: number | null; testTransactions: number | null };
};

/** Browser subprocesses receive operating-system settings, never provider credentials. */
function safeEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> & NodeJS.ProcessEnv {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
    'SSL_CERT_DIR', 'PLAYWRIGHT_BROWSERS_PATH'];
  return { NODE_ENV: 'development', ...Object.fromEntries(keys.flatMap(key => environment[key] === undefined ? [] : [[key, environment[key]!]])) };
}

function browserOptions(): LaunchOptions {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || process.env.DEBUG || process.env.PWDEBUG) throw new Error();
  return { headless: true, env: safeEnvironment(process.env),
    ...(process.env.CAKE_BROWSER_EXECUTABLE ? { executablePath: process.env.CAKE_BROWSER_EXECUTABLE } : {}) };
}

async function source(cwd: string): Promise<Source> {
  const options = { cwd, env: safeEnvironment(process.env), encoding: 'utf8' as const, timeout: 15_000, maxBuffer: 1024 * 1024 };
  const [sha, branch, status] = await Promise.all([
    executeFile('git', ['rev-parse', 'HEAD'], options),
    executeFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], options),
    executeFile('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=normal'], options),
  ]);
  if (!/^[a-f0-9]{40}$/.test(sha.stdout.trim()) || !branch.stdout.trim()) throw new Error();
  return { sha: sha.stdout.trim(), branch: branch.stdout.trim(), clean: status.stdout.length === 0 };
}

function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new Error('CLOUD_BROWSER_CHECK_FAILED');
}

async function readApp(page: Page, user: 'a' | 'b'): Promise<BootstrapData> {
  const result = await page.evaluate(async id => {
    const response = await fetch(`/api/app?workspaceId=${encodeURIComponent(id)}&scope=full`, {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, data: await response.json() };
  }, workspaceId);
  const data = result.data as BootstrapData;
  requireCondition(result.status === 200 && data.user?.id === `test-user-${user}` && data.user.isAdmin !== true
    && data.workspaces?.some(item => item.id === workspaceId) && data.selected?.workspace.id === workspaceId
    && Array.isArray(data.selected.transactions) && Array.isArray(data.selected.categories)
    && ['test-user-a', 'test-user-b'].every(id => data.selected?.members.some(member => member.id === id && member.isAdmin !== true)));
  return data;
}

async function waitForApp(page: Page, user: 'a' | 'b', accept: (data: BootstrapData) => boolean): Promise<BootstrapData> {
  const deadline = Date.now() + 25_000;
  do {
    const data = await readApp(page, user);
    if (accept(data)) return data;
    await page.waitForTimeout(150);
  } while (Date.now() < deadline);
  throw new Error('CLOUD_BROWSER_CHECK_FAILED');
}

function ids(transactions: TransactionRecord[]): string[] {
  return transactions.map(item => item.id).sort();
}

function sameIds(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

/** This proof is deliberately separate from the Preview/Ready proof protocol. */
export async function verifyCloudBrowser(args: readonly string[] = []): Promise<CloudBrowserProof> {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const directory = resolve(cwd, '.cake/cloud'), proofPath = resolve(directory, 'verification.json');
  const started = Date.now();
  const proof: CloudBrowserProof = {
    protocol: 'cake-cloud-browser/v1', success: false, startedAt: new Date(started).toISOString(), finishedAt: '', durationMs: 0,
    source: { before: null, after: null, unchanged: false },
    environment: { platform: process.platform, arch: process.arch, node: process.version, npm: null, chromium: null },
    cases: [false, true].flatMap(mobile => (['a', 'b'] as const).map(user => ({
      name: `${mobile ? 'mobile' : 'desktop'}-${user}`, user, mobile, status: 'not-run' as const, success: false,
      durationMs: 0, checks: [], screenshots: [], blockedExternalRequests: 0,
    }))),
    resources: { browserContexts: 0, browsers: 0, servers: 0, databases: 0, testTransactions: 0 },
  };
  let stage: Stage = 'proof', currentCase: Case | undefined, caseStarted = 0;
  let browser: Browser | undefined, server: Awaited<ReturnType<typeof startCloudServer>> | undefined;
  let interrupted = false, baselineIds: string[] | undefined;
  const contexts = new Set<BrowserContext>();
  const interrupt = () => {
    interrupted = true;
    // Closing Chromium interrupts a pending UI operation; the normal finally path disposes the DB.
    if (browser) void browser.close().catch(() => undefined);
  };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const fail = (failureStage: Stage) => {
    proof.failure ??= { stage: failureStage, ...(currentCase ? { case: currentCase.name } : {}) };
    if (currentCase?.status === 'running') {
      currentCase.status = 'failed'; currentCase.failureStage = failureStage; currentCase.durationMs = Date.now() - caseStarted;
    }
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // A failed new run must never leave the previous successful proof in place.
    await rm(proofPath, { force: true });
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
    stage = 'arguments';
    if (args.length) {
      requireCondition(args.length === 2 && args[0] === '--port');
    }
    const portValue = args.length ? args[1] : process.env.PORT ?? '3000';
    requireCondition(/^[1-9]\d*$/.test(portValue));
    const port = Number(portValue);
    requireCondition(Number.isSafeInteger(port) && port >= 1 && port <= 65_535);
    stage = 'source-before'; proof.source.before = await source(cwd);
    try {
      proof.environment.npm = (await executeFile('npm', ['--version'], { cwd, env: safeEnvironment(process.env), timeout: 15_000 })).stdout.trim();
    } catch { /* Node can also invoke this CLI directly; npm is optional metadata. */ }
    stage = 'server';
    requireCondition(!interrupted);
    server = await startCloudServer({ port, hostname: '127.0.0.1', quiet: true });
    proof.resources.servers = 1; proof.resources.databases = 1;
    const origin = new URL(server.url).origin;
    requireCondition(new URL(origin).hostname === '127.0.0.1' && new URL(origin).protocol === 'http:' && !interrupted);
    stage = 'launch'; browser = await chromium.launch(browserOptions());
    proof.resources.browsers = 1; proof.environment.chromium = browser.version();
    for (const item of proof.cases) {
      currentCase = item; caseStarted = Date.now(); item.status = 'running';
      const check = (name: string) => item.checks.push({ name, at: new Date().toISOString() });
      stage = 'context'; requireCondition(!interrupted);
      const context = await browser.newContext({
        viewport: item.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        isMobile: item.mobile, hasTouch: item.mobile, serviceWorkers: 'block', acceptDownloads: false,
      });
      contexts.add(context); proof.resources.browserContexts = contexts.size;
      let routeFailed = false;
      const page = await context.newPage(); page.setDefaultTimeout(30_000);
      stage = 'boundary';
      // Playwright routes only the first URL in a redirect chain; CDP checks every hop.
      const interception = await context.newCDPSession(page);
      interception.on('Fetch.requestPaused', async event => {
        try {
          if (new URL(event.request.url).origin !== origin) {
            item.blockedExternalRequests++;
            await interception.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
          } else await interception.send('Fetch.continueRequest', { requestId: event.requestId });
        } catch {
          routeFailed = true;
          try { await interception.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }); }
          catch { /* A closing context has no active request. */ }
        }
      });
      await interception.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      const screenshot = async (name: string) => {
        const filename = `${item.name}-${name}.png`;
        await page.screenshot({ path: resolve(directory, filename) }); item.screenshots.push(filename);
      };
      const navigation = page.locator(item.mobile ? '.bottom-nav' : '.app-nav');
      const navigate = async (name: string) => {
        await navigation.getByRole('button', { name: new RegExp(name) }).click();
        if (name === 'ホーム') await page.getByRole('heading', { name: '最近の取引', exact: true }).waitFor();
        else await page.getByRole('heading', { name, exact: true }).waitFor();
      };
      stage = 'navigation';
      const response = await page.goto(origin, { waitUntil: 'networkidle', timeout: 60_000 });
      requireCondition(response?.status() === 200 && new URL(page.url()).origin === origin && await page.title() === 'Cake');
      stage = 'login';
      await page.getByRole('button', { name: new RegExp(`テストユーザー${item.user.toUpperCase()}`) }).click();
      await page.locator('.app-shell').waitFor(); check('test-login');
      stage = 'session-app';
      const session = await page.evaluate(async () => {
        const response = await fetch('/api/auth/session', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
        return { status: response.status, data: await response.json() };
      });
      requireCondition(session.status === 200 && session.data?.user?.id === `test-user-${item.user}` && session.data.user.isAdmin !== true);
      const initial = await readApp(page, item.user); check('session-app-get-non-admin');
      item.initialTransactionCount = initial.selected!.transactions.length; item.initialCategoryCount = initial.selected!.categories.length;
      requireCondition(item.initialTransactionCount > 0 && item.initialCategoryCount > 0);
      const existingIds = ids(initial.selected!.transactions);
      if (baselineIds) requireCondition(sameIds(existingIds, baselineIds)); else baselineIds = existingIds;
      stage = 'workspace';
      await page.locator(item.mobile ? '.mobile-header select' : '.workspace-picker select').selectOption(workspaceId);
      stage = 'home'; await navigate('ホーム'); await screenshot('home'); check('home-navigation');
      stage = 'transactions'; await navigate('取引明細'); await screenshot('transactions'); check('transactions-navigation');
      stage = 'analytics'; await navigate('集計'); await screenshot('analytics'); check('analytics-navigation');
      stage = 'settings'; await navigate('設定'); await screenshot('settings'); check('settings-navigation');
      stage = 'transactions'; await navigate('取引明細');
      stage = 'create';
      const merchant = `Cloud QA ${item.name} ${randomUUID()}`, editedMerchant = `${merchant} 更新`, memo = `Cloud QA autosave ${item.name}`;
      await page.getByRole('button', { name: '＋ 明細を追加', exact: true }).click();
      const modal = page.getByRole('dialog', { name: '明細を追加', exact: true });
      await modal.getByLabel('取引先', { exact: true }).fill(merchant);
      await modal.getByLabel('金額（円）', { exact: true }).fill('1234');
      await modal.getByRole('button', { name: '追加する', exact: true }).click();
      await modal.waitFor({ state: 'hidden' });
      const created = await waitForApp(page, item.user, data => data.selected!.transactions.some(transaction => transaction.merchant === merchant));
      const matches = created.selected!.transactions.filter(transaction => transaction.merchant === merchant && !existingIds.includes(transaction.id));
      requireCondition(matches.length === 1 && matches[0].amountYen === 1234 && matches[0].actorUserId === `test-user-${item.user}`);
      item.createdTransactionId = matches[0].id; proof.resources.testTransactions = 1; check('transaction-ui-create-api-read');
      const row = page.locator(`tr[data-transaction-id="${item.createdTransactionId}"]`);
      const expand = async (name: string) => {
        await row.waitFor();
        if (item.mobile && await row.getAttribute('data-expanded') !== 'true') {
          await row.getByRole('button', { name: `${name}の詳細を開く`, exact: true }).click();
        }
      };
      await expand(merchant); await screenshot('created');
      stage = 'edit';
      await row.getByRole('textbox', { name: '取引先', exact: true }).fill(editedMerchant);
      await row.getByRole('textbox', { name: '取引先', exact: true }).press('Enter');
      await waitForApp(page, item.user, data => data.selected!.transactions.some(transaction => transaction.id === item.createdTransactionId && transaction.merchant === editedMerchant));
      await row.getByRole('spinbutton', { name: '金額（円）', exact: true }).fill('2345');
      await row.getByRole('spinbutton', { name: '金額（円）', exact: true }).press('Enter');
      await waitForApp(page, item.user, data => data.selected!.transactions.some(transaction => transaction.id === item.createdTransactionId && transaction.amountYen === 2345));
      check('transaction-ui-edit-api-read');
      stage = 'autosave';
      const memoInput = row.getByRole('textbox', { name: `${editedMerchant}のメモ`, exact: true });
      await memoInput.fill(memo); await memoInput.press('Tab');
      await waitForApp(page, item.user, data => data.selected!.transactions.some(transaction => transaction.id === item.createdTransactionId && transaction.memo === memo));
      check('transaction-memo-ui-blur-autosave-api-read');
      stage = 'reload';
      await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
      await page.locator('.app-shell').waitFor(); await navigate('取引明細'); await expand(editedMerchant);
      requireCondition(await row.getByRole('textbox', { name: '取引先', exact: true }).inputValue() === editedMerchant
        && await row.getByRole('spinbutton', { name: '金額（円）', exact: true }).inputValue() === '2345'
        && await row.getByRole('textbox', { name: `${editedMerchant}のメモ`, exact: true }).inputValue() === memo);
      const reloaded = await readApp(page, item.user);
      requireCondition(reloaded.selected!.transactions.some(transaction => transaction.id === item.createdTransactionId
        && transaction.merchant === editedMerchant && transaction.amountYen === 2345 && transaction.memo === memo));
      await screenshot('reloaded'); check('transaction-ui-api-reload-persistence');
      stage = 'delete';
      requireCondition(!existingIds.includes(item.createdTransactionId));
      await row.getByRole('checkbox', { name: `${editedMerchant}の明細を選択`, exact: true }).check();
      let confirmed = false, dialogFailed = false;
      page.once('dialog', async dialog => {
        try {
          if (dialog.type() === 'confirm' && dialog.message() === '選択した1件の明細を削除しますか？') { confirmed = true; await dialog.accept(); }
          else await dialog.dismiss();
        } catch { dialogFailed = true; }
      });
      await page.getByRole('button', { name: '削除', exact: true }).click();
      const after = await waitForApp(page, item.user, data => !data.selected!.transactions.some(transaction => transaction.id === item.createdTransactionId));
      requireCondition(confirmed && !dialogFailed); await row.waitFor({ state: 'detached' });
      item.remainingTestTransactions = after.selected!.transactions.filter(transaction => transaction.merchant === merchant || transaction.merchant === editedMerchant).length;
      requireCondition(item.remainingTestTransactions === 0); proof.resources.testTransactions = 0; check('transaction-ui-delete-api-read');
      stage = 'preservation';
      item.existingTransactionIdsPreserved = sameIds(existingIds, ids(after.selected!.transactions));
      requireCondition(item.existingTransactionIdsPreserved); check('existing-transaction-ids-preserved');
      await screenshot('deleted');
      stage = 'boundary'; requireCondition(!routeFailed && new URL(page.url()).origin === origin && !interrupted); check('origin-isolation');
      await context.close(); contexts.delete(context); proof.resources.browserContexts = contexts.size;
      item.status = 'passed'; item.success = true; item.durationMs = Date.now() - caseStarted;
      process.stdout.write(`CLOUD_BROWSER_CASE_PASSED ${item.name}\n`);
      currentCase = undefined;
    }
  } catch (error) {
    if (stage === 'server' && !server && (!(error instanceof CloudStartupError) || !error.cleanupSucceeded)) {
      proof.resources.servers = null; proof.resources.databases = null; proof.resources.testTransactions = null;
    }
    fail(interrupted ? 'interrupted' : stage);
  } finally {
    stage = 'cleanup';
    for (const context of contexts) {
      try { await context.close(); contexts.delete(context); } catch { fail('cleanup'); }
    }
    proof.resources.browserContexts = contexts.size;
    try {
      if (browser) await browser.close();
      proof.resources.browsers = browser?.isConnected() ? 1 : 0;
      if (proof.resources.browsers === 0) { contexts.clear(); proof.resources.browserContexts = 0; }
    } catch { proof.resources.browsers = 1; fail('cleanup'); }
    try {
      if (server) {
        await server.close();
        proof.resources.servers = 0; proof.resources.databases = 0; proof.resources.testTransactions = 0;
      }
    } catch { proof.resources.testTransactions = null; fail('cleanup'); }
    try {
      proof.source.after = await source(cwd);
      proof.source.unchanged = proof.source.before?.sha === proof.source.after.sha && proof.source.before.branch === proof.source.after.branch
        && proof.source.before.clean && proof.source.after.clean;
      if (!proof.source.unchanged) fail('source-after');
    } catch { fail('source-after'); }
    if (interrupted) fail('interrupted');
    proof.finishedAt = new Date().toISOString(); proof.durationMs = Date.now() - started;
    proof.success = !proof.failure && proof.cases.every(item => item.success)
      && Object.values(proof.resources).every(value => value === 0);
    try { await writeFile(proofPath, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 }); }
    catch { fail('proof'); proof.success = false; }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void verifyCloudBrowser(process.argv.slice(2)).then(proof => {
    if (proof.success) process.stdout.write('CLOUD_BROWSER_PASSED cases=4 resources=0 proof=.cake/cloud/verification.json\n');
    else {
      process.stderr.write(`CLOUD_BROWSER_FAILED stage=${proof.failure?.stage ?? 'proof'}${proof.failure?.case ? ` case=${proof.failure.case}` : ''}\n`);
      process.exitCode = 1;
    }
  }).catch(() => {
    process.stderr.write('CLOUD_BROWSER_FAILED stage=proof\n'); process.exitCode = 1;
  });
}

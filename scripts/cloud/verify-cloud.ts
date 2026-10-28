import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright';
import type { BootstrapData, TransactionRecord } from '../../lib/shared/types';
import { analyticsToday, type AnalyticsDataset } from '../../lib/shared/analytics';
import { formatCashflow, formatYen } from '../../lib/shared/display-formatters';
import { homeMonth, personalCashflowSummary, transactionsInMonth } from '../../lib/shared/home-summary';
import type { HomeData } from '../../lib/shared/home-data';
import { addMonths } from '../../lib/shared/recurring-payment-calendar';
import { CloudStartupError, startCloudServer } from './dev-cloud';

const executeFile = promisify(execFile);
const workspaceId = '00000000-0000-4000-8000-000000000001';
export const cloudBrowserStages = ['arguments', 'source-before', 'server', 'launch', 'context', 'navigation', 'login', 'session-app', 'workspace',
  'home', 'transactions', 'analytics', 'settings', 'create', 'edit', 'autosave', 'reload', 'delete', 'preservation', 'boundary',
  'privacy', 'cleanup', 'source-after', 'proof', 'interrupted'] as const;
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
  let interrupted = false;
  const baselineIds = new Map<'a' | 'b', string[]>();
  let sharedBaseline: string[] | undefined;
  let activePage: Page | undefined;
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
    requireCondition(new URL(origin).hostname === 'localhost' && new URL(origin).protocol === 'http:' && !interrupted);
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
      const page = await context.newPage(); activePage = page; page.setDefaultTimeout(30_000);
      let analyticsRequestCount = 0;
      let homeRequestCount = 0;
      let observeHomeRequests = false;
      const homeAppRequests: URL[] = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api/analytics') analyticsRequestCount++;
        if (request.method() === 'GET' && url.pathname === '/api/home') homeRequestCount++;
        if (observeHomeRequests && request.method() === 'GET' && url.pathname === '/api/app') homeAppRequests.push(url);
      });
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
      const homeTableForMonth = (value = homeMonth()) => {
        const [year, month] = value.split('-').map(Number);
        return page.getByRole('table', { name: `${year}年${month}月の収支`, exact: true });
      };
      const navigate = async (name: string) => {
        await navigation.getByRole('button', { name: new RegExp(name) }).click();
        if (name === 'ホーム') {
          await homeTableForMonth().waitFor();
          await page.locator('.home-month-summary[aria-busy="false"]').waitFor();
        }
        else await page.getByRole('heading', { name: name === '集計' ? '収支の集計' : name, exact: true }).waitFor();
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
      const baseline = baselineIds.get(item.user);
      if (baseline) requireCondition(sameIds(existingIds, baseline)); else baselineIds.set(item.user, existingIds);
      requireCondition(initial.selected!.transactions.some(transaction => transaction.expenseClass === 'PERSONAL'
        && transaction.actorUserId !== `test-user-${item.user}`));
      const sharedIds = ids(initial.selected!.transactions.filter(transaction => transaction.expenseClass === 'SHARED'));
      if (sharedBaseline) requireCondition(sameIds(sharedIds, sharedBaseline)); else sharedBaseline = sharedIds;
      stage = 'workspace';
      // readApp's explicit full GET above is a verification read, not a UI request.
      // Observe only home UI operations until the transaction list is opened.
      observeHomeRequests = true;
      await page.locator(item.mobile ? '.mobile-header select' : '.workspace-picker select').selectOption(workspaceId);
      stage = 'home'; await navigate('ホーム');
      const assertHomeMonth = async (month: string, summary?: HomeData) => {
        const table = homeTableForMonth(month);
        await table.waitFor();
        await page.locator('.home-month-summary[aria-busy="false"]').waitFor();
        const expectedPeople = initial.selected!.members.map(member => personalCashflowSummary(
          transactionsInMonth(initial.selected!.transactions, month), initial.selected!.members, member.id));
        requireCondition(await table.getByRole('columnheader').allTextContents().then(names =>
          JSON.stringify(names) === JSON.stringify([...initial.selected!.members.map(member => member.name), '合計'])));
        for (const [name, values, key, sign] of [
          ['収入', expectedPeople.map(person => person.receiptTotal), 'receiptTotal', BigInt(1)],
          ['支出', expectedPeople.map(person => -person.paymentTotal), 'paymentTotal', BigInt(-1)],
          ['収支', expectedPeople.map(person => person.balanceYen), 'balanceYen', BigInt(1)],
        ] as const) {
          const amounts = [...values, values.reduce((total, value) => total + value, BigInt(0))];
          requireCondition(JSON.stringify(await table.getByRole('row', { name: new RegExp(`^${name} `) })
            .getByRole('cell').allTextContents()) === JSON.stringify(amounts.map(formatCashflow)));
          if (summary) requireCondition(JSON.stringify([
            ...initial.selected!.members.map(member => BigInt(summary.monthly.people.find(person => person.userId === member.id)![key]) * sign),
            BigInt(summary.monthly.total[key]) * sign,
          ].map(String)) === JSON.stringify(amounts.map(String)));
        }
      };
      await assertHomeMonth(homeMonth());
      await screenshot('home'); check('home-per-member-and-total-cashflow');
      const settlementBeforeMonthChanges = await page.locator('.settlement-hero').innerText();
      const readHomeFromUi = async (month: string, action: () => Promise<unknown>) => {
        const requestCount = homeRequestCount;
        const [response] = await Promise.all([
          page.waitForResponse(response => {
            const url = new URL(response.url());
            return response.request().method() === 'GET' && url.pathname === '/api/home'
              && url.searchParams.get('workspaceId') === workspaceId && url.searchParams.get('month') === month;
          }),
          action(),
        ]);
        requireCondition(response.status() === 200 && response.headers()['cache-control'] === 'no-store');
        const summary = await response.json() as HomeData;
        requireCondition(summary.workspaceId === workspaceId && summary.month === month
          && Array.isArray(summary.monthly?.people) && Array.isArray(summary.members)
          && !/"(?:transactions|transactionIds)"\s*:/.test(JSON.stringify(summary)));
        await assertHomeMonth(month, summary);
        requireCondition(homeRequestCount > requestCount);
        requireCondition(await page.locator('.settlement-hero').innerText() === settlementBeforeMonthChanges);
      };
      const chooseCachedHomeMonth = async (month: string) => {
        const requestCount = homeRequestCount;
        await page.locator('input[type="month"][aria-label="収支の対象年月"]').fill(month);
        await assertHomeMonth(month);
        // Let the committed view's effects settle without a fixed-duration sleep.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        requireCondition(homeRequestCount === requestCount);
        requireCondition(await page.locator('.settlement-hero').innerText() === settlementBeforeMonthChanges);
      };
      const currentHomeMonth = homeMonth();
      const previousHomeMonth = addMonths(`${currentHomeMonth}-01`, -1).slice(0, 7);
      const futureHomeMonth = addMonths(`${currentHomeMonth}-01`, 1).slice(0, 7);
      for (const month of [previousHomeMonth, futureHomeMonth]) {
        await readHomeFromUi(month, () => page.locator('input[type="month"][aria-label="収支の対象年月"]').fill(month));
      }
      check('home-server-month-switch-cashflow-and-independent-settlement');
      await chooseCachedHomeMonth(currentHomeMonth);
      await chooseCachedHomeMonth(previousHomeMonth);
      check('home-month-cache-reuses-initial-and-visited-months-without-fetch');
      await readHomeFromUi(previousHomeMonth, () => page.locator('.home-actions').getByRole('button', { name: '更新', exact: true }).click());
      check('home-manual-refresh-force-fetches-and-clears-month-cache');
      await readHomeFromUi(currentHomeMonth, () => page.locator('input[type="month"][aria-label="収支の対象年月"]').fill(currentHomeMonth));
      await chooseCachedHomeMonth(previousHomeMonth);
      await chooseCachedHomeMonth(currentHomeMonth);
      check('home-after-refresh-other-month-fetch-and-refreshed-month-cache-reuse');
      requireCondition(homeAppRequests.length > 0 && homeAppRequests.every(url => url.searchParams.get('scope') === 'metadata'));
      observeHomeRequests = false;
      check('home-ui-requests-metadata-and-summary-without-full-transactions');
      stage = 'transactions'; await navigate('取引明細'); await screenshot('transactions'); check('transactions-navigation');
      stage = 'analytics'; await navigate('集計');
      await page.getByTestId('analytics-total').waitFor();
      const analyticsResponse = await page.evaluate(async ({ workspaceId, month }) => {
        const response = await fetch(`/api/analytics?workspaceId=${workspaceId}&period=month&month=${month}`, { cache: 'no-store' });
        return { status: response.status, data: await response.json() };
      }, { workspaceId, month: analyticsToday().slice(0, 7) });
      const dataset = analyticsResponse.data as AnalyticsDataset;
      requireCondition(analyticsResponse.status === 200 && Array.isArray(dataset.buckets) && Array.isArray(dataset.receiptBuckets)
        && [...dataset.buckets, ...dataset.receiptBuckets].every(bucket => dataset.members.some(member => member.id === bucket.memberId))
        && dataset.buckets.some(bucket => bucket.expenseClass === 'PERSONAL' && bucket.memberId !== `test-user-${item.user}`));
      const memberGroup = page.getByRole('group', { name: '表示対象', exact: true });
      const contentGroup = page.getByRole('group', { name: '収支に含める内容', exact: true });
      const selectedMembers = new Set(dataset.members.map(member => member.id));
      const selectMembers = async (memberIds: readonly string[]) => {
        selectedMembers.clear();
        for (const id of memberIds) selectedMembers.add(id);
        for (const member of dataset.members) await memberGroup.getByRole('checkbox', { name: member.name, exact: true }).setChecked(selectedMembers.has(member.id));
      };
      requireCondition(await memberGroup.getByRole('checkbox').count() === dataset.members.length);
      for (const member of dataset.members) requireCondition(
        await memberGroup.getByRole('checkbox', { name: member.name, exact: true }).isChecked() === selectedMembers.has(member.id));
      const ownTotal = dataset.buckets.filter(bucket => bucket.scope === 'current' && bucket.memberId === `test-user-${item.user}`)
        .reduce((total, bucket) => total + BigInt(bucket.burdenYen), BigInt(0));
      const ownIncomeTotal = dataset.receiptBuckets.filter(bucket => bucket.scope === 'current' && bucket.memberId === `test-user-${item.user}`)
        .reduce((total, bucket) => total + BigInt(bucket.burdenYen), BigInt(0));
      const categoriesById = new Map(dataset.categories.map(category => [category.id, category]));
      const months: string[] = [];
      const firstMonth = new Date(`${dataset.periods.trend.from.slice(0, 7)}-01T00:00:00Z`);
      for (let offset = 0; offset < 6; offset++) {
        const month = new Date(firstMonth); month.setUTCMonth(month.getUTCMonth() + offset);
        months.push(month.toISOString().slice(0, 7));
      }
      requireCondition(months.at(-1) === dataset.periods.trend.to.slice(0, 7));
      type CategorySelection = ReadonlySet<string | null> | undefined;
      const sumAnalytics = (buckets: AnalyticsDataset['buckets'], scope: 'current' | 'comparison' | 'trend',
        classes: readonly string[], categoryIds: CategorySelection, month?: string) => buckets
        .filter(bucket => bucket.scope === scope && classes.includes(bucket.expenseClass)
          && selectedMembers.has(bucket.memberId) && (!month || bucket.month === month)
          && (!categoryIds || categoryIds.has(bucket.categoryId && categoriesById.has(bucket.categoryId) ? bucket.categoryId : null)))
        .reduce((total, bucket) => total + BigInt(bucket.burdenYen), BigInt(0));
      const assertSelectedCashflow = async (classes: readonly string[], categoryIds?: CategorySelection, extraIncome = BigInt(0)) => {
        const income = sumAnalytics(dataset.receiptBuckets, 'current', ['SHARED', 'PERSONAL'], categoryIds) + extraIncome;
        const expense = sumAnalytics(dataset.buckets, 'current', classes, categoryIds);
        const difference = expense - sumAnalytics(dataset.buckets, 'comparison', classes, categoryIds);
        requireCondition(await page.getByTestId('analytics-income').textContent() === formatCashflow(income)
          && await page.getByTestId('analytics-total').textContent() === formatCashflow(-expense)
          && await page.getByTestId('analytics-balance').textContent() === formatCashflow(income - expense)
          && await page.getByTestId('analytics-difference').textContent() === `${difference > BigInt(0) ? '+' : ''}${formatYen(difference)}`);
      };
      const assertSelectedTrend = async (extraIncome = BigInt(0), classes: readonly string[] = ['SHARED', 'PERSONAL'], categoryIds?: CategorySelection) => {
        const section = page.locator('section[aria-labelledby="analytics-trend-heading"]');
        const details = section.locator('details');
        if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator('summary').click();
        const table = section.getByRole('table', { name: '月ごとの収入・支出・収支（円）', exact: true });
        requireCondition(await table.locator('tbody tr').count() === months.length);
        let hasAmounts = false;
        for (const month of months) {
          const income = sumAnalytics(dataset.receiptBuckets, 'trend', ['SHARED', 'PERSONAL'], categoryIds, month)
            + (month === dataset.periods.current.to.slice(0, 7) ? extraIncome : BigInt(0));
          const expense = sumAnalytics(dataset.buckets, 'trend', classes, categoryIds, month);
          hasAmounts ||= income > BigInt(0) || expense > BigInt(0);
          const cells = await table.getByRole('row', { name: new RegExp(`^${month.replace('-', '/')} `) }).getByRole('cell').allTextContents();
          requireCondition(cells.length === 3 && cells[0] === formatCashflow(income)
            && cells[1] === formatCashflow(-expense) && cells[2] === formatCashflow(income - expense));
        }
        if (hasAmounts) await page.getByTestId('analytics-cashflow-chart').locator('.analytics-cashflow-balance .recharts-line-curve').waitFor();
        requireCondition(await page.locator('#analytics-trend-heading').evaluate(element =>
          Boolean(element.compareDocumentPosition(document.getElementById('analytics-composition-heading')!) & Node.DOCUMENT_POSITION_FOLLOWING)));
      };
      await assertSelectedCashflow(['SHARED', 'PERSONAL']);
      await assertSelectedTrend();
      check('analytics-default-all-members-selected-and-total-cashflow');
      await selectMembers([`test-user-${item.user}`]);
      requireCondition(await page.getByTestId('analytics-total').textContent() === formatCashflow(-ownTotal));
      await assertSelectedCashflow(['SHARED', 'PERSONAL']);
      await contentGroup.getByRole('checkbox', { name: '共有費', exact: true }).uncheck();
      await assertSelectedCashflow(['PERSONAL']);
      await contentGroup.getByRole('checkbox', { name: '個人費', exact: true }).uncheck();
      await assertSelectedCashflow([]);
      await assertSelectedTrend(BigInt(0), []);
      await contentGroup.getByRole('checkbox', { name: '収入', exact: true }).uncheck();
      await page.getByText('収支に含める内容を1つ以上選んでください。', { exact: true }).waitFor();
      requireCondition(await page.getByTestId('analytics-total').count() === 0);
      await contentGroup.getByRole('checkbox', { name: '共有費', exact: true }).check();
      requireCondition(await page.getByTestId('analytics-income').count() === 0
        && await page.getByTestId('analytics-balance').count() === 0);
      const expenseSection = page.locator('section[aria-labelledby="analytics-trend-heading"]');
      const expenseDetails = expenseSection.locator('details');
      if (!await expenseDetails.evaluate(element => (element as HTMLDetailsElement).open)) await expenseDetails.locator('summary').click();
      await expenseSection.getByRole('table', { name: '月ごとの支出（円）', exact: true }).waitFor({ state: 'attached' });
      requireCondition(await expenseSection.getByRole('columnheader', { name: '収入', exact: true }).count() === 0
        && await expenseSection.getByRole('columnheader', { name: '収支', exact: true }).count() === 0
        && await expenseSection.locator('.analytics-cashflow-income, .analytics-cashflow-balance').count() === 0);
      await contentGroup.getByRole('checkbox', { name: '収入', exact: true }).check();
      await assertSelectedCashflow(['SHARED']);
      await contentGroup.getByRole('checkbox', { name: '個人費', exact: true }).check();
      await assertSelectedCashflow(['SHARED', 'PERSONAL']);
      await assertSelectedTrend();
      const userRequests = analyticsRequestCount;
      await selectMembers(dataset.members.map(member => member.id));
      await assertSelectedCashflow(['SHARED', 'PERSONAL']);
      await assertSelectedTrend();
      await screenshot('analytics-all-members');
      await selectMembers(dataset.members.filter(member => member.id !== `test-user-${item.user}`).map(member => member.id));
      await assertSelectedCashflow(['SHARED', 'PERSONAL']);
      await assertSelectedTrend();
      await selectMembers([]);
      await page.getByText('表示対象のユーザーを1人以上選んでください。', { exact: true }).waitFor();
      requireCondition(await page.getByTestId('analytics-total').count() === 0);
      await selectMembers([`test-user-${item.user}`]);
      await assertSelectedCashflow(['SHARED', 'PERSONAL']);
      requireCondition(analyticsRequestCount === userRequests);
      await screenshot('analytics'); check('analytics-member-income-and-expense-filters-without-fetch');
      const categorySummary = page.locator('summary').filter({ hasText: /^集計に含めるカテゴリ/ });
      await categorySummary.click();
      const categoryGroup = page.getByRole('group', { name: '集計に含めるカテゴリ', exact: true });
      const openCategories = async () => {
        if (!await categoryGroup.isVisible()) await categorySummary.click();
        await categoryGroup.waitFor();
      };
      const chooseAllCategories = async () => {
        await openCategories(); await categoryGroup.getByRole('button', { name: 'すべて選択', exact: true }).click();
      };
      const clearCategories = async () => {
        await openCategories(); await categoryGroup.getByRole('button', { name: 'すべて解除', exact: true }).click();
      };
      requireCondition(await categoryGroup.getByRole('checkbox').count() === dataset.categories.length + 1
        && await categoryGroup.getByRole('checkbox').evaluateAll(elements => elements.every(element => (element as HTMLInputElement).checked)));
      const categoryRequests = analyticsRequestCount;
      await clearCategories();
      await page.getByText('集計に含めるカテゴリを1つ以上選んでください。', { exact: true }).waitFor();
      requireCondition(await page.getByTestId('analytics-total').count() === 0);
      const food = dataset.categories.find(category => category.name === '食費' && category.parentId === null);
      requireCondition(food);
      const foodIds = new Set<string | null>([food.id]);
      for (const category of dataset.categories) {
        let ancestor = category.parentId;
        while (ancestor && ancestor !== food.id) ancestor = categoriesById.get(ancestor)?.parentId ?? null;
        if (ancestor === food.id) foodIds.add(category.id);
      }
      requireCondition(foodIds.size > 1);
      const foodCheckbox = categoryGroup.getByRole('checkbox', { name: food.name, exact: true });
      await foodCheckbox.check();
      await assertSelectedCashflow(['SHARED', 'PERSONAL'], foodIds);
      await assertSelectedTrend(BigInt(0), ['SHARED', 'PERSONAL'], foodIds);
      await page.getByRole('combobox', { name: 'カテゴリの細かさ', exact: true }).selectOption('all');
      await assertSelectedCashflow(['SHARED', 'PERSONAL'], foodIds);
      const leaf = dataset.categories.find(category => foodIds.has(category.id)
        && !dataset.categories.some(child => child.parentId === category.id));
      requireCondition(leaf);
      const leafPath = [leaf.name];
      let ancestor = leaf.parentId;
      while (ancestor) {
        const category = categoriesById.get(ancestor); requireCondition(category);
        leafPath.unshift(category.name); ancestor = category.parentId;
      }
      const leafCheckbox = categoryGroup.getByRole('checkbox', { name: leafPath.join(' › '), exact: true });
      await leafCheckbox.uncheck();
      const partialFoodIds = new Set(foodIds); partialFoodIds.delete(leaf.id);
      requireCondition(await foodCheckbox.evaluate(element => (element as HTMLInputElement).indeterminate));
      await assertSelectedCashflow(['SHARED', 'PERSONAL'], partialFoodIds);
      await assertSelectedTrend(BigInt(0), ['SHARED', 'PERSONAL'], partialFoodIds);
      await selectMembers(dataset.members.map(member => member.id));
      await assertSelectedCashflow(['SHARED', 'PERSONAL'], partialFoodIds);
      await assertSelectedTrend(BigInt(0), ['SHARED', 'PERSONAL'], partialFoodIds);
      await selectMembers([`test-user-${item.user}`]);
      await assertSelectedCashflow(['SHARED', 'PERSONAL'], partialFoodIds);
      await clearCategories();
      await categoryGroup.getByRole('checkbox', { name: '未分類', exact: true }).check();
      const unclassified = new Set<string | null>([null]);
      await assertSelectedCashflow(['SHARED', 'PERSONAL'], unclassified);
      await assertSelectedTrend(BigInt(0), ['SHARED', 'PERSONAL'], unclassified);
      requireCondition(analyticsRequestCount === categoryRequests);
      await screenshot('analytics-categories');
      check('analytics-category-parent-child-unclassified-six-month-api-totals-without-fetch');
      await navigate('設定');
      await navigate('集計');
      await page.getByTestId('analytics-total').waitFor();
      await openCategories();
      requireCondition(await categoryGroup.getByRole('checkbox', { name: '未分類', exact: true }).isChecked()
        && !await foodCheckbox.isChecked());
      await assertSelectedCashflow(['SHARED', 'PERSONAL'], unclassified);
      await assertSelectedTrend(BigInt(0), ['SHARED', 'PERSONAL'], unclassified);
      check('analytics-category-selection-preserved-between-tabs');
      await contentGroup.getByRole('checkbox', { name: '共有費', exact: true }).uncheck();
      await contentGroup.getByRole('checkbox', { name: '収入', exact: true }).uncheck();
      await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
      await page.locator('.app-shell').waitFor();
      await page.locator(item.mobile ? '.mobile-header select' : '.workspace-picker select').selectOption(workspaceId);
      await navigate('集計');
      await page.getByTestId('analytics-total').waitFor();
      for (const member of dataset.members) requireCondition(
        await memberGroup.getByRole('checkbox', { name: member.name, exact: true }).isChecked() === selectedMembers.has(member.id));
      requireCondition(!await contentGroup.getByRole('checkbox', { name: '収入', exact: true }).isChecked()
        && !await contentGroup.getByRole('checkbox', { name: '共有費', exact: true }).isChecked()
        && await contentGroup.getByRole('checkbox', { name: '個人費', exact: true }).isChecked()
        && await page.getByRole('combobox', { name: 'カテゴリの細かさ', exact: true }).inputValue() === 'all'
        && await page.getByTestId('analytics-income').count() === 0
        && await page.getByTestId('analytics-balance').count() === 0
        && await page.getByTestId('analytics-total').textContent() === formatCashflow(-sumAnalytics(dataset.buckets, 'current', ['PERSONAL'], unclassified)));
      await openCategories();
      requireCondition(await categoryGroup.getByRole('checkbox', { name: '未分類', exact: true }).isChecked()
        && !await foodCheckbox.isChecked());
      await screenshot('analytics-restored-filters');
      check('analytics-member-income-class-category-depth-restored-after-reload');
      await contentGroup.getByRole('checkbox', { name: '収入', exact: true }).check();
      await contentGroup.getByRole('checkbox', { name: '共有費', exact: true }).check();
      await assertSelectedCashflow(['SHARED', 'PERSONAL'], unclassified);
      await chooseAllCategories();
      await page.getByRole('combobox', { name: 'カテゴリの細かさ', exact: true }).selectOption('1');
      await assertSelectedCashflow(['SHARED', 'PERSONAL']);
      stage = 'settings'; await navigate('設定'); await screenshot('settings'); check('settings-navigation');
      stage = 'transactions'; await navigate('取引明細');
      stage = 'create';
      const merchant = `Cloud QA ${item.name} ${randomUUID()}`, editedMerchant = `${merchant} 更新`, memo = `Cloud QA autosave ${item.name}`;
      await page.getByRole('button', { name: '＋ 明細を追加', exact: true }).click();
      const modal = page.getByRole('dialog', { name: '明細を追加', exact: true });
      await modal.getByRole('combobox', { name: '種別', exact: true }).selectOption('RECEIPT');
      await modal.getByRole('combobox', { name: '受取者', exact: true }).waitFor();
      await modal.getByLabel('取引先', { exact: true }).fill(merchant);
      await modal.getByLabel('金額（円）', { exact: true }).fill('1234');
      await modal.getByRole('button', { name: '追加する', exact: true }).click();
      await modal.waitFor({ state: 'hidden' });
      const created = await waitForApp(page, item.user, data => data.selected!.transactions.some(transaction => transaction.merchant === merchant));
      const matches = created.selected!.transactions.filter(transaction => transaction.merchant === merchant && !existingIds.includes(transaction.id));
      requireCondition(matches.length === 1 && matches[0].amountYen === 1234 && matches[0].type === 'RECEIPT'
        && matches[0].expenseClass === 'PERSONAL' && matches[0].actorUserId === `test-user-${item.user}`);
      item.createdTransactionId = matches[0].id; proof.resources.testTransactions = 1; check('transaction-ui-create-api-read');
      stage = 'analytics'; await navigate('集計');
      await page.waitForFunction(expected => document.querySelector('[data-testid="analytics-income"]')?.textContent === expected,
        formatCashflow(ownIncomeTotal + BigInt(1234)));
      requireCondition(await page.getByTestId('analytics-total').textContent() === formatCashflow(-ownTotal));
      await assertSelectedTrend(BigInt(1234));
      check('personal-income-ui-create-to-analytics-cashflow');
      requireCondition(matches[0].categoryId === null);
      await clearCategories();
      await categoryGroup.getByRole('checkbox', { name: '未分類', exact: true }).check();
      await assertSelectedCashflow(['SHARED', 'PERSONAL'], unclassified, BigInt(1234));
      await assertSelectedTrend(BigInt(1234), ['SHARED', 'PERSONAL'], unclassified);
      await clearCategories();
      await foodCheckbox.check();
      await assertSelectedCashflow(['SHARED', 'PERSONAL'], foodIds);
      await assertSelectedTrend(BigInt(0), ['SHARED', 'PERSONAL'], foodIds);
      await chooseAllCategories();
      await assertSelectedCashflow(['SHARED', 'PERSONAL'], undefined, BigInt(1234));
      check('personal-income-category-filter-includes-and-excludes-created-receipt');
      stage = 'transactions'; await navigate('取引明細');
      stage = 'privacy';
      const otherUser = item.user === 'a' ? 'b' : 'a';
      const otherContext = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      contexts.add(otherContext); proof.resources.browserContexts = contexts.size;
      try {
        await otherContext.route('**/*', route => new URL(route.request().url()).origin === origin
          ? route.continue() : route.abort());
        const otherPage = await otherContext.newPage();
        await otherPage.goto(origin, { waitUntil: 'networkidle' });
        await otherPage.getByRole('button', { name: new RegExp(`テストユーザー${otherUser.toUpperCase()}`) }).click();
        await otherPage.locator('.app-shell').waitFor();
        const otherApp = await readApp(otherPage, otherUser);
        requireCondition(otherApp.selected!.transactions.some(transaction => transaction.id === item.createdTransactionId
          && transaction.merchant === merchant && transaction.expenseClass === 'PERSONAL'));
        requireCondition(sameIds(ids(otherApp.selected!.transactions), ids((await readApp(page, item.user)).selected!.transactions)));
        const otherAnalytics = await otherPage.evaluate(async ({ workspaceId, month }) => {
          const response = await fetch(`/api/analytics?workspaceId=${workspaceId}&period=month&month=${month}`, { cache: 'no-store' });
          return { status: response.status, data: await response.json() };
        }, { workspaceId, month: analyticsToday().slice(0, 7) });
        requireCondition(otherAnalytics.status === 200);
        const visibleIncome = (otherAnalytics.data as AnalyticsDataset).receiptBuckets
          .filter(bucket => bucket.scope === 'current' && bucket.memberId === `test-user-${item.user}`)
          .reduce((total, bucket) => total + BigInt(bucket.burdenYen), BigInt(0));
        requireCondition(visibleIncome === ownIncomeTotal + BigInt(1234));
        const denied = await otherPage.evaluate(async ({ workspaceId, transactionId }) => {
          const response = await fetch('/api/app', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'saveTransactionMemo', workspaceId, transactionId, memo: 'PRIVATE_ACCESS_DENIED' }) });
          return response.status;
        }, { workspaceId, transactionId: item.createdTransactionId });
        requireCondition(denied >= 400);
        const ownApp = await readApp(page, item.user);
        requireCondition(ownApp.selected!.transactions.find(transaction => transaction.id === item.createdTransactionId)?.memo === '');
        check('personal-transaction-visible-and-mutation-denied-for-other-member');
      } finally {
        await otherContext.close(); contexts.delete(otherContext); proof.resources.browserContexts = contexts.size;
      }
      const row = page.locator(`tr[data-transaction-id="${item.createdTransactionId}"]`);
      const expand = async (name: string) => {
        await row.waitFor();
        if (item.mobile && await row.getAttribute('data-expanded') !== 'true') {
          await row.getByRole('button', { name: `${name}の詳細を開く`, exact: true }).click();
        }
      };
      await expand(merchant); await screenshot('created');
      stage = 'edit';
      const savedWeights = JSON.stringify(matches[0].splitWeights);
      for (const type of ['PAYMENT', 'RECEIPT'] as const) {
        await row.getByRole('combobox', { name: '種別', exact: true }).selectOption(type);
        const updated = await waitForApp(page, item.user, data => data.selected!.transactions.some(transaction => transaction.id === item.createdTransactionId && transaction.type === type));
        const transaction = updated.selected!.transactions.find(transaction => transaction.id === item.createdTransactionId)!;
        requireCondition(transaction.amountYen === 1234 && transaction.expenseClass === 'PERSONAL' && JSON.stringify(transaction.splitWeights) === savedWeights);
        await row.getByRole('combobox', { name: type === 'PAYMENT' ? '支払者' : '受取者', exact: true }).waitFor();
      }
      check('transaction-type-ui-autosave-preserves-positive-amount-and-allocation');
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
        && await row.getByRole('combobox', { name: '種別', exact: true }).inputValue() === 'RECEIPT'
        && await row.getByRole('spinbutton', { name: '金額（円）', exact: true }).inputValue() === '2345'
        && await row.getByRole('textbox', { name: `${editedMerchant}のメモ`, exact: true }).inputValue() === memo);
      const reloaded = await readApp(page, item.user);
      requireCondition(reloaded.selected!.transactions.some(transaction => transaction.id === item.createdTransactionId
        && transaction.type === 'RECEIPT' && transaction.merchant === editedMerchant && transaction.amountYen === 2345 && transaction.memo === memo));
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
    if (activePage && currentCase && !activePage.isClosed()) {
      try {
        const filename = `${currentCase.name}-failure.png`;
        await activePage.screenshot({ path: resolve(directory, filename), timeout: 5_000 });
        currentCase.screenshots.push(filename);
      } catch { /* The fixed failure stage remains available if Chromium cannot capture an image. */ }
    }
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

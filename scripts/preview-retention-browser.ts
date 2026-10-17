import { randomBytes } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright';
import { browserOptions, developmentToken } from './preview-browser';
import { config, type Deployment, type Source } from './preview-model';
import type { Transport } from './preview-provider';
import { exactDeploymentIdentity } from './preview-verify-receipt';
import { isRetentionMarker, parseRetentionEvidence, retentionPayload, retentionSnapshot, retentionWorkspaceId, sameRetentionEvidence,
  type RetentionBrowserRequest, type RetentionBrowserResult, type RetentionStage } from './preview-retention-model';

/** An explicit arm allows only the fixed application payload once. Redirect hops
 * have separate CDP decisions; neither the token nor the write can follow one. */
export async function interceptRetentionRequests(context: BrowserContext, page: Page, origin: string, marker: string, allowInsert: boolean) {
  const expectedBody = JSON.stringify(retentionPayload(marker));
  let session;
  try { session = await context.newCDPSession(page); } catch { throw new Error('PREVIEW_RETENTION_BOUNDARY_FAILED'); }
  let armed = false, attempts: 0 | 1 = 0, blocked = false;
  // The OIDC token is supplied separately after interception is installed.
  let credential: string | undefined;
  session.on('Fetch.requestPaused', async event => {
    try {
      const request = event.request, url = new URL(request.url);
      if (!credential || url.origin !== origin) { blocked = true; await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); return; }
      const read = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      const login = request.method === 'POST' && url.pathname === '/api/auth/callback/test-login' && !url.search;
      if (!read && !login) {
        const contentType = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
        if (!(allowInsert && armed && attempts === 0 && !event.redirectedRequestId && request.method === 'POST'
          && url.pathname === '/api/app' && !url.search && request.postData === expectedBody && contentType === 'application/json')) {
          blocked = true; await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); return;
        }
        // Consume before forwarding, including an uncertain CDP/network outcome.
        armed = false; attempts = 1;
      }
      const headers = Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== 'x-vercel-trusted-oidc-idp-token')
        .map(([name, value]) => ({ name, value: String(value) }));
      headers.push({ name: 'x-vercel-trusted-oidc-idp-token', value: credential });
      await session.send('Fetch.continueRequest', { requestId: event.requestId, headers });
    } catch {
      blocked = true;
      try { await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }); } catch { /* Shutdown is handled by the caller. */ }
    }
  });
  try { await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }); }
  catch { throw new Error('PREVIEW_RETENTION_BOUNDARY_FAILED'); }
  return {
    authenticate(token: string) { if (credential || !token || /\s/.test(token)) throw new Error('PREVIEW_RETENTION_BOUNDARY_FAILED'); credential = token; },
    arm() { if (!allowInsert || armed || attempts || blocked) throw new Error('PREVIEW_RETENTION_BOUNDARY_FAILED'); armed = true; },
    writeAttempts: () => attempts,
    blocked: () => blocked,
  };
}

export async function runRetentionBrowser(source: Source, deployment: Deployment, cwd: string, request: RetentionBrowserRequest,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  launch: (options: LaunchOptions) => Promise<Browser> = options => chromium.launch(options), api?: Transport): Promise<RetentionBrowserResult> {
  let stage: RetentionStage = 'boundary', failureStage: RetentionStage | undefined;
  let browser: Browser | undefined, context: BrowserContext | undefined;
  let gate: Awaited<ReturnType<typeof interceptRetentionRequests>> | undefined;
  let observedAt: string | undefined, runtimeBeforeAt: string | undefined, runtimeAfterAt: string | undefined;
  let outcome: RetentionBrowserResult['outcome'] = 'unknown', evidence: RetentionBrowserResult['evidence'];
  try {
    if (!cwd || source.state !== 'open' || source.sha !== deployment.sha || source.pr !== deployment.pr || source.branch !== deployment.branch
      || !exactDeploymentIdentity(deployment, deployment) || !['prepare', 'inspect', 'check'].includes(request.mode) || !isRetentionMarker(request.marker)
      || request.mode === 'prepare' && request.baseline !== undefined || request.mode === 'check' && request.baseline === undefined) throw new Error();
    const baseline = request.baseline === undefined ? undefined : parseRetentionEvidence(request.baseline);
    if (baseline && baseline.marker !== request.marker) throw new Error();
    stage = 'oidc'; const token = await developmentToken(environment, api);
    stage = 'launch'; browser = await launch(browserOptions(environment));
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    stage = 'boundary'; gate = await interceptRetentionRequests(context, page, deployment.url, request.marker, request.mode === 'prepare'); gate.authenticate(token);
    stage = 'navigation';
    const response = await page.goto(deployment.url, { waitUntil: 'networkidle', timeout: 30_000 });
    if (response?.status() !== 200 || page.url() !== deployment.url + '/' && page.url() !== deployment.url || await page.title() !== 'Cake') throw new Error();
    const runtime = async () => {
      const nonce = randomBytes(32).toString('base64url');
      const value = await page.evaluate(async nonce => {
        const response = await fetch(`/api/qa/preview?nonce=${nonce}`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
        return response.ok ? await response.json() : null;
      }, nonce);
      if (!value || value.protocol !== config.protocol || value.nonce !== nonce || value.deploymentId !== deployment.id
        || value.pr !== source.pr || value.sha !== source.sha || value.branch !== source.branch || value.generation !== deployment.generation
        || value.connectionVerified !== true || value.database?.branchId !== deployment.database!.branchId || value.database?.hostDigest !== deployment.database!.hostDigest) throw new Error();
    };
    const read = async () => retentionSnapshot(await page.evaluate(async id => {
      const response = await fetch(`/api/app?workspaceId=${id}&scope=full`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
      return response.ok ? await response.json() : null;
    }, retentionWorkspaceId), request.marker);
    stage = 'runtime-before'; await runtime(); runtimeBeforeAt = new Date().toISOString();
    stage = 'login';
    await page.getByRole('button', { name: /テストユーザーA/ }).click();
    await page.locator('.app-shell').waitFor(); await page.waitForLoadState('networkidle');
    stage = 'read-before'; const before = await read(); observedAt = new Date().toISOString();
    let after = before;
    if (request.mode === 'prepare') {
      if (before.evidence || gate.blocked()) throw new Error();
      stage = 'write'; gate.arm();
      // The response can be lost after a committed insert. Always reconcile by
      // GET once; never repeat the POST, even when the browser reports timeout.
      let returnedId: string | undefined;
      try {
        returnedId = await page.evaluate(async payload => {
          try {
            const response = await fetch('/api/app', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
              redirect: 'error', signal: AbortSignal.timeout(15_000) });
            if (!response.ok) return undefined;
            const value = await response.json();
            return typeof value?.transaction?.id === 'string' ? value.transaction.id : undefined;
          } catch { return undefined; }
        }, retentionPayload(request.marker));
      } catch { /* The same GET-only recovery applies to a detached evaluate call. */ }
      stage = 'read-after'; after = await read(); observedAt = new Date().toISOString();
      if (!after.evidence || gate.writeAttempts() !== 1 || returnedId !== undefined && returnedId !== after.evidence.transactionId
        || after.transactionCount !== before.transactionCount + 1 || after.totalAmountYen !== before.totalAmountYen + 1234
        || after.withoutMarkerDigest !== before.collectionDigest || after.fixtureDigest !== before.fixtureDigest) throw new Error();
    }
    stage = 'read-after';
    if (request.mode === 'check' && (!after.evidence || !baseline || !sameRetentionEvidence(after.evidence, baseline))
      || baseline && after.evidence && !sameRetentionEvidence(after.evidence, baseline)) throw new Error();
    stage = 'runtime-after'; await runtime(); runtimeAfterAt = new Date().toISOString();
    stage = 'boundary';
    if (gate.blocked() || new URL(page.url()).origin !== deployment.url) throw new Error();
    evidence = after.evidence; outcome = evidence ? 'present' : 'absent';
    if (!evidence) failureStage = 'read-after';
  } catch { failureStage = stage; }
  try { if (context) await context.close(); } catch { failureStage ??= 'boundary'; }
  try { if (browser) await browser.close(); } catch { failureStage ??= 'boundary'; }
  // Private application rows, token, cookies and underlying errors are never
  // attached to the result, persisted, logged or captured in screenshots.
  if (failureStage && outcome !== 'absent') { outcome = 'unknown'; evidence = undefined; }
  return { success: !failureStage && outcome === 'present', outcome, writeAttempts: gate?.writeAttempts() ?? 0,
    ...(evidence ? { evidence } : {}), observedAt: observedAt ?? new Date().toISOString(), ...(runtimeBeforeAt ? { runtimeBeforeAt } : {}),
    ...(runtimeAfterAt ? { runtimeAfterAt } : {}), ...(failureStage ? { failureStage } : {}) };
}

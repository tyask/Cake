import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium, type Browser, type LaunchOptions, type BrowserContext, type Page } from 'playwright';
import { config, sameDatabase, type Deployment, type Source } from './preview-model';
import { transport } from './preview-provider';
export const browserCases = ['desktop-a','desktop-b','mobile-a','mobile-b','read-api'] as const;
export type BrowserProof = { protocol: 'cake-preview-browser/v1'; source: Source; deployment: Deployment; cases: string[];
  clicks: { case: string; target: string; at: string }[]; verifiedAt: string; success: boolean };
export async function developmentToken(environment: Readonly<Record<string, string | undefined>> = process.env): Promise<string> {
  try {
    const inherited = environment.VERCEL_OIDC_TOKEN;
    const response = inherited ? undefined : await transport(environment)('vercel', `/v3/env/pull/${config.vercelProjectId}/development`);
    const token = inherited ?? (response as { env?: Record<string, string> })?.env?.VERCEL_OIDC_TOKEN;
    if (!token || token.length > 32_768 || /\s/.test(token)) throw new Error();
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (claims.project_id !== config.vercelProjectId || claims.owner_id !== config.vercelTeamId || claims.environment !== 'development'
      || typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() + 60_000) throw new Error();
    return token;
  } catch { throw new Error('PREVIEW_OIDC_UNAVAILABLE'); }
}
export function browserOptions(env: Readonly<Record<string, string | undefined>> = process.env): LaunchOptions {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || env.DEBUG || env.PWDEBUG) throw new Error('PREVIEW_BROWSER_UNSAFE_CONFIGURATION');
  const safeKeys = ['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','TMPDIR','TMP','TEMP','LANG','LC_ALL','DISPLAY',
    'XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy',
    'NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','PLAYWRIGHT_BROWSERS_PATH'];
  const safe = Object.fromEntries(safeKeys.flatMap(k => env[k] === undefined ? [] : [[k,env[k]!]]));
  const proxy = env.HTTPS_PROXY ?? env.HTTP_PROXY;
  return { headless: true, env: safe, ...(env.CAKE_BROWSER_EXECUTABLE ? { executablePath: env.CAKE_BROWSER_EXECUTABLE } : {}),
    ...(proxy ? { proxy: { server: new URL(proxy).origin } } : {}) };
}
/** CDP overrides apply to one request, including each redirect hop. Playwright
 * route.continue headers can carry across redirects, so credentials use Fetch instead.
 * The browser performs TLS and the actual HTTP request; no response is fetched in Node. */
export async function interceptPreviewRequests(context: BrowserContext, page: Page, origin: string, token: string) {
  const session = await context.newCDPSession(page);
  let blocked = false;
  session.on('Fetch.requestPaused', async event => {
    try {
      const request = event.request, url = new URL(request.url);
      if (url.origin !== origin) { await session.send('Fetch.failRequest', { requestId:event.requestId,errorReason:'BlockedByClient' }); return; }
      if (!['GET','HEAD','OPTIONS'].includes(request.method) && !(request.method === 'POST' && url.pathname === '/api/auth/callback/test-login')) {
        blocked = true; await session.send('Fetch.failRequest', { requestId:event.requestId,errorReason:'BlockedByClient' }); return;
      }
      const headers = Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== 'x-vercel-trusted-oidc-idp-token').map(([name,value]) => ({ name,value:String(value) }));
      headers.push({ name:'x-vercel-trusted-oidc-idp-token',value:token });
      await session.send('Fetch.continueRequest', { requestId:event.requestId,headers });
    } catch {
      blocked = true;
      try { await session.send('Fetch.failRequest', { requestId:event.requestId,errorReason:'Failed' }); } catch { /* Browser shutdown. */ }
    }
  });
  await session.send('Fetch.enable', { patterns:[{ urlPattern:'*',requestStage:'Request' }] });
  return { blocked:() => blocked };
}
export async function verifyBrowser(source: Source, deployment: Deployment, cwd: string, environment: Readonly<Record<string, string | undefined>> = process.env,
  launch: (options: LaunchOptions) => Promise<Browser> = options => chromium.launch(options)): Promise<BrowserProof> {
  if (!deployment.database || source.sha !== deployment.sha || source.pr !== deployment.pr || source.branch !== deployment.branch || deployment.state !== 'READY') throw new Error('PREVIEW_BROWSER_TARGET');
  const directory = resolve(cwd, '.cake'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const proofPath = resolve(directory, 'verification.json'); await rm(proofPath, { force: true });
  const proof: BrowserProof = { protocol: 'cake-preview-browser/v1', source, deployment, cases: [], clicks: [], verifiedAt: new Date().toISOString(), success: false };
  let browser: Browser | undefined;
  try {
    const token = await developmentToken(environment);
    browser = await launch(browserOptions(environment));
    for (const mobile of [false,true]) for (const user of ['a','b']) {
      const label = `${mobile ? 'mobile' : 'desktop'}-${user}`;
      const context = await browser.newContext({ viewport: mobile ? { width:390,height:844 } : { width:1440,height:1000 }, isMobile: mobile, hasTouch: mobile,
        serviceWorkers: 'block', acceptDownloads: false });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(30_000);
        const interception = await interceptPreviewRequests(context, page, deployment.url, token);
        const r = await page.goto(deployment.url, { waitUntil:'networkidle',timeout:30_000 });
        if (r?.status() !== 200 || new URL(page.url()).origin !== deployment.url || await page.title() !== 'Cake') throw new Error();
        const checkRuntime = async () => {
          const nonce = randomBytes(32).toString('base64url');
          const result = await page.evaluate(async nonce => {
            const response = await fetch(`/api/qa/preview?nonce=${nonce}`, { cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15_000) });
            return response.ok ? await response.json() : null;
          }, nonce);
          if (!result || result.protocol !== config.protocol || result.nonce !== nonce || result.deploymentId !== deployment.id
            || result.pr !== source.pr || result.sha !== source.sha || result.branch !== source.branch || result.generation !== deployment.generation
            || result.connectionVerified !== true || result.database?.branchId !== deployment.database!.branchId || result.database?.hostDigest !== deployment.database!.hostDigest) throw new Error();
        };
        await checkRuntime();
        await page.getByRole('button', { name:new RegExp(`テストユーザー${user.toUpperCase()}`) }).click();
        proof.clicks.push({ case:label,target:`ログイン${user.toUpperCase()}`,at:new Date().toISOString() });
        await page.locator('.app-shell').waitFor(); await page.waitForLoadState('networkidle');
        const identity = await page.evaluate(async user => {
          const [s,a] = await Promise.all(['/api/auth/session','/api/app'].map(path => fetch(path, { redirect:'error',signal:AbortSignal.timeout(15_000) })));
          const [sd,ad] = await Promise.all([s.json(),a.json()]);
          return s.status === 200 && a.status === 200 && sd?.user?.id === `test-user-${user}` && ad?.user?.id === `test-user-${user}` && Array.isArray(ad.workspaces);
        }, user);
        if (!identity) throw new Error();
        const navigation = page.locator(mobile ? '.bottom-nav' : '.app-nav');
        for (const name of ['取引明細','設定','ホーム']) {
          await navigation.getByRole('button', { name:new RegExp(name) }).click();
          if (name === 'ホーム') await page.locator('.app-shell').waitFor(); else await page.getByRole('heading', { name, exact:true }).waitFor();
          proof.clicks.push({ case:label,target:name,at:new Date().toISOString() });
          await page.screenshot({ path:resolve(directory,`${label}-${name === '設定' ? 'settings' : name === 'ホーム' ? 'home' : 'transactions'}.png`) });
        }
        await checkRuntime();
        if (interception.blocked() || new URL(page.url()).origin !== deployment.url) throw new Error();
        proof.cases.push(label);
      } finally { await context.close(); }
    }
    proof.cases.push('read-api'); proof.success = true; proof.verifiedAt = new Date().toISOString();
    return proof;
  } catch { throw new Error('PREVIEW_BROWSER_FAILED'); }
  finally {
    try { if (browser) await browser.close(); } finally { await writeFile(proofPath, JSON.stringify(proof,null,2)+'\n', { mode:0o600 }); }
  }
}
export function sameVerifiedDeployment(a: Deployment, b: Deployment): boolean {
  return a.id === b.id && a.url === b.url && a.sha === b.sha && a.branch === b.branch && a.pr === b.pr && a.generation === b.generation
    && a.state === 'READY' && b.state === 'READY' && !!a.database && !!b.database && sameDatabase(a.database,b.database);
}

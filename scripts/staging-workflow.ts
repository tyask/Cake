import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StagingProvider } from './staging-service';
import { PreviewService } from './preview-service';
import { config, object } from './preview-model';
import { verifyBrowser, sameVerifiedDeployment } from './preview-browser';
import { browserEvidence } from './preview-verify-receipt';
import staging from '../staging.config.json';

export async function assertAnonymousProtection(request: typeof fetch = fetch): Promise<void> {
  const response = await request(`https://${staging.alias}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (response.status === 401) return;
  if ([302, 303, 307, 308].includes(response.status)) {
    const location = new URL(response.headers.get('location') ?? '', `https://${staging.alias}`);
    if (location.protocol === 'https:' && location.hostname === 'vercel.com' && ['/sso-api', '/login'].includes(location.pathname)) return;
  }
  throw new Error('PREVIEW_STAGING_PUBLIC_ACCESS');
}

export async function runStagingWorkflow(env = process.env, provider = new StagingProvider()): Promise<void> {
  if (env.GITHUB_REPOSITORY !== config.repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_WORKFLOW_REF !== `${config.repository}/.github/workflows/staging.yml@refs/heads/main`
    || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
    || !env.GITHUB_EVENT_PATH) throw new Error('PREVIEW_STAGING_UNTRUSTED_WORKFLOW');
  const event = object(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
  if (object(event.repository).id !== config.repositoryId || object(event.repository).full_name !== config.repository)
    throw new Error('PREVIEW_STAGING_UNTRUSTED_WORKFLOW');
  const source = await provider.main();
  if (source.sha !== env.GITHUB_SHA || env.GITHUB_EVENT_NAME === 'push' && (event.after !== source.sha || event.deleted === true))
    throw new Error('PREVIEW_STAGING_SOURCE_CHANGED');
  await provider.sync(source);
  const digest = createHash('sha256').update(`cake-staging/v1:${env.GITHUB_RUN_ID}`).digest('hex');
  const operation = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
  const service = new PreviewService(provider);
  const deployed = await service.deploy(source, operation, env.GITHUB_RUN_ATTEMPT !== '1');
  if (!deployed.deployment) throw new Error('PREVIEW_STAGING_DEPLOYMENT_MISSING');
  // Reuse the formal PC/mobile × A/B login, navigation, session/app and runtime proof.
  const directory = await mkdtemp(join(tmpdir(), 'cake-staging-'));
  let browser;
  try { browser = browserEvidence(await verifyBrowser(source, deployed.deployment, directory, env, undefined, provider.api)); }
  finally { await rm(directory, { recursive: true, force: true }); }
  const after = await service.status(source);
  if (!after.deployment || !sameVerifiedDeployment(deployed.deployment, after.deployment)) throw new Error('PREVIEW_STAGING_SOURCE_CHANGED');
  await provider.alias(source, after.deployment);
  await assertAnonymousProtection();
  await provider.assertSource(source);
  const receipt = { ...after, protocol: 'cake-staging/v1', action: 'deploy', alias: `https://${staging.alias}`, browser,
    operation, runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT), controlSha: env.GITHUB_SHA };
  const serialized = JSON.stringify(receipt);
  if (Buffer.byteLength(serialized) > 4096) throw new Error('PREVIEW_STAGING_RECEIPT_TOO_LARGE');
  console.log(`::notice title=cake-staging/v1::${serialized.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A')}`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `常設Preview: 成功\n\nSHA: ${source.sha}\n\nURL: https://${staging.alias}\n\nDeployment: ${after.deployment.id}\n\nDB: ${after.database?.branchId} / ${after.database?.endpointId}\n\nPC/mobile × A/B: 成功（16クリック・12観測）\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runStagingWorkflow().catch(error => {
    const code = error instanceof Error && /^PREVIEW_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PREVIEW_STAGING_FAILED';
    console.error(`Cake: ${code}。main・Deployment・DB・aliasを照合してください。秘密値・外部応答は表示しません。`);
    process.exitCode = 1;
  });
}

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, uuid } from './preview-model';
import { fullSha, validTaskBranch } from './task-workflow';

type Environment = Readonly<Record<string, string | undefined>>;

/** A provisioning build publishes no application or DB client. Other phases keep the DB guard. */
export function provisioningBuild(environment: Environment): boolean {
  if (environment.CAKE_PREVIEW_PHASE !== 'provisioning') return false;
  const pr = environment.CAKE_PREVIEW_PR;
  if (environment.VERCEL_ENV !== 'preview' || environment.AUTH_MODE !== 'test'
    || environment.CAKE_PREVIEW_REPOSITORY !== config.repository
    || !/^[1-9][0-9]*$/.test(pr ?? '') || !Number.isSafeInteger(Number(pr)) || Number(pr) > 2147483647
    || !uuid(environment.CAKE_PREVIEW_GENERATION)
    || !validTaskBranch(environment.CAKE_PREVIEW_SOURCE_BRANCH)
    || environment.CAKE_PREVIEW_SOURCE_BRANCH !== environment.VERCEL_GIT_COMMIT_REF
    || !fullSha(environment.CAKE_PREVIEW_SOURCE_SHA)
    || environment.CAKE_PREVIEW_SOURCE_SHA !== environment.VERCEL_GIT_COMMIT_SHA
    || environment.CAKE_PREVIEW_PRODUCTION_HOST_SHA256 !== config.productionHostDigest
    || environment.CAKE_PREVIEW_DATABASE_BRANCH_ID !== ''
    || environment.CAKE_PREVIEW_DATABASE_HOST_SHA256 !== '') {
    throw new Error('Preview準備用ビルドの対象を確認できません。アプリ・DB操作は開始しません。');
  }
  return true;
}

/** Remove the previous static build before compiling the actual application. */
export function clearProvisioningOutput(cwd = process.cwd()): void {
  rmSync(resolve(cwd, '.next/output'), { recursive: true, force: true });
  rmSync(resolve(cwd, '.vercel/output'), { recursive: true, force: true });
}

export function writeProvisioningOutput(cwd = process.cwd()): void {
  // Never carry a cached application runtime into the preparation deployment.
  rmSync(resolve(cwd, '.next'), { recursive: true, force: true });
  clearProvisioningOutput(cwd);
  // The Next.js Vercel builder accepts Build Output API v3 in <distDir>/output.
  // Keep the existing nextjs preset and trusted-main deployment request unchanged.
  const output = resolve(cwd, '.next/output');
  mkdirSync(resolve(output, 'static'), { recursive: true });
  writeFileSync(resolve(output, 'config.json'), JSON.stringify({
    version: 3,
    routes: [
      { src: '/(.*)', headers: {
        'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Cake-Preview-Phase': 'provisioning',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      }, continue: true },
      { src: '/', dest: '/index.html', methods: ['GET', 'HEAD'] },
      { src: '/(.*)', status: 404 },
    ],
  }) + '\n');
  writeFileSync(resolve(output, 'static/index.html'), '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cake Preview準備中</title><h1>Cake Previewを準備しています</h1><p>検証用アプリのURLは、専用DBの照合とアプリのビルドが完了した後にPRへ表示されます。</p></html>\n');
}

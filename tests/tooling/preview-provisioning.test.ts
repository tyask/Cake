import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { config } from '../../scripts/preview/preview-model';
import { buildSteps, runVercelBuild } from '../../scripts/build/vercel-build';
import { clearProvisioningOutput, provisioningBuild } from '../../scripts/build/preview-provisioning';
import { databaseConnectionString } from '../../lib/server/database-environment';

const environment = {
  VERCEL_ENV: 'preview', AUTH_MODE: 'test', CAKE_PREVIEW_PHASE: 'provisioning',
  CAKE_PREVIEW_REPOSITORY: config.repository, CAKE_PREVIEW_PR: '34',
  CAKE_PREVIEW_GENERATION: '00000000-0000-4000-8000-000000000001',
  CAKE_PREVIEW_SOURCE_BRANCH: 'codex/feature', VERCEL_GIT_COMMIT_REF: 'codex/feature',
  CAKE_PREVIEW_SOURCE_SHA: 'a'.repeat(40), VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
  CAKE_PREVIEW_DATABASE_BRANCH_ID: '', CAKE_PREVIEW_DATABASE_HOST_SHA256: '',
  CAKE_PREVIEW_PRODUCTION_HOST_SHA256: config.productionHostDigest,
};

test('準備用はDB資格情報なしで静的生成だけを行い、DB接続ガードは引き続き拒否する', () => {
  assert.deepEqual(buildSteps(environment), ['provision']);
  const steps: string[] = [];
  runVercelBuild(environment, step => { steps.push(step); return 0; });
  assert.deepEqual(steps, ['provision']);
  assert.throws(() => databaseConnectionString({ ...environment, CAKE_TEST_DATABASE_URL: 'postgresql://user:secret@ep-preview.example.neon.tech/cake' }), /PreviewとDBの照合/);
  assert.equal(provisioningBuild({ ...environment, CAKE_PREVIEW_PHASE: 'application' }), false);
});

test('準備用の対象・世代・branch/SHA・本番との分離情報が不明なら生成もDB操作もしない', () => {
  const changes = [
    ...Object.keys(environment).map(key => ({ [key]: undefined })),
    { VERCEL_ENV: 'production' }, { VERCEL_ENV: 'development' }, { AUTH_MODE: 'google' },
    { CAKE_PREVIEW_REPOSITORY: 'other/repository' }, { CAKE_PREVIEW_PR: '0' }, { CAKE_PREVIEW_PR: '2147483648' },
    { CAKE_PREVIEW_GENERATION: 'wrong' }, { CAKE_PREVIEW_SOURCE_BRANCH: 'main' },
    { VERCEL_GIT_COMMIT_REF: 'codex/other' }, { VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) },
    { CAKE_PREVIEW_PRODUCTION_HOST_SHA256: 'b'.repeat(64) },
    { CAKE_PREVIEW_DATABASE_BRANCH_ID: 'br-preview' }, { CAKE_PREVIEW_DATABASE_HOST_SHA256: 'a'.repeat(64) },
  ];
  for (const change of changes) {
    const steps: string[] = [];
    assert.throws(() => runVercelBuild({ ...environment, ...change }, step => { steps.push(step); return 0; }));
    assert.deepEqual(steps, []);
  }
});

test('準備用の実CLIは正常終了し、キャッシュ済みアプリ・Function・秘密値を公開成果物へ含めない', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'cake-provision-build-'));
  try {
    for (const path of ['.next/server/api.js', '.next/output/functions/old.func/index.js', '.vercel/output/functions/old.func/index.js']) {
      mkdirSync(resolve(directory, path, '..'), { recursive: true });
      writeFileSync(resolve(directory, path), 'stale-private-runtime');
    }
    const marker = 'private-sentinel-not-for-output';
    const result = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/build/vercel-build.ts')], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', ...environment, DATABASE_URL: marker, CAKE_TEST_DATABASE_URL: marker, AUTH_SECRET: marker },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DBに接続せず/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(marker));
    assert.deepEqual(readdirSync(resolve(directory, '.next/output')).sort(), ['config.json', 'static']);
    assert.deepEqual(readdirSync(resolve(directory, '.next/output/static')), ['index.html']);
    assert.equal(existsSync(resolve(directory, '.next/server')), false);
    assert.equal(existsSync(resolve(directory, '.vercel/output')), false);
    const output = readFileSync(resolve(directory, '.next/output/config.json'), 'utf8');
    const html = readFileSync(resolve(directory, '.next/output/static/index.html'), 'utf8');
    assert.ok(!`${output}${html}`.includes(marker));
    assert.doesNotMatch(html, /<script|<form|postgres|DATABASE_URL/i);
    assert.match(html, /準備しています/);
    const manifest = JSON.parse(output);
    assert.equal(manifest.version, 3);
    const matches = (path: string, method: string) => manifest.routes.find((r: { src: string; continue?: boolean; methods?: string[] }) =>
      !r.continue && new RegExp(`^${r.src}$`).test(path) && (!r.methods || r.methods.includes(method)));
    assert.equal(matches('/', 'GET').dest, '/index.html');
    assert.equal(matches('/', 'HEAD').dest, '/index.html');
    for (const path of ['/', '/api/app', '/api/auth/callback/test-login', '/api/qa/preview', '/api/cron/recurring-payments']) {
      assert.equal(matches(path, 'POST').status, 404);
      if (path !== '/') assert.equal(matches(path, 'GET').status, 404);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('通常アプリのbuild前に準備成果物を除去し、プロジェクト設定と通常cacheは維持する', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'cake-provision-clear-'));
  try {
    for (const path of ['.next/output/config.json', '.vercel/output/config.json', '.next/cache/keep', '.vercel/project.json']) {
      mkdirSync(resolve(directory, path, '..'), { recursive: true });
      writeFileSync(resolve(directory, path), '{}');
    }
    clearProvisioningOutput(directory);
    assert.equal(existsSync(resolve(directory, '.next/output')), false);
    assert.equal(existsSync(resolve(directory, '.vercel/output')), false);
    assert.equal(existsSync(resolve(directory, '.next/cache/keep')), true);
    assert.equal(existsSync(resolve(directory, '.vercel/project.json')), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('準備成果物の生成失敗を正常終了として扱わない', () => {
  let calls = 0;
  assert.throws(() => runVercelBuild(environment, () => { calls++; return 1; }), /provision が失敗/);
  assert.equal(calls, 1);
});

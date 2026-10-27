import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStagingIdle, runRetentionWorkflow } from '../../scripts/preview/deployment-retention-workflow';
import { config } from '../../scripts/preview/preview-model';
import type { RetentionReceipt } from '../../scripts/preview/deployment-retention';

const sha = 'a'.repeat(40);
test('mainのstaging未完了run全状態を確認し、busy・取得不明では整理を停止する', async () => {
  const statuses = ['requested', 'queued', 'pending', 'in_progress', 'waiting'];
  const paths: string[] = [];
  await assertStagingIdle(async (provider, path, method = 'GET') => {
    assert.equal(provider, 'github'); assert.equal(method, 'GET');
    assert.equal(new URL(path, 'https://api.github.com').searchParams.get('branch'), 'main');
    paths.push(path); return { total_count: 0, workflow_runs: [] };
  });
  assert.deepEqual(paths.map(path => new URL(path, 'https://api.github.com').searchParams.get('status')), statuses);
  for (const active of statuses) {
    await assert.rejects(assertStagingIdle(async (_provider, path) => {
      const busy = new URL(path, 'https://api.github.com').searchParams.get('status') === active;
      return { total_count: busy ? 1 : 0, workflow_runs: busy ? [{ status: active }] : [] };
    }), /STAGING_BUSY/);
  }
  for (const response of [{}, { total_count: 0, workflow_runs: [{}] }, { total_count: 1, workflow_runs: [] }])
    await assert.rejects(assertStagingIdle(async () => response), /STAGING_RUNS_INVALID/);
  await assert.rejects(assertStagingIdle(async () => { throw new Error('PREVIEW_GITHUB_GET_RESPONSE_UNKNOWN'); }), /RESPONSE_UNKNOWN/);
});
async function fixture(event = { repository: { id: config.repositoryId, full_name: config.repository }, inputs: {} }) {
  const directory = await mkdtemp(join(tmpdir(), 'cake-retention-test-'));
  const path = join(directory, 'event.json'), summary = join(directory, 'summary.md');
  await writeFile(path, JSON.stringify(event));
  const env = { GITHUB_REPOSITORY: config.repository, GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/deployment-retention.yml@refs/heads/main`,
    GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_PATH: path,
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_STEP_SUMMARY: summary,
    GH_TOKEN: 'fixture-only', VERCEL_TOKEN: 'fixture-only', NEON_API_KEY: 'fixture-only' };
  return { env, summary, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
function receipt(mode: 'plan' | 'apply'): RetentionReceipt {
  return { protocol: 'cake-deployment-retention/v1', mode, sourceSha: sha, checkedAt: '2026-10-26T00:00:00Z',
    success: true, planned: ['dpl_old'], deleted: mode === 'apply' ? ['dpl_old'] : [], skipped: [], retained: 1 };
}
test('手動既定はplanで、管理用mainの完全SHAをserviceへ渡す', async () => {
  const f = await fixture(), notices: string[] = [];
  try {
    await runRetentionWorkflow(f.env, audit => ({ run: async (mode, expected) => {
      assert.equal(mode, 'plan'); assert.equal(expected, sha);
      audit({ action: 'plan', ids: ['dpl_old'] }); return receipt(mode);
    } }), line => notices.push(line));
    assert.ok(notices.some(line => line.includes('"action":"plan"')));
    assert.ok(notices.some(line => line.includes('"action":"complete"') && line.includes('"deleted":0')));
    assert.match(await readFile(f.summary, 'utf8'), /削除候補:\n- dpl_old/);
  } finally { await f.cleanup(); }
});
test('定刻scheduleはapply、手動の明示applyも許可する', async () => {
  for (const scheduled of [true, false]) {
    const f = await fixture();
    try {
      await writeFile(f.env.GITHUB_EVENT_PATH, JSON.stringify({ repository: { id: config.repositoryId, full_name: config.repository },
        ...(scheduled ? { schedule: '0 21 * * *' } : { inputs: { mode: 'apply' } }) }));
      f.env.GITHUB_EVENT_NAME = scheduled ? 'schedule' : 'workflow_dispatch';
      await runRetentionWorkflow(f.env, audit => ({ run: async mode => {
        assert.equal(mode, 'apply'); audit({ action: 'plan', ids: ['dpl_old'] });
        audit({ action: 'deleted', ids: ['dpl_old'] }); return receipt(mode);
      } }), () => {});
      assert.match(await readFile(f.summary, 'utf8'), /削除確認済み:\n- dpl_old/);
    } finally { await f.cleanup(); }
  }
});
test('不正workflow・event・入力・資格情報とapply再runはproviderに触れる前に拒否する', async () => {
  const f = await fixture(); let calls = 0;
  const factory = () => { calls++; return { run: async () => receipt('plan') }; };
  try {
    for (const change of [ { GITHUB_REF: 'refs/heads/codex/feature' }, { GITHUB_SHA: 'bad' },
      { GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/deployment-retention.yml@refs/heads/feature` },
      { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_RUN_ID: '9007199254740992' }, { VERCEL_TOKEN: '' } ])
      await assert.rejects(runRetentionWorkflow({ ...f.env, ...change }, factory, () => {}));
    for (const event of [ { repository: { id: 1, full_name: config.repository }, inputs: {} },
      { repository: { id: config.repositoryId, full_name: config.repository }, inputs: { mode: 'delete-all' } } ]) {
      await writeFile(f.env.GITHUB_EVENT_PATH, JSON.stringify(event));
      await assert.rejects(runRetentionWorkflow(f.env, factory, () => {}));
    }
    await writeFile(f.env.GITHUB_EVENT_PATH, JSON.stringify({ repository: { id: config.repositoryId, full_name: config.repository }, inputs: { mode: 'apply' } }));
    await assert.rejects(runRetentionWorkflow({ ...f.env, GITHUB_RUN_ATTEMPT: '2' }, factory, () => {}), /RERUN_UNSUPPORTED/);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});
test('途中失敗は成功receiptを出さず、削除確認済みIDを残す', async () => {
  const f = await fixture(), notices: string[] = [];
  try {
    await assert.rejects(runRetentionWorkflow(f.env, audit => ({ run: async () => {
      audit({ action: 'plan', ids: ['dpl_one', 'dpl_two'] });
      audit({ action: 'deleting', ids: ['dpl_one'] });
      audit({ action: 'deleted', ids: ['dpl_one'] });
      audit({ action: 'deleting', ids: ['dpl_two'] });
      throw new Error('PREVIEW_VERCEL_DELETE_RESPONSE_UNKNOWN');
    } }), line => notices.push(line)), /RESPONSE_UNKNOWN/);
    assert.ok(!notices.some(line => line.includes('"action":"complete"')));
    const summary = await readFile(f.summary, 'utf8');
    assert.match(summary, /未完了/); assert.match(summary, /削除確認済み:\n- dpl_one/);
    assert.match(summary, /削除要求対象（不在確認前）:\n- dpl_two/);
    assert.ok(!summary.includes('削除確認済み:\n- dpl_two'));
  } finally { await f.cleanup(); }
});
test('大量削除でもnoticeは1件だけとし、全IDをSummaryと公開ログへ残す', async () => {
  const f = await fixture(), lines: string[] = [];
  const ids = Array.from({ length: 141 }, (_, i) => `dpl_${i.toString().padStart(30, '0')}`);
  try {
    await runRetentionWorkflow(f.env, audit => ({ run: async mode => {
      audit({ action: 'plan', ids });
      for (const id of ids) { audit({ action: 'deleting', ids: [id] }); audit({ action: 'deleted', ids: [id] }); }
      return { ...receipt(mode), planned: ids, deleted: ids };
    } }), line => lines.push(line));
    const notices = lines.filter(line => line.startsWith('::notice'));
    assert.equal(notices.length, 1); assert.ok(Buffer.byteLength(notices[0]) < 4096);
    assert.match(notices[0], /"deleted":141/);
    const summary = await readFile(f.summary, 'utf8');
    for (const id of ids) { assert.ok(summary.includes(id)); assert.ok(lines.some(line => line.includes(id))); }
    await assert.rejects(runRetentionWorkflow(f.env, audit => ({ run: async mode => {
      audit({ action: 'plan', ids: ['dpl_bad\n::warning::injected'] }); return receipt(mode);
    } }), () => {}), /INVALID_RECEIPT/);
  } finally { await f.cleanup(); }
});

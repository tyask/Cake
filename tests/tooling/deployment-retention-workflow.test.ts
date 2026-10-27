import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retentionNotices, runRetentionWorkflow } from '../../scripts/preview/deployment-retention-workflow';
import { config } from '../../scripts/preview/preview-model';
import type { RetentionReceipt } from '../../scripts/preview/deployment-retention';

const sha = 'a'.repeat(40);
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
        ...(scheduled ? { schedule: '17 3 * * *' } : { inputs: { mode: 'apply' } }) }));
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
test('大量の公開IDは欠落なく分割し、各noticeを4KiB以下にする', () => {
  const ids = Array.from({ length: 141 }, (_, i) => `dpl_${i.toString().padStart(30, '0')}`), lines: string[] = [];
  retentionNotices({ protocol: 'cake-deployment-retention/v1', action: 'plan', ids }, line => lines.push(line));
  const payloads = lines.map(line => {
    const text = line.split('::').at(-1)!; assert.ok(Buffer.byteLength(text) <= 4096); return JSON.parse(text);
  });
  assert.equal(lines.length, 5); assert.deepEqual(payloads.flatMap(part => part.ids), ids);
  assert.deepEqual(payloads.map(part => part.part), [1, 2, 3, 4, 5]);
  assert.ok(payloads.every(part => part.parts === 5));
  assert.throws(() => retentionNotices({ ids: ['dpl_bad\n::warning::injected'] }), /INVALID_RECEIPT/);
});

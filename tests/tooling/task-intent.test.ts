import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertTaskIntentReady, readTaskIntent, runTaskIntent, taskIntentRegistry, taskIntentRoot } from '../../scripts/task/task-intent';

const clock = () => new Date('2026-10-27T23:30:00.000Z');
const branch = 'codex/example';
const id = '261028-example'; // Tokyo is already the next day.

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'cake-intent-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.cake'));
  await writeFile(join(cwd, '.cake/plan.md'), '# 計画\n\nAC-01: 合意した変更だけを実装する。\n');
  await writeFile(join(cwd, '.cake/reply.md'), 'この計画で進めてください。\n');
  await writeFile(join(cwd, '.cake/note.md'), '予定した修正を進める。\n');
  const run = (args: string[], selectedBranch = branch) => runTaskIntent({ cwd, branch: selectedBranch, args, now: clock, log() {} });
  const init = () => run(['init', '--issue', '123', '--name', 'example', '--plan-file', '.cake/plan.md']);
  const approve = () => run(['approve', '--intent', id, '--actor', 'このチャットの利用者', '--reply-file', '.cake/reply.md']);
  const freeze = () => run(['freeze', '--intent', id]);
  return { cwd, run, init, approve, freeze, recordDir: `${taskIntentRoot}/${id}` };
}

test('承認された計画と回答を永続化し、別セッションから再開・凍結確認できる', async t => {
  const { cwd, run, init, approve, freeze, recordDir } = await fixture(t);
  const created = await init();
  assert.equal(created!.id, id);
  assert.equal(created!.approval, null);
  await assert.rejects(assertTaskIntentReady(cwd, id, branch), /PLAN_APPROVAL_REQUIRED/);
  const approved = await approve();
  assert.equal(approved!.approval!.reply, 'この計画で進めてください。\n');
  assert.equal(approved!.approval!.recordedAt, clock().toISOString());
  await assert.rejects(assertTaskIntentReady(cwd, id, branch), /FREEZE_REQUIRED/);
  await run(['progress', '--intent', id, '--phase', 'Construction', '--status', 'running', '--note-file', '.cake/note.md']);
  await freeze();
  const restored = await assertTaskIntentReady(cwd, recordDir, branch);
  assert.equal(restored.id, id);
  assert.equal(restored.approval!.planHash, restored.planHash);
  assert.equal(restored.frozen, true);
  assert.match(await readFile(join(cwd, recordDir, 'aidlc-state.md'), 'utf8'), /Status：frozen/);
  assert.match(await readFile(join(cwd, recordDir, 'audit/cake.md'), 'utf8'), /この計画で進めてください。/);
  const before = await readFile(join(cwd, recordDir, 'cake-intent.json'), 'utf8');
  await run(['status', '--intent', id]);
  assert.equal(await readFile(join(cwd, recordDir, 'cake-intent.json'), 'utf8'), before);
});

test('未承認の計画で実装工程へ進めず、入力本文や秘密値をログへ出さない', async t => {
  const { cwd, run, init } = await fixture(t);
  await init();
  await assert.rejects(run(['progress', '--intent', id, '--phase', 'Construction', '--status', 'running', '--note-file', '.cake/note.md']), /PLAN_APPROVAL_REQUIRED/);
  await writeFile(join(cwd, '.cake/reply.md'), '承認 ghp_abcdefghijklmnopqrstuvwxyz1234567890');
  await assert.rejects(run(['approve', '--intent', id, '--actor', '利用者', '--reply-file', '.cake/reply.md']), { message: 'CAKE_INTENT_SECRET_CONTENT' });
  assert.equal((await readTaskIntent(cwd, id, branch))!.approval, null);
});

test('直接編集された計画の古い承認はReady判定に使えない', async t => {
  const { cwd, init, approve, freeze, recordDir } = await fixture(t);
  await init(); await approve(); await freeze();
  await writeFile(join(cwd, recordDir, 'plan.md'), '# 変更後\n\n承認した範囲が変わった。\n');
  await assert.rejects(assertTaskIntentReady(cwd, id, branch), /PLAN_APPROVAL_REQUIRED/);
});

test('計画更新は凍結と承認を解除し、再承認した計画だけを凍結できる', async t => {
  const { cwd, run, init, approve, freeze } = await fixture(t);
  await init(); const original = await approve(); await freeze();
  await writeFile(join(cwd, '.cake/plan.md'), '# 計画の変更\n\nAC-02: 新しい条件を満たす。\n');
  const updated = await run(['plan', '--intent', id, '--plan-file', '.cake/plan.md']);
  assert.equal(updated!.approval, null);
  assert.equal(updated!.frozen, false);
  assert.notEqual(updated!.planHash, original!.planHash);
  assert.equal(await readFile(join(cwd, original!.recordDir, original!.approval!.planFile), 'utf8'), '# 計画\n\nAC-01: 合意した変更だけを実装する。\n');
  const audit = await readFile(join(cwd, original!.recordDir, 'audit/cake.md'), 'utf8');
  assert.ok(audit.includes(original!.approval!.planFile));
  assert.ok(audit.includes('この計画で進めてください。'));
  await assert.rejects(freeze(), /PLAN_APPROVAL_REQUIRED/);
  await approve(); await freeze();
  assert.equal((await assertTaskIntentReady(cwd, id, branch)).planHash, updated!.planHash);
});

test('分割PRの別branchを同じ承認済みIntentへ対応付け、他案件のbranchは使わない', async t => {
  const { cwd, run, init, approve, freeze } = await fixture(t);
  await init(); await approve(); await freeze();
  await run(['attach', '--intent', id, '--note-file', '.cake/note.md'], 'codex/second');
  const attached = await readTaskIntent(cwd, undefined, 'codex/second');
  assert.equal(attached!.issue, 123);
  assert.equal(attached!.frozen, false);
  await run(['freeze', '--intent', id], 'codex/second');
  assert.equal((await assertTaskIntentReady(cwd, id, 'codex/second')).id, id);
  await run(['init', '--issue', '456', '--name', 'other', '--plan-file', '.cake/plan.md'], 'codex/third');
  await assert.rejects(run(['attach', '--intent', id, '--note-file', '.cake/note.md'], 'codex/third'), /BRANCH_ALREADY_ASSIGNED/);
});

test('過去の承認対象本文を改変・紛失した場合は履歴の整合性確認を拒否する', async t => {
  const { cwd, init, approve, freeze } = await fixture(t);
  await init(); const record = await approve(); await freeze();
  await writeFile(join(cwd, record!.recordDir, record!.approval!.planFile), '承認対象を書き換えた。');
  await assert.rejects(assertTaskIntentReady(cwd, id, branch), /APPROVAL_PLAN_CHANGED/);
});

test('凍結後の進捗更新を拒否し、同じ計画の修正再開では承認を保持する', async t => {
  const { run, init, approve, freeze } = await fixture(t);
  await init(); const original = await approve(); await freeze();
  await assert.rejects(run(['progress', '--intent', id, '--phase', 'Operation', '--status', 'running', '--note-file', '.cake/note.md']), /FROZEN/);
  await assert.rejects(approve(), /FROZEN/);
  const reopened = await run(['reopen', '--intent', id, '--note-file', '.cake/note.md']);
  assert.deepEqual(reopened!.approval, original!.approval);
  assert.equal(reopened!.status, 'running');
  assert.equal(reopened!.frozen, false);
  await freeze();
});

test('別branch・別Issueへの取り違えと重複登録を拒否する', async t => {
  const { cwd, run, init, approve, freeze } = await fixture(t);
  await init(); await approve(); await freeze();
  await assert.rejects(assertTaskIntentReady(cwd, id, 'codex/other'), /BRANCH_MISMATCH/);
  await assert.rejects(run(['init', '--issue', '123', '--name', 'other', '--plan-file', '.cake/plan.md'], 'codex/other'), /ALREADY_EXISTS/);
  await assert.rejects(run(['init', '--issue', '456', '--name', 'other', '--plan-file', '.cake/plan.md']), /ALREADY_EXISTS/);
  assert.equal(await readTaskIntent(cwd, undefined, branch).then(record => record!.issue), 123);
  assert.equal(await readTaskIntent(cwd, '261028-missing', branch), null);
});

test('同時初期化はlockで一方だけ成功し、台帳を破損しない', async t => {
  const { cwd, init } = await fixture(t);
  const results = await Promise.allSettled([init(), init()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(String((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason), /CAKE_INTENT_(?:BUSY|ALREADY_EXISTS)/);
  const index = JSON.parse(await readFile(join(cwd, taskIntentRegistry), 'utf8'));
  assert.equal(index.intents.length, 1);
});

test('パストラバーサルと入力・記録先のsymlinkを拒否する', async t => {
  const { cwd, run, init } = await fixture(t);
  await assert.rejects(run(['init', '--issue', '123', '--name', '../escape', '--plan-file', '.cake/plan.md']), /INVALID_ARGUMENTS/);
  await assert.rejects(run(['init', '--issue', '123', '--name', 'example', '--plan-file', '../outside.md']), /PATH_OUTSIDE_WORKTREE/);
  await symlink(join(cwd, '.cake/plan.md'), join(cwd, '.cake/linked.md'));
  await assert.rejects(run(['init', '--issue', '123', '--name', 'example', '--plan-file', '.cake/linked.md']), /SYMLINK/);
  await init();
  await assert.rejects(readTaskIntent(cwd, `${taskIntentRoot}/../example`, branch), /INVALID_ID/);
  const { cwd: linkedCwd, run: linkedRun } = await fixture(t);
  await mkdir(join(linkedCwd, 'aidlc/spaces'), { recursive: true });
  await symlink(join(cwd, '.cake'), join(linkedCwd, 'aidlc/spaces/default'));
  await assert.rejects(linkedRun(['init', '--issue', '123', '--name', 'example', '--plan-file', '.cake/plan.md']), /SYMLINK/);
});

test('記録のIssueや承認shapeを改変した場合は検証を拒否する', async t => {
  const { cwd, init, approve, freeze, recordDir } = await fixture(t);
  await init(); await approve(); await freeze();
  const path = join(cwd, recordDir, 'cake-intent.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...record, issue: 124 }));
  await assert.rejects(assertTaskIntentReady(cwd, id, branch), /INVALID_RECORD/);
  await writeFile(path, JSON.stringify({ ...record, approval: { ...record.approval, planHash: 'bad' } }));
  await assert.rejects(assertTaskIntentReady(cwd, id, branch), /INVALID_APPROVAL/);
});

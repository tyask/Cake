import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import capability from '../../preview-verify.config.json';
import { config } from '../../scripts/preview/preview-model';
import { remotePreviewProof } from '../../scripts/preview/preview-remote-proof';
import { runTaskPr } from '../../scripts/task/task-pr';
import type { WorkflowExecutor } from '../../scripts/task/task-workflow';
import { checksFixture } from './fixtures/preview-checks-fixture';
import { verifyChecksFixture, verifyProofFixture } from './fixtures/preview-verify-fixture';

type Mode = 'success' | 'old-target-head' | 'old-proof-head' | 'wrong-deployment' | 'changed-deployment-operation'
  | 'latest-push-failed' | 'latest-pr-failed' | 'dirty-control' | 'non-main-control' | 'missing-capability';
const silent = () => {};
const changes = '明細一覧の一括操作で繰り返すDB処理を減らします。\n\n### 修正内容\n\n参加者の集約を一回にまとめ、適用結果を維持します。`SQL`と$(literal)は本文として保持します。';

/** Exercise the real control module and both receipt readers; only Git/GitHub I/O is stubbed. */
async function fixture(mode: Mode = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'cake-task-pr-remote-'));
  const control = join(directory, 'control'), target = join(directory, 'old-target');
  await mkdir(join(control, '.cake'), { recursive: true });
  await mkdir(join(target, 'scripts', 'task'), { recursive: true });
  const executed = join(directory, 'target-code-was-executed');
  await writeFile(join(target, 'scripts/task/task-pr.ts'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(executed)}, 'untrusted');\nthrow new Error('old target code must never run');\n`);
  await writeFile(join(target, 'package.json'), JSON.stringify({ scripts: { 'task:pr': 'node --import tsx scripts/task/task-pr.ts' } }));
  await writeFile(join(control, 'report.md'), 'Local checks passed. External QA comes from the exact verified Actions notice.\n');
  await writeFile(join(control, 'changes.md'), `\n${changes}\n`);

  const verified = verifyChecksFixture(), s = verified.receipt.source;
  const proofPath = join(control, '.cake', `verify-${s.pr}.json`);
  await writeFile(proofPath, JSON.stringify(remotePreviewProof(verified.workflow.id, verified.receipt)));
  const changedHead = 'c'.repeat(40);
  const targetHead = ['old-target-head', 'old-proof-head'].includes(mode) ? changedHead : s.sha;
  const pullHead = mode === 'old-proof-head' ? changedHead : s.sha;
  const pull = { number: s.pr, html_url: `https://github.com/${config.repository}/pull/${s.pr}`, state: 'open', created_at: s.createdAt,
    head: { ref: s.branch, sha: pullHead, repo: { full_name: config.repository } }, base: { ref: 'main', repo: { full_name: config.repository } } };

  // The newly dispatched status operation has its own run/job/check/suite identity.
  const status = checksFixture('status'), apiUrl = (path: string) => `https://api.github.com/repos/${config.repository}/${path}`;
  Object.assign(status.run, { id: 124, url: apiUrl('actions/runs/124'), check_suite_id: 235, check_suite_url: apiUrl('check-suites/235') });
  Object.assign(status.job, { id: 457, run_id: 124, url: apiUrl('actions/jobs/457'), run_url: status.run.url, check_run_url: apiUrl('check-runs/346') });
  Object.assign(status.suite, { id: 235, url: status.run.check_suite_url });
  Object.assign(status.check, { id: 346, url: status.job.check_run_url, check_suite: { id: 235 },
    output: { annotations_count: 1, annotations_url: apiUrl('check-runs/346/annotations') } });
  const currentDeployment = structuredClone(verified.deployment);
  if (mode === 'wrong-deployment') currentDeployment.id = 'dpl_different';
  if (mode === 'changed-deployment-operation') currentDeployment.operation = '30000000-0000-4000-8000-000000000003';
  Object.assign(status.receipt, { runId: '124', deployment: currentDeployment, database: currentDeployment.database });
  status.responses.clear();
  for (const [path, value] of [
    ['actions/workflows/preview.yml', status.workflow], ['actions/runs/124', status.run],
    ['actions/runs/124/attempts/1/jobs?per_page=100&page=1', status.jobs], ['check-suites/235', status.suite],
    ['check-runs/346', status.check], ['check-runs/346/annotations?per_page=100&page=1', [status.annotation]],
  ] as const) status.responses.set(path, value);

  const history: { command: string; args: readonly string[]; cwd: string }[] = [], events: string[] = [];
  const mutations = { dispatch: 0, update: 0, ready: 0 };
  let updatedBody = '';
  const execute: WorkflowExecutor = async (command, args, cwd) => {
    history.push({ command, args: [...args], cwd });
    let value: unknown;
    if (command === 'git') {
      assert.ok(cwd === control || cwd === target);
      const call = args.join(' ');
      if (call === 'rev-parse --show-toplevel') value = cwd;
      else if (call === 'branch --show-current') value = cwd === target ? s.branch : 'main';
      else if (call === 'rev-parse HEAD') value = cwd === target ? targetHead : mode === 'non-main-control' ? changedHead : verified.mainSha;
      else if (call.startsWith('status ')) value = cwd === control && mode === 'dirty-control' ? ' M scripts/task/task-pr.ts\n' : '';
      else if (call === 'remote get-url origin') value = 'https://github.com/tyask/Cake.git';
      else if (call === `ls-remote --heads origin refs/heads/${s.branch}`) value = `${pullHead}\trefs/heads/${s.branch}`;
      else assert.fail(`Unexpected git command: ${call}`);
    } else if (args[0] === 'pr') {
      assert.equal(cwd, target);
      if (args[1] === 'list') value = [{ number: s.pr, url: pull.html_url, headRefOid: pullHead, isDraft: true }];
      else if (args[1] === 'ready') { mutations.ready++; events.push('ready'); value = ''; }
      else assert.fail(`Unexpected PR command: ${args[1]}`);
    } else {
      assert.equal(args[0], 'api');
      const apiPath = args.find(arg => arg.startsWith(`repos/${config.repository}/`));
      assert.ok(apiPath);
      const path = apiPath.slice(`repos/${config.repository}/`.length);
      if (args.includes('PATCH')) {
        assert.equal(path, `pulls/${s.pr}`); assert.equal(cwd, target);
        const input = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
        mutations.update++; events.push('update'); updatedBody = input.body;
        value = { ...pull, title: input.title, body: input.body };
      } else if (args.includes('POST')) {
        assert.equal(path, 'actions/workflows/preview.yml/dispatches'); assert.equal(cwd, target);
        const input = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
        assert.equal(input.ref, 'main'); assert.equal(input.inputs.action, 'status');
        assert.equal(input.inputs.pr, String(s.pr)); assert.equal(input.inputs.sha, pullHead); assert.equal(input.inputs.controlSha, verified.mainSha);
        mutations.dispatch++; events.push('status-dispatch');
        status.run.display_title = `Preview status PR ${s.pr} ${input.inputs.operation}`;
        status.receipt.operation = input.inputs.operation; status.annotation.message = JSON.stringify(status.receipt); value = '';
      } else if (path === 'branches/main') { events.push('main-read'); value = { name: 'main', commit: { sha: verified.mainSha } }; }
      else if (path.startsWith('contents/')) {
        const expected = path === `contents/preview.config.json?ref=${verified.mainSha}` ? config
          : path === `contents/preview-verify.config.json?ref=${verified.mainSha}` ? (mode === 'missing-capability' ? {} : capability) : undefined;
        assert.ok(expected); events.push(path.includes('preview-verify.config') ? 'capability-read' : 'config-read');
        value = { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(expected)).toString('base64') };
      } else if (path === `pulls/${s.pr}`) value = pull;
      else if (path.startsWith('actions/workflows/ci.yml/runs?')) {
        assert.ok(args.includes('--paginate')); assert.ok(args.includes('--slurp')); events.push('latest-ci');
        const runs = ['push', 'pull_request'].map(event => ({ event, head_sha: pullHead, head_branch: s.branch,
          head_repository: { full_name: config.repository }, path: '.github/workflows/ci.yml', pull_requests: [{ number: s.pr }],
          run_number: 10, run_attempt: 1, status: 'completed', conclusion: 'success' }));
        const failedEvent = mode === 'latest-push-failed' ? 'push' : mode === 'latest-pr-failed' ? 'pull_request' : undefined;
        if (failedEvent) runs.push({ ...runs.find(run => run.event === failedEvent)!, run_attempt: 2, conclusion: 'failure' });
        value = [{ workflow_runs: runs }];
      } else if (path.startsWith('actions/workflows/preview.yml/runs?')) value = { workflow_runs: [status.run] };
      else if (status.responses.has(path) && path !== 'actions/workflows/preview.yml') {
        if (path.includes('/annotations')) events.push('status-notice'); value = await status.get(path);
      } else {
        if (path.includes('/annotations')) events.push('verify-notice'); value = await verified.get(path);
      }
    }
    return { status: 0, signal: null, stdout: typeof value === 'string' ? value : JSON.stringify(value) };
  };
  const options = { cwd: control, execute, log: silent,
    args: ['--title', 'Actions QA acceptance', '--changes-file', 'changes.md', '--verification-file', 'report.md', '--remote-proof', `.cake/verify-${s.pr}.json`, '--target-worktree', target] };
  return { directory, control, target, executed, verified, status, mutations, history, events, options, body: () => updatedBody };
}

test('trusted main task:pr revalidates remote evidence and current status/CI before updating an old target draft', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await runTaskPr(f.options), { url: `https://github.com/${config.repository}/pull/71`, existing: true });
    assert.deepEqual(f.mutations, { dispatch: 1, update: 1, ready: 1 });
    for (const [before, after] of [['capability-read', 'verify-notice'], ['verify-notice', 'status-dispatch'],
      ['status-dispatch', 'status-notice'], ['status-notice', 'latest-ci'], ['latest-ci', 'update'], ['update', 'ready']]) {
      assert.ok(f.events.indexOf(before) < f.events.indexOf(after), `${before} must precede ${after}`);
    }
    assert.equal(f.verified.calls.filter(path => path === 'actions/runs/123').length, 2);
    assert.ok(f.verified.calls.includes('actions/runs/123/attempts/1/jobs?per_page=100&page=1'));
    assert.ok(f.body().includes(`- Deployment: ${f.verified.deployment.id}`));
    assert.ok(f.body().includes(`- DB endpoint: ${f.verified.deployment.database!.endpointId}`));
    assert.ok(f.body().includes('- 実クリック: 16回'));
    assert.equal(f.body().split('## Preview\n')[0], `## 変更内容\n\n${changes}\n\n`);
    assert.ok(f.body().endsWith(`## 検証結果\n\n${(await readFile(join(f.control, 'report.md'), 'utf8')).trim()}\n`));
    assert.ok(f.history.every(call => call.command === 'git' || call.command === 'gh'));
    assert.equal(f.history.some(call => call.command === 'git' && call.args[0] === 'push'), false);
    await assert.rejects(readFile(f.executed));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('stale target or proof, changed Deployment, latest CI failure and untrusted control never update or ready a PR', async t => {
  const failures: [Exclude<Mode, 'success'>, RegExp, number][] = [
    ['old-target-head', /origin.*コミット/, 0], ['old-proof-head', /PREVIEW_VERIFY_PROOF_INVALID/, 0],
    ['wrong-deployment', /PREVIEW_PROOF_STALE/, 1], ['changed-deployment-operation', /PREVIEW_PROOF_STALE/, 1],
    ['latest-push-failed', /PREVIEW_CI_NOT_SUCCESSFUL/, 1], ['latest-pr-failed', /PREVIEW_CI_NOT_SUCCESSFUL/, 1],
    ['dirty-control', /PREVIEW_VERIFY_TRUSTED_MAIN_REQUIRED/, 0], ['non-main-control', /PREVIEW_VERIFY_TRUSTED_MAIN_REQUIRED/, 0],
    ['missing-capability', /PREVIEW_VERIFY_NOT_INSTALLED_ON_MAIN/, 0],
  ];
  for (const [mode, expected, dispatch] of failures) await t.test(mode, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(runTaskPr(f.options), expected);
      assert.deepEqual(f.mutations, { dispatch, update: 0, ready: 0 });
      await assert.rejects(readFile(f.executed));
      if (['dirty-control', 'non-main-control', 'missing-capability'].includes(mode)) {
        assert.equal(f.history.some(call => call.cwd === f.target), false);
        assert.equal(f.events.includes('verify-notice'), false);
      }
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
});

test('task:pr without remote flags retains its local browser-proof path', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.target, '.cake'));
    await writeFile(join(f.target, '.cake/verification.json'), JSON.stringify({ protocol: 'cake-preview-browser/v1',
      source: f.verified.receipt.source, deployment: f.verified.deployment, ...verifyProofFixture(), success: true }));
    await runTaskPr({ cwd: f.target, execute: f.options.execute, log: silent,
      args: ['--title', 'Local QA acceptance', '--changes-file', join(f.control, 'changes.md'), '--verification-file', join(f.control, 'report.md')] });
    assert.deepEqual(f.mutations, { dispatch: 1, update: 1, ready: 1 });
    assert.equal(f.events.includes('capability-read'), false);
    assert.equal(f.events.includes('verify-notice'), false);
    assert.equal(f.verified.calls.includes('actions/runs/123'), false);
    assert.ok(f.body().startsWith(`## 変更内容\n\n${changes}\n\n## Preview\n`));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('draft作成でも変更説明と検証報告を別章へ反映し、タイトルで説明を上書きしない', async () => {
  const f = await fixture(); let createdBody = '', createdPath = '';
  try {
    const execute: WorkflowExecutor = async (command, args, cwd) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return { status: 0, signal: null, stdout: '[]' };
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        assert.ok(args.includes('--draft')); assert.equal(cwd, f.target);
        createdPath = args[args.indexOf('--body-file') + 1]; createdBody = await readFile(createdPath, 'utf8');
        return { status: 0, signal: null, stdout: `https://github.com/${config.repository}/pull/71` };
      }
      return f.options.execute(command, args, cwd);
    };
    assert.deepEqual(await runTaskPr({ cwd: f.target, execute, log: silent,
      args: ['--draft', '--title', '一括操作を改善する', '--changes-file', join(f.control, 'changes.md'), '--verification-file', join(f.control, 'report.md')] }),
    { url: `https://github.com/${config.repository}/pull/71`, existing: false });
    assert.ok(createdBody.startsWith(`## 変更内容\n\n${changes}\n\n## Preview\n`));
    assert.ok(createdBody.includes('未検証。'));
    assert.ok(createdBody.endsWith(`## 検証結果\n\n${(await readFile(join(f.control, 'report.md'), 'utf8')).trim()}\n`));
    assert.deepEqual(f.mutations, { dispatch: 0, update: 0, ready: 0 });
    await assert.rejects(readFile(createdPath));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('変更説明の不足・不正ファイルはGit/GitHub操作より前に拒否する', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cake-task-pr-changes-'));
  try {
    await writeFile(join(directory, 'report.md'), '検証結果');
    await writeFile(join(directory, 'empty.md'), ' \n\t');
    await writeFile(join(directory, 'nul.md'), '変更内容\0');
    await writeFile(join(directory, 'large.md'), 'x'.repeat(1_000_001));
    const base = ['--draft', '--title', '変更内容の説明を改善する', '--verification-file', 'report.md'];
    for (const [name, extra, pattern] of [
      ['引数なし', [], /変更内容ファイル/],
      ...['missing.md', 'empty.md', 'nul.md', 'large.md', '.'].map(file => [file, ['--changes-file', file], /変更内容ファイルを読み込めません/] as const),
      ['重複指定', ['--changes-file', 'empty.md', '--changes-file', 'nul.md'], /--changes-file/],
    ] as const) await t.test(name, async () => {
      let calls = 0;
      await assert.rejects(runTaskPr({ cwd: directory, args: [...base, ...extra], log: silent,
        execute: async () => { calls++; throw new Error('外部操作は許可しない'); } }), pattern);
      assert.equal(calls, 0);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

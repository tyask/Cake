import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskPreview } from "../scripts/task-preview";
import { CAKE_VERCEL_PROJECT, previewRecordPath, type WorkflowExecutor, type WorkflowCommandResult } from "../scripts/task-workflow";

const sha = "a".repeat(40);
const branch = "codex/test-preview";
const url = "https://cake-task-test-fumin1.vercel.app";
const ready = {
  uid: "dpl_ready", url: url.slice("https://".length), source: "git", projectId: CAKE_VERCEL_PROJECT,
  target: null, readyState: "READY", state: "READY", createdAt: 10,
  meta: { githubCommitRef: branch, githubCommitSha: sha, githubCommitOrg: "tyask", githubCommitRepo: "Cake" },
};
const commandResult = (stdout = "", status = 0, signal: NodeJS.Signals | null = null): WorkflowCommandResult => ({ stdout, status, signal });
const listing = (deployments: unknown[]) => commandResult(JSON.stringify({ deployments }));

async function fixture(t: TestContext, outcomes: (WorkflowCommandResult | Error)[] = [listing([ready])]) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-task-preview-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const state = { branch, sha, status: "", origin: "git@github.com:tyask/Cake.git", pushStatus: 0 };
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  let clock = 0;
  const sleeps: number[] = [];
  const execute: WorkflowExecutor = async (command, args, directory) => {
    calls.push({ command, args: [...args], cwd: directory });
    if (command === "git") {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return commandResult(cwd);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return commandResult(state.branch);
      if (args[0] === "status") return commandResult(state.status);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return commandResult(state.sha);
      if (args[0] === "remote") return commandResult(state.origin);
      if (args[0] === "push") return commandResult("", state.pushStatus);
    }
    if (command === "npx") {
      const result = outcomes.shift() ?? listing([]);
      if (result instanceof Error) throw result;
      return result;
    }
    assert.fail(`Unexpected command ${command}: ${args.join(" ")}`);
  };
  return { cwd, state, calls, sleeps, execute, options: { cwd, execute, log: () => {},
    now: () => clock, sleep: async (milliseconds: number) => { sleeps.push(milliseconds); clock += milliseconds; },
    timeoutMs: 50, pollIntervalMs: 10 } };
}

test("cleanなタスクブランチをpushし、Git連携PreviewのREADY後に対応する記録を保存する", async (t) => {
  const f = await fixture(t, [listing([]), listing([{ ...ready, readyState: "BUILDING", state: "BUILDING" }]), listing([ready])]);
  const record = await runTaskPreview(f.options);
  assert.deepEqual(record, { projectId: CAKE_VERCEL_PROJECT, branch, sha, url,
    deploymentId: "dpl_ready", createdAt: "1970-01-01T00:00:00.020Z" });
  assert.deepEqual(JSON.parse(await readFile(previewRecordPath(f.cwd), "utf8")), record);
  const mutations = f.calls.filter((call) => call.command === "git" && call.args[0] === "push");
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].args, ["push", "--set-upstream", "origin", branch]);
  assert.deepEqual(f.sleeps, [10, 10]);
  const polling = f.calls.filter((call) => call.command === "npx");
  assert.equal(polling.length, 3);
  for (const call of polling) {
    assert.ok(call.args.includes("vercel@62.2.0"));
    assert.ok(call.args.some((arg) => arg.includes(`projectId=${CAKE_VERCEL_PROJECT}&sha=${sha}&target=preview`)));
    assert.equal(call.args.includes("deploy"), false);
    assert.equal(call.args.includes("alias"), false);
    assert.equal(call.cwd, f.cwd);
  }
});

test("未コミット変更・main・予約名・別originを検出したらpushしない", async (t) => {
  const f = await fixture(t);
  const cases = [
    { status: " M app.ts", branch, origin: f.state.origin },
    { status: "?? unfinished.ts", branch, origin: f.state.origin },
    { status: "", branch: "main", origin: f.state.origin },
    { status: "", branch: "HEAD", origin: f.state.origin },
    { status: "", branch: "codex/main", origin: f.state.origin },
    { status: "", branch: "codex/test-preview", origin: "https://github.com/other/Cake.git" },
    { status: "", branch: "codex/test-preview", origin: "https://private-token@github.com/tyask/Cake.git" },
  ];
  for (const scenario of cases) {
    Object.assign(f.state, scenario);
    await assert.rejects(() => runTaskPreview(f.options));
  }
  assert.equal(f.calls.some((call) => call.args[0] === "push" || call.command === "npx"), false);
  await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
});

test("追加引数はGit操作を開始する前に拒否する", async (t) => {
  const f = await fixture(t);
  for (const args of [["--prod"], ["--force"], ["--logs"], ["extra"]]) {
    await assert.rejects(() => runTaskPreview({ ...f.options, args }), /追加引数なし/);
  }
  assert.equal(f.calls.length, 0);
});

test("push失敗後はVercelへアクセスせず記録を作成しない", async (t) => {
  const f = await fixture(t);
  f.state.pushStatus = 1;
  await assert.rejects(() => runTaskPreview(f.options), /pushに失敗/);
  assert.equal(f.calls.some((call) => call.command === "npx"), false);
  await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
});

test("同じSHAでもブランチ・project・target・Git source・dirty metadataが異なるDeploymentは採用しない", async (t) => {
  const invalid = [
    { ...ready, meta: { ...ready.meta, githubCommitRef: "codex/another-task" } },
    { ...ready, meta: { ...ready.meta, githubCommitSha: "b".repeat(40) } },
    { ...ready, projectId: "prj_other" },
    { ...ready, target: "production" },
    { ...ready, target: "staging" },
    { ...ready, source: "cli" },
    { ...ready, meta: { ...ready.meta, gitDirty: "1" } },
    { ...ready, meta: null },
  ];
  const f = await fixture(t, [listing(invalid), listing([{ ...ready, target: "preview" }])]);
  const record = await runTaskPreview(f.options);
  assert.equal(record.deploymentId, "dpl_ready");
  assert.deepEqual(f.sleeps, [10]);
});

test("新しい対象Deploymentが失敗していれば古いREADYを採用しない", async (t) => {
  for (const readyState of ["ERROR", "CANCELED", "BLOCKED"]) {
    const f = await fixture(t, [listing([ready, { ...ready, uid: "dpl_latest", createdAt: 20, readyState }])]);
    await mkdir(join(f.cwd, ".cake"));
    await writeFile(previewRecordPath(f.cwd), JSON.stringify({ old: "success" }));
    await assert.rejects(() => runTaskPreview(f.options), new RegExp(readyState));
    assert.equal(f.calls.filter((call) => call.command === "npx").length, 1);
    await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
  }
});

test("不正JSON・不正Deployment情報・API失敗時は秘密値を出さず記録も作成しない", async (t) => {
  const responses = [commandResult("private-invalid-json"), commandResult('{"error":"private-message"}'),
    listing([{ ...ready, uid: "private-invalid-id" }]), listing([{ ...ready, readyState: "unknown" }]),
    commandResult("private-error-output", 1), new Error("private-executor-error")];
  for (const response of responses) {
    const f = await fixture(t, [response]);
    const logs: string[] = [];
    await assert.rejects(() => runTaskPreview({ ...f.options, log: (message) => { logs.push(message); } }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("private-"), false);
      return true;
    });
    assert.equal(logs.join("\n").includes("private-"), false);
    await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
  }
});

test("不正なPreview URLを拒否する", async (t) => {
  const invalid = ["https://example.com", "http://cake-test.vercel.app", "https://private@cake-test.vercel.app",
    "https://cake-test.vercel.app:443", "https://cake-test.vercel.app/path", "https://cake-test.vercel.app?token=secret",
    "https://cake-test.vercel.app#secret", "https://cake-test.vercel.app.evil.example", "cake-test.vercel.app\nprivate-value",
    "https://cake-test.vercel.app@evil.example", null];
  for (const value of invalid) {
    const f = await fixture(t, [listing([{ ...ready, url: value }])]);
    await assert.rejects(() => runTaskPreview(f.options), /Preview URL/);
    await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
  }
});

test("タイムアウト後は停止しPreview記録を作成しない", async (t) => {
  const f = await fixture(t, []);
  await assert.rejects(() => runTaskPreview(f.options), /待機時間内/);
  assert.equal(f.calls.filter((call) => call.command === "npx").length, 5);
  assert.deepEqual(f.sleeps, [10, 10, 10, 10, 10]);
  await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
});

test("待機中にHEADが変わったら成功したPreviewも現在の検証結果として記録しない", async (t) => {
  const f = await fixture(t);
  const execute: WorkflowExecutor = async (command, args, cwd) => {
    const result = await f.execute(command, args, cwd);
    if (command === "npx") f.state.sha = "b".repeat(40);
    return result;
  };
  await assert.rejects(() => runTaskPreview({ ...f.options, execute }), /待機中に/);
  await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
});

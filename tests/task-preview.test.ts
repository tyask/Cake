import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskPreview } from "../scripts/task-preview";
import { QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_TASK, type QaLeaseRecord } from "../lib/qa-pool";
import { CAKE_VERCEL_PROJECT, previewRecordPath, type WorkflowExecutor, type WorkflowCommandResult } from "../scripts/task-workflow";

const sha = "a".repeat(40);
const mainSha = "b".repeat(40);
const gitConfig = { git: { deploymentEnabled: { "**": false, main: true } } };
const contents = (config: unknown = gitConfig) => {
  const bytes = Buffer.from(JSON.stringify(config));
  return { type: "file", name: "vercel.json", path: "vercel.json", encoding: "base64", size: bytes.length,
    sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), content: bytes.toString("base64") };
};
const isLedgerRead = (call: { command: string; args: readonly string[] }) => call.command === "gh" && call.args[0] === "api" && call.args.includes("--paginate");
const branch = "codex/test-preview";
const url = "https://cake-task-test-fumin1.vercel.app";
const payload: QaLeaseRecord = { protocol: "cake-qa/v1", slot: "qa1", leaseId: "00000000-0000-4000-8000-000000000001",
  pr: 42, branch, headSha: sha, state: "held", createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:01:00Z",
  sequence: 1, previousRecordId: null, deployments: [{ id: "dpl_ready", sha, url, phase: "application" }],
  database: { projectId: QA_NEON_PROJECT_ID, branchId: "br-preview", endpointId: "ep-preview", host: "ep-preview.ap-southeast-1.aws.neon.tech" },
  retiredDatabases: [], readyDeploymentId: "dpl_ready", aliasSha: sha };
const initial = { id: 100, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: { ...payload,
  deployments: [], database: undefined, readyDeploymentId: undefined, aliasSha: undefined } };
const ledger = (value = payload) => ({ id: 101, task: QA_TASK, environment: QA_ENVIRONMENT, sha: value.headSha,
  payload: { ...value, sequence: 2, previousRecordId: 100 } });
const commandResult = (stdout = "", status = 0): WorkflowCommandResult => ({ stdout, status, signal: null });
const listing = (records: unknown[]) => commandResult(JSON.stringify([records.length ? [initial, ...records] : []]));
const project = { id: CAKE_VERCEL_PROJECT, name: "cake", accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub",
  previewDeploymentsDisabled: false, link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main" } };

async function fixture(t: TestContext, outcomes: (WorkflowCommandResult | Error)[] = [listing([ledger()])]) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-task-preview-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const state = { branch, sha, status: "", origin: "git@github.com:tyask/Cake.git", pushStatus: 0,
    enabled: commandResult("true"), gate: commandResult("true"), config: commandResult(JSON.stringify(gitConfig)),
    project: commandResult(JSON.stringify(project)),
    main: commandResult(JSON.stringify({ name: "main", commit: { sha: mainSha } })),
    mainConfig: commandResult(JSON.stringify(contents())),
    prs: commandResult(JSON.stringify([{ url: "https://github.com/tyask/Cake/pull/42", number: 42, headRefOid: sha, isDraft: true }])) };
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
      if (args[0] === "show") return state.config;
      if (args[0] === "push") return commandResult("", state.pushStatus);
    }
    if (command === "gh") {
      if (args[0] === "variable") return args[2] === "CAKE_QA_POOL_ENABLED" ? state.enabled : state.gate;
      if (args[0] === "pr" && args[1] === "list") return state.prs;
      if (args[0] === "api") {
        if (args.includes("repos/tyask/Cake/branches/main")) return state.main;
        if (args.includes(`repos/tyask/Cake/contents/vercel.json?ref=${mainSha}`)) return state.mainConfig;
        const result = outcomes.shift() ?? listing([]);
        if (result instanceof Error) throw result;
        return result;
      }
    }
    if (command === "npx") {
      assert.ok(args.includes("api"));
      assert.equal(args[args.indexOf("--method") + 1], "GET");
      return state.project;
    }
    assert.fail(`Unexpected command ${command}: ${args.join(" ")}`);
  };
  return { cwd, state, calls, sleeps, execute, options: { cwd, execute, log: () => {}, now: () => clock,
    sleep: async (milliseconds: number) => { sleeps.push(milliseconds); clock += milliseconds; }, timeoutMs: 50, pollIntervalMs: 10 } };
}

test("有効な固定QAだけを待ち、同じPR/HEADの成功DeploymentとDB貸出証拠を保存する", async (t) => {
  const f = await fixture(t, [listing([]), listing([ledger()])]);
  const record = await runTaskPreview(f.options);
  assert.deepEqual(record, { projectId: CAKE_VERCEL_PROJECT, branch, sha, url, deploymentId: "dpl_ready",
    createdAt: payload.updatedAt, slot: "qa1", leaseId: payload.leaseId, prNumber: 42, ledgerRecordId: 101, database: payload.database });
  assert.deepEqual(JSON.parse(await readFile(previewRecordPath(f.cwd), "utf8")), record);
  assert.deepEqual(f.sleeps, [10]);
  assert.equal(f.calls.filter((c) => c.command === "git" && c.args[0] === "push").length, 1);
  const pushes = f.calls.filter((c) => c.command === "git" && c.args[0] === "push");
  assert.deepEqual(pushes[0].args, ["push", "origin", `${sha}:refs/heads/${branch}`]);
  const polling = f.calls.filter(isLedgerRead);
  assert.equal(polling.length, 2);
  assert.ok(polling.every((c) => c.args.includes("--paginate") && c.args.includes("--slurp")));
  const projectReads = f.calls.filter((c) => c.command === "npx");
  assert.equal(projectReads.length, 1);
  assert.ok(projectReads[0].args.some((arg) => arg.includes(`/v9/projects/${CAKE_VERCEL_PROJECT}`)));
  const mainReads = f.calls.filter((c) => c.command === "gh" && c.args[0] === "api" && !isLedgerRead(c));
  assert.deepEqual(mainReads.map((c) => c.args), [
    ["api", "--method", "GET", "repos/tyask/Cake/branches/main"],
    ["api", "--method", "GET", `repos/tyask/Cake/contents/vercel.json?ref=${mainSha}`],
  ]);
  const configRead = f.calls.findIndex((c) => c.command === "git" && c.args[0] === "show");
  const mainRead = f.calls.findIndex((c) => c.args.includes("repos/tyask/Cake/branches/main"));
  const mainConfigRead = f.calls.findIndex((c) => c.args.includes(`repos/tyask/Cake/contents/vercel.json?ref=${mainSha}`));
  const push = f.calls.findIndex((c) => c.command === "git" && c.args[0] === "push");
  assert.ok(configRead < mainRead && mainRead < mainConfigRead && mainConfigRead < push);
  assert.equal(f.calls.some((c) => c.args.includes("deploy") || c.args.includes("alias") || c.args.includes("workflow")), false);
});

test("未設定/無効/設定照会失敗ではpushやQA台帳APIに入らない", async (t) => {
  for (const enabled of [commandResult("false"), commandResult("TRUE"), commandResult(""), commandResult("private-error", 1)]) {
    const f = await fixture(t);
    f.state.enabled = enabled;
    await assert.rejects(() => runTaskPreview(f.options), /固定QAは未有効/);
    assert.equal(f.calls.some((c) => c.args[0] === "push" || c.args[0] === "api"), false);
  }
});

test("draft PRを作る前はpushせず、枠を取得しない", async (t) => {
  const f = await fixture(t);
  f.state.prs = commandResult("[]");
  await assert.rejects(() => runTaskPreview(f.options), /先にdraft PR/);
  assert.equal(f.calls.some((c) => c.args[0] === "push" || c.args[0] === "api"), false);
});

test("有効化済みでもHEADがGit Previewを再許可する場合やgate未確認ではpushしない", async (t) => {
  for (const unsafe of ["flag", "config", "missing"] as const) {
    const f = await fixture(t);
    if (unsafe === "flag") f.state.gate = commandResult("false");
    if (unsafe === "config") f.state.config = commandResult(JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true, "codex/**": true } } }));
    if (unsafe === "missing") f.state.config = commandResult("{}", 1);
    await assert.rejects(() => runTaskPreview(f.options), /pushを開始しません/);
    assert.equal(f.calls.some((c) => c.args[0] === "push" || c.args[0] === "api"), false);
  }
});

test("ローカル設定と確認flagがあってもproject接続不一致/Preview無効/照会失敗ではpushしない", async (t) => {
  for (const response of [commandResult(JSON.stringify({ ...project, link: undefined })),
    commandResult(JSON.stringify({ ...project, previewDeploymentsDisabled: true })),
    commandResult(JSON.stringify({ ...project, previewDeploymentsDisabled: undefined })),
    commandResult(JSON.stringify({ ...project, link: { ...project.link, productionBranch: "other" } })),
    commandResult("private-api-error", 1)]) {
    const f = await fixture(t);
    f.state.project = response;
    await assert.rejects(() => runTaskPreview(f.options), (error: unknown) => error instanceof Error && !error.message.includes("private-"));
    assert.equal(f.calls.some((c) => c.args[0] === "push" || c.command === "gh" && c.args[0] === "api"), false);
  }
});

test("mainの設定が欠落・不正・読取失敗なら確認flagがtrueでもpushと台帳読取に進まない", async (t) => {
  for (const failure of [commandResult(JSON.stringify(contents({}))),
    commandResult(JSON.stringify(contents({ git: { deploymentEnabled: { "**": false, main: true, "codex/**": true } } }))),
    commandResult(JSON.stringify({ ...contents(), path: "other.json" })),
    commandResult(JSON.stringify({ ...contents(), encoding: "none" })),
    commandResult(JSON.stringify({ ...contents(), size: 1 })),
    commandResult(JSON.stringify({ ...contents(), sha: "c".repeat(40) })),
    commandResult("private-json"), commandResult("private-404", 1), commandResult("private-403", 1)]) {
    const f = await fixture(t);
    f.state.mainConfig = failure;
    await assert.rejects(() => runTaskPreview(f.options),
      (error: unknown) => error instanceof Error && !error.message.includes("private-"));
    assert.equal(f.calls.some((c) => c.args[0] === "push" || isLedgerRead(c)), false);
  }
});

test("main完全SHAの照会失敗はContents取得とpushの前に止める", async (t) => {
  for (const main of [commandResult(JSON.stringify({ name: "other", commit: { sha: mainSha } })),
    commandResult(JSON.stringify({ name: "main", commit: { sha: "short" } })),
    commandResult("private-json"), commandResult("private-403", 1)]) {
    const f = await fixture(t);
    f.state.main = main;
    await assert.rejects(() => runTaskPreview(f.options));
    assert.equal(f.calls.some((c) => c.args.some((arg) => arg.includes("/contents/")) || c.args[0] === "push" || isLedgerRead(c)), false);
  }
});

test("ゲート照会中にHEADが動いても確認済みSHAだけをpushし、新HEADのPreview証拠を保存しない", async (t) => {
  const f = await fixture(t);
  const execute: WorkflowExecutor = async (command, args, cwd) => {
    const result = await f.execute(command, args, cwd);
    if (command === "gh" && args.includes("repos/tyask/Cake/branches/main")) f.state.sha = "c".repeat(40);
    return result;
  };
  await assert.rejects(() => runTaskPreview({ ...f.options, execute }), /待機中に/);
  assert.deepEqual(f.calls.filter((c) => c.command === "git" && c.args[0] === "push").map((c) => c.args),
    [["push", "origin", `${sha}:refs/heads/${branch}`]]);
  await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
});

test("未コミット変更・main・別originでは外部照会やpushを開始しない", async (t) => {
  const f = await fixture(t);
  for (const scenario of [{ status: " M app.ts", branch, origin: f.state.origin },
    { status: "", branch: "main", origin: f.state.origin },
    { status: "", branch, origin: "https://private-token@github.com/tyask/Cake.git" }]) {
    Object.assign(f.state, scenario);
    await assert.rejects(() => runTaskPreview(f.options));
  }
  assert.equal(f.calls.some((c) => c.command === "gh" || c.args[0] === "push"), false);
});

test("追加引数と不正な待機時間はGit操作前に拒否する", async (t) => {
  const f = await fixture(t);
  for (const args of [["--prod"], ["--force"], ["--logs"], ["extra"]]) await assert.rejects(() => runTaskPreview({ ...f.options, args }), /追加引数なし/);
  await assert.rejects(() => runTaskPreview({ ...f.options, timeoutMs: 0 }), /待機時間が不正/);
  assert.equal(f.calls.length, 0);
});

test("新しい試行のpush失敗や満枠待機は古い成功記録を残さない", async (t) => {
  for (const failPush of [true, false]) {
    const f = await fixture(t, []);
    await mkdir(join(f.cwd, ".cake"));
    await writeFile(previewRecordPath(f.cwd), JSON.stringify({ old: "success" }));
    f.state.pushStatus = failPush ? 1 : 0;
    await assert.rejects(() => runTaskPreview(f.options), failPush ? /pushに失敗/ : /待機時間内/);
    await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
    if (failPush) assert.equal(f.calls.some(isLedgerRead), false);
    else assert.equal(f.sleeps.length, 5);
  }
});

test("別PR/枝/SHAやalias未成功の古いDeploymentを採用しない", async (t) => {
  for (const value of [{ ...payload, aliasSha: undefined },
    { ...payload, headSha: "b".repeat(40), aliasSha: "b".repeat(40), deployments: [{ ...payload.deployments[0], sha: "b".repeat(40) }] }]) {
    const f = await fixture(t, [listing([ledger(value)])]);
    await assert.rejects(() => runTaskPreview(f.options), /待機時間内/);
    await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
  }
});

test("最新台帳のdeletingを検出し、旧held READYを使わない", async (t) => {
  const deleting = { id: 102, task: QA_TASK, environment: QA_ENVIRONMENT, sha,
    payload: { ...payload, state: "deleting", readyDeploymentId: undefined, aliasSha: undefined, sequence: 3, previousRecordId: 101 } };
  const f = await fixture(t, [listing([deleting, ledger()])]);
  await assert.rejects(() => runTaskPreview(f.options), /返却処理中/);
  await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
});

test("壊れた台帳/不正URL/API失敗では秘密応答を出さず証拠も残さない", async (t) => {
  for (const result of [commandResult("private-json"), commandResult("private-response", 1),
    listing([ledger({ ...payload, deployments: [{ ...payload.deployments[0], url: "https://evil.example" }] })]),
    listing([{ ...ledger(), sha: "b".repeat(40) }])]) {
    const f = await fixture(t, [result]);
    await assert.rejects(() => runTaskPreview(f.options), (error: unknown) => error instanceof Error && !error.message.includes("private-"));
    await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
  }
});

test("待機中にHEADが変わったら成功したPreviewを記録しない", async (t) => {
  const f = await fixture(t);
  const execute: WorkflowExecutor = async (command, args, cwd) => {
    const result = await f.execute(command, args, cwd);
    if (isLedgerRead({ command, args })) f.state.sha = "b".repeat(40);
    return result;
  };
  await assert.rejects(() => runTaskPreview({ ...f.options, execute }), /待機中に/);
});

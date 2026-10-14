import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskPreview } from "../scripts/task-preview";
import { makeOwnerDecision, makeOwnerPlan, QA_APPROVAL_TASK, QA_APPROVAL_WORKFLOW,
  type OwnerDecisionProvenance } from "../lib/qa-owner-approval";
import { QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_TASK, qaAlias, type QaLeaseRecord } from "../lib/qa-pool";
import { CAKE_VERCEL_PROJECT, previewRecordPath, type WorkflowExecutor, type WorkflowCommandResult, type PreviewProviderReader } from "../scripts/task-workflow";

const sha = "a".repeat(40), mainSha = "b".repeat(40), branch = "codex/test-preview";
const start = Date.parse("2026-10-13T00:00:00Z"), url = "https://cake-task-test-fumin1.vercel.app";
const gitConfig = { git: { deploymentEnabled: { "**": false, main: true } } };
const contents = (config: unknown = gitConfig) => {
  const bytes = Buffer.from(JSON.stringify(config));
  return { type: "file", name: "vercel.json", path: "vercel.json", encoding: "base64", size: bytes.length,
    sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), content: bytes.toString("base64") };
};
const isLedgerRead = (call: { command: string; args: readonly string[] }) => call.command === "gh" && call.args[0] === "api" && call.args.includes("--paginate");
const payload: QaLeaseRecord = { protocol: "cake-qa/v1", slot: "qa1", leaseId: "00000000-0000-4000-8000-000000000001",
  pr: 42, branch, headSha: sha, state: "held", createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:01:00Z",
  sequence: 1, previousRecordId: null, deployments: [{ id: "dpl_ready", sha, url, phase: "application" }],
  database: { projectId: QA_NEON_PROJECT_ID, branchId: "br-preview", endpointId: "ep-preview", host: "ep-preview.mock.aws.neon.tech" },
  retiredDatabases: [], readyDeploymentId: "dpl_ready", aliasSha: sha };
const initial = { id: 100, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: { ...payload,
  deployments: [], database: undefined, readyDeploymentId: undefined, aliasSha: undefined } };
const ledger = (value = payload) => ({ id: 101, task: QA_TASK, environment: QA_ENVIRONMENT, sha: value.headSha,
  payload: { ...value, sequence: 2, previousRecordId: 100 } });
const commandResult = (stdout = "", status = 0): WorkflowCommandResult => ({ stdout, status, signal: null });
const listing = (records: unknown[]) => commandResult(JSON.stringify([records.length ? [initial, ...records] : []]));
const owner = { id: 42, login: "tyask", type: "User" } as const;
const plan = makeOwnerPlan({ action: "preview", projectId: CAKE_VERCEL_PROJECT, pr: 42, branch, sha, slot: "qa1",
  leaseId: payload.leaseId, previousLeaseRecordId: null, deploymentIds: [], alias: qaAlias("qa1"), database: null,
  parentBranchId: "br-parent", runId: 500, runAttempt: 1 }, mainSha, start);
const provenance: OwnerDecisionProvenance = { runId: 501, mainSha, event: "workflow_dispatch", branch: "main",
  path: QA_APPROVAL_WORKFLOW, repository: "tyask/Cake", headRepository: "tyask/Cake", actorId: owner.id, triggeringActorId: owner.id,
  actorType: "User", triggeringActorType: "User", attempt: 1, trustedMain: true,
  binding: { planId: 200, digest: plan.digest, state: "approved" }, status: "completed", conclusion: "success" };
const decision = makeOwnerDecision(200, plan, "approved", provenance, owner, undefined, start + 1);
const event = (id: number, payload: unknown) => ({ id, task: QA_APPROVAL_TASK, environment: QA_ENVIRONMENT, sha, payload,
  creator: { login: "github-actions[bot]", type: "Bot" } });
const project = { id: CAKE_VERCEL_PROJECT, name: "cake", accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub",
  link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main" } };
const run = (id: number) => ({ id, run_attempt: 1, repository: { full_name: "tyask/Cake" }, head_repository: { full_name: "tyask/Cake" },
  path: QA_APPROVAL_WORKFLOW, referenced_workflows: [{ path: `tyask/Cake/.github/workflows/qa-private-run.yml@${mainSha}`, ref: "refs/heads/main", sha: mainSha }],
  event: "workflow_dispatch", head_branch: "main", head_sha: mainSha,
  actor: { id: owner.id, type: "User" }, triggering_actor: { id: owner.id, type: "User" },
  display_title: id === 500 ? "Cake QA request-preview -" : "Cake QA approve 200", status: "completed", conclusion: "success" });

async function fixture(t: TestContext, outcomes: (WorkflowCommandResult | Error)[] = [listing([ledger()])]) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-task-preview-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const state = { branch, sha, status: "", origin: "git@github.com:tyask/Cake.git", pushStatus: 0,
    remote: `${sha}\trefs/heads/${branch}`, dispatch: commandResult(), config: commandResult(JSON.stringify(gitConfig)),
    main: commandResult(JSON.stringify({ name: "main", commit: { sha: mainSha } })), mainConfig: commandResult(JSON.stringify(contents())),
    approval: commandResult(JSON.stringify([event(200, plan), event(201, decision)])), owner: commandResult(JSON.stringify({ full_name: "tyask/Cake", owner })),
    run500: commandResult(JSON.stringify(run(500))), run501: commandResult(JSON.stringify(run(501))),
    prs: commandResult(JSON.stringify([{ url: "https://github.com/tyask/Cake/pull/42", number: 42, headRefOid: sha, isDraft: true }])) };
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [], sleeps: number[] = [], logs: string[] = [], providerCalls: string[] = [];
  let clock = start + 10, lastOutcome: WorkflowCommandResult | Error = listing([]);
  const execute: WorkflowExecutor = async (command, args, directory) => {
    calls.push({ command, args: [...args], cwd: directory });
    if (command === "git") {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return commandResult(cwd);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return commandResult(state.branch);
      if (args[0] === "status") return commandResult(state.status);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return commandResult(state.sha);
      if (args[0] === "rev-parse" && args[1] === `${sha}:vercel.json`) return commandResult(contents().sha);
      if (args[0] === "remote") return commandResult(state.origin);
      if (args[0] === "ls-remote") return commandResult(state.remote);
      if (args[0] === "show") return state.config;
      if (args[0] === "push") return commandResult("", state.pushStatus);
    }
    if (command === "gh") {
      if (args[0] === "workflow") return state.dispatch;
      if (args[0] === "pr" && args[1] === "list") return state.prs;
      if (args[0] === "api") {
        if (args.includes("repos/tyask/Cake/branches/main")) return state.main;
        if (args.includes(`repos/tyask/Cake/contents/vercel.json?ref=${mainSha}`)) return state.mainConfig;
        if (args.includes("repos/tyask/Cake")) return state.owner;
        if (args.some(arg => arg.includes(`?task=${QA_APPROVAL_TASK}&`))) return state.approval;
        if (args.includes("repos/tyask/Cake/actions/runs/500/attempts/1")) return state.run500;
        if (args.includes("repos/tyask/Cake/actions/runs/501/attempts/1")) return state.run501;
        if (args.includes("repos/tyask/Cake/pulls/42")) return commandResult(JSON.stringify({ number: 42, state: "open",
          head: { ref: state.branch, sha: state.sha, repo: { full_name: "tyask/Cake" } }, base: { ref: "main" } }));
        const result = outcomes.shift() ?? lastOutcome; lastOutcome = result;
        if (result instanceof Error) throw result; return result;
      }
    }
    assert.fail(`Unexpected command ${command}: ${args.join(" ")}`);
  };
  const provider: PreviewProviderReader = async (path) => {
    providerCalls.push(path);
    if (path.startsWith("/v9/projects/")) return project;
    if (path.startsWith("/v4/aliases/")) return { projectId: CAKE_VERCEL_PROJECT, deploymentId: "dpl_ready", alias: qaAlias("qa1"), uid: "mock_alias" };
    if (path.startsWith("/v13/deployments/")) return { id: "dpl_ready", projectId: CAKE_VERCEL_PROJECT, target: "preview", readyState: "READY", url,
      gitSource: { ref: branch, sha }, meta: { githubCommitRef: branch, githubCommitSha: sha, cakeQaPr: "42", cakeQaLeaseId: payload.leaseId, cakeQaPhase: "application" } };
    assert.fail("Unexpected provider mock path");
  };
  return { cwd, state, calls, sleeps, logs, providerCalls, execute, options: { cwd, execute, log: (message: string) => { logs.push(message); }, now: () => clock,
    provider, sleep: async (milliseconds: number) => { sleeps.push(milliseconds); clock += milliseconds; }, timeoutMs: 50, pollIntervalMs: 10 } };
}

test("承認済みHEADだけをtrusted mainへ要求し、live固定URLを主表示して固有URLを診断証跡へ保存する", async t => {
  const f = await fixture(t, [listing([]), listing([ledger()])]);
  const record = await runTaskPreview(f.options);
  assert.deepEqual(record, { projectId: CAKE_VERCEL_PROJECT, branch, sha, url, fixedUrl: `https://${qaAlias("qa1")}`, deploymentId: "dpl_ready",
    createdAt: payload.updatedAt, slot: "qa1", leaseId: payload.leaseId, prNumber: 42, ledgerRecordId: 101, database: payload.database });
  assert.deepEqual(JSON.parse(await readFile(previewRecordPath(f.cwd), "utf8")), record); assert.deepEqual(f.sleeps, [10]);
  assert.deepEqual(f.calls.filter(c => c.args[0] === "push").map(c => c.args), [["push", "origin", `${sha}:refs/heads/${branch}`]]);
  const dispatches = f.calls.filter(c => c.args[0] === "workflow");
  assert.deepEqual(dispatches.map(c => c.args), [["workflow", "run", "qa-pool.yml", "--repo", "tyask/Cake", "--ref", "main",
    "-f", "action=request-preview", "-f", "pr_number=42", "-f", `source_sha=${sha}`]]);
  assert.equal(f.calls.filter(isLedgerRead).length, 3);
  for (const id of [500, 501]) assert.equal(f.calls.filter(c => c.args.includes(`repos/tyask/Cake/actions/runs/${id}/attempts/1`)).length, 1);
  assert.equal(f.calls.some(c => c.command === "npx" || c.args[0] === "variable" || c.args.includes("deploy") || c.args.includes("alias")), false);
  assert.ok(f.calls.filter(c => c.args[0] === "api" && !isLedgerRead(c)).every(c => c.args[c.args.indexOf("--method") + 1] === "GET"));
  const ready = f.logs.findIndex(message => message.includes(`READY: https://${qaAlias("qa1")}`)), diagnostic = f.logs.findIndex(message => message.includes(`診断用Deployment URL: ${url}`));
  assert.ok(ready >= 0 && ready < diagnostic); assert.equal(f.logs.some(message => message.includes(payload.database!.host)), false);
});

test("未承認ではsmall plan IDだけ案内し、providerや資源操作に入らずWAIT_APPROVALで終える", async t => {
  const f = await fixture(t); f.state.approval = commandResult(JSON.stringify([event(200, plan)]));
  await mkdir(join(f.cwd, ".cake")); await writeFile(previewRecordPath(f.cwd), "old-success");
  assert.deepEqual(await runTaskPreview(f.options), { status: "WAIT_APPROVAL", planId: 200, workflowUrl: "https://github.com/tyask/Cake/actions/runs/500" });
  assert.equal(f.providerCalls.length, 0); assert.equal(f.calls.some(isLedgerRead), false); assert.equal(f.sleeps.length, 0);
  assert.ok(f.logs.some(message => message.includes("npm run qa:approve -- --plan-id 200")));
  assert.equal(f.logs.some(message => message.includes(plan.digest) || message.includes("\"protocol\"") || message.includes(payload.database!.host)), false);
  await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
});

test("旧head承認・cleanup計画・未完了または失敗した本人承認runは新HEADのREADYを許可しない", async t => {
  for (const scenario of ["old-head", "cleanup", "unfinished", "failed"] as const) {
    const f = await fixture(t);
    if (scenario === "old-head" || scenario === "cleanup") {
      const changed = { ...plan, sha: scenario === "old-head" ? "c".repeat(40) : sha, action: scenario === "cleanup" ? "cleanup" : "preview",
        maximumNewDeployments: scenario === "cleanup" ? 0 : 2, maximumNewDatabases: scenario === "cleanup" ? 0 : 1 };
      f.state.approval = commandResult(JSON.stringify([{ ...event(200, changed), sha: changed.sha }]));
      await assert.rejects(() => runTaskPreview(f.options), /待機時間内/);
    } else {
      f.state.run501 = commandResult(JSON.stringify({ ...run(501), status: scenario === "unfinished" ? "in_progress" : "completed",
        conclusion: scenario === "unfinished" ? null : "failure" }));
      assert.deepEqual(await runTaskPreview(f.options), { status: "WAIT_APPROVAL", planId: 200, workflowUrl: "https://github.com/tyask/Cake/actions/runs/500" });
    }
    assert.equal(f.providerCalls.length, 0); await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
  }
});

test("偽造creator・非本人actor・別main reusable source・破損承認では固定URLを提示しない", async t => {
  for (const scenario of ["creator", "actor", "source", "json"] as const) {
    const f = await fixture(t);
    if (scenario === "creator") f.state.approval = commandResult(JSON.stringify([{ ...event(200, plan), creator: { login: "tyask", type: "User" } }]));
    if (scenario === "actor") f.state.run501 = commandResult(JSON.stringify({ ...run(501), actor: { id: 99, type: "User" } }));
    if (scenario === "source") f.state.run500 = commandResult(JSON.stringify({ ...run(500), referenced_workflows: [] }));
    if (scenario === "json") f.state.approval = commandResult("PRIVATE_APPROVAL_JSON");
    await assert.rejects(() => runTaskPreview(f.options), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE_"));
    assert.equal(f.providerCalls.length, 0); await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
  }
});

test("draft PRを作る前はpushせず、枠を取得しない", async t => {
  const f = await fixture(t); f.state.prs = commandResult("[]");
  await assert.rejects(() => runTaskPreview(f.options), /先にdraft PR/);
  assert.equal(f.calls.some(c => c.args[0] === "push" || c.args[0] === "api" || c.args[0] === "workflow"), false);
});

test("HEADのGit自動Preview停止が欠落・再許可・読取失敗ならpushしない", async t => {
  for (const unsafe of [commandResult("{}"), commandResult(JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true, "codex/**": true } } })), commandResult("PRIVATE_CONFIG", 1)]) {
    const f = await fixture(t); f.state.config = unsafe;
    await assert.rejects(() => runTaskPreview(f.options), /pushを開始しません/);
    assert.equal(f.calls.some(c => c.args[0] === "push" || c.args[0] === "api" || c.args[0] === "workflow"), false);
  }
});

test("mainの停止設定が欠落・不正・読取失敗ならpushと承認計画要求を行わない", async t => {
  for (const failure of [commandResult(JSON.stringify(contents({}))),
    commandResult(JSON.stringify(contents({ git: { deploymentEnabled: { "**": false, main: true, "codex/**": true } } }))),
    commandResult(JSON.stringify({ ...contents(), path: "other.json" })), commandResult(JSON.stringify({ ...contents(), encoding: "none" })),
    commandResult(JSON.stringify({ ...contents(), size: 1 })), commandResult(JSON.stringify({ ...contents(), sha: "c".repeat(40) })),
    commandResult("PRIVATE_JSON"), commandResult("PRIVATE_404", 1), commandResult("PRIVATE_403", 1)]) {
    const f = await fixture(t); f.state.mainConfig = failure;
    await assert.rejects(() => runTaskPreview(f.options), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE_"));
    assert.equal(f.calls.some(c => c.args[0] === "push" || c.args[0] === "workflow" || isLedgerRead(c)), false);
  }
});

test("main完全SHAの照会失敗はContents取得とpushの前に止める", async t => {
  for (const main of [commandResult(JSON.stringify({ name: "other", commit: { sha: mainSha } })),
    commandResult(JSON.stringify({ name: "main", commit: { sha: "short" } })), commandResult("PRIVATE_JSON"), commandResult("PRIVATE_403", 1)]) {
    const f = await fixture(t); f.state.main = main; await assert.rejects(() => runTaskPreview(f.options));
    assert.equal(f.calls.some(c => c.args.some(arg => arg.includes("/contents/")) || c.args[0] === "push" || isLedgerRead(c)), false);
  }
});

test("push後remote/PR/local HEADが違えばmain writerを要求しない", async t => {
  for (const changed of ["remote", "pr", "local"] as const) {
    const f = await fixture(t);
    if (changed === "remote") f.state.remote = `${"c".repeat(40)}\trefs/heads/${branch}`;
    const execute: WorkflowExecutor = async (command, args, cwd) => {
      const result = await f.execute(command, args, cwd);
      if (args[0] === "push") {
        if (changed === "pr") f.state.prs = commandResult(JSON.stringify([{ url: "https://github.com/tyask/Cake/pull/42", number: 42, headRefOid: "c".repeat(40), isDraft: true }]));
        if (changed === "local") f.state.sha = "c".repeat(40);
      }
      return result;
    };
    await assert.rejects(() => runTaskPreview({ ...f.options, execute }), /HEAD|コミット/);
    assert.equal(f.calls.filter(c => c.args[0] === "push").length, 1); assert.equal(f.calls.some(c => c.args[0] === "workflow"), false);
    await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
  }
});

test("未コミット変更・main・別originでは外部照会やpushを開始しない", async t => {
  const f = await fixture(t);
  for (const scenario of [{ status: " M app.ts", branch, origin: f.state.origin }, { status: "", branch: "main", origin: f.state.origin },
    { status: "", branch, origin: "https://PRIVATE_TOKEN@github.com/tyask/Cake.git" }]) {
    Object.assign(f.state, scenario); await assert.rejects(() => runTaskPreview(f.options));
  }
  assert.equal(f.calls.some(c => c.command === "gh" || c.args[0] === "push"), false);
});

test("追加引数と不正な待機時間はGit操作前に拒否する", async t => {
  const f = await fixture(t);
  for (const args of [["--prod"], ["--force"], ["--logs"], ["extra"]]) await assert.rejects(() => runTaskPreview({ ...f.options, args }), /追加引数なし/);
  await assert.rejects(() => runTaskPreview({ ...f.options, timeoutMs: 0 }), /待機時間が不正/); assert.equal(f.calls.length, 0);
});

test("push失敗・dispatch失敗・満枠待機は古い成功記録を残さない", async t => {
  for (const failure of ["push", "dispatch", "full"] as const) {
    const f = await fixture(t, []); await mkdir(join(f.cwd, ".cake")); await writeFile(previewRecordPath(f.cwd), "old-success");
    if (failure === "push") f.state.pushStatus = 1;
    if (failure === "dispatch") f.state.dispatch = commandResult("PRIVATE_BODY", 1);
    if (failure === "full") f.state.approval = commandResult("[]");
    await assert.rejects(() => runTaskPreview(f.options), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE_"));
    await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
    assert.equal(f.providerCalls.length, 0); if (failure === "full") assert.equal(f.sleeps.length, 5);
  }
});

test("別SHAやalias未成功の古いDeploymentを採用しない", async t => {
  for (const value of [{ ...payload, aliasSha: undefined }, { ...payload, headSha: "b".repeat(40), aliasSha: "b".repeat(40), deployments: [{ ...payload.deployments[0], sha: "b".repeat(40) }] }]) {
    const f = await fixture(t, [listing([ledger(value)])]); await assert.rejects(() => runTaskPreview(f.options), /待機時間内/);
    await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/); assert.equal(f.providerCalls.length, 0);
  }
});

test("最新台帳のdeletingを検出し、旧held READYを使わない", async t => {
  const deleting = { id: 102, task: QA_TASK, environment: QA_ENVIRONMENT, sha,
    payload: { ...payload, state: "deleting", readyDeploymentId: undefined, aliasSha: undefined, sequence: 3, previousRecordId: 101 } };
  const f = await fixture(t, [listing([deleting, ledger()])]); await assert.rejects(() => runTaskPreview(f.options), /返却処理中/);
  await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
});

test("壊れた台帳/不正URL/API失敗では秘密応答を出さず証拠も残さない", async t => {
  for (const result of [commandResult("PRIVATE_JSON"), commandResult("PRIVATE_RESPONSE", 1),
    listing([ledger({ ...payload, deployments: [{ ...payload.deployments[0], url: "https://evil.example" }] })]), listing([{ ...ledger(), sha: "b".repeat(40) }])]) {
    const f = await fixture(t, [result]);
    await assert.rejects(() => runTaskPreview(f.options), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE_"));
    await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
  }
});

test("待機中のHEAD変更と承認main変更を検出して成功証拠を保存しない", async t => {
  for (const changed of ["head", "main"] as const) {
    const f = await fixture(t);
    const execute: WorkflowExecutor = async (command, args, cwd) => {
      const result = await f.execute(command, args, cwd);
      if (args[0] === "workflow" && changed === "main") f.state.main = commandResult(JSON.stringify({ name: "main", commit: { sha: "c".repeat(40) } }));
      if (isLedgerRead({ command, args }) && changed === "head") f.state.sha = "c".repeat(40);
      return result;
    };
    await assert.rejects(() => runTaskPreview({ ...f.options, execute })); await assert.rejects(() => readFile(previewRecordPath(f.cwd)), /ENOENT/);
  }
});

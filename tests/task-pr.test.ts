import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskPr } from "../scripts/task-pr";
import { QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_TASK, type QaLeaseRecord } from "../lib/qa-pool";
import { CAKE_VERCEL_PROJECT, previewRecordPath, type TaskPreviewRecord, type WorkflowExecutor, type WorkflowCommandResult } from "../scripts/task-workflow";

const branch = "codex/test-pr";
const sha = "a".repeat(40);
const prUrl = "https://github.com/tyask/Cake/pull/42";
const preview: TaskPreviewRecord = { projectId: CAKE_VERCEL_PROJECT, branch, sha,
  url: "https://cake-pr-test-fumin1.vercel.app", deploymentId: "dpl_preview", createdAt: "2026-10-12T00:01:00Z",
  slot: "qa1", leaseId: "00000000-0000-4000-8000-000000000001", prNumber: 42, ledgerRecordId: 101,
  database: { projectId: QA_NEON_PROJECT_ID, branchId: "br-preview", endpointId: "ep-preview", host: "ep-preview.ap-southeast-1.aws.neon.tech" } };
const payload: QaLeaseRecord = { protocol: "cake-qa/v1", slot: "qa1", leaseId: preview.leaseId, pr: 42, branch, headSha: sha,
  state: "held", createdAt: "2026-10-12T00:00:00Z", updatedAt: preview.createdAt, sequence: 1, previousRecordId: null,
  deployments: [{ id: preview.deploymentId, sha, url: preview.url, phase: "application" }], retiredDatabases: [],
  database: { ...preview.database, projectId: QA_NEON_PROJECT_ID }, readyDeploymentId: preview.deploymentId, aliasSha: sha };
const initial = { id: 100, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: { ...payload,
  deployments: [], database: undefined, readyDeploymentId: undefined, aliasSha: undefined } };
const ledger = (value = payload) => ({ id: 101, task: QA_TASK, environment: QA_ENVIRONMENT, sha: value.headSha,
  payload: { ...value, sequence: 2, previousRecordId: 100 } });
const commandResult = (stdout = "", status = 0): WorkflowCommandResult => ({ stdout, status, signal: null });
const listedPr = (isDraft = true) => commandResult(JSON.stringify([{ url: prUrl, number: 42, headRefOid: sha, isDraft }]));

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-task-pr-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".cake"));
  await writeFile(previewRecordPath(cwd), JSON.stringify(preview));
  const reportFile = join(cwd, ".cake/verification.md");
  await writeFile(reportFile, "- lint・test・build 成功\n- PreviewでA・B認証とAPIを確認\n");
  const state = { branch, sha, status: "", origin: "https://github.com/tyask/Cake.git", remote: `${sha}\trefs/heads/${branch}`,
    listed: listedPr(), ledger: commandResult(JSON.stringify([[initial, ledger()]])), created: commandResult(prUrl),
    edited: commandResult(), gate: commandResult("true"), config: commandResult(JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true } } })),
    pushStatus: 0, pushUpdates: true, body: "", bodyFile: "" };
  const calls: { command: string; args: readonly string[] }[] = [];
  const execute: WorkflowExecutor = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "git") {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return commandResult(cwd);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return commandResult(state.branch);
      if (args[0] === "status") return commandResult(state.status);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return commandResult(state.sha);
      if (args[0] === "remote") return commandResult(state.origin);
      if (args[0] === "ls-remote") return commandResult(state.remote);
      if (args[0] === "show") return state.config;
      if (args[0] === "push") {
        if (state.pushStatus === 0 && state.pushUpdates) state.remote = `${state.sha}\trefs/heads/${state.branch}`;
        return commandResult("", state.pushStatus);
      }
    }
    if (command === "gh" && args[0] === "variable") return state.gate;
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return state.listed;
    if (command === "gh" && args[0] === "api") return state.ledger;
    if (command === "gh" && args[0] === "pr" && ["create", "edit"].includes(args[1])) {
      const index = args.indexOf("--body-file");
      assert.notEqual(index, -1);
      state.bodyFile = args[index + 1];
      state.body = await readFile(state.bodyFile, "utf8");
      return args[1] === "create" ? state.created : state.edited;
    }
    assert.fail(`Unexpected command ${command}: ${args.join(" ")}`);
  };
  return { cwd, reportFile, state, calls, execute,
    options: { cwd, execute, log: () => {}, args: ["--title", "固定QAの入口を整備", "--verification-file", reportFile] } };
}

test("同じPR/HEADとlive貸出の検証証拠で既存draft本文を更新し、ready/merge操作はしない", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await runTaskPr(f.options), { url: prUrl, existing: true });
  for (const value of [preview.url, sha, preview.leaseId, preview.database.projectId, preview.database.branchId, preview.database.endpointId]) {
    assert.ok(f.state.body.includes(value));
  }
  assert.match(f.state.body, /QA枠: `qa1` \/ PR #42/);
  assert.match(f.state.body, /台帳Deployment: `101`/);
  assert.match(f.state.body, /lint・test・build 成功\n- PreviewでA・B認証/);
  assert.equal(f.calls.filter((c) => c.args[1] === "edit").length, 1);
  assert.equal(f.calls.some((c) => c.args.includes("ready") || c.args.includes("merge") || c.args.includes("--auto") || c.args.includes("--body")), false);
  await assert.rejects(() => readFile(f.state.bodyFile), /ENOENT/);
});

test("Preview未実施でも--draftでPRを作成し、未検証を本文へ明記する", async (t) => {
  const f = await fixture(t);
  await rm(previewRecordPath(f.cwd));
  f.state.listed = commandResult("[]");
  assert.deepEqual(await runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] }), { url: prUrl, existing: false });
  const created = f.calls.find((c) => c.args[1] === "create")!;
  assert.ok(created.args.includes("--draft"));
  assert.match(f.state.body, /未検証/);
  assert.ok(f.state.body.includes(sha));
  assert.equal(f.state.body.includes(preview.url), false);
  assert.equal(f.calls.some((c) => c.command === "npx" || c.args[0] === "api" || c.args[0] === "push"), false);
});

test("初回draftは運用者確認とコミット済み全枝denyを確認してpushし、remote HEAD確認後だけ作成する", async (t) => {
  const f = await fixture(t);
  f.state.remote = "";
  f.state.listed = commandResult("[]");
  await rm(previewRecordPath(f.cwd));
  assert.deepEqual(await runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] }), { url: prUrl, existing: false });
  const gate = f.calls.findIndex((c) => c.command === "gh" && c.args[0] === "variable");
  const config = f.calls.findIndex((c) => c.command === "git" && c.args[0] === "show");
  const push = f.calls.findIndex((c) => c.command === "git" && c.args[0] === "push");
  const create = f.calls.findIndex((c) => c.args[1] === "create");
  assert.ok(gate < config && config < push && push < create);
  assert.deepEqual(f.calls[config].args, ["show", `${sha}:vercel.json`]);
  assert.equal(f.calls.filter((c) => c.args[0] === "ls-remote").length, 2);
  assert.equal(f.calls.some((c) => c.command === "npx" || c.args[0] === "api"), false);
});

test("draftの未push HEADはgate未確認/不正config/push失敗/remote不一致ならPRを作成しない", async (t) => {
  for (const failure of ["unconfirmed", "config", "push", "remote"] as const) {
    const f = await fixture(t);
    f.state.remote = "";
    f.state.listed = commandResult("[]");
    if (failure === "unconfirmed") f.state.gate = commandResult("false");
    if (failure === "config") f.state.config = commandResult(JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true, qa1: true } } }));
    if (failure === "push") f.state.pushStatus = 1;
    if (failure === "remote") f.state.pushUpdates = false;
    await assert.rejects(() => runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] }));
    assert.equal(f.calls.some((c) => c.args[1] === "create" || c.args[1] === "edit"), false);
    if (["unconfirmed", "config"].includes(failure)) assert.equal(f.calls.some((c) => c.args[0] === "push"), false);
  }
});

test("--draftは既存draftの本文を更新でき、既存ready PRは未検証本文へ変更しない", async (t) => {
  const f = await fixture(t);
  await runTaskPr({ ...f.options, args: ["--draft", ...f.options.args] });
  assert.equal(f.calls.filter((c) => c.args[1] === "edit").length, 1);
  assert.match(f.state.body, /未検証/);
  f.state.listed = listedPr(false);
  await assert.rejects(() => runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] }), /既存PRはdraftではありません/);
  assert.equal(f.calls.filter((c) => c.args[1] === "edit").length, 1);
});

test("追加・重複・不足引数と不正タイトルをGit操作前に拒否する", async (t) => {
  const f = await fixture(t);
  for (const args of [[], ["--title", "title"], ["--verification-file", f.reportFile],
    [...f.options.args, "--auto"], [...f.options.args, "--draft", "--draft"],
    ["--title", "line\nbreak", "--verification-file", f.reportFile],
    ["--title", "x".repeat(241), "--verification-file", f.reportFile]]) await assert.rejects(() => runTaskPr({ ...f.options, args }));
  assert.equal(f.calls.length, 0);
});

test("mainや未コミット変更、空の検証報告、未push HEADではPRを書き換えない", async (t) => {
  const f = await fixture(t);
  f.state.branch = "main";
  await assert.rejects(() => runTaskPr(f.options), /タスク専用/);
  f.state.branch = branch;
  f.state.status = " M app.ts";
  await assert.rejects(() => runTaskPr(f.options), /未コミット変更/);
  f.state.status = "";
  f.state.remote = `${"b".repeat(40)}\trefs/heads/${branch}`;
  await assert.rejects(() => runTaskPr(f.options), /originのブランチ/);
  await writeFile(f.reportFile, " ");
  await assert.rejects(() => runTaskPr(f.options), /検証結果ファイル/);
  assert.equal(f.calls.some((c) => c.args[1] === "edit" || c.args[1] === "create"), false);
});

test("旧形式/壊れた/別SHAのローカルPreview証拠ではPRを更新しない", async (t) => {
  const f = await fixture(t);
  for (const record of ["private-invalid-json", JSON.stringify({ ...preview, leaseId: undefined }),
    JSON.stringify({ ...preview, projectId: "prj_other" }), JSON.stringify({ ...preview, sha: "b".repeat(40) }),
    JSON.stringify({ ...preview, prNumber: 43 }), JSON.stringify({ ...preview, url: "https://evil.example" })]) {
    await writeFile(previewRecordPath(f.cwd), record);
    await assert.rejects(() => runTaskPr(f.options));
  }
  assert.equal(f.calls.some((c) => c.args[1] === "edit" || c.args[1] === "create"), false);
});

test("返却/他lease/別Deployment/別DBへ変わった枠はローカル証拠があっても拒否する", async (t) => {
  const f = await fixture(t);
  for (const value of [{ ...payload, state: "deleting" as const, readyDeploymentId: undefined, aliasSha: undefined },
    { ...payload, leaseId: "00000000-0000-4000-8000-000000000002" },
    { ...payload, readyDeploymentId: "dpl_other", deployments: [{ id: "dpl_other", sha, url: preview.url, phase: "application" as const }] },
    { ...payload, database: { ...payload.database!, branchId: "br-other" } },
    { ...payload, aliasSha: "b".repeat(40) }]) {
    const records = value.state === "deleting" ? [initial, ledger(), { ...ledger(value), id: 102, payload: { ...value, sequence: 3, previousRecordId: 101 } }] : [initial, ledger(value)];
    f.state.ledger = commandResult(JSON.stringify([records]));
    await assert.rejects(() => runTaskPr(f.options));
  }
  assert.equal(f.calls.some((c) => c.args[1] === "edit" || c.args[1] === "create"), false);
});

test("paginationした最新snapshotを採用し、同じ貸出/Deployment/DBのrefreshは証拠を失効させない", async (t) => {
  const f = await fixture(t);
  const next = { ...ledger(), id: 102, payload: { ...payload, sequence: 3, previousRecordId: 101, updatedAt: "2026-10-12T00:02:00Z" } };
  f.state.ledger = commandResult(JSON.stringify([[next], [initial, ledger()]]));
  assert.deepEqual(await runTaskPr(f.options), { url: prUrl, existing: true });
});

test("不正/重複PRと照会失敗では秘密応答を出さず書込を継続しない", async (t) => {
  const f = await fixture(t);
  for (const listed of [commandResult("private-json"), commandResult("private-api-error", 1),
    commandResult(JSON.stringify([{ url: prUrl, number: 42, headRefOid: "b".repeat(40), isDraft: true }])),
    commandResult(JSON.stringify([{ url: prUrl, number: 43, headRefOid: sha, isDraft: true }]))]) {
    f.state.listed = listed;
    await assert.rejects(() => runTaskPr(f.options), (error: unknown) => error instanceof Error && !error.message.includes("private-"));
  }
  assert.equal(f.calls.some((c) => c.args[1] === "edit" || c.args[1] === "create"), false);
});

test("PR更新/作成失敗時も本文の一時ファイルを削除し後続の書込を行わない", async (t) => {
  for (const draft of [false, true]) {
    const f = await fixture(t);
    f.state.edited = commandResult("private-error", 1);
    if (draft) { f.state.listed = commandResult("[]"); f.state.created = commandResult("private-error", 1); }
    await assert.rejects(() => runTaskPr({ ...f.options, args: [...f.options.args, ...(draft ? ["--draft"] : [])] }),
      (error: unknown) => error instanceof Error && !error.message.includes("private-"));
    await assert.rejects(() => readFile(f.state.bodyFile), /ENOENT/);
    assert.equal(f.calls.filter((c) => c.args[1] === "edit" || c.args[1] === "create").length, 1);
  }
});

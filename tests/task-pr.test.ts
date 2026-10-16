import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskPr } from "../scripts/task-pr";
import { QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_TASK, type QaLeaseRecord } from "../lib/qa-pool";
import { CAKE_VERCEL_PROJECT, previewRecordPath, type TaskPreviewRecord, type WorkflowExecutor, type WorkflowCommandResult, type PreviewProviderReader } from "../scripts/task-workflow";
import manifest from "../docs/cannele/resource-manifest.json";

const branch = "codex/test-pr";
const sha = "a".repeat(40);
const mainSha = "b".repeat(40);
const gitConfig = { git: { deploymentEnabled: { "**": false, main: true } } };
const contents = (config: unknown = gitConfig) => {
  const bytes = Buffer.from(JSON.stringify(config));
  return { type: "file", name: "vercel.json", path: "vercel.json", encoding: "base64", size: bytes.length,
    sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), content: bytes.toString("base64") };
};
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
const isPatch = (call: { command: string; args: readonly string[] }) => call.command === "gh" && call.args[0] === "api" && call.args.includes("PATCH");
const project = { id: CAKE_VERCEL_PROJECT, name: "cake", accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub",
  previewDeploymentsDisabled: false, link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main" } };

async function fixture(t: TestContext, currentBranch = branch) {
  const branch = currentBranch;
  const cwd = await mkdtemp(join(tmpdir(), "cake-task-pr-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".cake"));
  await writeFile(previewRecordPath(cwd), JSON.stringify(preview));
  const reportFile = join(cwd, ".cake/verification.md");
  await writeFile(reportFile, "- lint・test・build 成功\n- PreviewでA・B認証とAPIを確認\n");
  const state = { branch, sha, status: "", origin: "https://github.com/tyask/Cake.git", remote: `${sha}\trefs/heads/${branch}`,
    listed: listedPr(), ledger: commandResult(JSON.stringify([[initial, ledger()]])), created: commandResult(prUrl),
    edited: commandResult(), gate: commandResult("true"), config: commandResult(JSON.stringify(gitConfig)),
    project: commandResult(JSON.stringify(project)),
    main: commandResult(JSON.stringify({ name: "main", commit: { sha: mainSha } })),
    mainConfig: commandResult(JSON.stringify(contents())),
    blob: commandResult(contents().sha), pushStatus: 0, pushUpdates: true, body: "", bodyFile: "" };
  const calls: { command: string; args: readonly string[] }[] = [];
  const execute: WorkflowExecutor = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "git") {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return commandResult(cwd);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return commandResult(state.branch);
      if (args[0] === "status") return commandResult(state.status);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return commandResult(state.sha);
      if (args[0] === "rev-parse" && args[1] === `${sha}:vercel.json`) return state.blob;
      if (args[0] === "remote") return commandResult(state.origin);
      if (args[0] === "ls-remote") return commandResult(state.remote);
      if (args[0] === "show") return state.config;
      if (args[0] === "push") {
        if (state.pushStatus === 0 && state.pushUpdates) {
          const [pushedSha, pushedRef] = args[2].split(":");
          state.remote = `${pushedSha}\t${pushedRef}`;
        }
        return commandResult("", state.pushStatus);
      }
    }
    if (command === "gh" && args[0] === "variable") return state.gate;
    if (command === "npx") {
      assert.ok(args.includes("api"));
      assert.equal(args[args.indexOf("--method") + 1], "GET");
      return state.project;
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return state.listed;
    if (command === "gh" && args[0] === "api") {
      if (args.includes("PATCH") && args.includes("repos/tyask/Cake/pulls/42")) {
        state.bodyFile = args[args.indexOf("--input") + 1];
        assert.equal((await stat(state.bodyFile)).mode & 0o777, 0o600);
        const value = JSON.parse(await readFile(state.bodyFile, "utf8"));
        assert.deepEqual(Object.keys(value).sort(), ["body", "title"]);
        state.body = value.body;
        return state.edited.status === 0 ? commandResult(JSON.stringify({ number: 42, html_url: prUrl, state: "open", title: value.title, body: value.body,
          head: { ref: branch, sha, repo: { full_name: "tyask/Cake" } }, base: { ref: "main", repo: { full_name: "tyask/Cake" } } })) : state.edited;
      }
      if (args.includes("repos/tyask/Cake/branches/main")) return state.main;
      if (args.includes(`repos/tyask/Cake/contents/vercel.json?ref=${mainSha}`)) return state.mainConfig;
      if (args.includes("repos/tyask/Cake/pulls/42")) return commandResult(JSON.stringify({ number: 42, state: "open",
        head: { ref: state.branch, sha: state.sha, repo: { full_name: "tyask/Cake" } }, base: { ref: "main" } }));
      return state.ledger;
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      const index = args.indexOf("--body-file");
      assert.notEqual(index, -1);
      state.bodyFile = args[index + 1];
      state.body = await readFile(state.bodyFile, "utf8");
      return state.created;
    }
    assert.fail(`Unexpected command ${command}: ${args.join(" ")}`);
  };
  const provider: PreviewProviderReader = async (path) => {
    if (path.startsWith("/v9/projects/")) return project;
    if (path.startsWith("/v4/aliases/")) return { projectId: CAKE_VERCEL_PROJECT, deploymentId: preview.deploymentId,
      alias: "cake-qa1-fumin.vercel.app", uid: "mock_alias" };
    if (path.startsWith("/v13/deployments/")) return { id: preview.deploymentId, projectId: CAKE_VERCEL_PROJECT, target: "preview", readyState: "READY", url: preview.url,
      gitSource: { ref: branch, sha }, meta: { githubCommitRef: branch, githubCommitSha: sha, cakeQaPr: "42", cakeQaLeaseId: preview.leaseId, cakeQaPhase: "application" } };
    assert.fail("Unexpected provider mock path");
  };
  return { cwd, reportFile, state, calls, execute,
    options: { cwd, execute, provider, log: () => {}, args: ["--title", "固定QAの入口を整備", "--verification-file", reportFile] } };
}

test("同じPR/HEADとlive貸出の検証証拠で既存draft本文を更新し、ready/merge操作はしない", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await runTaskPr(f.options), { url: prUrl, existing: true });
  for (const value of [preview.url, sha, preview.leaseId, preview.database.projectId, preview.database.branchId, preview.database.endpointId]) {
    assert.ok(f.state.body.includes(value));
  }
  assert.match(f.state.body, /QA枠: `qa1` \/ PR #42/);
  assert.ok(f.state.body.indexOf("固定QA URL: https://cake-qa1-fumin.vercel.app") < f.state.body.indexOf(`診断用Deployment URL: ${preview.url}`));
  assert.equal(f.state.body.includes(preview.database.host), false);
  assert.match(f.state.body, /台帳Deployment: `101`/);
  assert.match(f.state.body, /lint・test・build 成功\n- PreviewでA・B認証/);
  assert.equal(f.calls.filter(isPatch).length, 1);
  assert.equal(f.calls.some((c) => c.args[1] === "edit"), false);
  assert.equal(f.calls.some((c) => c.args.includes("ready") || c.args.includes("merge") || c.args.includes("--auto") || c.args.includes("--body")), false);
  await assert.rejects(() => readFile(f.state.bodyFile), /ENOENT/);
});

test("draft PR creation pushes the actual generation branch without QA calls and rejects another generation before pushing", async t => {
  const currentBranch = `${manifest.repository.featureBranchPrefix}qa-acceptance`, f = await fixture(t, currentBranch);
  f.state.listed = commandResult("[]"); f.state.remote = "";
  await runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] });
  const created = f.calls.find(call => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create");
  assert.ok(created); assert.equal(created.args[created.args.indexOf("--head") + 1], currentBranch); assert.ok(created.args.includes("--draft"));
  assert.ok(f.calls.some(call => call.command === "git" && call.args[0] === "push" && call.args[2] === `${sha}:refs/heads/${currentBranch}`));
  assert.equal(f.calls.some(call => call.command === "npx" || call.args.includes("ready") || call.args.includes("merge")), false);
  const other = await fixture(t, "codex/cannele-00000000-0000-4000-8000-000000000001/qa-acceptance");
  await assert.rejects(runTaskPr({ ...other.options, args: [...other.options.args, "--draft"] }));
  assert.equal(other.calls.some(call => call.command === "gh" || call.args[0] === "push"), false);
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

test("初回draftはlocal blobとmain完全SHAの停止設定を照合し、remote HEAD確認後だけ作成する", async (t) => {
  const f = await fixture(t);
  f.state.remote = "";
  f.state.listed = commandResult("[]");
  await rm(previewRecordPath(f.cwd));
  assert.deepEqual(await runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] }), { url: prUrl, existing: false });
  const config = f.calls.findIndex((c) => c.command === "git" && c.args[0] === "show");
  const mainRead = f.calls.findIndex((c) => c.args.includes("repos/tyask/Cake/branches/main"));
  const mainConfigRead = f.calls.findIndex((c) => c.args.includes(`repos/tyask/Cake/contents/vercel.json?ref=${mainSha}`));
  const push = f.calls.findIndex((c) => c.command === "git" && c.args[0] === "push");
  const create = f.calls.findIndex((c) => c.args[1] === "create");
  const blob = f.calls.findIndex((c) => c.command === "git" && c.args[0] === "rev-parse" && c.args[1] === `${sha}:vercel.json`);
  assert.ok(config < mainRead && mainRead < mainConfigRead && mainConfigRead < blob && blob < push && push < create);
  assert.deepEqual(f.calls[config].args, ["show", `${sha}:vercel.json`]);
  assert.deepEqual(f.calls[push].args, ["push", "origin", `${sha}:refs/heads/${branch}`]);
  assert.equal(f.calls.filter((c) => c.args[0] === "ls-remote").length, 2);
  const mainCalls = f.calls.filter((c) => c.command === "gh" && c.args[0] === "api");
  assert.equal(mainCalls.length, 2);
  assert.ok(mainCalls.every((c) => c.args[c.args.indexOf("--method") + 1] === "GET"));
  assert.equal(f.calls.filter((c) => c.command === "npx" || c.args[0] === "variable").length, 0);
});

test("ゲート照会中にlocal HEADが動いても確認済みSHAだけをpushする", async (t) => {
  const f = await fixture(t);
  f.state.remote = ""; f.state.listed = commandResult("[]");
  const execute: WorkflowExecutor = async (command, args, cwd) => {
    const result = await f.execute(command, args, cwd);
    if (command === "gh" && args.includes("repos/tyask/Cake/branches/main")) f.state.sha = "c".repeat(40);
    return result;
  };
  await runTaskPr({ ...f.options, execute, args: [...f.options.args, "--draft"] });
  const pushes = f.calls.filter((c) => c.command === "git" && c.args[0] === "push");
  assert.deepEqual(pushes.map((c) => c.args), [["push", "origin", `${sha}:refs/heads/${branch}`]]);
  assert.equal(f.state.remote, `${sha}\trefs/heads/${branch}`);
  assert.equal(f.state.body.includes("c".repeat(40)), false);
});

test("draftのpushはRepository VariableやVercel CLI認証へ依存しない", async t => {
  const f = await fixture(t);
  f.state.remote = ""; f.state.listed = commandResult("[]"); f.state.project = commandResult("private-project-error", 1);
  f.state.gate = commandResult("private-variable-403", 1);
  await runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] });
  assert.equal(f.calls.some(c => c.command === "npx" || c.args[0] === "variable"), false);
  assert.equal(f.calls.filter(c => c.args[0] === "push").length, 1);
});

test("git-showの末尾改行を含む実blob bytesを照合し、差し替えblobを拒否する", async t => {
  for (const valid of [true, false]) {
    const f = await fixture(t); f.state.remote = ""; f.state.listed = commandResult("[]");
    const raw = JSON.stringify(gitConfig) + "\n", bytes = Buffer.from(raw);
    f.state.config = commandResult(raw);
    f.state.blob = commandResult(valid ? createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") : "c".repeat(40));
    if (valid) await runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] });
    else await assert.rejects(() => runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] }), /blob/);
    assert.equal(f.calls.filter(c => c.args[0] === "push").length, valid ? 1 : 0);
  }
});

test("localが正しくてもmainの停止設定が欠落・不正・読取失敗ならpushとPR変更を行わない", async (t) => {
  for (const failure of [commandResult(JSON.stringify(contents({}))),
    commandResult(JSON.stringify(contents({ git: { deploymentEnabled: { "**": false, main: true, qa1: true } } }))),
    commandResult(JSON.stringify({ ...contents(), type: "symlink" })),
    commandResult(JSON.stringify({ ...contents(), size: "60" })),
    commandResult(JSON.stringify({ ...contents(), sha: "c".repeat(40) })),
    commandResult("private-json"), commandResult("private-404", 1), commandResult("private-403", 1)]) {
    const f = await fixture(t);
    f.state.remote = ""; f.state.listed = commandResult("[]"); f.state.mainConfig = failure;
    await assert.rejects(() => runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] }),
      (error: unknown) => error instanceof Error && !error.message.includes("private-"));
    assert.equal(f.calls.some((c) => c.args[0] === "push" || c.args[1] === "create" || isPatch(c)), false);
  }
});

test("main参照が不正・照会不可の場合はContentsを取得せずpushしない", async (t) => {
  for (const main of [commandResult(JSON.stringify({ name: "feature", commit: { sha: mainSha } })),
    commandResult(JSON.stringify({ name: "main", commit: { sha: "short" } })),
    commandResult("private-json"), commandResult("private-403", 1)]) {
    const f = await fixture(t);
    f.state.remote = ""; f.state.listed = commandResult("[]"); f.state.main = main;
    await assert.rejects(() => runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] }));
    assert.equal(f.calls.some((c) => c.args.some((arg) => arg.includes("/contents/")) || c.args[0] === "push" || c.args[1] === "create"), false);
  }
});

test("draftの未push HEADは不正blob/config/push失敗/remote不一致ならPRを作成しない", async (t) => {
  for (const failure of ["blob", "config", "push", "remote"] as const) {
    const f = await fixture(t);
    f.state.remote = "";
    f.state.listed = commandResult("[]");
    if (failure === "blob") f.state.blob = commandResult("c".repeat(40));
    if (failure === "config") f.state.config = commandResult(JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true, qa1: true } } }));
    if (failure === "push") f.state.pushStatus = 1;
    if (failure === "remote") f.state.pushUpdates = false;
    await assert.rejects(() => runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] }));
    assert.equal(f.calls.some((c) => c.args[1] === "create" || isPatch(c)), false);
    if (["blob", "config"].includes(failure)) assert.equal(f.calls.some((c) => c.args[0] === "push"), false);
    if (failure === "config") assert.equal(f.calls.some((c) => c.command === "gh" && c.args[0] === "variable" || c.command === "npx" || c.args[0] === "api"), false);
  }
});

test("--draftは既存draftの本文を更新でき、既存ready PRは未検証本文へ変更しない", async (t) => {
  const f = await fixture(t);
  await runTaskPr({ ...f.options, args: ["--draft", ...f.options.args] });
  assert.equal(f.calls.filter(isPatch).length, 1);
  assert.match(f.state.body, /未検証/);
  f.state.listed = listedPr(false);
  await assert.rejects(() => runTaskPr({ ...f.options, args: [...f.options.args, "--draft"] }), /既存PRはdraftではありません/);
  assert.equal(f.calls.filter(isPatch).length, 1);
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
  assert.equal(f.calls.some((c) => isPatch(c) || c.args[1] === "create"), false);
});

test("旧形式/壊れた/別SHAのローカルPreview証拠ではPRを更新しない", async (t) => {
  const f = await fixture(t);
  for (const record of ["private-invalid-json", JSON.stringify({ ...preview, leaseId: undefined }),
    JSON.stringify({ ...preview, projectId: "prj_other" }), JSON.stringify({ ...preview, sha: "b".repeat(40) }),
    JSON.stringify({ ...preview, prNumber: 43 }), JSON.stringify({ ...preview, url: "https://evil.example" }),
    JSON.stringify({ ...preview, fixedUrl: "https://cake-qa2-fumin.vercel.app" })]) {
    await writeFile(previewRecordPath(f.cwd), record);
    await assert.rejects(() => runTaskPr(f.options));
  }
  assert.equal(f.calls.some((c) => isPatch(c) || c.args[1] === "create"), false);
});

test("旧unique URL証跡があっても現在alias欠落・provider秘密エラー時はPRへ書き込まない", async t => {
  for (const missing of [true, false]) {
    const f = await fixture(t);
    const provider: PreviewProviderReader = async path => {
      if (path.startsWith("/v4/aliases/")) {
        if (missing) return null;
        throw new Error(`PRIVATE_TOKEN ${preview.database.host} PRIVATE_BODY`);
      }
      return f.options.provider(path);
    };
    await assert.rejects(() => runTaskPr({ ...f.options, provider }), (error: unknown) => error instanceof Error
      && !error.message.includes("PRIVATE_") && !error.message.includes(preview.database.host));
    assert.equal(f.calls.some(c => c.args[1] === "create" || isPatch(c)), false);
  }
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
  assert.equal(f.calls.some((c) => isPatch(c) || c.args[1] === "create"), false);
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
  assert.equal(f.calls.some((c) => isPatch(c) || c.args[1] === "create"), false);
});

test("PR更新/作成失敗時も本文の一時ファイルを削除し後続の書込を行わない", async (t) => {
  for (const draft of [false, true]) {
    const f = await fixture(t);
    f.state.edited = commandResult("private-error", 1);
    if (draft) { f.state.listed = commandResult("[]"); f.state.created = commandResult("private-error", 1); }
    await assert.rejects(() => runTaskPr({ ...f.options, args: [...f.options.args, ...(draft ? ["--draft"] : [])] }),
      (error: unknown) => error instanceof Error && !error.message.includes("private-"));
    await assert.rejects(() => readFile(f.state.bodyFile), /ENOENT/);
    assert.equal(f.calls.filter((c) => isPatch(c) || c.args[1] === "create").length, 1);
  }
});

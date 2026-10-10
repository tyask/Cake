import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskPr } from "../scripts/task-pr";
import { CAKE_VERCEL_PROJECT, previewRecordPath, type TaskPreviewRecord, type WorkflowExecutor, type WorkflowCommandResult } from "../scripts/task-workflow";

const branch = "codex/test-pr";
const sha = "a".repeat(40);
const preview: TaskPreviewRecord = { projectId: CAKE_VERCEL_PROJECT, branch, sha,
  url: "https://cake-pr-test-fumin1.vercel.app", deploymentId: "dpl_preview", createdAt: "2026-10-10T00:00:00.000Z" };
const prUrl = "https://github.com/tyask/Cake/pull/42";
const commandResult = (stdout = "", status = 0): WorkflowCommandResult => ({ stdout, status, signal: null });

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-task-pr-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".cake"));
  await writeFile(previewRecordPath(cwd), JSON.stringify(preview));
  const reportFile = join(cwd, ".cake/verification.md");
  await writeFile(reportFile, "- lint・test・build 成功\n- PreviewでA・B認証とAPIを確認\n- PC・スマートフォンで操作確認\n");
  const state = { branch, sha, status: "", origin: "https://github.com/tyask/Cake.git",
    remote: `${sha}\trefs/heads/${branch}`, listed: commandResult("[]"), created: commandResult(prUrl),
    edited: commandResult(), body: "", bodyFile: "" };
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
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return state.listed;
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
    options: { cwd, execute, log: () => {}, args: ["--title", "開発フローを整備", "--verification-file", reportFile] } };
}

test("検証済みHEADだけをmain向けPRにし、Previewと複数行の検証結果をbody-fileで渡す", async (t) => {
  const f = await fixture(t);
  const result = await runTaskPr(f.options);
  assert.deepEqual(result, { url: prUrl, existing: false });
  assert.match(f.state.body, /開発フローを整備/);
  assert.ok(f.state.body.includes(preview.url));
  assert.ok(f.state.body.includes(sha));
  assert.ok(f.state.body.includes(branch));
  assert.match(f.state.body, /本番から分離したNeon Previewリソース/);
  assert.match(f.state.body, /lint・test・build 成功\n- PreviewでA・B認証/);
  const mutations = f.calls.filter((call) => call.command === "gh" && call.args[1] !== "list");
  assert.equal(mutations.length, 1);
  const created = mutations[0];
  assert.equal(created.args[1], "create");
  assert.equal(created.args[created.args.indexOf("--repo") + 1], "tyask/Cake");
  assert.equal(created.args[created.args.indexOf("--base") + 1], "main");
  assert.equal(created.args[created.args.indexOf("--head") + 1], branch);
  assert.equal(created.args.includes("--body"), false);
  assert.equal(created.args.includes("merge"), false);
  assert.equal(created.args.includes("--auto"), false);
  await assert.rejects(() => readFile(f.state.bodyFile), /ENOENT/);
});

test("追加・重複・不足引数と不正タイトルをGit操作前に拒否する", async (t) => {
  const f = await fixture(t);
  const invalid = [[], ["--title", "title"], ["--verification-file", f.reportFile],
    ["--title", "one", "--title", "two", "--verification-file", f.reportFile],
    [...f.options.args, "--auto"], ["--title", "", "--verification-file", f.reportFile],
    ["--title", "line\nbreak", "--verification-file", f.reportFile],
    ["--title", "x".repeat(241), "--verification-file", f.reportFile],
    ["--title", "title", "--verification-file"]];
  for (const args of invalid) await assert.rejects(() => runTaskPr({ ...f.options, args }));
  assert.equal(f.calls.length, 0);
});

test("mainや未コミット変更ではPRを作成しない", async (t) => {
  const f = await fixture(t);
  f.state.branch = "main";
  await assert.rejects(() => runTaskPr(f.options), /タスク専用/);
  f.state.branch = branch;
  f.state.status = " M app.ts";
  await assert.rejects(() => runTaskPr(f.options), /未コミット変更/);
  assert.equal(f.calls.some((call) => call.command === "gh"), false);
});

test("Previewと現在のブランチ・SHAが一致しなければ検証のやり直しを要求する", async (t) => {
  const f = await fixture(t);
  for (const record of [{ ...preview, branch: "codex/other-task" }, { ...preview, sha: "b".repeat(40) }]) {
    await writeFile(previewRecordPath(f.cwd), JSON.stringify(record));
    await assert.rejects(() => runTaskPr(f.options), /現在のHEADが一致しません/);
  }
  assert.equal(f.calls.some((call) => call.command === "gh" || call.args[0] === "ls-remote"), false);
});

test("Preview記録がない・壊れている・projectやURLが異なる場合はPRを作成しない", async (t) => {
  const f = await fixture(t);
  await rm(previewRecordPath(f.cwd));
  await assert.rejects(() => runTaskPr(f.options), /記録がないか不正/);
  const records = ["private-invalid-json", JSON.stringify({ ...preview, projectId: "prj_other" }),
    JSON.stringify({ ...preview, url: "https://evil.example" }), JSON.stringify({ ...preview, deploymentId: "wrong" }),
    JSON.stringify({ ...preview, createdAt: "wrong-date" }), JSON.stringify({ ...preview, url: `${preview.url}/` }),
    JSON.stringify({ ...preview, sha: "invalid-sha" })];
  for (const record of records) {
    await writeFile(previewRecordPath(f.cwd), record);
    await assert.rejects(() => runTaskPr(f.options), /記録がないか不正/);
  }
  assert.equal(f.calls.some((call) => call.command === "gh"), false);
});

test("空・不足・ディレクトリの検証結果はPRに添付しない", async (t) => {
  const f = await fixture(t);
  await writeFile(f.reportFile, " \n\t");
  await assert.rejects(() => runTaskPr(f.options), /検証結果ファイル/);
  for (const path of [join(f.cwd, "missing-report.md"), f.cwd]) {
    await assert.rejects(() => runTaskPr({ ...f.options, args: ["--title", "title", "--verification-file", path] }), /検証結果ファイル/);
  }
  assert.equal(f.calls.some((call) => call.command === "gh"), false);
});

test("remoteブランチが検証済みSHAと異なる場合はPRを作成しない", async (t) => {
  const f = await fixture(t);
  for (const remote of ["", `${"b".repeat(40)}\trefs/heads/${branch}`, `${sha}\trefs/heads/codex/other-task`]) {
    f.state.remote = remote;
    await assert.rejects(() => runTaskPr(f.options), /originのブランチが検証済みコミットと一致しません/);
  }
  assert.equal(f.calls.some((call) => call.command === "gh"), false);
});

test("同じ検証済みコミットの既存PRを最新のタイトル・Preview・検証結果へ更新する", async (t) => {
  const f = await fixture(t);
  f.state.listed = commandResult(JSON.stringify([{ url: prUrl, headRefOid: sha }]));
  const currentPreview = { ...preview, url: "https://cake-pr-new-preview-fumin1.vercel.app", deploymentId: "dpl_retested" };
  await writeFile(previewRecordPath(f.cwd), JSON.stringify(currentPreview));
  await writeFile(f.reportFile, "- 修正後のPreviewでAPIを再確認\n- lint・test・build 再実行成功\n");
  assert.deepEqual(await runTaskPr(f.options), { url: prUrl, existing: true });
  assert.equal(f.calls.some((call) => call.command === "gh" && call.args[1] === "create"), false);
  const edits = f.calls.filter((call) => call.command === "gh" && call.args[1] === "edit");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].args[2], prUrl);
  assert.equal(edits[0].args[edits[0].args.indexOf("--title") + 1], "開発フローを整備");
  assert.ok(f.state.body.includes(currentPreview.url));
  assert.equal(f.state.body.includes(preview.url), false);
  assert.ok(f.state.body.includes(currentPreview.deploymentId));
  assert.ok(f.state.body.includes(sha));
  assert.match(f.state.body, /修正後のPreviewでAPIを再確認\n- lint・test・build 再実行成功/);
  await assert.rejects(() => readFile(f.state.bodyFile), /ENOENT/);
});

test("既存PRのSHA・URL・JSONが不正なら追加PRを作成しない", async (t) => {
  const f = await fixture(t);
  const values = ["private-json", "{}", '[null]',
    JSON.stringify([{ url: prUrl, headRefOid: "b".repeat(40) }]),
    JSON.stringify([{ url: "https://github.com/other/Cake/pull/42", headRefOid: sha }]),
    JSON.stringify([{ url: prUrl, headRefOid: sha }, { url: prUrl, headRefOid: sha }])];
  for (const value of values) {
    f.state.listed = commandResult(value);
    await assert.rejects(() => runTaskPr(f.options), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("private-"), false);
      return true;
    });
  }
  assert.equal(f.calls.some((call) => call.command === "gh" && ["create", "edit"].includes(call.args[1])), false);
});

test("既存PRの照会が失敗したら作成を続けない", async (t) => {
  const f = await fixture(t);
  f.state.listed = commandResult("private-api-error", 1);
  await assert.rejects(() => runTaskPr(f.options), /既存PRを確認できません/);
  assert.equal(f.calls.some((call) => call.command === "gh" && call.args[1] === "create"), false);
});

test("PR作成失敗時にも本文の一時ファイルを削除し、秘密エラーを出さない", async (t) => {
  const f = await fixture(t);
  f.state.created = commandResult("private-create-error", 1);
  await assert.rejects(() => runTaskPr(f.options), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /PRを作成できません/);
    assert.equal(error.message.includes("private-"), false);
    return true;
  });
  assert.ok(f.state.bodyFile);
  await assert.rejects(() => readFile(f.state.bodyFile), /ENOENT/);
  assert.equal(f.calls.filter((call) => call.command === "gh" && call.args[1] === "create").length, 1);
});

test("既存PR更新失敗時も一時本文を削除し、新規PR作成や後続処理を続けない", async (t) => {
  const f = await fixture(t);
  f.state.listed = commandResult(JSON.stringify([{ url: prUrl, headRefOid: sha }]));
  f.state.edited = commandResult("private-edit-error", 1);
  await assert.rejects(() => runTaskPr(f.options), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /既存PRの更新に失敗/);
    assert.equal(error.message.includes("private-"), false);
    return true;
  });
  assert.ok(f.state.bodyFile);
  await assert.rejects(() => readFile(f.state.bodyFile), /ENOENT/);
  assert.equal(f.calls.filter((call) => call.command === "gh" && call.args[1] === "edit").length, 1);
  assert.equal(f.calls.some((call) => call.command === "gh" && call.args[1] === "create"), false);
});

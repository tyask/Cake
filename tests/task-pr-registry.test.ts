import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskPrRegistry } from "../scripts/task-pr-registry";
import type { QaPublicLease } from "../scripts/qa-client";
import type { WorkflowExecutor } from "../scripts/task-workflow";
import { QA_NEON_PROJECT_ID } from "../lib/qa-pool";

const sha = "a".repeat(40), mainSha = "b".repeat(40), branch = "codex/rest-pr-test";
const prUrl = "https://github.com/tyask/Cake/pull/50", uniqueUrl = "https://cake-rest-pr.vercel.app";
const leaseId = "00000000-0000-4000-8000-000000000001";
const config = JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true } } });
const bytes = Buffer.from(config), blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const title = "QA確認結果を更新", report = "1行目\n2行目\n\nリテラル \\n と `$()` を保持";
const lease: QaPublicLease = { slot: "qa1", state: "published", leaseId, pr: 50, branch, headSha: sha, version: 5, aliasSha: sha,
  readyDeploymentId: "dpl_ready", deployments: [{ id: "dpl_ready", sha, phase: "application", url: uniqueUrl }],
  database: { projectId: QA_NEON_PROJECT_ID, branchId: "br-rest-test", endpointId: "ep-rest-test" } };

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-rest-pr-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".cake"));
  const reportFile = join(cwd, ".cake/report.md"); await writeFile(reportFile, report);
  const proofFile = join(cwd, ".cake/qa-verification.json");
  await writeFile(proofFile, JSON.stringify({ protocol: "cake-qa-verification/v1", pr: 50, leaseId, sha,
    deploymentId: "dpl_ready", uniqueUrl, fixedUrl: "https://cake-qa1-fumin.vercel.app", success: true }));
  const calls: { command: string; args: readonly string[] }[] = [];
  const state = { patchStatus: 0, wrongResponse: "", draft: true, patchBody: "", inputFile: "", statusReads: 0, validQa: true };
  const result = (stdout = "", status = 0) => ({ stdout, status, signal: null });
  const execute: WorkflowExecutor = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "git") {
      if (args[0] === "status") return result();
      if (args[0] === "show") return result(config);
      if (args[0] === "remote") return result("git@github.com:tyask/Cake.git");
      if (args[0] === "ls-remote") return result(`${sha}\trefs/heads/${branch}`);
      if (args[1] === "--show-toplevel") return result(cwd);
      if (args[1] === "--abbrev-ref") return result(branch);
      if (args[1] === "HEAD") return result(sha);
      if (args[1] === `${sha}:vercel.json`) return result(blob);
    }
    if (command === "gh") {
      if (args[0] === "pr" && args[1] === "list") return result(JSON.stringify([{ number: 50, url: prUrl, headRefOid: sha, isDraft: state.draft }]));
      if (args[0] === "pr" && args[1] === "ready") return result();
      if (args.includes("repos/tyask/Cake/branches/main")) return result(JSON.stringify({ name: "main", commit: { sha: mainSha } }));
      if (args.includes(`repos/tyask/Cake/contents/vercel.json?ref=${mainSha}`)) return result(JSON.stringify({ type: "file", name: "vercel.json", path: "vercel.json",
        size: bytes.length, sha: blob, encoding: "base64", content: bytes.toString("base64") }));
      if (args[0] === "api" && args.includes("PATCH") && args.includes("repos/tyask/Cake/pulls/50")) {
        state.inputFile = args[args.indexOf("--input") + 1];
        assert.equal((await stat(state.inputFile)).mode & 0o777, 0o600);
        const json = JSON.parse(await readFile(state.inputFile, "utf8"));
        assert.deepEqual(Object.keys(json).sort(), ["body", "title"]);
        state.patchBody = json.body;
        if (state.patchStatus) return result("PRIVATE_PROVIDER_GRAPHQL_ERROR", state.patchStatus);
        const response = { number: 50, html_url: prUrl, state: "open", title: json.title, body: json.body,
          head: { ref: branch, sha, repo: { full_name: "tyask/Cake" } }, base: { ref: "main", repo: { full_name: "tyask/Cake" } } };
        if (state.wrongResponse === "number") response.number = 51;
        if (state.wrongResponse === "url") response.html_url = "https://github.com/other/Cake/pull/50";
        if (state.wrongResponse === "state") response.state = "closed";
        if (state.wrongResponse === "body") response.body = json.body.replaceAll("\n", "\\n");
        if (state.wrongResponse === "title") response.title = "OTHER";
        if (state.wrongResponse === "head") response.head.sha = "c".repeat(40);
        if (state.wrongResponse === "branch") response.head.ref = "codex/other";
        if (state.wrongResponse === "headRepo") response.head.repo.full_name = "other/Cake";
        if (state.wrongResponse === "base") response.base.ref = "preview";
        if (state.wrongResponse === "baseRepo") response.base.repo.full_name = "other/Cake";
        return result(JSON.stringify(response));
      }
    }
    assert.fail(`Unexpected ${command} ${args.join(" ")}`);
  };
  const options = { cwd, execute, log: () => {}, args: ["--title", title, "--verification-file", reportFile],
    statusRequest: async () => {
      state.statusReads++;
      return { protocol: "cake-qa-result/v1" as const, requestId: leaseId, action: "status" as const, status: "success" as const,
        payload: state.validQa ? structuredClone(lease) : null, workflowUrl: "https://github.com/tyask/Cake/actions/runs/100" };
    } };
  return { state, calls, options, proofFile };
}

test("検証済みPR本文をREST JSONで実改行のまま更新し成功確認後にだけReadyにする", async t => {
  const f = await fixture(t);
  assert.deepEqual(await runTaskPrRegistry(f.options), { url: prUrl, existing: true });
  const patchIndex = f.calls.findIndex(call => call.args.includes("PATCH")), readyIndex = f.calls.findIndex(call => call.args[1] === "ready");
  assert.ok(patchIndex >= 0 && readyIndex > patchIndex);
  assert.ok(f.state.patchBody.endsWith(`${report}\n`));
  assert.equal(f.calls.some(call => call.args[1] === "edit" || call.args.includes("--body") || call.args.includes("--body-file")), false);
  assert.equal(f.state.statusReads, 1);
  await assert.rejects(readFile(f.state.inputFile), /ENOENT/);
});

test("PATCH失敗や別PR/本文の応答ではReadyを実行せず原例外を出さない", async t => {
  for (const mismatch of ["failure", "number", "url", "state", "body", "title", "head", "branch", "headRepo", "base", "baseRepo"]) {
    const f = await fixture(t);
    if (mismatch === "failure") f.state.patchStatus = 1;
    else f.state.wrongResponse = mismatch;
    await assert.rejects(runTaskPrRegistry(f.options), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE"));
    assert.equal(f.calls.some(call => call.args[1] === "ready"), false);
    await assert.rejects(readFile(f.state.inputFile), /ENOENT/);
  }
});

test("QA未公開や別コミットの画面証拠ではREST更新もReadyも実行しない", async t => {
  for (const invalid of ["qa", "proof"]) {
    const f = await fixture(t);
    if (invalid === "qa") f.state.validQa = false;
    else await writeFile(f.proofFile, JSON.stringify({ protocol: "cake-qa-verification/v1", sha: "c".repeat(40), success: true }));
    await assert.rejects(runTaskPrRegistry(f.options));
    assert.equal(f.calls.some(call => call.args.includes("PATCH") || call.args[1] === "ready"), false);
  }
});

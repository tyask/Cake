import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { assertCanneleCi, runCanneleReady, type CanneleReadyOptions } from "../scripts/cannele-ready";
import { CAKE_REPOSITORY, type WorkflowExecutor, type WorkflowCommandResult } from "../scripts/task-workflow";
import manifest from "../docs/cannele/resource-manifest.json";

const sha = "a".repeat(40), mainSha = "b".repeat(40), branch = "codex/verified-ready", prNumber = 71;
const prUrl = `https://github.com/${CAKE_REPOSITORY}/pull/${prNumber}`;
const gitConfig = { git: { deploymentEnabled: { "**": false, main: true } } };
const bytes = Buffer.from(JSON.stringify(gitConfig));
const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const contents = { type: "file", name: "vercel.json", path: "vercel.json", encoding: "base64", size: bytes.length, sha: blob, content: bytes.toString("base64") };
const result = (stdout = "", status = 0): WorkflowCommandResult => ({ stdout, status, signal: null });
type CiRun = { id: number; run_number: number; run_attempt: number; path: string; event: string; head_sha: string; head_branch: string;
  head_repository: { full_name: string }; pull_requests: { number: number }[]; status: string; conclusion: string | null };
function ci(event: string, id: number, changes: Partial<CiRun> = {}): CiRun {
  return { id, run_number: id, run_attempt: 1, path: ".github/workflows/ci.yml", event, head_sha: sha, head_branch: branch,
    head_repository: { full_name: CAKE_REPOSITORY }, pull_requests: event === "pull_request" ? [{ number: prNumber }] : [], status: "completed", conclusion: "success", ...changes };
}

async function fixture(t: TestContext, currentBranch = branch) {
  const branch = currentBranch;
  const cwd = await mkdtemp(join(tmpdir(), "cake-cannele-ready-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const verificationFile = join(cwd, "verification.md"); await writeFile(verificationFile, "- lint・test・build 成功\n- 固有・固定URLの画面操作、保存・readback・復元を確認\n");
  const leaseId = randomUUID();
  const source = { cwd, branch, sourceSha: sha, prNumber, draft: true };
  const lease = { leaseId, slot: "qa1", state: "published", sourceSha: sha, version: 8, prNumber, readyDeploymentId: "dpl_current",
    currentPublication: { deploymentId: "dpl_current", sourceSha: sha, url: "https://cake-qa1-fumin.vercel.app", aliasId: "alias_current" } };
  const evidence = (kind: "unique" | "fixed", version: number) => {
    const proof = { leaseId, sourceSha: sha, deploymentId: lease.readyDeploymentId, leaseVersion: version, urlKind: kind,
      url: kind === "unique" ? "https://cake-current-fumin1.vercel.app" : lease.currentPublication.url };
    return { before: { ...proof }, after: { ...proof }, cases: ["user_a", "user_b", "recurring_payment_readback"], verifiedAt: "2026-10-15T12:00:00Z" };
  };
  // Unique UI tests run before publication; the fixed tests run after its version increment.
  const unique = evidence("unique", 7), fixed = evidence("fixed", 8);
  const state = { sha, status: "", pushedSha: sha, config: gitConfig as unknown, pages: [{ workflow_runs: [ci("push", 11, { head_branch: branch })] }, { workflow_runs: [ci("pull_request", 12, { head_branch: branch })] }],
    body: "", title: "", isDraft: true, patchStatus: 0, readyStatus: 0, changeAfterPatch: false };
  const calls: { command: string; args: readonly string[] }[] = [];
  const execute: WorkflowExecutor = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "git") {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(cwd);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return result(branch);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return result(state.sha);
      if (args[0] === "rev-parse" && args[1] === `${sha}:vercel.json`) return result(blob);
      if (args[0] === "status") return result(state.status);
      if (args[0] === "remote") return result("https://github.com/tyask/Cake.git");
      if (args[0] === "ls-remote") return result(`${state.pushedSha}\trefs/heads/${branch}`);
      if (args[0] === "show") return result(JSON.stringify(state.config));
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return result(JSON.stringify([{ number: prNumber, url: prUrl, headRefOid: state.sha, isDraft: state.isDraft }]));
    if (command === "gh" && args[0] === "pr" && args[1] === "ready") { if (state.readyStatus === 0) state.isDraft = false; return result("", state.readyStatus); }
    if (command === "gh" && args[0] === "api") {
      const path = args.find(value => value.startsWith(`repos/${CAKE_REPOSITORY}/`));
      if (path?.includes("actions/workflows/ci.yml/runs?")) return result(JSON.stringify(state.pages));
      if (path?.endsWith("branches/main")) return result(JSON.stringify({ name: "main", commit: { sha: mainSha } }));
      if (path?.includes("contents/vercel.json?")) return result(JSON.stringify(contents));
      if (path?.endsWith(`pulls/${prNumber}`) && args.includes("PATCH")) {
        const input = JSON.parse(await readFile(args[args.indexOf("--input") + 1]!, "utf8")) as { title: string; body: string };
        state.title = input.title; state.body = input.body;
        if (state.changeAfterPatch) state.sha = "c".repeat(40);
        return result(JSON.stringify({ number: prNumber, html_url: prUrl, state: "open", title: input.title, body: input.body,
          head: { ref: branch, sha, repo: { full_name: CAKE_REPOSITORY } }, base: { ref: "main", repo: { full_name: CAKE_REPOSITORY } } }), state.patchStatus);
      }
    }
    throw new Error("Unexpected fixture command.");
  };
  const options: CanneleReadyOptions = { cwd, verificationFile, title: "QAで確認した変更", source, lease, unique, fixed, execute, log: () => undefined };
  return { cwd, options, state, calls, execute, unique, fixed, lease };
}

function mutations(calls: { command: string; args: readonly string[] }[]) { return calls.filter(call => call.command === "gh" && (call.args.includes("PATCH") || call.args[0] === "pr" && call.args[1] === "ready")); }

test("Ready accepts pre-publication unique evidence and current fixed evidence, checking both paginated CI events before body and Ready", async t => {
  const f = await fixture(t); await runCanneleReady(f.options);
  assert.equal(f.state.isDraft, false); assert.match(f.state.body, /recurring_payment_readback/); assert.match(f.state.body, new RegExp(f.lease.leaseId));
  const inventory = f.calls.find(call => call.args.some(arg => arg.includes("actions/workflows/ci.yml/runs?")));
  assert.ok(inventory?.args.includes("--paginate") && inventory.args.includes("--slurp"));
  const writes = mutations(f.calls); assert.equal(writes.length, 2); assert.ok(writes[0]!.args.includes("PATCH")); assert.equal(writes[1]!.args[1], "ready");
  const patchIndex = f.calls.indexOf(writes[0]!); const readyIndex = f.calls.indexOf(writes[1]!);
  assert.ok(f.calls.slice(patchIndex + 1, readyIndex).some(call => call.command === "git" && call.args[0] === "ls-remote"));
});

test("Ready consumes the actual reviewed generation and still rejects another generation before any mutation", async t => {
  const current = await fixture(t, `${manifest.repository.featureBranchPrefix}qa-acceptance`);
  await runCanneleReady(current.options);
  assert.equal(current.state.isDraft, false); assert.ok(current.state.body.includes(current.options.source.branch));
  const other = await fixture(t, "codex/cannele-00000000-0000-4000-8000-000000000001/qa-acceptance");
  await assert.rejects(runCanneleReady(other.options)); assert.equal(mutations(other.calls).length, 0);
});

test("changed lease/deployment/version evidence and empty browser cases reject before any GitHub mutation", async t => {
  const cases: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
    f => { f.fixed.after.leaseId = randomUUID(); },
    f => { f.unique.before.leaseVersion = 6; },
    f => { f.fixed.before.leaseVersion = 7; f.fixed.after.leaseVersion = 7; },
    f => { f.unique.before.leaseVersion = 9; f.unique.after.leaseVersion = 9; },
    f => { f.fixed.after.deploymentId = "dpl_other"; },
    f => { f.fixed.cases = []; },
    f => { f.lease.state = "reserved"; },
  ];
  for (const mutate of cases) {
    const f = await fixture(t); mutate(f); await assert.rejects(runCanneleReady(f.options)); assert.equal(mutations(f.calls).length, 0);
  }
});

test("Ready refuses nonregular, linked, oversized and empty report files", async t => {
  for (const kind of ["symlink", "hardlink", "oversized", "empty", "directory"]) {
    const f = await fixture(t); const file = join(f.cwd, "invalid-report");
    if (kind === "symlink") await symlink(f.options.verificationFile, file);
    if (kind === "hardlink") await link(f.options.verificationFile, file);
    if (kind === "oversized") await writeFile(file, "x".repeat(1_000_001));
    if (kind === "empty") await writeFile(file, " \n");
    if (kind === "directory") await mkdir(file);
    await assert.rejects(runCanneleReady({ ...f.options, verificationFile: file })); assert.equal(mutations(f.calls).length, 0);
  }
});

test("newest failed, queued or cancelled CI blocks Ready even when older runs succeeded", async t => {
  for (const state of ["failed", "queued", "cancelled"]) {
    const f = await fixture(t);
    f.state.pages.push({ workflow_runs: [ci("push", 11, { run_attempt: 2, status: state === "queued" ? "queued" : "completed", conclusion: state === "queued" ? null : state === "cancelled" ? "cancelled" : "failure" })] });
    await assert.rejects(runCanneleReady(f.options)); assert.equal(mutations(f.calls).length, 0);
  }
});

test("CI must match the current PR, SHA, branch, repository and workflow, with a unique newest run", async t => {
  const malformed: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
    f => { f.state.pages[1]!.workflow_runs[0]!.pull_requests = [{ number: 999 }]; },
    f => { f.state.pages[1]!.workflow_runs[0]!.head_repository.full_name = "foreign/Cake"; },
    f => { f.state.pages[1]!.workflow_runs[0]!.head_sha = "c".repeat(40); },
    f => { f.state.pages[1]!.workflow_runs[0]!.head_branch = "codex/other"; },
    f => { f.state.pages[1]!.workflow_runs[0]!.path = ".github/workflows/other.yml"; },
    f => { f.state.pages[0]!.workflow_runs.push(ci("push", 999, { run_number: 11, conclusion: "failure" })); },
  ];
  for (const mutate of malformed) { const f = await fixture(t); mutate(f); await assert.rejects(assertCanneleCi(f.options.source, f.execute)); }
});

test("dirty or unpushed heads and a commit change after the body update never trigger Ready", async t => {
  const dirty = await fixture(t); dirty.state.status = " M app/page.tsx"; await assert.rejects(runCanneleReady(dirty.options)); assert.equal(mutations(dirty.calls).length, 0);
  const unpushed = await fixture(t); unpushed.state.pushedSha = "c".repeat(40); await assert.rejects(runCanneleReady(unpushed.options)); assert.equal(mutations(unpushed.calls).length, 0);
  const changed = await fixture(t); changed.state.changeAfterPatch = true; await assert.rejects(runCanneleReady(changed.options));
  assert.equal(changed.calls.filter(call => call.args[0] === "pr" && call.args[1] === "ready").length, 0);
});

test("unsafe committed Git deployment configuration and failed PR-body updates preserve draft state", async t => {
  const unsafe = await fixture(t); unsafe.state.config = { git: { deploymentEnabled: true } }; await assert.rejects(runCanneleReady(unsafe.options)); assert.equal(mutations(unsafe.calls).length, 0);
  const failed = await fixture(t); failed.state.patchStatus = 1; await assert.rejects(runCanneleReady(failed.options));
  assert.equal(failed.state.isDraft, true); assert.equal(failed.calls.filter(call => call.args[0] === "pr" && call.args[1] === "ready").length, 0);
});

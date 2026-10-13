import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { QA_ENVIRONMENT, QA_PROJECT_ID, QA_REPOSITORY } from "../lib/qa-pool";
import { makeOwnerPlan, QA_APPROVAL_TASK, QA_APPROVAL_WORKFLOW, type OwnerPlan } from "../lib/qa-owner-approval";
import { parseQaApprovalArgs, runQaApproval } from "../scripts/qa-approve";
import type { WorkflowExecutor } from "../scripts/task-workflow";

const mainSha = "a".repeat(40), sha = "b".repeat(40), ownerId = 4242;
const failure = /QA本人承認を確認できませんでした/;
const makePlan = (createdAt = Date.now() - 1000): OwnerPlan => makeOwnerPlan({ action: "preview", projectId: QA_PROJECT_ID, pr: 42,
  branch: "codex/owner-test", sha, slot: "qa1", leaseId: "00000000-0000-4000-8000-000000000042", previousLeaseRecordId: null,
  deploymentIds: [], alias: "cake-qa1-fumin.vercel.app", database: null, parentBranchId: "br-owner-parent", runId: 100, runAttempt: 1 }, mainSha, createdAt);
function world(plan = makePlan()) {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  const user: Record<string, unknown> = { id: ownerId, login: "tyask", type: "User" };
  const repository: Record<string, unknown> = { full_name: QA_REPOSITORY, owner: { id: ownerId, login: "tyask", type: "User" } };
  const source: Record<string, unknown> = { id: plan.runId, run_attempt: plan.runAttempt, repository: { full_name: QA_REPOSITORY },
    head_repository: { full_name: QA_REPOSITORY }, path: QA_APPROVAL_WORKFLOW,
    referenced_workflows: [{ path: `${QA_REPOSITORY}/.github/workflows/qa-private-run.yml@${mainSha}`, ref: "refs/heads/main", sha: mainSha }],
    event: "workflow_dispatch", head_branch: "main", head_sha: mainSha,
    actor: { id: ownerId, type: "User" }, triggering_actor: { id: ownerId, type: "User" },
    display_title: "Cake QA request-preview -", status: "completed", conclusion: "success" };
  const records: Record<string, unknown>[] = [{ id: 101, task: QA_APPROVAL_TASK, environment: QA_ENVIRONMENT, sha: plan.sha, payload: plan,
    creator: { login: "github-actions[bot]", type: "Bot" } }];
  const main: Record<string, unknown> = { name: "main", commit: { sha: mainSha } };
  const execute: WorkflowExecutor = async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    assert.equal(command, "gh");
    if (args[0] === "workflow") return { status: 0, signal: null, stdout: "Bearer PRIVATE_STDOUT_SENTINEL" };
    assert.deepEqual(args.slice(0, 6), ["api", "--hostname", "github.com", "--method", "GET", args[5]]);
    const path = args[5];
    let data: unknown;
    if (path === "user") data = user;
    else if (path === `repos/${QA_REPOSITORY}`) data = repository;
    else if (path === `repos/${QA_REPOSITORY}/branches/main`) data = main;
    else if (path === `repos/${QA_REPOSITORY}/deployments?task=${QA_APPROVAL_TASK}&per_page=100&page=1`) data = records;
    else if (path === `repos/${QA_REPOSITORY}/actions/runs/${plan.runId}/attempts/${plan.runAttempt}`) data = source;
    else assert.fail("Unexpected API path");
    return { status: 0, signal: null, stdout: JSON.stringify(data) };
  };
  return { execute, calls, user, repository, source, records, main, plan };
}
function dispatches(calls: ReturnType<typeof world>["calls"]) { return calls.filter((call) => call.args[0] === "workflow"); }

test("approval arguments require one exact positive plan ID and only the known optional revoke flag", () => {
  assert.deepEqual(parseQaApprovalArgs(["--plan-id", "101"]), { planId: 101, action: "approve" });
  assert.deepEqual(parseQaApprovalArgs(["--revoke", "--plan-id", "101"]), { planId: 101, action: "revoke" });
  for (const args of [[], ["--plan-id"], ["--revoke"], ["--plan-id", "101", "--plan-id", "102"], ["--plan-id", "101", "--revoke", "--revoke"],
    ["--plan-id=101"], ["101"], ["--plan-id", "101", "--force"], ["--plan-id", "0"], ["--plan-id", "-1"], ["--plan-id", "01"],
    ["--plan-id", "1.5"], ["--plan-id", "1e2"], ["--plan-id", " 101"], ["--plan-id", "9007199254740992"], ["--plan-id", "101\n--ref=feature"]]) {
    assert.throws(() => parseQaApprovalArgs(args), failure);
  }
});

test("owner approval performs GET validation then one exact main approval dispatch and returns only the public summary", async () => {
  const g = world(), result = await runQaApproval(["--plan-id", "101"], "/workspace/task", g.execute);
  assert.equal(result.status, "REQUESTED"); assert.equal(result.planId, 101); assert.equal(result.action, "approve");
  assert.deepEqual(dispatches(g.calls), [{ command: "gh", args: ["workflow", "run", "qa-pool.yml", "--repo", `github.com/${QA_REPOSITORY}`,
    "--ref", "main", "-f", "action=approve", "-f", "plan_id=101"], cwd: "/workspace/task" }]);
  assert.equal(g.calls.slice(0, -1).every((call) => call.args[0] === "api" && call.args[4] === "GET"), true);
  assert.equal(g.calls.some((call) => /vercel|neon|variables|secrets/.test(call.args[5] ?? "")), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE_STDOUT_SENTINEL"), false);
  assert.deepEqual(result.plan.resources, g.plan.resources);
});

test("revoke has its own exact dispatch and permits an expired plan without extending it", async () => {
  const g = world(makePlan(Date.now() - 3 * 60 * 60 * 1000)), result = await runQaApproval(["--plan-id", "101", "--revoke"], "/workspace/task", g.execute);
  assert.equal(result.action, "revoke"); assert.equal(result.plan.expiresAt, g.plan.expiresAt);
  assert.deepEqual(dispatches(g.calls)[0].args.slice(-6), ["--ref", "main", "-f", "action=revoke", "-f", "plan_id=101"]);
});

test("bad arguments stop before identity GET or dispatch", async () => {
  const g = world();
  await assert.rejects(() => runQaApproval(["--plan-id", "101", "--raw-field", "PRIVATE_SENTINEL"], "/workspace/task", g.execute), failure);
  assert.equal(g.calls.length, 0);
});

test("nonowner, bot, organization, owner-name spoof and invalid authenticated IDs cannot request approval", async () => {
  for (const change of [{ id: 9 }, { login: "someone" }, { type: "Bot" }, { type: "Organization" }, { id: "4242" }, { id: 0 }]) {
    const g = world(); Object.assign(g.user, change);
    await assert.rejects(() => runQaApproval(["--plan-id", "101"], "/workspace/task", g.execute), failure);
    assert.equal(dispatches(g.calls).length, 0);
  }
  for (const change of [{ owner: { id: ownerId, login: "tyask", type: "Organization" } }, { full_name: "fork/Cake" },
    { owner: { id: 9, login: "tyask", type: "User" } }, { owner: { id: ownerId, login: "github-actions[bot]", type: "User" } }]) {
    const g = world(); Object.assign(g.repository, change);
    await assert.rejects(() => runQaApproval(["--plan-id", "101"], "/workspace/task", g.execute), failure);
    assert.equal(dispatches(g.calls).length, 0);
  }
});

test("unknown plan, expiry and main source changes stop before the dispatch", async () => {
  const expired = world(makePlan(Date.now() - 3 * 60 * 60 * 1000));
  await assert.rejects(() => runQaApproval(["--plan-id", "101"], "/workspace/task", expired.execute), failure);
  assert.equal(dispatches(expired.calls).length, 0);
  const missing = world();
  await assert.rejects(() => runQaApproval(["--plan-id", "102"], "/workspace/task", missing.execute), failure);
  assert.equal(dispatches(missing.calls).length, 0);
  for (const change of [{ commit: { sha: "c".repeat(40) } }, { name: "feature" }, { commit: { sha: "a".repeat(7) } }]) {
    const g = world(); Object.assign(g.main, change);
    await assert.rejects(() => runQaApproval(["--plan-id", "101"], "/workspace/task", g.execute), failure);
    assert.equal(dispatches(g.calls).length, 0);
  }
});

test("plan provenance rejects forks, comments, non-main source and missing referenced-main proof", async () => {
  for (const change of [{ head_repository: { full_name: "fork/Cake" } }, { repository: { full_name: "fork/Cake" } },
    { event: "issue_comment" }, { head_branch: "codex/owner-test" }, { head_sha: "c".repeat(40) }, { referenced_workflows: [] },
    { path: ".github/workflows/other.yml" }, { id: 999 }, { run_attempt: 2 }, { display_title: "Cake QA approve 101" }]) {
    const g = world(); Object.assign(g.source, change);
    await assert.rejects(() => runQaApproval(["--plan-id", "101"], "/workspace/task", g.execute), failure);
    assert.equal(dispatches(g.calls).length, 0);
  }
});

test("malformed or foreign plan records cannot use a spoofed Actions creator to dispatch", async () => {
  for (const change of [{ creator: { login: "tyask", type: "User" } }, { creator: { login: "github-actions[bot]", type: "User" } },
    { environment: "Production" }, { sha: mainSha }, { payload: { ...makePlan(), secret: "PRIVATE_SENTINEL" } }]) {
    const g = world(); Object.assign(g.records[0], change);
    await assert.rejects(() => runQaApproval(["--plan-id", "101"], "/workspace/task", g.execute), failure);
    assert.equal(dispatches(g.calls).length, 0);
  }
});

test("provider errors, malformed JSON and secret-bearing executor errors are replaced by one fixed failure", async () => {
  for (const behavior of ["throw", "json", "status", "signal"] as const) {
    const execute: WorkflowExecutor = async () => {
      if (behavior === "throw") throw new Error("Bearer PRIVATE_SENTINEL");
      return { status: behavior === "status" ? 403 : 0, signal: behavior === "signal" ? "SIGTERM" : null,
        stdout: "PRIVATE_SENTINEL postgresql://secret" };
    };
    await assert.rejects(() => runQaApproval(["--plan-id", "101"], "/workspace/task", execute), (error: unknown) => {
      assert.equal(error instanceof Error && failure.test(error.message), true);
      assert.equal(error instanceof Error && /PRIVATE_SENTINEL|postgresql/.test(error.message), false);
      return true;
    });
  }
});

test("a failed approval dispatch is not reported as a successful request and exposes no raw CLI body", async () => {
  const g = world();
  const execute: WorkflowExecutor = async (command, args, cwd) => args[0] === "workflow"
    ? { status: 1, signal: null, stdout: "Bearer PRIVATE_SENTINEL" } : g.execute(command, args, cwd);
  await assert.rejects(() => runQaApproval(["--plan-id", "101"], "/workspace/task", execute), (error: unknown) => {
    assert.equal(error instanceof Error && error.message.includes("PRIVATE_SENTINEL"), false);
    return error instanceof Error && failure.test(error.message);
  });
});

test("CLI invalid invocation prints a fixed failure and never echoes injected arguments or stack details", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/qa-approve.ts", "--secret=PRIVATE_SENTINEL"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.match(result.stderr, failure);
  assert.equal(/PRIVATE_SENTINEL|Error:|at runQaApproval/.test(result.stderr), false);
});

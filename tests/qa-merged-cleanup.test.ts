import test from "node:test";
import assert from "node:assert/strict";
import { deletePlan, type DeletePlan } from "../lib/qa-pool-authorization";
import { runQaRequest } from "../lib/qa-pool-service";
import { runQaRequestWithWaiting } from "../lib/qa-pool-runner";
import { nextRecord, QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK, qaAlias,
  replayDeployments, type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord } from "../lib/qa-pool";
import { HttpQaGateway, type QaTransport } from "../scripts/qa-pool-writer";

const sha = "a".repeat(40), newerSha = "b".repeat(40), mergeSha = "c".repeat(40);
const leaseId = "00000000-0000-4000-8000-000000000042";
const timestamp = "2026-10-14T00:00:00.000Z", mergedAt = "2026-10-14T01:00:00.000Z";
const teamId = "team_D1Mcx2TdFWPKcypfu8KzNMub", aliasUid = "alias_merged_cleanup";
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-merged-cleanup",
  endpointId: "ep-merged-cleanup", host: "ep-merged-cleanup.mock.aws.neon.tech" };
type Call = { method: string; path: string; query: URLSearchParams; body?: unknown };

/** Exercise the real HTTP adapter and ledger replay without contacting any provider. */
class Fixture {
  records: GithubDeployment[] = [];
  calls: Call[] = [];
  logs: string[] = [];
  env: Record<string, string | undefined> = { GITHUB_TOKEN: "FAKE_GITHUB_TOKEN", VERCEL_TOKEN: "FAKE_VERCEL_TOKEN",
    NEON_API_KEY: "FAKE_NEON_TOKEN", CAKE_QA_APPROVED_HEADS: "{}", CAKE_QA_POOL_ENABLED: "false",
    CAKE_QA_PARENT_BRANCH_ID: "br-parent", CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.mock.aws.neon.tech" };
  pr = { number: 42, state: "closed", merged: true as unknown, merged_at: mergedAt as unknown, merge_commit_sha: mergeSha as unknown,
    head: { sha, ref: "codex/merged-cleanup", repo: { full_name: QA_REPOSITORY as string } },
    base: { ref: "main", repo: { full_name: QA_REPOSITORY as string } } };
  project = { id: QA_PROJECT_ID, name: "cake", accountId: teamId,
    previewDeploymentsDisabled: false,
    link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main", repoId: 1318171856 } };
  identity = structuredClone(database);
  nativePresent = true;
  nativeCleanupImmediate = true;
  alias: { uid: string; alias: string; projectId: string; deploymentId: string } | null = {
    uid: aliasUid, alias: qaAlias("qa1"), projectId: QA_PROJECT_ID, deploymentId: "dpl_application" };
  remotes = ["dpl_provisioning", "dpl_application"].map((id, index) => ({ id, projectId: QA_PROJECT_ID as string,
    target: "preview", readyState: index ? "READY" : "ERROR", gitSource: { ref: this.pr.head.ref, sha },
    meta: { githubCommitRef: this.pr.head.ref, githubCommitSha: sha, cakeQaPr: "42", cakeQaLeaseId: leaseId,
      cakeQaAttemptId: "00000000-0000-4000-8000-000000000100", cakeQaPhase: index ? "application" : "provisioning" } }));
  before?: (call: Call) => void;
  constructor(state: "held" | "deleting" = "held", purpose?: "probe") {
    this.append({ protocol: "cake-qa/v1", slot: "qa1", leaseId, pr: 42, branch: this.pr.head.ref,
      headSha: sha, state: "held", ...(purpose ? { purpose } : {}), createdAt: timestamp, updatedAt: timestamp,
      sequence: 1, previousRecordId: null, deployments: [], retiredDatabases: [] });
    this.update({ database, readyDeploymentId: "dpl_application", ...(purpose ? {} : { aliasSha: sha }),
      deployments: this.remotes.map(d => ({ id: d.id, sha, phase: d.meta.cakeQaPhase as "application" | "provisioning" })) });
    if (purpose) this.alias = null;
    if (state === "deleting") this.update({ state: "deleting", readyDeploymentId: undefined, aliasSha: undefined });
  }
  latest() { return replayDeployments(this.records).qa1!; }
  append(payload: QaLeaseRecord) {
    this.records.push({ id: (this.records.at(-1)?.id ?? 0) + 1, task: QA_TASK,
      environment: QA_ENVIRONMENT, sha: payload.headSha, payload: structuredClone(payload) });
  }
  update(changes: Partial<QaLeaseRecord>) { this.append(nextRecord(this.latest(), changes, timestamp)); }
  approve() { this.env.CAKE_QA_DELETE_APPROVALS = JSON.stringify([{ ...deletePlan(this.latest().payload), expiresAt: "2099-01-01T00:00:00.000Z" }]); }
  deletes() { return this.calls.filter(call => call.method === "DELETE"); }
  gateway() { return new HttpQaGateway(this.env, this.request, "write"); }
  async run(action: "close" | "refresh" | "release" = "close") {
    await runQaRequest(this.gateway(), { action, ...(action === "refresh" ? {} : { pr: 42 }),
      ...(action === "release" ? { leaseId } : {}) }, { now: () => timestamp, log: message => { this.logs.push(message); } });
  }
  request: QaTransport = async (method, address, _token, body) => {
    const url = new URL(address), path = url.pathname.replace(/^\/api\/v2(?=\/)/, "");
    const call = { method, path, query: url.searchParams, body }; this.calls.push(call); this.before?.(call);
    if (method === "GET") {
      assert.equal(body, undefined);
      if (path === `/repos/${QA_REPOSITORY}/deployments`) {
        assert.equal(url.searchParams.get("task"), QA_TASK, "automatic cleanup must not create or consume owner approval records");
        return { status: 200, data: structuredClone(this.records) };
      }
      if (path === `/repos/${QA_REPOSITORY}/pulls/42`) return { status: 200, data: structuredClone(this.pr) };
      if (path === `/repos/${QA_REPOSITORY}/actions/variables`) return { status: 200, data: { variables: [] } };
      if (path === `/v9/projects/${QA_PROJECT_ID}`) return { status: 200, data: structuredClone(this.project) };
      if (path === `/projects/${QA_NEON_PROJECT_ID}`) return { status: 200, data: { project: { id: QA_NEON_PROJECT_ID } } };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/branches/br-parent`) return { status: 200, data: {
        branch: { id: "br-parent", project_id: QA_NEON_PROJECT_ID } } };
      const branch = { id: this.identity.branchId, name: `preview/${this.latest().payload.branch}`, project_id: QA_NEON_PROJECT_ID,
        parent_id: "br-parent", default: false, protected: false, created_at: timestamp };
      const endpoint = { id: this.identity.endpointId, project_id: QA_NEON_PROJECT_ID, branch_id: this.identity.branchId,
        type: "read_write", host: this.identity.host };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/branches`) return { status: 200, data: {
        branches: this.nativePresent ? [branch] : [], pagination: { next: null } } };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`) return { status: 200, data: { endpoints: this.nativePresent ? [endpoint] : [] } };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/branches/${this.identity.branchId}`) return {
        status: this.nativePresent ? 200 : 404, data: this.nativePresent ? { branch } : null };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints/${this.identity.endpointId}`) return {
        status: this.nativePresent ? 200 : 404, data: this.nativePresent ? { endpoint } : null };
      if (path === "/v7/deployments") return { status: 200, data: { deployments: structuredClone(this.remotes), pagination: { next: null } } };
      if (path.startsWith("/v13/deployments/")) {
        const found = this.remotes.find(d => path === `/v13/deployments/${d.id}`);
        return { status: found ? 200 : 404, data: found ? structuredClone(found) : null };
      }
      if ([qaAlias("qa1"), aliasUid].some(value => path === `/v4/aliases/${value}`)) return {
        status: this.alias ? 200 : 404, data: structuredClone(this.alias) };
      if ([qaAlias("qa2"), qaAlias("qa3")].some(value => path === `/v4/aliases/${value}`)) return { status: 404, data: null };
    }
    if (method === "POST" && path === `/repos/${QA_REPOSITORY}/deployments`) {
      const posted = body as { task: string; payload: QaLeaseRecord };
      assert.equal(posted.task, QA_TASK, "no owner approval receipt may be synthesized");
      this.append(posted.payload);
      return { status: 201, data: structuredClone(this.records.at(-1)) };
    }
    if (method === "DELETE" && path === `/v2/aliases/${aliasUid}`) {
      assert.equal(url.searchParams.get("teamId"), teamId);
      this.alias = null; return { status: 200, data: { status: "SUCCESS" } };
    }
    if (method === "DELETE" && path.startsWith("/v13/deployments/")) {
      const index = this.remotes.findIndex(d => path === `/v13/deployments/${d.id}`);
      assert.ok(index >= 0, "cleanup may delete only the fixture's existing resources");
      this.remotes.splice(index, 1);
      if (!this.remotes.length && this.nativeCleanupImmediate) this.nativePresent = false;
      return { status: 200, data: { state: "DELETED" } };
    }
    assert.fail(`unexpected cleanup request: ${method} ${path}`);
  };
}

test("merged PR close deletes its complete QA lease without an approval record and verifies absence before free", async () => {
  const f = new Fixture();
  await f.run();
  assert.equal(f.latest().payload.state, "free");
  assert.deepEqual(f.latest().payload.deployments.map(d => d.id), ["dpl_provisioning", "dpl_application"]);
  assert.deepEqual(f.latest().payload.retiredDatabases, [database]);
  assert.deepEqual(f.deletes().map(call => call.path), [`/v2/aliases/${aliasUid}`, "/v13/deployments/dpl_provisioning", "/v13/deployments/dpl_application"]);
  assert.equal(f.alias, null); assert.equal(f.remotes.length, 0); assert.equal(f.nativePresent, false);
  assert.ok(f.calls.some(call => call.method === "GET" && call.path.endsWith(`/branches/${database.branchId}`)));
  assert.ok(f.calls.some(call => call.method === "GET" && call.path.endsWith(`/endpoints/${database.endpointId}`)));
  assert.ok(f.calls.filter(call => call.method === "POST").every(call => (call.body as { task: string }).task === QA_TASK));
});

test("closed event runner waits for Native disappearance and frees the same lease without a scheduled run", async () => {
  const f = new Fixture(); f.nativeCleanupImmediate = false;
  let clock = 0, sleeps = 0;
  await runQaRequestWithWaiting(f.gateway(), { action: "close", pr: 42 }, {
    now: () => clock, timeoutMs: 100, pollIntervalMs: 10, log: () => {},
    sleep: async (delay) => { clock += delay; sleeps++; f.nativePresent = false; },
  });
  assert.equal(sleeps, 1); assert.equal(f.latest().payload.state, "free");
  assert.equal(f.deletes().length, 3);
  assert.ok(f.calls.filter(call => call.path.includes("/pulls/")).every(call => call.path.endsWith("/42")));
});

test("cleanup timeout fails the run, retains deleting, and exact manual release resumes after Native completion", async () => {
  const f = new Fixture(); f.nativeCleanupImmediate = false;
  let clock = 0;
  await assert.rejects(() => runQaRequestWithWaiting(f.gateway(), { action: "close", pr: 42 }, {
    now: () => clock, timeoutMs: 20, pollIntervalMs: 10, log: () => {}, sleep: async (delay) => { clock += delay; },
  }), /待機上限/);
  assert.equal(f.latest().payload.state, "deleting"); assert.equal(f.deletes().length, 3);
  f.nativePresent = false;
  await runQaRequestWithWaiting(f.gateway(), { action: "release", pr: 42, leaseId }, { log: () => {} });
  assert.equal(f.latest().payload.state, "free"); assert.equal(f.deletes().length, 3);
});

test("a changed lease snapshot during event waiting stops the run without freeing the replacement", async () => {
  const f = new Fixture(); f.nativeCleanupImmediate = false;
  let clock = 0;
  await assert.rejects(() => runQaRequestWithWaiting(f.gateway(), { action: "close", pr: 42 }, {
    now: () => clock, timeoutMs: 20, pollIntervalMs: 10, log: () => {}, sleep: async (delay) => { clock += delay; f.update({}); },
  }), /貸出世代/);
  assert.equal(f.latest().payload.state, "deleting"); assert.equal(f.deletes().length, 3);
});

test("approval waits and unknown intents do not turn into event polling or automatic deletion", async () => {
  for (const mode of ["unmerged", "intent"] as const) {
    const f = new Fixture();
    if (mode === "unmerged") f.pr.merged = false;
    else f.update({ intent: { sha, phase: "application", attemptId: "00000000-0000-4000-8000-000000000999", startedAt: timestamp } });
    await runQaRequestWithWaiting(f.gateway(), { action: "close", pr: 42 }, {
      log: () => {}, sleep: async () => { assert.fail("ambiguous or unapproved operations must not poll"); },
    });
    assert.equal(f.latest().payload.state, "deleting"); assert.equal(f.deletes().length, 0);
  }
});

test("provider failures stop event waiting immediately and retain the recorded deletion targets", async () => {
  const f = new Fixture();
  f.before = (call) => { if (call.method === "DELETE") throw new Error("simulated provider failure"); };
  await assert.rejects(() => runQaRequestWithWaiting(f.gateway(), { action: "close", pr: 42 }, {
    log: () => {}, sleep: async () => { assert.fail("failed mutations must not be retried blindly"); },
  }));
  assert.equal(f.latest().payload.state, "deleting"); assert.equal(f.remotes.length, 2);
});

test("Native cleanup delay retains deleting and explicit refresh releases without another approval or DELETE", async () => {
  const f = new Fixture(); f.nativeCleanupImmediate = false;
  await f.run();
  assert.equal(f.latest().payload.state, "deleting"); assert.equal(f.nativePresent, true);
  assert.equal(f.remotes.length, 0); assert.equal(f.deletes().length, 3);
  f.nativePresent = false;
  await f.run("refresh");
  assert.equal(f.latest().payload.state, "free"); assert.equal(f.deletes().length, 3);
});

test("live owner-flow configuration needs no preview receipt or legacy head approval for a closed merged PR", async () => {
  const f = new Fixture(); f.env.QA_OWNER_FLOW = "true"; f.env.CAKE_QA_APPROVED_HEADS = "invalid legacy preview data";
  await f.run();
  assert.equal(f.latest().payload.state, "free"); assert.equal(f.deletes().length, 3);
  assert.equal(f.calls.some(call => call.path.includes("/actions/runs")), false);
});

test("read-only plan-release explains automatic merged cleanup and redacts private DB host", async () => {
  const f = new Fixture("deleting"), before = structuredClone(f.records); f.env.QA_OWNER_FLOW = "true";
  const report = await new HttpQaGateway(f.env, f.request).inspect({ action: "plan-release", pr: 42, leaseId });
  const plan = report.plan as { automaticMergedCleanup: boolean; approvalManifestRequiresPrivateHost: boolean;
    databaseDataLossRequiresApproval: boolean; dataLossNotice: string };
  assert.equal(plan.automaticMergedCleanup, true); assert.equal(plan.approvalManifestRequiresPrivateHost, false);
  assert.equal(plan.databaseDataLossRequiresApproval, false); assert.ok(plan.dataLossNotice);
  assert.ok(report.checks.every(check => check.ok));
  assert.equal(JSON.stringify(report).includes(database.host), false);
  assert.ok(f.calls.every(call => call.method === "GET")); assert.deepEqual(f.records, before);
});

test("merged cleanup retains the recorded QA SHA when the final PR head was not previewed", async () => {
  const f = new Fixture(); f.pr.head.sha = newerSha;
  await f.run();
  assert.equal(f.latest().payload.state, "free"); assert.equal(f.latest().payload.headSha, sha);
  assert.ok(f.latest().payload.deployments.every(d => d.sha === sha));
});

test("unmerged close and open-PR manual release await exact approval, which still permits their cleanup", async () => {
  for (const state of ["closed", "open"] as const) {
    const f = new Fixture(); f.pr.state = state; f.pr.merged = false; f.pr.merged_at = null; f.pr.merge_commit_sha = null;
    const action = state === "closed" ? "close" : "release";
    await f.run(action);
    assert.equal(f.latest().payload.state, "deleting"); assert.equal(f.deletes().length, 0);
    f.approve(); await f.run("release");
    assert.equal(f.latest().payload.state, "free"); assert.equal(f.deletes().length, 3);
  }
});

test("automatic cleanup requires explicit valid merge evidence and the same main/source repository and feature branch", async () => {
  const invalid: Array<(f: Fixture) => void> = [
    f => { f.pr.merged = undefined; }, f => { f.pr.merged = "true"; }, f => { f.pr.merged = false; },
    f => { f.pr.state = "open"; }, f => { f.pr.number = 43; },
    f => { f.pr.merged_at = null; }, f => { f.pr.merged_at = "invalid"; },
    f => { f.pr.merge_commit_sha = null; }, f => { f.pr.merge_commit_sha = "short"; },
    f => { f.pr.head.repo.full_name = "foreign/Cake"; }, f => { f.pr.base.repo.full_name = "foreign/Cake"; },
    f => { f.pr.base.ref = "develop"; }, f => { f.pr.head.ref = "codex/other-task"; }, f => { f.pr.head.sha = "short"; },
  ];
  for (const invalidate of invalid) {
    const f = new Fixture("deleting"); invalidate(f);
    assert.equal(await f.gateway().deletionApproved(deletePlan(f.latest().payload)), false);
    assert.equal(f.deletes().length, 0);
  }
});

test("automatic cleanup accepts only the current deleting lease's exact complete resource plan", async () => {
  const mutate: Array<(plan: DeletePlan) => void> = [
    plan => { plan.leaseId = "00000000-0000-4000-8000-000000000043"; },
    plan => { plan.headSha = newerSha; }, plan => { plan.pr = 43; }, plan => { plan.slot = "qa2"; },
    plan => { plan.deploymentIds.pop(); }, plan => { plan.deploymentIds.push("dpl_foreign"); },
    plan => { plan.alias = null; }, plan => { plan.database = { ...database, branchId: "br-foreign" }; },
  ];
  for (const change of mutate) {
    const f = new Fixture("deleting"), plan = deletePlan(f.latest().payload); change(plan);
    assert.equal(await f.gateway().deletionApproved(plan), false);
    assert.equal(f.deletes().length, 0);
  }
  const held = new Fixture();
  assert.equal(await held.gateway().deletionApproved(deletePlan(held.latest().payload)), false);
});

test("a lease generation change during GitHub merge verification invalidates automatic authorization", async () => {
  const f = new Fixture("deleting"), plan = deletePlan(f.latest().payload);
  f.before = call => {
    if (call.method === "GET" && call.path.endsWith("/pulls/42")) { f.before = undefined; f.update({}); }
  };
  assert.equal(await f.gateway().deletionApproved(plan), false);
  assert.equal(f.deletes().length, 0);
});

test("manual fallback rejects an approval that expires during the live merge-policy reads", async () => {
  const f = new Fixture("deleting"), actualNow = Date.now, startedAt = actualNow(); let clock = startedAt;
  f.pr.merged = false;
  f.env.CAKE_QA_DELETE_APPROVALS = JSON.stringify([{ ...deletePlan(f.latest().payload), expiresAt: new Date(startedAt + 1).toISOString() }]);
  f.before = call => { if (call.path.endsWith("/pulls/42")) clock = startedAt + 2; };
  Date.now = () => clock;
  try { assert.equal(await f.gateway().deletionApproved(deletePlan(f.latest().payload)), false); }
  finally { Date.now = actualNow; }
  assert.equal(f.deletes().length, 0);
});

test("merge eligibility is checked again after alias removal before deleting deployments", async () => {
  const f = new Fixture();
  f.before = call => {
    if (call.method === "GET" && call.path.endsWith("/pulls/42") && !f.alias) f.pr.merged = false;
  };
  await assert.rejects(() => f.run());
  assert.equal(f.latest().payload.state, "deleting");
  assert.deepEqual(f.deletes().map(call => call.path), [`/v2/aliases/${aliasUid}`]);
  assert.equal(f.remotes.length, 2); assert.equal(f.nativePresent, true);
});

test("merged probe leases retain manual deletion approval", async () => {
  const f = new Fixture("deleting", "probe");
  await f.run();
  assert.equal(f.latest().payload.state, "deleting"); assert.equal(f.deletes().length, 0);
  f.approve(); await f.run("release");
  assert.equal(f.latest().payload.state, "free");
  assert.equal(f.deletes().some(call => call.path.startsWith("/v2/aliases/")), false);
});

test("merge does not authorize unknown creation intents, foreign resources, production targets, or changed DB identity", async () => {
  const invalid: Array<(f: Fixture) => void> = [
    f => { f.update({ intent: { sha, phase: "application", attemptId: "00000000-0000-4000-8000-000000000999", startedAt: timestamp } }); },
    f => { f.remotes[0].projectId = "prj_foreign"; }, f => { f.remotes[0].target = "production"; },
    f => { f.remotes[0].meta.cakeQaLeaseId = "00000000-0000-4000-8000-000000000043"; },
    f => { f.remotes.push({ ...structuredClone(f.remotes[0]), id: "dpl_unrecorded" }); },
    f => { f.alias!.deploymentId = "dpl_foreign"; },
    f => { f.identity.endpointId = "ep-replaced"; },
    f => { f.identity.host = f.env.CAKE_QA_PRODUCTION_DATABASE_HOST!; },
  ];
  for (const invalidate of invalid) {
    const f = new Fixture(); invalidate(f);
    await f.run("refresh");
    assert.equal(f.latest().payload.state, "deleting"); assert.equal(f.deletes().length, 0);
  }
});

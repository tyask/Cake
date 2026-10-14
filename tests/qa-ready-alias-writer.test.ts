import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliasPlan, deletePlan } from "../lib/qa-pool-authorization";
import { QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK, qaAlias, parseLeaseRecord,
  type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord } from "../lib/qa-pool";
import { HttpQaGateway, runQaWriter, type QaTransport } from "../scripts/qa-pool-writer";

const sha = "a".repeat(40), mainSha = "b".repeat(40);
const leaseId = "00000000-0000-4000-8000-000000000037";
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-test", endpointId: "ep-test",
  host: "ep-test.ap-southeast-1.aws.neon.tech" };
const initial = (): QaLeaseRecord => ({ protocol: "cake-qa/v1", purpose: "probe", slot: "qa1", leaseId,
  pr: 37, branch: "codex/task-37", headSha: sha, state: "held", createdAt: "2026-10-13T00:00:00Z",
  updatedAt: "2026-10-13T00:00:00Z", sequence: 1, previousRecordId: null, deployments: [], retiredDatabases: [] });
const ready = (): QaLeaseRecord => ({ ...initial(), sequence: 2, previousRecordId: 1, database,
  deployments: [{ id: "dpl_test", sha, phase: "application" }], readyDeploymentId: "dpl_test" });
const pending = (): QaLeaseRecord => ({ ...ready(), sequence: 3, previousRecordId: 2,
  aliasAssignment: { alias: qaAlias("qa1"), deploymentId: "dpl_test", sha, state: "pending" } });
function gitFile() {
  const content = Buffer.from(JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true } } }));
  return { type: "file", name: "vercel.json", path: "vercel.json", encoding: "base64", size: content.length,
    content: content.toString("base64"), sha: createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex") };
}
class Fixture {
  env: Record<string, string | undefined> = { GITHUB_TOKEN: "test-gh-token", VERCEL_TOKEN: "test-vercel-token", NEON_API_KEY: "test-neon-key",
    CAKE_QA_APPROVED_HEADS: "", CAKE_QA_PARENT_BRANCH_ID: "br-parent",
    CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.ap-southeast-1.aws.neon.tech" };
  record = pending();
  records: GithubDeployment[] = [initial(), ready(), this.record].map((payload, i) => ({ id: i + 1,
    task: QA_TASK, environment: QA_ENVIRONMENT, sha: payload.headSha, payload: structuredClone(payload) }));
  pr = { number: 37, state: "open", head: { ref: "codex/task-37", sha, repo: { full_name: QA_REPOSITORY } }, base: { ref: "main" } };
  remote = { id: "dpl_test", projectId: QA_PROJECT_ID, target: null as string | null, readyState: "READY",
    gitSource: { ref: this.pr.head.ref, sha }, meta: { githubCommitRef: this.pr.head.ref, githubCommitSha: sha,
      cakeQaPr: "37", cakeQaLeaseId: leaseId, cakeQaAttemptId: "00000000-0000-4000-8000-000000000100", cakeQaPhase: "application" } };
  identity = structuredClone(database);
  assigned: { projectId: string; deploymentId: string } | null = null;
  calls: { method: string; path: string; body?: unknown }[] = [];
  beforeRead?: (path: string) => void;
  request: QaTransport = async (method, address, _token, body) => {
    const url = new URL(address), path = url.pathname.replace(/^\/api\/v2(?=\/)/, "");
    this.calls.push({ method, path, body });
    if (method === "GET") this.beforeRead?.(path);
    if (path === `/repos/${QA_REPOSITORY}/deployments`) {
      if (method === "GET") return { status: 200, data: structuredClone(this.records) };
      const value = body as { payload: QaLeaseRecord; ref: string; task: string; environment: string };
      const saved = { id: this.records.length + 1, sha: value.ref, task: value.task, environment: value.environment, payload: structuredClone(value.payload) };
      this.records.push(saved); return { status: 201, data: structuredClone(saved) };
    }
    if (method === "GET" && path === `/repos/${QA_REPOSITORY}/pulls/37`) return { status: 200, data: structuredClone(this.pr) };
    if (method === "GET" && path === `/repos/${QA_REPOSITORY}/branches/main`) return { status: 200, data: { name: "main", commit: { sha: mainSha } } };
    if (method === "GET" && path === `/repos/${QA_REPOSITORY}/contents/vercel.json`) {
      assert.ok([sha, mainSha].includes(url.searchParams.get("ref") ?? "")); return { status: 200, data: gitFile() };
    }
    if (method === "GET" && path === `/v9/projects/${QA_PROJECT_ID}`) return { status: 200, data: {
      id: QA_PROJECT_ID, name: "cake", accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub", previewDeploymentsDisabled: false,
      link: { type: "github", org: "tyask", repo: "Cake", repoId: 1318171856, productionBranch: "main" } } };
    if (method === "GET" && path === `/projects/${QA_NEON_PROJECT_ID}`) return { status: 200, data: { project: { id: QA_NEON_PROJECT_ID } } };
    if (method === "GET" && path === `/projects/${QA_NEON_PROJECT_ID}/branches`) return { status: 200, data: { branches: [{
      id: this.identity.branchId, name: `preview/${this.pr.head.ref}`, project_id: QA_NEON_PROJECT_ID, parent_id: "br-parent",
      default: false, protected: false, created_at: "2026-10-13T00:01:00Z" }], pagination: { next: null } } };
    if (method === "GET" && path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`) return { status: 200, data: { endpoints: [{
      id: this.identity.endpointId, project_id: QA_NEON_PROJECT_ID, branch_id: this.identity.branchId, type: "read_write", host: this.identity.host }] } };
    if (method === "GET" && path === "/v13/deployments/dpl_test") return { status: 200, data: structuredClone(this.remote) };
    if (method === "GET" && path === "/v7/deployments") return { status: 200, data: { deployments: [structuredClone(this.remote)], pagination: { next: null } } };
    if (method === "GET" && [qaAlias("qa1"), "alias_ready_fixture"].some((identifier) => path === `/v4/aliases/${identifier}`)) {
      return { status: this.assigned ? 200 : 404,
        data: this.assigned ? { ...this.assigned, uid: "alias_ready_fixture", alias: qaAlias("qa1") } : null };
    }
    if (method === "POST" && path === "/v2/deployments/dpl_test/aliases") {
      this.assigned = { projectId: QA_PROJECT_ID, deploymentId: "dpl_test" }; return { status: 200, data: this.assigned };
    }
    if (method === "DELETE" && path === "/v2/aliases/alias_ready_fixture") {
      assert.equal(url.searchParams.get("teamId"), "team_D1Mcx2TdFWPKcypfu8KzNMub");
      this.assigned = null; return { status: 200, data: { status: "SUCCESS" } };
    }
    assert.fail(`unexpected test transport: ${method} ${path}`);
  };
  gateway() { return new HttpQaGateway(this.env, this.request, "write"); }
  approve() { this.env.CAKE_QA_ALIAS_APPROVALS = JSON.stringify([{ ...aliasPlan(this.record, "dpl_test"), expiresAt: "2099-01-01T00:00:00Z" }]); }
  aliasPosts() { return this.calls.filter((c) => c.method === "POST" && c.path.includes("/aliases")); }
  async assign() { return this.gateway().assignReadyAlias(this.record, {
    id: "dpl_test", projectId: QA_PROJECT_ID, target: null, branch: this.record.branch, sha, leaseId, pr: 37,
    attemptId: this.remote.meta.cakeQaAttemptId, phase: "application", state: "READY",
  }, aliasPlan(this.record, "dpl_test")); }
}

test("alias gatewayはprobeの保存済みpendingと完全承認で既存READYだけを割り当てる", async () => {
  const f = new Fixture(); f.approve(); await f.assign();
  assert.equal(f.aliasPosts().length, 1);
  assert.ok(f.calls.every((c) => c.method === "GET" || c.path === "/v2/deployments/dpl_test/aliases"));
  assert.equal(f.calls.some((c) => c.path.endsWith("/pulls") || c.path === "/v13/deployments"), false);
  assert.equal(f.records.length, 3);
});

test("alias POST直前のPR/lease/READY/DB/別alias/承認取消を再照合して拒否する", async () => {
  for (const failure of ["sha", "closed", "ready", "project", "lease", "database", "alias", "expired", "ledger"] as const) {
    const f = new Fixture(); f.approve();
    if (failure === "sha") f.pr.head.sha = mainSha;
    if (failure === "closed") f.pr.state = "closed";
    if (failure === "ready") f.remote.readyState = "ERROR";
    if (failure === "project") f.remote.projectId = "prj_foreign";
    if (failure === "lease") f.remote.meta.cakeQaLeaseId = "00000000-0000-4000-8000-000000000999";
    if (failure === "database") f.identity.branchId = "br-other";
    if (failure === "alias") f.assigned = { projectId: QA_PROJECT_ID, deploymentId: "dpl_foreign" };
    if (failure === "expired") f.beforeRead = (path) => { if (path.startsWith("/v4/aliases/")) f.env.CAKE_QA_ALIAS_APPROVALS = "[]"; };
    if (failure === "ledger") f.records[2].payload = { ...f.record, updatedAt: "2026-10-13T00:02:00Z" };
    await assert.rejects(() => f.assign()); assert.equal(f.aliasPosts().length, 0, failure);
  }
});

test("既存exact aliasはGETで認識しPOSTしない", async () => {
  const f = new Fixture(); f.approve(); f.assigned = { projectId: QA_PROJECT_ID, deploymentId: "dpl_test" };
  await f.assign(); assert.equal(f.aliasPosts().length, 0);
});

test("alias直前のREADY再GETが同leaseの別記録IDを返しても拒否する", async () => {
  const f = new Fixture();
  const extra = { id: "dpl_other", sha, phase: "application" as const };
  for (const row of f.records.slice(1)) (row.payload as QaLeaseRecord).deployments.push(extra);
  f.record.deployments.push(extra); f.approve(); f.remote.id = extra.id;
  await assert.rejects(() => f.assign()); assert.equal(f.aliasPosts().length, 0);
});

test("空・未設定・空白のhead承認は空として扱い不正な非空JSONを拒否する", async () => {
  for (const value of [undefined, "", " \n\t", "{}"] as const) {
    const f = new Fixture(); f.env.CAKE_QA_APPROVED_HEADS = value;
    assert.equal((await f.gateway().pullRequest(37)).approved, false);
  }
  for (const value of ["{", "null", "[]", "true", JSON.stringify({ "37": sha.slice(0, 7) }), JSON.stringify({ "037": sha }),
    JSON.stringify({ "-1": sha }), JSON.stringify({ "9007199254740992": sha }), JSON.stringify({ "37": 1 })]) {
    const f = new Fixture(); f.env.CAKE_QA_APPROVED_HEADS = value;
    await assert.rejects(() => f.gateway().pullRequest(37), /SHA設定/);
  }
  const f = new Fixture(); f.env.CAKE_QA_APPROVED_HEADS = JSON.stringify({ "37": sha });
  assert.equal((await f.gateway().pullRequest(37)).approved, true);
  f.pr.head.sha = mainSha; assert.equal((await f.gateway().pullRequest(37)).approved, false);
});

test("tracked probeのalias DELETEは全manifestと直前の別割当を照合する", async () => {
  for (const foreign of [false, true]) {
    const f = new Fixture();
    const assigned: QaLeaseRecord = { ...f.record, sequence: 4, previousRecordId: 3,
      aliasAssignment: { ...f.record.aliasAssignment!, state: "assigned" } };
    f.record = parseLeaseRecord({ ...assigned, sequence: 5, previousRecordId: 4, state: "deleting", readyDeploymentId: undefined });
    for (const payload of [assigned, f.record]) f.records.push({ id: payload.sequence, task: QA_TASK,
      environment: QA_ENVIRONMENT, sha, payload: structuredClone(payload) });
    f.assigned = { projectId: QA_PROJECT_ID, deploymentId: foreign ? "dpl_foreign" : "dpl_test" };
    const plan = deletePlan(f.record);
    f.env.CAKE_QA_DELETE_APPROVALS = JSON.stringify([{ ...plan, expiresAt: "2099-01-01T00:00:00Z" }]);
    if (foreign) await assert.rejects(() => f.gateway().deleteAlias(f.record, plan));
    else await f.gateway().deleteAlias(f.record, plan);
    assert.equal(f.calls.filter((c) => c.method === "DELETE").length, foreign ? 0 : 1);
  }
});

test("Actions closed eventは対象PRだけdeletingへ進め承認がなければ保持する", async () => {
  const f = new Fixture(); f.record = ready(); f.records = f.records.slice(0, 2); f.pr.state = "closed";
  const dir = await mkdtemp(join(tmpdir(), "cake-closed-event-"));
  try {
    const path = join(dir, "event.json"); await writeFile(path, JSON.stringify({ action: "closed", number: 37 }));
    await runQaWriter({ ...f.env, EVENT_PATH: path, EVENT_NAME: "pull_request_target", GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: QA_REPOSITORY, GITHUB_REF: "refs/heads/main" }, undefined, undefined, f.request);
    assert.equal((f.records.at(-1)!.payload as QaLeaseRecord).state, "deleting");
    assert.equal(f.calls.some((c) => c.path.endsWith("/pulls") || c.method === "DELETE" || c.path === "/v13/deployments"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider exception本文を呼出元エラーへ転記しない", async () => {
  const f = new Fixture();
  const g = new HttpQaGateway(f.env, async () => { throw new Error(`provider ${database.host} ${f.env.VERCEL_TOKEN}`); });
  await assert.rejects(() => g.pullRequest(37), (error: Error) => {
    assert.equal(error.message.includes(database.host), false);
    assert.equal(error.message.includes(f.env.VERCEL_TOKEN!), false); return true;
  });
});

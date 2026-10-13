import test from "node:test";
import assert from "node:assert/strict";
import { aliasApproval, aliasPlan, deletePlan, deletionApproval, type AliasApproval, type AliasPlan, type DeleteApproval, type DeletePlan } from "../lib/qa-pool-authorization";
import { runQaRequest, type AliasTarget, type QaGateway, type QaGateTarget, type QaPullRequest, type QaRequest, type RemoteDeployment } from "../lib/qa-pool-service";
import { nextRecord, qaAlias, replayDeployments, QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK,
  type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord, type SavedLease, type Slot } from "../lib/qa-pool";

const sha = "a".repeat(40), otherSha = "b".repeat(40), now = "2026-10-13T01:00:00.000Z", expiresAt = "2026-10-13T02:00:00.000Z";
const token = "00000000-0000-4000-8000-000000000037";
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-alias-test", endpointId: "ep-alias-test", host: "ep-alias-test.test.aws.neon.tech" };
function lease(pr = 37, slot: Slot = "qa1"): QaLeaseRecord {
  return { protocol: "cake-qa/v1", pr, slot, leaseId: pr === 37 ? token : "00000000-0000-4000-8000-000000000038", branch: `codex/task-${pr}`,
    headSha: sha, state: "held", purpose: "probe", sequence: 1, previousRecordId: null, createdAt: now, updatedAt: now, deployments: [], retiredDatabases: [] };
}
class AliasGateway implements QaGateway {
  rows: GithubDeployment[] = [];
  calls: string[] = [];
  prs = new Map<number, QaPullRequest>();
  remotes = new Map<string, RemoteDeployment>();
  aliases = new Map<Slot, AliasTarget>();
  approvals: AliasApproval[] = [];
  deleteApprovals: DeleteApproval[] = [];
  native: DatabaseIdentity | null = database;
  gone = false;
  expired = false;
  poolReads = 0;
  onPool?: () => void;
  onSave?: (record: QaLeaseRecord) => void;
  onAlias?: () => void;
  assignBehavior: "ok" | "lost" | "unknown" = "ok";
  failAssignedSave = false;
  failDelete = false;
  constructor() {
    this.seed(lease());
    const current = this.latest();
    this.append(nextRecord(current, { database, deployments: [{ id: "dpl_provisioning", sha, phase: "provisioning" }, { id: "dpl_ready", sha, phase: "application" }], readyDeploymentId: "dpl_ready" }, now));
    const record = this.latest().payload;
    for (const d of record.deployments) this.remotes.set(d.id, { ...this.remote(record), id: d.id, phase: d.phase, state: d.phase === "application" ? "READY" : "ERROR" });
    this.approvals = [{ ...aliasPlan(record, "dpl_ready"), expiresAt }];
  }
  remote(record: QaLeaseRecord): RemoteDeployment {
    return { id: "dpl_ready", projectId: QA_PROJECT_ID, target: null, branch: record.branch, sha: record.headSha, leaseId: record.leaseId, pr: record.pr,
      attemptId: "00000000-0000-4000-8000-000000000999", phase: "application", state: "READY", url: "https://alias-test.vercel.app" };
  }
  seed(record: QaLeaseRecord) {
    this.append(record);
    this.prs.set(record.pr, { number: record.pr, state: "open", branch: record.branch, sha: record.headSha, repository: QA_REPOSITORY, base: "main", approved: false });
  }
  append(record: QaLeaseRecord): SavedLease {
    const row = { id: this.rows.length + 1, task: QA_TASK, environment: QA_ENVIRONMENT, sha: record.headSha, payload: structuredClone(record) };
    replayDeployments([...this.rows, row]); this.rows.push(row);
    return { id: row.id, payload: structuredClone(record) };
  }
  latest(slot: Slot = "qa1") { return replayDeployments(this.rows)[slot]!; }
  async pool() { this.poolReads += 1; this.onPool?.(); return replayDeployments(this.rows); }
  async save(record: QaLeaseRecord) {
    this.calls.push(`save:${record.state}:${record.aliasAssignment?.state ?? "none"}`);
    if (this.failAssignedSave && record.aliasAssignment?.state === "assigned") throw new Error("ledger response unavailable");
    const saved = this.append(record); this.onSave?.(record); return saved;
  }
  async pullRequest(pr: number) { this.calls.push(`pr:${pr}`); return structuredClone(this.prs.get(pr)!); }
  async openPullRequests(): Promise<QaPullRequest[]> { this.calls.push("openPRs"); throw new Error("must not enumerate PRs"); }
  generationEnabled() { this.calls.push("generationEnabled"); return true; }
  async assertGate(mode: "create" | "probe" | "cleanup" | "alias", target?: QaGateTarget) {
    this.calls.push(`gate:${mode}`); if (mode !== "cleanup") assert.deepEqual(target, { pr: 37, branch: "codex/task-37", sha });
  }
  probeAuthorization(): null { throw new Error("must not use generation approval"); }
  aliasApproved(plan: AliasPlan) { return aliasApproval(JSON.stringify(this.approvals), plan, Date.parse(this.expired ? expiresAt : now)); }
  async deployments(record: QaLeaseRecord) { this.calls.push("deployments"); return [...this.remotes.values()].filter((d) => d.branch === record.branch).map((d) => structuredClone(d)); }
  async deployment(id: string) { this.calls.push(`get:${id}`); return structuredClone(this.remotes.get(id) ?? null); }
  async create(): Promise<RemoteDeployment> { this.calls.push("create"); throw new Error("must not create"); }
  async database() { this.calls.push("database"); return structuredClone(this.native); }
  async databaseGone() { this.calls.push("databaseGone"); return this.gone; }
  async alias(slot: Slot) { this.calls.push(`alias:${slot}`); this.onAlias?.(); return structuredClone(this.aliases.get(slot) ?? null); }
  async assignAlias() { this.calls.push("normalAlias"); throw new Error("must not use normal alias"); }
  async assignReadyAlias(record: QaLeaseRecord, deployment: RemoteDeployment, plan: AliasPlan) {
    assert.deepEqual(record.aliasAssignment, { alias: qaAlias(record.slot), deploymentId: deployment.id, sha, state: "pending" });
    assert.ok(this.aliasApproved(plan)); this.calls.push("aliasPOST");
    if (this.assignBehavior !== "unknown") this.aliases.set(record.slot, { projectId: QA_PROJECT_ID, deploymentId: deployment.id });
    if (this.assignBehavior !== "ok") throw new Error("alias response unavailable");
  }
  deletionApproved(plan: DeletePlan) { return deletionApproval(JSON.stringify(this.deleteApprovals), plan, Date.parse(now)); }
  async deleteAlias(record: QaLeaseRecord, plan: DeletePlan) {
    assert.ok(this.deletionApproved(plan)); assert.equal(plan.alias, qaAlias(record.slot)); this.calls.push("aliasDELETE"); this.aliases.delete(record.slot);
  }
  async deleteDeployment(_record: QaLeaseRecord, deployment: RemoteDeployment, plan: DeletePlan) {
    assert.ok(this.deletionApproved(plan)); this.calls.push(`delete:${deployment.id}`); if (this.failDelete) throw new Error("delete unavailable"); this.remotes.delete(deployment.id);
  }
  request(): QaRequest { return { action: "alias-only", pr: 37, sha, slot: "qa1", leaseId: token, deploymentId: "dpl_ready" }; }
  run(request = this.request()) { return runQaRequest(this, request, { now: () => now, log: () => undefined }); }
  approveCleanup() { this.deleteApprovals = [{ ...deletePlan(this.latest().payload), expiresAt }]; }
  pending() { this.append(nextRecord(this.latest(), { aliasAssignment: { alias: qaAlias("qa1"), deploymentId: "dpl_ready", sha, state: "pending" } }, now)); }
}
function assertBounded(g: AliasGateway) {
  assert.equal(g.calls.some((c) => ["create", "openPRs", "generationEnabled", "normalAlias", "gate:create", "gate:probe"].includes(c)), false);
  assert.equal(g.calls.some((c) => c === "pr:38"), false);
}

test("alias-only keeps probe and all recorded IDs, persists pending before POST, and never touches another PR", async () => {
  const g = new AliasGateway(); g.seed(lease(38, "qa2")); g.prs.get(38)!.state = "closed";
  const other = structuredClone(g.latest("qa2")); await g.run();
  const record = g.latest().payload;
  assert.equal(record.purpose, "probe"); assert.equal(record.aliasSha, undefined);
  assert.deepEqual(record.aliasAssignment, { alias: qaAlias("qa1"), deploymentId: "dpl_ready", sha, state: "assigned" });
  assert.deepEqual(record.deployments.map((d) => d.id), ["dpl_provisioning", "dpl_ready"]);
  assert.deepEqual(g.latest("qa2"), other);
  assert.ok(g.calls.indexOf("save:held:pending") < g.calls.indexOf("aliasPOST"));
  assert.ok(g.calls.indexOf("aliasPOST") < g.calls.indexOf("save:held:assigned")); assertBounded(g);
  const count = g.rows.length; await g.run(); assert.equal(g.rows.length, count); assert.equal(g.calls.filter((c) => c === "aliasPOST").length, 1);
});

test("every explicit alias-only input is required and no missing target can claim a lease", async () => {
  for (const key of ["pr", "sha", "slot", "leaseId", "deploymentId"] as const) {
    const g = new AliasGateway(), request = g.request(); delete request[key];
    await assert.rejects(() => g.run(request)); assert.equal(g.rows.length, 2); assertBounded(g);
  }
  const g = new AliasGateway(); await assert.rejects(() => g.run({ ...g.request(), slot: "qa3" }), /既存貸出/);
  assert.equal(g.rows.length, 2); assertBounded(g);
});

test("stale PR, lease, SHA, normal purpose, missing DB and non-READY or foreign deployments fail before pending", async () => {
  for (const failure of ["pr", "lease", "sha", "closed", "head", "purpose", "database", "target", "project", "phase", "state", "gone"] as const) {
    const g = new AliasGateway(), request = g.request();
    if (failure === "pr") request.pr = 38;
    if (failure === "lease") request.leaseId = "00000000-0000-4000-8000-000000000038";
    if (failure === "sha") request.sha = otherSha;
    if (failure === "closed") g.prs.get(37)!.state = "closed";
    if (failure === "head") g.prs.get(37)!.sha = otherSha;
    if (failure === "purpose") (g.rows[1].payload as QaLeaseRecord).purpose = undefined;
    if (failure === "database") g.native = null;
    if (failure === "target") g.remotes.get("dpl_ready")!.target = "production";
    if (failure === "project") g.remotes.get("dpl_ready")!.projectId = "prj_other";
    if (failure === "phase") g.remotes.get("dpl_ready")!.phase = "provisioning";
    if (failure === "state") g.remotes.get("dpl_ready")!.state = "ERROR";
    if (failure === "gone") g.remotes.delete("dpl_ready");
    await assert.rejects(() => g.run(request), failure);
    assert.equal(g.rows.length, 2, failure); assert.equal(g.calls.includes("aliasPOST"), false, failure); assertBounded(g);
  }
});

test("foreign aliases, including another recorded deployment, are never overwritten", async () => {
  for (const deploymentId of ["dpl_foreign", "dpl_provisioning"]) {
    const g = new AliasGateway(); g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId });
    await assert.rejects(() => g.run(), /上書き/); assert.equal(g.rows.length, 2); assert.equal(g.calls.includes("aliasPOST"), false);
  }
});

test("pending recovery rejects a READY response for another ID even on the same lease and SHA", async () => {
  const g = new AliasGateway(); g.pending();
  g.remotes.get("dpl_ready")!.id = "dpl_other";
  g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId: "dpl_other" });
  const before = g.rows.length;
  await assert.rejects(() => g.run(), /指定ID/);
  assert.equal(g.rows.length, before);
  assert.equal(g.latest().payload.aliasAssignment!.state, "pending");
  assert.equal(g.calls.includes("aliasPOST"), false); assertBounded(g);
});

test("lease snapshot changes during verification stop all alias and ledger mutations", async () => {
  const g = new AliasGateway(); g.onPool = () => {
    if (g.poolReads === 2) g.append(nextRecord(g.latest(), { headSha: otherSha, readyDeploymentId: undefined }, now));
  };
  await assert.rejects(() => g.run(), /世代/); assert.equal(g.calls.some((c) => c.startsWith("save:") || c === "aliasPOST"), false);
});

test("PR changes during resource GETs fail the final reread before pending or alias POST", async () => {
  const g = new AliasGateway(); g.onAlias = () => { g.prs.get(37)!.sha = otherSha; };
  await assert.rejects(() => g.run(), /確認中に変わり/);
  assert.equal(g.calls.some((c) => c.startsWith("save:") || c === "aliasPOST"), false);
  assertBounded(g);
});

test("expiry after pending save or after alias GET stops POST and keeps pending", async () => {
  for (const boundary of ["save", "alias"] as const) {
    const g = new AliasGateway();
    if (boundary === "save") g.onSave = () => { g.expired = true; };
    else g.onAlias = () => { if (g.latest().payload.aliasAssignment) g.expired = true; };
    await assert.rejects(() => g.run(), /承認/); assert.equal(g.latest().payload.aliasAssignment!.state, "pending");
    assert.equal(g.calls.includes("aliasPOST"), false); g.expired = false; g.onSave = undefined; g.onAlias = undefined;
    await g.run(); assert.equal(g.calls.includes("aliasPOST"), false);
  }
});

test("lost alias response is recovered only by exact GET without another POST", async () => {
  const g = new AliasGateway(); g.assignBehavior = "lost";
  await assert.rejects(() => g.run(), /response/); assert.equal(g.latest().payload.aliasAssignment!.state, "pending");
  await g.run(); assert.equal(g.latest().payload.aliasAssignment!.state, "assigned"); assert.equal(g.calls.filter((c) => c === "aliasPOST").length, 1); assertBounded(g);
});

test("pending with absent alias never blindly retries, even with fresh valid approval", async () => {
  const g = new AliasGateway(); g.assignBehavior = "unknown";
  await assert.rejects(() => g.run()); await g.run(); await g.run();
  assert.equal(g.latest().payload.aliasAssignment!.state, "pending"); assert.equal(g.calls.filter((c) => c === "aliasPOST").length, 1); assertBounded(g);
});

test("assigned snapshot failure retains pending and safely records the observed binding on retry", async () => {
  const g = new AliasGateway(); g.failAssignedSave = true;
  await assert.rejects(() => g.run(), /ledger/); assert.equal(g.latest().payload.aliasAssignment!.state, "pending");
  g.failAssignedSave = false; await g.run(); assert.equal(g.latest().payload.aliasAssignment!.state, "assigned");
  assert.equal(g.calls.filter((c) => c === "aliasPOST").length, 1);
});

test("assigned alias disappearance or pending foreign binding cannot cause reassignment or theft", async () => {
  const assigned = new AliasGateway(); await assigned.run(); assigned.aliases.delete("qa1");
  await assert.rejects(() => assigned.run(), /再割当/); assert.equal(assigned.calls.filter((c) => c === "aliasPOST").length, 1);
  const pending = new AliasGateway(); pending.pending(); pending.aliases.set("qa1", { projectId: "prj_other", deploymentId: "dpl_other" });
  await assert.rejects(() => pending.run(), /上書き/); assert.equal(pending.calls.includes("aliasPOST"), false);
});

test("close is PR/lease-scoped, skips reopened PRs, and never enumerates or generates other PRs", async () => {
  const g = new AliasGateway(); g.seed(lease(38, "qa2")); g.prs.get(38)!.state = "closed";
  const other = structuredClone(g.latest("qa2")); await g.run({ action: "close", pr: 37 });
  assert.equal(g.latest().payload.state, "held"); assert.deepEqual(g.latest("qa2"), other); assertBounded(g);
  await assert.rejects(() => g.run({ action: "close", pr: 37, leaseId: "wrong" }), /lease/);
});

test("tracked probe cleanup includes alias and all IDs but needs a new exact delete manifest", async () => {
  const g = new AliasGateway(); const old = { ...deletePlan(g.latest().payload), expiresAt };
  await g.run(); g.prs.get(37)!.state = "closed"; g.gone = true; g.expired = true; g.deleteApprovals = [old];
  await g.run({ action: "close", pr: 37, leaseId: token });
  assert.equal(g.latest().payload.state, "deleting"); assert.equal(g.calls.includes("aliasDELETE"), false);
  g.approveCleanup(); await g.run({ action: "close", pr: 37, leaseId: token });
  assert.equal(g.latest().payload.state, "free"); assert.equal(g.latest().payload.purpose, "probe");
  assert.equal(g.calls.includes("aliasDELETE"), true);
  assert.deepEqual(g.latest().payload.deployments.map((d) => d.id), ["dpl_provisioning", "dpl_ready"]); assertBounded(g);
});

test("pending invisible alias keeps cleanup quarantined and a foreign tracked target stops deletion", async () => {
  for (const visible of [false, true]) {
    const g = new AliasGateway(); g.pending(); g.prs.get(37)!.state = "closed"; g.gone = true; g.approveCleanup();
    if (visible) g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId: "dpl_provisioning" });
    if (visible) await assert.rejects(() => g.run({ action: "close", pr: 37 }), /削除を拒否/);
    else await g.run({ action: "close", pr: 37 });
    assert.equal(g.latest().payload.state, "deleting"); assert.equal(g.calls.some((c) => c === "aliasDELETE" || c.startsWith("delete:")), false);
  }
});

test("observed pending alias is durably confirmed before partial cleanup and can resume after alias deletion", async () => {
  const g = new AliasGateway(); g.pending(); g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId: "dpl_ready" });
  g.prs.get(37)!.state = "closed"; g.gone = true; g.approveCleanup(); g.failDelete = true;
  await assert.rejects(() => g.run({ action: "close", pr: 37 }));
  assert.equal(g.latest().payload.aliasAssignment!.state, "assigned"); assert.equal(g.aliases.has("qa1"), false);
  g.failDelete = false; await g.run({ action: "close", pr: 37 }); assert.equal(g.latest().payload.state, "free");
});

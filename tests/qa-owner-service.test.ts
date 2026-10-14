import test from "node:test";
import assert from "node:assert/strict";
import { runQaRequest, type AliasTarget, type QaGateway, type QaGateTarget, type QaPullRequest, type QaRequest, type RemoteDeployment } from "../lib/qa-pool-service";
import { deletePlan, type DeletePlan } from "../lib/qa-pool-authorization";
import { QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, type DatabaseIdentity, type Pool, type QaLeaseRecord, type SavedLease, type Slot } from "../lib/qa-pool";

const sha = "a".repeat(40), newSha = "b".repeat(40), now = "2026-10-13T12:00:00.000Z";
const leaseId = "00000000-0000-4000-8000-000000000042", claimLeaseId = "00000000-0000-4000-8000-000000000142";
const fallbackLeaseId = "00000000-0000-4000-8000-000000000999";
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-owner-fixture", endpointId: "ep-owner-fixture", host: "ep-owner-fixture.test.aws.neon.tech" };
function pr(number = 42): QaPullRequest {
  return { number, state: "open", branch: `codex/task-${number}`, sha, repository: QA_REPOSITORY, base: "main", approved: false };
}
function ready(number = 42, slot: Slot = "qa1"): QaLeaseRecord {
  const suffix = number === 42 ? "" : `_${number}`;
  const native = number === 42 ? database : { ...database, branchId: `br-owner-fixture-${number}`,
    endpointId: `ep-owner-fixture-${number}`, host: `ep-owner-fixture-${number}.test.aws.neon.tech` };
  return { protocol: "cake-qa/v1", slot, leaseId: number === 42 ? leaseId : "00000000-0000-4000-8000-000000000099", pr: number, branch: pr(number).branch, headSha: sha,
    state: "held", createdAt: now, updatedAt: now, sequence: 2, previousRecordId: 1, database: native, retiredDatabases: [],
    deployments: [{ id: `dpl_provisioning${suffix}`, sha, phase: "provisioning" }, { id: `dpl_application${suffix}`, sha, phase: "application", url: "https://owner-fixture.vercel.app" }],
    readyDeploymentId: `dpl_application${suffix}`, aliasSha: sha };
}
class OwnerGateway implements QaGateway {
  states: Pool = { qa1: null, qa2: null, qa3: null };
  prs = new Map<number, QaPullRequest>([[42, pr()]]);
  remotes = new Map<string, RemoteDeployment>();
  aliases = new Map<Slot, AliasTarget>();
  calls: string[] = [];
  logs: string[] = [];
  plans: { action: "preview" | "cleanup"; pr: number; savedId?: number }[] = [];
  enabled = false;
  approval = false;
  approvalReject = false;
  approvalSequence: boolean[] = [];
  approvalReads = 0;
  claim: { slot: Slot; leaseId: string } | null = null;
  onPlan?: () => void;
  onGate?: () => void;
  onApproval?: () => void;
  native: DatabaseIdentity | null = database;
  gone = true;
  poolReads = 0;
  onPool?: () => void;
  seed(record: QaLeaseRecord) {
    this.states[record.slot] = { id: 2, payload: structuredClone(record) };
    this.prs.set(record.pr, pr(record.pr));
    for (const d of record.deployments) this.remotes.set(d.id, { id: d.id, projectId: QA_PROJECT_ID, target: null, branch: record.branch, sha: d.sha,
      leaseId: record.leaseId, pr: record.pr, attemptId: fallbackLeaseId, phase: d.phase, state: d.phase === "application" ? "READY" : "ERROR", url: d.url });
    if (record.aliasSha) this.aliases.set(record.slot, { projectId: QA_PROJECT_ID, deploymentId: record.readyDeploymentId! });
  }
  async pool() { this.poolReads += 1; this.onPool?.(); return structuredClone(this.states); }
  async save(record: QaLeaseRecord): Promise<SavedLease> {
    this.calls.push(`save:${record.slot}:${record.state}`);
    const saved = { id: (this.states[record.slot]?.id ?? 0) + 1, payload: structuredClone(record) };
    this.states[record.slot] = saved; return structuredClone(saved);
  }
  async pullRequest(number: number) { this.calls.push(`pr:${number}`); return structuredClone(this.prs.get(number)!); }
  async openPullRequests() { this.calls.push("openPRs"); return [...this.prs.values()].map((value) => structuredClone(value)); }
  generationEnabled() { this.calls.push("enabled"); return this.enabled; }
  async requestOwnerPlan(action: "preview" | "cleanup", value: QaPullRequest, saved?: SavedLease) {
    this.calls.push(`plan:${action}:${value.number}`); this.plans.push({ action, pr: value.number, savedId: saved?.id }); this.onPlan?.();
  }
  async claimAuthorization(value: QaPullRequest) { this.calls.push(`claimApproval:${value.number}`); return structuredClone(this.claim); }
  async assertGate(mode: "create" | "probe" | "cleanup" | "alias", target?: QaGateTarget) {
    this.calls.push(`gate:${mode}`); if (mode !== "cleanup") assert.ok(target); this.onGate?.();
  }
  probeAuthorization(): null { return null; }
  aliasApproved(): boolean { return false; }
  async deployments(record: QaLeaseRecord) { this.calls.push(`list:${record.pr}`); return [...this.remotes.values()].filter((value) => value.pr === record.pr).map((value) => structuredClone(value)); }
  async deployment(id: string) { this.calls.push(`get:${id}`); return structuredClone(this.remotes.get(id) ?? null); }
  async create(record: QaLeaseRecord) {
    this.calls.push(`create:${record.pr}`);
    const deployment: RemoteDeployment = { id: "dpl_created", projectId: QA_PROJECT_ID, target: null, branch: record.branch, sha: record.headSha,
      leaseId: record.leaseId, pr: record.pr, attemptId: record.intent!.attemptId, phase: record.intent!.phase, state: "BUILDING" };
    this.remotes.set(deployment.id, deployment); return structuredClone(deployment);
  }
  async database() { return structuredClone(this.native); }
  async databaseGone() { return this.gone; }
  async alias(slot: Slot) { return structuredClone(this.aliases.get(slot) ?? null); }
  async assignAlias(record: QaLeaseRecord, deployment: RemoteDeployment) { this.calls.push("aliasPOST"); this.aliases.set(record.slot, { projectId: QA_PROJECT_ID, deploymentId: deployment.id }); }
  async assignReadyAlias() { throw new Error("unexpected probe alias"); }
  async deletionApproved() {
    this.approvalReads += 1; this.calls.push("deleteApproval"); this.onApproval?.();
    if (this.approvalReject) throw new Error("approval unavailable");
    return this.approvalSequence.length ? this.approvalSequence.shift()! : this.approval;
  }
  async deleteAlias(record: QaLeaseRecord, plan: DeletePlan) { assert.deepEqual(plan, deletePlan(record)); this.calls.push("aliasDELETE"); this.aliases.delete(record.slot); }
  async deleteDeployment(record: QaLeaseRecord, deployment: RemoteDeployment, plan: DeletePlan) {
    assert.deepEqual(plan, deletePlan(record)); this.calls.push(`delete:${deployment.id}`); this.remotes.delete(deployment.id);
  }
  run(request: QaRequest) { return runQaRequest(this, request, { now: () => now, token: () => fallbackLeaseId, log: (message) => this.logs.push(message) }); }
  preview(): QaRequest { return { action: "request-preview", pr: 42, sha }; }
  release(): QaRequest { return { action: "request-release", pr: 42, sha, leaseId }; }
}
function noGeneration(g: OwnerGateway) { assert.equal(g.calls.some((value) => value === "openPRs" || value.startsWith("create:")), false); }
function noDeletion(g: OwnerGateway) { assert.equal(g.calls.some((value) => value === "aliasDELETE" || value.startsWith("delete:")), false); }

test("unapproved request-preview issues a target plan without claim, generation or other-slot reconciliation", async () => {
  const g = new OwnerGateway(); g.seed(ready(99, "qa3")); g.prs.get(99)!.state = "closed";
  const other = structuredClone(g.states.qa3); await g.run(g.preview());
  assert.deepEqual(g.plans, [{ action: "preview", pr: 42, savedId: undefined }]);
  assert.equal(g.states.qa1, null); assert.equal(g.states.qa2, null); assert.deepEqual(g.states.qa3, other);
  assert.equal(g.calls.includes("pr:99"), false); assert.equal(g.calls.some((value) => value.startsWith("save:")), false); noGeneration(g); noDeletion(g);
});

test("request-preview requires exact OPEN repository, main base, feature branch and full current SHA", async () => {
  for (const change of [{ state: "closed" }, { repository: "fork/Cake" }, { base: "other" }, { branch: "main" }, { sha: newSha }, { number: 99 }]) {
    const g = new OwnerGateway(); Object.assign(g.prs.get(42)!, change);
    await assert.rejects(() => g.run(g.preview())); assert.equal(g.plans.length, 0); assert.equal(g.calls.some((value) => value.startsWith("save:")), false);
  }
  const g = new OwnerGateway(); await assert.rejects(() => g.run({ ...g.preview(), sha: sha.slice(0, 7) })); assert.equal(g.plans.length, 0);
});

test("plan await cannot carry preview approval across a pushed HEAD or PR close", async () => {
  for (const change of [{ sha: newSha }, { state: "closed" }]) {
    const g = new OwnerGateway(); g.enabled = true; g.claim = { slot: "qa2", leaseId: claimLeaseId }; g.prs.get(42)!.approved = true;
    g.onPlan = () => Object.assign(g.prs.get(42)!, change);
    await assert.rejects(() => g.run(g.preview())); assert.equal(g.calls.some((value) => value.startsWith("save:")), false); noGeneration(g); noDeletion(g);
  }
});

test("approved preview claims only the consented slot and lease before targeted reconciliation", async () => {
  const g = new OwnerGateway(); g.enabled = true; g.prs.get(42)!.approved = true; g.claim = { slot: "qa2", leaseId: claimLeaseId };
  await g.run(g.preview());
  assert.equal(g.states.qa2!.payload.leaseId, claimLeaseId); assert.equal(g.states.qa1, null); assert.equal(g.states.qa3, null);
  assert.equal(g.calls.filter((value) => value === "create:42").length, 1); assert.equal(g.calls.includes("openPRs"), false);
});

test("new preview cannot fall back to a token on missing consent, disabled generation or occupied approved slot", async () => {
  for (const failure of ["none", "disabled", "occupied", "slot", "lease"] as const) {
    const g = new OwnerGateway(); g.enabled = true; g.prs.get(42)!.approved = true; g.claim = { slot: "qa2", leaseId: claimLeaseId };
    if (failure === "none") g.claim = null;
    if (failure === "disabled") g.enabled = false;
    if (failure === "occupied") g.seed(ready(99, "qa2"));
    if (failure === "slot") g.claim = { slot: "qa4" as Slot, leaseId: claimLeaseId };
    if (failure === "lease") g.claim = { slot: "qa2", leaseId: "invalid" };
    if (failure === "slot" || failure === "lease") await assert.rejects(() => g.run(g.preview())); else await g.run(g.preview());
    assert.equal(g.states.qa1, null); assert.equal(g.states.qa3, null); assert.equal(g.calls.some((value) => value.startsWith("save:")), false); noGeneration(g);
  }
});

test("owner claim is rechecked before first lease save and cannot survive revocation", async () => {
  const g = new OwnerGateway(); g.enabled = true; g.prs.get(42)!.approved = true; g.claim = { slot: "qa2", leaseId: claimLeaseId };
  g.onGate = () => { g.claim = null; };
  await assert.rejects(() => g.run(g.preview()), /承認が変わり/); assert.equal(g.calls.some((value) => value.startsWith("save:")), false); noGeneration(g);
});

test("held preview plans and reconciles only its current lease, preserving unapproved resources", async () => {
  const g = new OwnerGateway(); g.seed(ready()); g.seed(ready(99, "qa3")); g.prs.get(99)!.state = "closed";
  const target = structuredClone(g.states.qa1), other = structuredClone(g.states.qa3); await g.run(g.preview());
  assert.deepEqual(g.plans, [{ action: "preview", pr: 42, savedId: 2 }]); assert.deepEqual(g.states.qa1, target); assert.deepEqual(g.states.qa3, other);
  assert.equal(g.calls.includes("pr:99"), false); noGeneration(g); noDeletion(g);
});

test("same ledger ID with changed payload is rejected after plan issuance", async () => {
  const g = new OwnerGateway(); g.seed(ready()); g.onPlan = () => { g.states.qa1!.payload.deployments = []; };
  await assert.rejects(() => g.run(g.preview()), /貸出世代/); assert.equal(g.calls.some((value) => value.startsWith("save:")), false); noGeneration(g); noDeletion(g);
});

test("request-release validates current SHA and lease, saves deleting and issues cleanup plan with no deletion", async () => {
  const g = new OwnerGateway(); g.seed(ready()); g.seed(ready(99, "qa3")); const other = structuredClone(g.states.qa3);
  await g.run(g.release());
  assert.equal(g.states.qa1!.payload.state, "deleting"); assert.deepEqual(g.plans, [{ action: "cleanup", pr: 42, savedId: 3 }]);
  assert.deepEqual(g.states.qa3, other); assert.equal(g.calls.includes("pr:99"), false); noGeneration(g); noDeletion(g);
  for (const request of [{ ...g.release(), leaseId: undefined }, { ...g.release(), leaseId: fallbackLeaseId }, { ...g.release(), sha: newSha }]) await assert.rejects(() => g.run(request));
});

test("approved release retry deletes only its lease and rechecks asynchronous consent before each mutation and free", async () => {
  const g = new OwnerGateway(); g.seed(ready()); await g.run(g.release()); g.approval = true;
  await g.run(g.release()); assert.equal(g.states.qa1!.payload.state, "free");
  assert.equal(g.calls.includes("aliasDELETE"), true); assert.equal(g.calls.includes("delete:dpl_provisioning"), true);
  assert.equal(g.calls.includes("delete:dpl_application"), true); assert.ok(g.approvalReads >= 6); noGeneration(g);
});

test("request-release accepts the current unapproved HEAD while preserving the saved cleanup SHA", async () => {
  const g = new OwnerGateway(); g.seed(ready()); g.prs.get(42)!.sha = newSha;
  await g.run({ ...g.release(), sha: newSha });
  assert.equal(g.states.qa1!.payload.state, "deleting"); assert.equal(g.states.qa1!.payload.headSha, sha);
  assert.deepEqual(g.plans, [{ action: "cleanup", pr: 42, savedId: 3 }]); noGeneration(g); noDeletion(g);
  g.approval = true; await g.run({ ...g.release(), sha: newSha });
  assert.equal(g.states.qa1!.payload.state, "free"); assert.equal(g.states.qa1!.payload.headSha, sha); noGeneration(g);
});

test("Promise false or rejected cleanup approval never permits DELETE or free", async () => {
  for (const reject of [false, true]) {
    const g = new OwnerGateway(); g.seed(ready()); g.approvalReject = reject;
    if (reject) await assert.rejects(() => g.run(g.release()), /approval unavailable/); else await g.run(g.release());
    assert.equal(g.states.qa1!.payload.state, "deleting"); noDeletion(g);
  }
});

test("revoke before alias DELETE, a later deployment DELETE, or free keeps deleting", async () => {
  for (const boundary of ["alias", "deployment", "free"] as const) {
    const g = new OwnerGateway(); g.seed(ready());
    g.approvalSequence = boundary === "alias" ? [true, false] : boundary === "deployment" ? [true, true, false] : [true, true, true, true, false];
    await assert.rejects(() => g.run(g.release()), /削除承認/); assert.equal(g.states.qa1!.payload.state, "deleting");
    if (boundary === "alias") noDeletion(g);
    if (boundary === "deployment") assert.equal(g.calls.some((value) => value.startsWith("delete:")), false);
    if (boundary === "free") assert.equal(g.calls.filter((value) => value.startsWith("delete:")).length, 2);
  }
});

test("close publishes a cleanup plan for its target PR only when asynchronous consent is absent", async () => {
  const g = new OwnerGateway(); g.seed(ready()); g.seed(ready(99, "qa3")); g.prs.get(42)!.state = "closed"; g.prs.get(99)!.state = "closed";
  const other = structuredClone(g.states.qa3); await g.run({ action: "close", pr: 42 });
  assert.equal(g.states.qa1!.payload.state, "deleting"); assert.deepEqual(g.plans, [{ action: "cleanup", pr: 42, savedId: 3 }]);
  assert.deepEqual(g.states.qa3, other); assert.equal(g.calls.includes("pr:99"), false); noGeneration(g); noDeletion(g);
});

test("legacy claim accepts optional consented slot/lease and preserves null-consent token fallback", async () => {
  for (const explicit of [false, true]) {
    const g = new OwnerGateway(); g.enabled = true; g.prs.get(42)!.approved = true;
    if (explicit) g.claim = { slot: "qa2", leaseId: claimLeaseId };
    await g.run({ action: "claim", pr: 42 });
    assert.equal(g.states[explicit ? "qa2" : "qa1"]!.payload.leaseId, explicit ? claimLeaseId : fallbackLeaseId);
  }
});

test("normal claim cannot save an old slot or lease after its nonnull authorization changes during the gate", async () => {
  for (const change of ["revoked", "slot", "lease"] as const) {
    const g = new OwnerGateway(); g.enabled = true; g.prs.get(42)!.approved = true; g.claim = { slot: "qa2", leaseId: claimLeaseId };
    g.onGate = () => { g.claim = change === "revoked" ? null : change === "slot" ? { slot: "qa1", leaseId: claimLeaseId }
      : { slot: "qa2", leaseId: fallbackLeaseId }; };
    await assert.rejects(() => g.run({ action: "claim", pr: 42 }), /生成承認が変わり/);
    assert.equal(g.calls.some((value) => value.startsWith("save:") || value.startsWith("create:") || value === "aliasPOST"), false);
    assert.deepEqual(g.states, { qa1: null, qa2: null, qa3: null }); noDeletion(g);
  }
});

test("enabled normal reconciliation publishes an updated-head preview plan but never carries old approval", async () => {
  const g = new OwnerGateway(); g.seed(ready()); g.enabled = true; g.prs.get(42)!.sha = newSha;
  await g.run({ action: "refresh" });
  assert.deepEqual(g.plans, [{ action: "preview", pr: 42, savedId: 2 }]);
  assert.equal(g.states.qa1!.payload.headSha, sha); assert.equal(g.calls.some((value) => value.startsWith("save:")), false);
  assert.equal(g.calls.some((value) => value.startsWith("create:") || value === "aliasPOST"), false);
});

test("preview requests and enabled normal passes recover an old-head POST before publishing the new-head plan", async () => {
  for (const explicit of [true, false]) {
    const g = new OwnerGateway(), previousSha = "c".repeat(40), record = ready();
    record.deployments = record.deployments.map((d) => ({ ...d, sha: previousSha }));
    record.readyDeploymentId = undefined; record.aliasSha = undefined;
    record.intent = { sha, phase: "application", attemptId: fallbackLeaseId, startedAt: now };
    g.seed(record); g.enabled = !explicit; g.prs.get(42)!.sha = newSha;
    g.remotes.set("dpl_recovered", { id: "dpl_recovered", projectId: QA_PROJECT_ID, target: null, branch: record.branch,
      sha, leaseId, pr: 42, attemptId: fallbackLeaseId, phase: "application", state: "ERROR" });
    await g.run(explicit ? { ...g.preview(), sha: newSha } : { action: "refresh" });
    assert.deepEqual(g.plans, [{ action: "preview", pr: 42, savedId: 3 }]);
    assert.equal(g.states.qa1!.payload.intent, undefined); assert.equal(g.states.qa1!.payload.headSha, sha);
    assert.ok(g.states.qa1!.payload.deployments.some((d) => d.id === "dpl_recovered" && d.sha === sha));
    assert.ok(g.calls.indexOf("save:qa1:held") < g.calls.indexOf("plan:preview:42"));
    assert.equal(g.calls.some((value) => value.startsWith("create:") || value === "aliasPOST"), false); noDeletion(g);
  }
});

test("an unrecovered old-head intent blocks a new Preview plan without creation or intent clearing", async () => {
  for (const explicit of [true, false]) {
    const g = new OwnerGateway(), record = ready(); record.readyDeploymentId = undefined; record.aliasSha = undefined;
    record.intent = { sha, phase: "application", attemptId: fallbackLeaseId, startedAt: now };
    g.seed(record); g.enabled = !explicit; g.prs.get(42)!.sha = newSha;
    const snapshot = structuredClone(g.states.qa1);
    await g.run(explicit ? { ...g.preview(), sha: newSha } : { action: "refresh" });
    assert.deepEqual(g.states.qa1, snapshot); assert.equal(g.plans.length, 0);
    assert.equal(g.calls.some((value) => value.startsWith("save:") || value.startsWith("create:") || value === "aliasPOST"), false);
    assert.ok(g.logs.some((message) => message.includes("作成応答が未確認"))); noDeletion(g);
  }
});

test("disabled normal reconciliation preserves the existing early return without publishing an automatic plan", async () => {
  const g = new OwnerGateway(); g.seed(ready()); g.prs.get(42)!.sha = newSha;
  await g.run({ action: "refresh" }); assert.equal(g.plans.length, 0); assert.equal(g.calls.some((value) => value.startsWith("save:")), false);
});

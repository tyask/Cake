import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryGateway, runRegistryAction, type RegistryRequest } from "../scripts/qa-registry-manager";
import { parseRegistryLease, validateRegistryReservation, validateRegistryTransition,
  type QaRegistryLease, type QaRegistryStore, type RegistryPool, type RegistryExpected, type RegistryReservation } from "../lib/qa-registry";
import { QA_REPOSITORY, QA_PROJECT_ID, QA_NEON_PROJECT_ID, SLOTS,
  type DatabaseIdentity, type QaLeaseRecord, type Slot } from "../lib/qa-pool";
import type { QaPullRequest, RemoteDeployment, AliasTarget, QaGateTarget } from "../lib/qa-pool-service";
import type { DeletePlan } from "../lib/qa-pool-authorization";
import type { QaTransport } from "../scripts/qa-pool-writer";

const sha = "a".repeat(40), newSha = "b".repeat(40), mainSha = "c".repeat(40);
const leaseId = "00000000-0000-4000-8000-000000000042";
const attemptId = "00000000-0000-4000-8000-000000000043";
const timestamp = "2026-10-14T00:00:00.000Z";
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-registry-fixture",
  endpointId: "ep-registry-fixture", host: "ep-registry-fixture.mock.aws.neon.tech" };

function reservation(changes: Partial<QaRegistryLease> = {}): QaRegistryLease {
  return parseRegistryLease({ protocol: "cake-qa-registry/v1", slot: "qa1", leaseId, pr: 42,
    branch: "codex/registry-fixture", headSha: sha, state: "reserved", version: 1, requestId: randomUUID(),
    createdAt: timestamp, updatedAt: timestamp, deployments: [], retiredDatabases: [], ...changes });
}

/** In-memory CAS store: every action still exercises strict registry transition validation. */
class MemoryStore implements QaRegistryStore {
  value: RegistryPool = { slots: { qa1: null, qa2: null, qa3: null }, retiredDatabases: [] };
  writes = 0;
  reservations = 0;
  beforeWrite?: () => void;
  async read() { return structuredClone(this.value); }
  async reserve(input: RegistryReservation) {
    validateRegistryReservation(input); this.reservations++;
    const existing = Object.values(this.value.slots).find(record => record?.pr === input.pr && record.state !== "free");
    if (existing) return structuredClone(existing);
    const slot = SLOTS.find(value => !this.value.slots[value] || this.value.slots[value]?.state === "free");
    if (!slot) return null;
    const previous = this.value.slots[slot];
    const record = reservation({ slot, leaseId: input.leaseId, pr: input.pr, branch: input.branch,
      headSha: input.headSha, requestId: input.requestId, createdAt: input.now, updatedAt: input.now,
      version: (previous?.version ?? 0) + 1, retiredDatabases: this.value.retiredDatabases });
    this.value.slots[slot] = record; return structuredClone(record);
  }
  async writeSnapshot(slot: Slot, expected: RegistryExpected, next: QaRegistryLease) {
    this.beforeWrite?.();
    const previous = this.value.slots[slot];
    if (!previous || previous.leaseId !== expected.leaseId || previous.version !== expected.version) throw new Error("CAS generation changed");
    validateRegistryTransition(previous, next); this.writes++;
    this.value.slots[slot] = structuredClone(next); return structuredClone(next);
  }
}

class FakeGateway extends RegistryGateway {
  readonly memory = new MemoryStore();
  currentPr: QaPullRequest = { number: 42, state: "open", branch: "codex/registry-fixture", sha,
    repository: QA_REPOSITORY, base: "main", approved: true };
  draft = true;
  allowed = true;
  ciSucceeded = true;
  closeTrusted = true;
  gates: string[] = [];
  remotes: RemoteDeployment[] = [];
  aliases: Partial<Record<Slot, AliasTarget>> = {};
  native: DatabaseIdentity | null = structuredClone(database);
  deleted: string[] = [];
  assigned = 0;
  uncertainAssignment = false;
  assignmentLanded = true;
  afterDelete?: () => void;
  constructor(record: QaRegistryLease | null = reservation(), manualRelease = false, environment: Record<string, string | undefined> = {}) {
    const store = new MemoryStore();
    super(environment, store, async () => { assert.fail("fake action must not contact a provider"); }, manualRelease);
    this.memory = store; store.value.slots.qa1 = record;
  }
  async assertDispatchOwner() { if (!this.allowed) throw new Error("dispatch owner mismatch"); }
  async assertLegacyPoolFree() {}
  async assertCloseEvent(number: number) {
    if (!this.closeTrusted || number !== this.currentPr.number || this.currentPr.state !== "closed") throw new Error("close event mismatch");
  }
  async pullRequest(number: number) { assert.equal(number, this.currentPr.number); return structuredClone(this.currentPr); }
  async isDraft() { return this.draft; }
  async assertCi(_pr: number, value: string) {
    if (!this.ciSucceeded || value !== this.currentPr.sha) throw new Error("required CI incomplete");
  }
  async assertGate(mode: "create" | "probe" | "cleanup" | "alias", target?: QaGateTarget) {
    this.gates.push(mode);
    if (mode !== "cleanup") assert.deepEqual(target, { pr: 42, branch: this.currentPr.branch, sha: this.currentPr.sha });
  }
  generationEnabled() { return true; }
  async deployment(id: string) { return structuredClone(this.remotes.find(remote => remote.id === id) ?? null); }
  async deployments() { return structuredClone(this.remotes); }
  async database() { return structuredClone(this.native); }
  async databaseGone() { return this.native === null; }
  async alias(slot: Slot) { return structuredClone(this.aliases[slot] ?? null); }
  async assignAlias(record: QaLeaseRecord, deployment: RemoteDeployment) {
    this.assigned++;
    if (this.assignmentLanded) this.aliases[record.slot] = { projectId: deployment.projectId, deploymentId: deployment.id };
    if (this.uncertainAssignment) throw new Error("alias response lost");
  }
  async deleteAlias(record: QaLeaseRecord, plan: DeletePlan) {
    assert.equal(await this.deletionApproved(plan), true);
    this.deleted.push(`alias:${record.slot}`); delete this.aliases[record.slot];
  }
  async deleteDeployment(_record: QaLeaseRecord, deployment: RemoteDeployment, plan: DeletePlan) {
    assert.equal(await this.deletionApproved(plan), true);
    this.deleted.push(deployment.id); this.remotes = this.remotes.filter(value => value.id !== deployment.id);
    if (!this.remotes.length) this.native = null;
    this.afterDelete?.();
  }
  actionRequest(action: RegistryRequest["action"], extra: Partial<RegistryRequest> = {}): RegistryRequest {
    return { action, requestId: randomUUID(), pr: 42, leaseId, sha: this.currentPr.sha, ...extra };
  }
  async run(action: RegistryRequest["action"], extra: Partial<RegistryRequest> = {}, closed = false) {
    return runRegistryAction(this, this.actionRequest(action, extra), closed);
  }
  ready() {
    const remote: RemoteDeployment = { id: "dpl_application", projectId: QA_PROJECT_ID, target: "preview",
      branch: this.currentPr.branch, sha, leaseId, pr: 42, attemptId, phase: "application", state: "READY",
      url: "https://cake-registry-fixture.vercel.app" };
    this.remotes = [remote];
    this.memory.value.slots.qa1 = reservation({ database, deployments: [{ id: remote.id, sha, phase: "application", url: remote.url }],
      readyDeploymentId: remote.id });
    return remote;
  }
}

test("QA reserve selects an empty slot and returns only safe metadata", async () => {
  const gateway = new FakeGateway(null);
  const result = await gateway.run("reserve", { leaseId: undefined });
  assert.equal(result.status, "success"); assert.equal(result.payload?.slot, "qa1");
  assert.equal(result.payload?.state, "reserved"); assert.equal(result.payload?.pr, 42);
  assert.equal(gateway.memory.reservations, 1); assert.equal(gateway.assigned, 0);
  assert.deepEqual(gateway.deleted, []);
});

test("full QA pool returns full without changing or creating resources", async () => {
  const gateway = new FakeGateway(null);
  for (const [index, slot] of SLOTS.entries()) gateway.memory.value.slots[slot] = reservation({ slot, pr: 100 + index,
    leaseId: randomUUID(), branch: `codex/other-${index}` });
  const before = await gateway.memory.read();
  const result = await gateway.run("reserve", { leaseId: undefined });
  assert.equal(result.status, "full"); assert.equal(result.payload, null);
  assert.deepEqual(await gateway.memory.read(), before);
  assert.equal(gateway.remotes.length, 0); assert.equal(gateway.memory.writes, 0);
});

test("same PR reservation returns its current lease instead of taking a second slot", async () => {
  const gateway = new FakeGateway(); gateway.draft = false;
  const before = await gateway.memory.read();
  const result = await gateway.run("reserve");
  assert.equal(result.payload?.leaseId, leaseId); assert.equal(gateway.memory.reservations, 0);
  assert.deepEqual(await gateway.memory.read(), before);
});

test("new QA reservation requires draft PR, current open SHA and trusted owner", async () => {
  for (const mode of ["draft", "closed", "sha", "owner"] as const) {
    const gateway = new FakeGateway(null);
    if (mode === "draft") gateway.draft = false;
    if (mode === "closed") gateway.currentPr.state = "closed";
    if (mode === "owner") gateway.allowed = false;
    await assert.rejects(() => gateway.run("reserve", { sha: mode === "sha" ? newSha : sha, leaseId: undefined }));
    assert.equal(gateway.memory.reservations, 0); assert.equal(gateway.memory.writes, 0);
  }
});

test("duplicate active PR leases and stale lease IDs fail without writes", async () => {
  const gateway = new FakeGateway();
  await assert.rejects(() => gateway.run("status", { leaseId: randomUUID() }), /lease ID/);
  gateway.memory.value.slots.qa2 = reservation({ slot: "qa2", leaseId: randomUUID() });
  await assert.rejects(() => gateway.run("status"), /multiple QA slots/);
  assert.equal(gateway.memory.writes, 0);
});

test("begin records creation intent before any provider creation", async () => {
  const gateway = new FakeGateway();
  const result = await gateway.run("begin", { phase: "provisioning", attemptId });
  const record = gateway.memory.value.slots.qa1!;
  assert.equal(record.intent?.attemptId, attemptId); assert.equal(record.intent?.phase, "provisioning");
  assert.equal(result.payload?.version, 2); assert.equal(gateway.memory.writes, 1);
  assert.equal(gateway.remotes.length, 0); assert.equal(gateway.assigned, 0);
});

test("begin rejects unconfirmed attempts, absent Native database, CI failure and stale heads", async () => {
  for (const mode of ["pending", "database", "ci", "head"] as const) {
    const gateway = new FakeGateway(mode === "pending" ? reservation({ intent: { sha, phase: "provisioning", attemptId, startedAt: timestamp } }) : reservation());
    if (mode === "ci") gateway.ciSucceeded = false;
    await assert.rejects(() => gateway.run("begin", { phase: mode === "database" ? "application" : "provisioning",
      attemptId: randomUUID(), sha: mode === "head" ? newSha : sha }));
    assert.equal(gateway.memory.writes, 0);
  }
});

test("creation registration verifies exact attempt and persists cleanup IDs before discovery", async () => {
  const gateway = new FakeGateway(reservation({ intent: { sha, phase: "provisioning", attemptId, startedAt: timestamp } }));
  gateway.remotes = [{ id: "dpl_provisioning", projectId: QA_PROJECT_ID, target: "preview", branch: gateway.currentPr.branch,
    sha, leaseId, pr: 42, attemptId, phase: "provisioning", state: "ERROR" }];
  const result = await gateway.run("register", { phase: "provisioning", attemptId, deploymentId: "dpl_provisioning" });
  assert.deepEqual(result.payload?.deploymentIds, ["dpl_provisioning"]);
  assert.equal(gateway.memory.value.slots.qa1?.database?.host, database.host);
  assert.equal(gateway.memory.value.slots.qa1?.intent, undefined);
  assert.equal(JSON.stringify(result).includes(database.host), false);
  assert.equal(JSON.stringify(result).includes("password"), false);
});

test("foreign Deployment identity is rejected before registering a cleanup target", async () => {
  const fields: Array<Partial<RemoteDeployment>> = [{ projectId: "prj_other" }, { target: "production" }, { branch: "codex/other" },
    { pr: 99 }, { leaseId: randomUUID() }, { sha: newSha }, { attemptId: randomUUID() }, { phase: "application" }];
  for (const changed of fields) {
    const gateway = new FakeGateway(reservation({ intent: { sha, phase: "provisioning", attemptId, startedAt: timestamp } }));
    gateway.remotes = [{ id: "dpl_provisioning", projectId: QA_PROJECT_ID, target: "preview", branch: gateway.currentPr.branch,
      sha, leaseId, pr: 42, attemptId, phase: "provisioning", state: "ERROR", ...changed }];
    await assert.rejects(() => gateway.run("register", { phase: "provisioning", attemptId, deploymentId: "dpl_provisioning" }), /identity/);
    assert.equal(gateway.memory.writes, 0);
  }
});

test("failed Native discovery retains deployment ID and slot for safe cleanup", async () => {
  const gateway = new FakeGateway(reservation({ intent: { sha, phase: "provisioning", attemptId, startedAt: timestamp } }));
  gateway.native = null;
  gateway.remotes = [{ id: "dpl_provisioning", projectId: QA_PROJECT_ID, target: "preview", branch: gateway.currentPr.branch,
    sha, leaseId, pr: 42, attemptId, phase: "provisioning", state: "ERROR" }];
  await assert.rejects(() => gateway.run("register", { phase: "provisioning", attemptId, deploymentId: "dpl_provisioning" }), /Native database/);
  assert.equal(gateway.memory.value.slots.qa1?.state, "reserved");
  assert.deepEqual(gateway.memory.value.slots.qa1?.deployments.map(remote => remote.id), ["dpl_provisioning"]);
  assert.deepEqual(gateway.deleted, []);
});

test("registration resumes Native discovery for the same recorded attempt without creating or duplicating resources", async () => {
  const gateway = new FakeGateway(reservation({ intent: { sha, phase: "provisioning", attemptId, startedAt: timestamp } }));
  gateway.native = null;
  gateway.remotes = [{ id: "dpl_provisioning", projectId: QA_PROJECT_ID, target: "preview", branch: gateway.currentPr.branch,
    sha, leaseId, pr: 42, attemptId, phase: "provisioning", state: "ERROR" }];
  const operation = { phase: "provisioning" as const, attemptId, deploymentId: "dpl_provisioning" };
  await assert.rejects(() => gateway.run("register", operation));
  const version = gateway.memory.value.slots.qa1!.version;
  gateway.native = structuredClone(database);
  await assert.rejects(() => gateway.run("register", { ...operation, attemptId: randomUUID() }), /identity/);
  const result = await gateway.run("register", operation);
  assert.deepEqual(result.payload?.deploymentIds, ["dpl_provisioning"]);
  assert.equal(gateway.memory.value.slots.qa1?.version, version + 1);
  assert.equal(gateway.memory.value.slots.qa1?.database?.branchId, database.branchId);
  assert.equal(gateway.remotes.length, 1); assert.equal(gateway.assigned, 0);
});

test("publish persists pending alias intent and confirms assignment before published", async () => {
  const gateway = new FakeGateway(); gateway.ready();
  const result = await gateway.run("publish", { deploymentId: "dpl_application" });
  assert.equal(gateway.assigned, 1); assert.equal(result.payload?.state, "published");
  assert.equal(result.payload?.aliasSha, sha);
  assert.equal(gateway.memory.value.slots.qa1?.aliasAssignment?.state, "assigned");
  assert.equal(JSON.stringify(result).includes(database.host), false);
});

test("foreign fixed alias is never overwritten", async () => {
  for (const alias of [{ projectId: "prj_other", deploymentId: "dpl_application" }, { projectId: QA_PROJECT_ID, deploymentId: "dpl_foreign" }]) {
    const gateway = new FakeGateway(); gateway.ready(); gateway.aliases.qa1 = alias;
    await assert.rejects(() => gateway.run("publish", { deploymentId: "dpl_application" }), /another lease/);
    assert.equal(gateway.assigned, 0); assert.equal(gateway.memory.writes, 0);
  }
});

test("lost alias response is recovered from provider evidence without a second POST", async () => {
  const gateway = new FakeGateway(); gateway.ready(); gateway.uncertainAssignment = true;
  await assert.rejects(() => gateway.run("publish", { deploymentId: "dpl_application" }), /response lost/);
  assert.equal(gateway.memory.value.slots.qa1?.aliasAssignment?.state, "pending");
  gateway.uncertainAssignment = false;
  const result = await gateway.run("publish", { deploymentId: "dpl_application" });
  assert.equal(result.payload?.state, "published"); assert.equal(gateway.assigned, 1);
});

test("unconfirmed alias outcome retains reservation and never retries alias mutation", async () => {
  const gateway = new FakeGateway(); gateway.ready(); gateway.uncertainAssignment = true; gateway.assignmentLanded = false;
  await assert.rejects(() => gateway.run("publish", { deploymentId: "dpl_application" }));
  await assert.rejects(() => gateway.run("publish", { deploymentId: "dpl_application" }), /uncertain/);
  assert.equal(gateway.assigned, 1); assert.equal(gateway.memory.value.slots.qa1?.state, "reserved");
  gateway.currentPr.state = "closed";
  await assert.rejects(() => gateway.run("release", {}, true), /unconfirmed/);
  assert.deepEqual(gateway.deleted, []);
});

test("new creation refuses to erase an unconfirmed alias intent", async () => {
  const gateway = new FakeGateway(); gateway.ready(); gateway.uncertainAssignment = true; gateway.assignmentLanded = false;
  await assert.rejects(() => gateway.run("publish", { deploymentId: "dpl_application" }));
  const before = await gateway.memory.read();
  await assert.rejects(() => gateway.run("begin", { phase: "application", attemptId: randomUUID() }), /assignment must be confirmed/);
  assert.deepEqual(await gateway.memory.read(), before); assert.equal(gateway.assigned, 1);
});

test("closed PR cleanup works without merged status or approval ledger and confirms all resources absent", async () => {
  const gateway = new FakeGateway(); gateway.ready();
  await gateway.run("publish", { deploymentId: "dpl_application" });
  gateway.currentPr.state = "closed";
  const result = await gateway.run("release", {}, true);
  assert.equal(result.payload?.state, "free");
  assert.deepEqual(gateway.deleted, ["alias:qa1", "dpl_application"]);
  assert.equal(gateway.remotes.length, 0); assert.equal(gateway.aliases.qa1, undefined); assert.equal(gateway.native, null);
  assert.deepEqual(gateway.memory.value.slots.qa1?.retiredDatabases, [database]);
});

test("close cleanup recovers assigned pending alias and refuses foreign alias", async () => {
  const gateway = new FakeGateway(); gateway.ready(); gateway.uncertainAssignment = true;
  await assert.rejects(() => gateway.run("publish", { deploymentId: "dpl_application" }));
  gateway.currentPr.state = "closed";
  gateway.aliases.qa1 = { projectId: QA_PROJECT_ID, deploymentId: "dpl_foreign" };
  await assert.rejects(() => gateway.run("release", {}, true));
  assert.deepEqual(gateway.deleted, []);
  gateway.aliases.qa1 = { projectId: QA_PROJECT_ID, deploymentId: "dpl_application" };
  const result = await gateway.run("release", {}, true);
  assert.equal(result.payload?.state, "free");
});

test("creation with unknown outcome is quarantined on close without polling or deletion", async () => {
  const gateway = new FakeGateway(reservation({ intent: { sha, phase: "provisioning", attemptId, startedAt: timestamp } }));
  gateway.currentPr.state = "closed"; gateway.native = null;
  await assert.rejects(() => gateway.run("release", {}, true), /cleanup is not confirmed/);
  assert.equal(gateway.memory.value.slots.qa1?.state, "deleting"); assert.deepEqual(gateway.deleted, []);
});

test("cleanup stops before DELETE when CAS changes the lease generation", async () => {
  const gateway = new FakeGateway(); gateway.ready(); gateway.currentPr.state = "closed";
  gateway.memory.beforeWrite = () => {
    const record = gateway.memory.value.slots.qa1!;
    gateway.memory.value.slots.qa1 = { ...record, version: record.version + 1 };
  };
  await assert.rejects(() => gateway.run("release", {}, true), /CAS/);
  assert.deepEqual(gateway.deleted, []); assert.equal(gateway.remotes.length, 1);
});

test("closed cleanup cannot delete a Deployment from an old or foreign lease", async () => {
  const gateway = new FakeGateway(); gateway.ready(); gateway.currentPr.state = "closed";
  gateway.remotes[0].leaseId = randomUUID();
  await assert.rejects(() => gateway.run("release", {}, true));
  assert.deepEqual(gateway.deleted, []); assert.equal(gateway.memory.value.slots.qa1?.state, "deleting");
});

test("status redacts private Native host and reports current registry, not local cached state", async () => {
  const gateway = new FakeGateway(); gateway.ready();
  const result = await gateway.run("status");
  assert.deepEqual(result.payload?.database, { projectId: database.projectId, branchId: database.branchId, endpointId: database.endpointId });
  assert.equal(JSON.stringify(result).includes(database.host), false); assert.equal(gateway.memory.writes, 0);
  assert.equal(result.payload?.databaseHostDigest, createHash("sha256").update(database.host).digest("hex"));
});

test("public QA fingerprint is absent before DB discovery and never persists raw host or fingerprint into the lease", async () => {
  const productionHost = "ep-production-pooler.mock.aws.neon.tech";
  const gateway = new FakeGateway(reservation(), false, { CAKE_QA_PRODUCTION_DATABASE_HOST: productionHost });
  const before = await gateway.memory.read();
  const result = await gateway.run("status");
  assert.equal(Object.hasOwn(result.payload!, "databaseHostDigest"), false);
  assert.equal(result.payload?.productionHostDigest, createHash("sha256").update(productionHost.replace("-pooler", "")).digest("hex"));
  assert.equal(JSON.stringify(result).includes(productionHost), false);
  assert.deepEqual(await gateway.memory.read(), before);
  gateway.ready();
  const discovered = await gateway.memory.read();
  const withDatabase = await gateway.run("status");
  assert.equal(withDatabase.payload?.databaseHostDigest, createHash("sha256").update(database.host).digest("hex"));
  assert.equal(JSON.stringify(withDatabase).includes(database.host), false);
  assert.deepEqual(await gateway.memory.read(), discovered);
});

test("public QA fingerprint uses the normalized validated endpoint and rejects malformed private DB metadata", async () => {
  const host = "ep-registry-fixture-pooler.mock.aws.neon.tech";
  const gateway = new FakeGateway(reservation({ database: { ...database, endpointId: "ep-registry-fixture-pooler", host } }));
  const result = await gateway.run("status");
  assert.equal(result.payload?.databaseHostDigest, createHash("sha256").update(host.replace("-pooler", "")).digest("hex"));
  assert.equal(JSON.stringify(result).includes(host), false);
  gateway.memory.value.slots.qa1!.database!.host = "invalid-host";
  await assert.rejects(gateway.run("status"));
});

test("published status verifies current alias, commit, deployment and Native identity", async () => {
  for (const mode of ["healthy", "alias", "sha", "deployment", "database"] as const) {
    const gateway = new FakeGateway(); gateway.ready(); await gateway.run("publish", { deploymentId: "dpl_application" });
    if (mode === "alias") gateway.aliases.qa1 = { projectId: QA_PROJECT_ID, deploymentId: "dpl_foreign" };
    if (mode === "sha") gateway.currentPr.sha = newSha;
    if (mode === "deployment") gateway.remotes[0].target = "production";
    if (mode === "database") gateway.native = { ...database, branchId: "br-other" };
    const before = await gateway.memory.read();
    if (mode === "healthy") assert.equal((await gateway.run("status")).payload?.state, "published");
    else await assert.rejects(() => gateway.run("status"), /no longer match/);
    assert.deepEqual(await gateway.memory.read(), before);
  }
});

const dispatchEnvironment = { GITHUB_TOKEN: "FAKE_GITHUB_TOKEN", GITHUB_REPOSITORY: QA_REPOSITORY,
  GITHUB_REF: "refs/heads/main", EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "123", QA_TRUSTED_MAIN_SHA: mainSha };
function prResponse(changes: Record<string, unknown> = {}) {
  return { number: 42, state: "open", draft: true, head: { ref: "codex/registry-fixture", sha, repo: { full_name: QA_REPOSITORY } },
    base: { ref: "main", repo: { full_name: QA_REPOSITORY } }, ...changes };
}

test("real dispatch authorization requires owner actor, main source and first attempt of its exact workflow", async () => {
  const valid = { actor: { id: 10, type: "User" }, triggering_actor: { id: 10, type: "User" }, event: "workflow_dispatch", head_branch: "main", head_sha: mainSha,
    path: ".github/workflows/qa-registry.yml", run_attempt: 1 };
  for (const mutation of [{}, { actor: { id: 99 } }, { triggering_actor: { id: 99 } }, { head_branch: "codex/foreign" },
    { head_sha: newSha }, { path: ".github/workflows/ci.yml" }, { run_attempt: 2 }]) {
    const transport: QaTransport = async (method, address) => {
      assert.equal(method, "GET");
      const path = new URL(address).pathname;
      if (path.endsWith("/actions/runs/123")) return { status: 200, data: { ...valid, ...mutation } };
      assert.equal(path, `/repos/${QA_REPOSITORY}`); return { status: 200, data: { owner: { type: "User", id: 10 } } };
    };
    const gateway = new RegistryGateway(dispatchEnvironment, new MemoryStore(), transport);
    if (Object.keys(mutation).length) await assert.rejects(() => gateway.assertDispatchOwner(), /owner or main/);
    else await gateway.assertDispatchOwner();
  }
});

test("CI authorization requires successful latest push and PR runs of the repository workflow", async () => {
  const good = { path: ".github/workflows/ci.yml", head_branch: "codex/registry-fixture", head_repository: { full_name: QA_REPOSITORY },
    repository: { full_name: QA_REPOSITORY }, status: "completed", conclusion: "success", head_sha: sha, pull_requests: [{ number: 42 }] };
  for (const mode of ["success", "failed", "foreign", "incomplete", "stale", "latest-failed", "wrong-pr", "wrong-workflow"] as const) {
    let runs = [{ ...good, id: 1, event: "push" }, { ...good, id: 2, event: "pull_request" }];
    if (mode === "failed") runs[1].conclusion = "failure";
    if (mode === "foreign") runs[1].head_repository = { full_name: "other/Cake" as typeof QA_REPOSITORY };
    if (mode === "incomplete") runs = runs.slice(0, 1);
    if (mode === "stale") runs[1].head_sha = newSha;
    if (mode === "latest-failed") runs.push({ ...good, id: 3, event: "push", conclusion: "failure" });
    if (mode === "wrong-pr") runs[1].pull_requests = [{ number: 99 }];
    if (mode === "wrong-workflow") runs[1].path = ".github/workflows/foreign.yml";
    const transport: QaTransport = async (_method, address) => {
      const path = new URL(address).pathname;
      if (path.endsWith("/actions/workflows/ci.yml/runs")) return { status: 200, data: { workflow_runs: runs } };
      assert.equal(path, `/repos/${QA_REPOSITORY}/pulls/42`); return { status: 200, data: prResponse() };
    };
    const gateway = new RegistryGateway(dispatchEnvironment, new MemoryStore(), transport);
    if (mode === "success") await gateway.assertCi(42, sha);
    else await assert.rejects(() => gateway.assertCi(42, sha));
  }
});

test("close event authorization verifies actual target and fresh PR closed state, regardless of merge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-registry-close-test-"));
  try {
    const path = join(directory, "event.json");
    await writeFile(path, JSON.stringify({ action: "closed", pull_request: prResponse({ state: "closed", merged: false }) }));
    const environment = { ...dispatchEnvironment, EVENT_NAME: "pull_request_target", EVENT_PATH: path };
    for (const state of ["closed", "open"] as const) {
      const transport: QaTransport = async () => ({ status: 200, data: prResponse({ state, merged: false }) });
      const gateway = new RegistryGateway(environment, new MemoryStore(), transport);
      if (state === "closed") await gateway.assertCloseEvent(42);
      else await assert.rejects(() => gateway.assertCloseEvent(42), /no longer closed/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

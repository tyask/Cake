import assert from "node:assert/strict";
import test from "node:test";
import { QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, type DatabaseIdentity } from "../lib/qa-pool";
import { makeOwnerPlan, parsePlan, planMatches, makeOwnerDecision, parseDecision, replayApprovalEvents, safePlanSummary,
  validatePlanProvenance, validateOwnerDecisionProvenance, QA_APPROVAL_TASK, QA_APPROVAL_WORKFLOW,
  QA_APPROVAL_DEFAULT_DURATION_MS, QA_APPROVAL_MAX_DURATION_MS,
  type OwnerPlanPrivateTarget, type OwnerPlan, type OwnerDecision, type OwnerIdentity, type OwnerApprovalEvent,
  type OwnerRunEvidence, type OwnerDecisionState, type SavedOwnerDecision } from "../lib/qa-owner-approval";

const now = Date.parse("2026-10-13T10:00:00.000Z"), mainSha = "a".repeat(40), sha = "b".repeat(40);
const owner: OwnerIdentity = { id: 4242, login: "tyask", type: "User" };
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-owner-test", endpointId: "ep-owner-test",
  host: "ep-owner-test.example.aws.neon.tech" };
const privateSentinel = database.host;
const invalidMessage = /QA owner approvalの形式または検証証拠を確認できません/;
const target = (changes: Partial<OwnerPlanPrivateTarget> = {}): OwnerPlanPrivateTarget => ({
  action: "preview", projectId: QA_PROJECT_ID, pr: 42, branch: "codex/owner-test", sha, slot: "qa1",
  leaseId: "00000000-0000-4000-8000-000000000042", previousLeaseRecordId: 10, deploymentIds: [],
  alias: "cake-qa1-fumin.vercel.app", database: null, parentBranchId: "br-owner-parent", runId: 100, runAttempt: 1, ...changes,
});
const evidence = (changes: Partial<OwnerRunEvidence> = {}): OwnerRunEvidence => ({
  mainSha, event: "workflow_dispatch", branch: "main", path: QA_APPROVAL_WORKFLOW, repository: QA_REPOSITORY,
  headRepository: QA_REPOSITORY, actorId: owner.id, triggeringActorId: owner.id, actorType: "User", triggeringActorType: "User",
  attempt: 1, trustedMain: true, binding: null, status: "completed", conclusion: "success", ...changes,
});
function decisionFor(plan: OwnerPlan, state: OwnerDecisionState = "approved", runId = 200, previous?: SavedOwnerDecision, at = now + 1000): OwnerDecision {
  return makeOwnerDecision(101, plan, state, { runId, ...evidence({ binding: { planId: 101, digest: plan.digest, state },
    status: "in_progress", conclusion: null }) }, owner, previous, at);
}
function event(id: number, payload: OwnerPlan | OwnerDecision): OwnerApprovalEvent {
  return { id, task: QA_APPROVAL_TASK, environment: QA_ENVIRONMENT, sha: payload.sha, payload,
    creator: { login: "github-actions[bot]", type: "Bot" } };
}
function runs(plan: OwnerPlan, decisions: OwnerDecision[] = []): Map<number | string, OwnerRunEvidence> {
  return new Map([[plan.runId, evidence({ attempt: plan.runAttempt })], ...decisions.map((decision): [number, OwnerRunEvidence] => [decision.runId,
    evidence({ binding: { planId: decision.planId, digest: decision.digest, state: decision.state } })])]);
}

test("private manifest digest is canonical and public plans never contain the host", () => {
  const input = target({ database, deploymentIds: ["dpl_second", "dpl_first"] });
  const original = structuredClone(input), plan = makeOwnerPlan(input, mainSha, now);
  const reordered: OwnerPlanPrivateTarget = { ...input, deploymentIds: [...input.deploymentIds].reverse(), database: {
    host: database.host, endpointId: database.endpointId, branchId: database.branchId, projectId: database.projectId } };
  assert.equal(makeOwnerPlan(reordered, mainSha, now).digest, plan.digest);
  assert.deepEqual(input, original);
  assert.deepEqual(plan.resources.deploymentIds, ["dpl_first", "dpl_second"]);
  assert.equal(JSON.stringify(plan).includes(privateSentinel), false);
  assert.equal(JSON.stringify(safePlanSummary(plan, 101)).includes(privateSentinel), false);
  assert.deepEqual(plan.resources.database, { projectId: QA_NEON_PROJECT_ID, branchId: database.branchId, endpointId: database.endpointId });
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
});

test("TTL defaults to two hours, permits at most 24 hours, and rejects unknown clocks", () => {
  const plan = makeOwnerPlan(target(), mainSha, now);
  assert.equal(Date.parse(plan.expiresAt) - now, QA_APPROVAL_DEFAULT_DURATION_MS);
  assert.equal(Date.parse(makeOwnerPlan(target(), mainSha, now, new Date(now + QA_APPROVAL_MAX_DURATION_MS).toISOString()).expiresAt) - now,
    QA_APPROVAL_MAX_DURATION_MS);
  for (const expiry of [new Date(now).toISOString(), new Date(now - 1).toISOString(), new Date(now + QA_APPROVAL_MAX_DURATION_MS + 1).toISOString(),
    "2026-02-30T00:00:00Z", "2026-10-13T12:00:00+00:00", "not-a-date"]) {
    assert.throws(() => makeOwnerPlan(target(), mainSha, now, expiry), invalidMessage);
  }
  for (const bad of [Number.NaN, Infinity, -1, now + 0.5]) assert.throws(() => makeOwnerPlan(target(), mainSha, bad), invalidMessage);
});

test("preview budgets distinguish a fresh DB from an existing DB and cleanup has no creation budget", () => {
  assert.deepEqual([makeOwnerPlan(target(), mainSha, now).maximumNewDeployments, makeOwnerPlan(target(), mainSha, now).maximumNewDatabases], [2, 1]);
  const updated = makeOwnerPlan(target({ database, deploymentIds: ["dpl_old"] }), mainSha, now);
  assert.deepEqual([updated.maximumNewDeployments, updated.maximumNewDatabases], [1, 0]);
  const cleanup = makeOwnerPlan(target({ action: "cleanup", database, deploymentIds: ["dpl_old"], alias: null }), mainSha, now);
  assert.deepEqual([cleanup.maximumNewDeployments, cleanup.maximumNewDatabases], [0, 0]);
  assert.equal(safePlanSummary(cleanup).databaseDataLossRequiresApproval, true);
  assert.match(safePlanSummary(cleanup).dataLossNotice ?? "", /QA DBと入力データを失います/);
});

test("plan matching binds every private target, parent, source, resource and expiry without mutating inputs", () => {
  const input = target({ database, deploymentIds: ["dpl_old"] }), plan = makeOwnerPlan(input, mainSha, now);
  assert.equal(planMatches(plan, structuredClone(input), mainSha, now), true);
  for (const change of [{ action: "cleanup" }, { pr: 43 }, { branch: "codex/other" }, { sha: "c".repeat(40) },
    { slot: "qa2", alias: "cake-qa2-fumin.vercel.app" }, { leaseId: "00000000-0000-4000-8000-000000000043" },
    { previousLeaseRecordId: 11 }, { deploymentIds: ["dpl_other"] }, { database: { ...database, host: "ep-owner-test.other.aws.neon.tech" } },
    { parentBranchId: "br-other-parent" }, { runId: 102 }, { runAttempt: 2 }] as Partial<OwnerPlanPrivateTarget>[]) {
    assert.equal(planMatches(plan, { ...input, ...change }, mainSha, now + 1000), false);
  }
  assert.equal(planMatches(plan, input, "c".repeat(40), now + 1000), false);
  assert.equal(planMatches(plan, input, mainSha, Date.parse(plan.expiresAt)), false);
  assert.equal(planMatches(plan, input, mainSha, now - 1), false);
  assert.equal(planMatches(plan, input, mainSha, Number.NaN), false);
});

test("strict plan parsing rejects secret fields, coercion objects, sparse arrays, spoofed resources and cap widening", () => {
  const plan = makeOwnerPlan(target({ database, deploymentIds: ["dpl_a", "dpl_b"] }), mainSha, now);
  const malformed: unknown[] = [null, "{", { ...plan, token: "PRIVATE_SENTINEL" }, { ...plan, projectId: "prj_foreign" },
    { ...plan, protocol: "cake-qa-approval/v2" }, { ...plan, branch: "main" }, { ...plan, sha: "b".repeat(7) },
    { ...plan, action: { toString: () => "preview", host: privateSentinel } }, { ...plan, pr: "42" }, { ...plan, pr: Number.MAX_SAFE_INTEGER + 1 },
    { ...plan, leaseId: "old" }, { ...plan, runId: 0 }, { ...plan, previousLeaseRecordId: 0 }, { ...plan, parentBranchId: privateSentinel },
    { ...plan, maximumNewDeployments: 2 }, { ...plan, maximumNewDatabases: 1 }, { ...plan, resources: { ...plan.resources, host: privateSentinel } },
    { ...plan, resources: { ...plan.resources, database } }, { ...plan, resources: { ...plan.resources, deploymentIds: ["dpl_b", "dpl_a"] } },
    { ...plan, resources: { ...plan.resources, deploymentIds: ["dpl_a", "dpl_a"] } },
    { ...plan, resources: { ...plan.resources, deploymentIds: Array(1) } }, { ...plan, resources: { ...plan.resources, alias: "cake-qa2-fumin.vercel.app" } },
    { ...plan, expiresAt: new Date(now + QA_APPROVAL_MAX_DURATION_MS + 1).toISOString() }];
  const accessor = { ...plan };
  Object.defineProperty(accessor, "action", { enumerable: true, get: () => "preview" }); malformed.push(accessor);
  const augmented = ["dpl_a"]; Object.assign(augmented, { host: privateSentinel });
  malformed.push({ ...plan, resources: { ...plan.resources, deploymentIds: augmented } });
  for (const value of malformed) assert.throws(() => parsePlan(value), invalidMessage);
  assert.deepEqual(parsePlan(JSON.stringify(plan)), plan);
});

test("private targets reject unknown fields and cleanup cannot approve deployment deletion without DB identity", () => {
  for (const input of [{ ...target(), host: privateSentinel }, target({ action: "cleanup", deploymentIds: ["dpl_a"] }),
    target({ database: { ...database, password: "PRIVATE_SENTINEL" } as DatabaseIdentity }), target({ alias: null }),
    target({ parentBranchId: "br-parent\n::error::PRIVATE_SENTINEL" })]) {
    assert.throws(() => makeOwnerPlan(input as OwnerPlanPrivateTarget, mainSha, now), invalidMessage);
  }
});

test("the approved fixture parent cannot become a planned preview or cleanup child", () => {
  for (const action of ["preview", "cleanup"] as const) {
    assert.throws(() => makeOwnerPlan(target({ action, database, deploymentIds: ["dpl_a"], parentBranchId: database.branchId }), mainSha, now), invalidMessage);
    const plan = makeOwnerPlan(target({ action, database, deploymentIds: ["dpl_a"] }), mainSha, now);
    assert.throws(() => parsePlan({ ...plan, parentBranchId: database.branchId }), invalidMessage);
  }
});

test("plan issuance accepts trusted main events but rejects forks, comments and untrusted referenced source", () => {
  const plan = makeOwnerPlan(target(), mainSha, now);
  for (const eventType of ["workflow_dispatch", "schedule", "pull_request_target"] as const) {
    assert.equal(validatePlanProvenance(plan, evidence({ event: eventType, branch: eventType === "pull_request_target" ? "codex/owner-test" : "main", actorType: "Bot" })), true);
  }
  for (const change of [{ mainSha: "c".repeat(40) }, { repository: "fork/Cake" }, { headRepository: "fork/Cake" },
    { branch: "codex/owner-test" }, { event: "issue_comment" }, { path: ".github/workflows/other.yml" }, { trustedMain: false }, { attempt: 2 },
    { binding: { planId: 101, digest: plan.digest, state: "approved" } }]) {
    assert.equal(validatePlanProvenance(plan, evidence(change as Partial<OwnerRunEvidence>)), false);
  }
  assert.equal(validatePlanProvenance(plan, { ...evidence(), verified: true } as OwnerRunEvidence), false);
});

test("owner decisions require both authenticated owner actors, exact dispatch provenance and title-derived binding", () => {
  const plan = makeOwnerPlan(target(), mainSha, now), decision = decisionFor(plan);
  const valid = evidence({ binding: { planId: 101, digest: plan.digest, state: "approved" } });
  assert.equal(validateOwnerDecisionProvenance(decision, valid, owner), true);
  for (const change of [{ actorId: 9 }, { triggeringActorId: 9 }, { actorType: "Bot" }, { triggeringActorType: "Bot" },
    { event: "schedule" }, { event: "pull_request_target" }, { event: "issue_comment" }, { branch: "codex/owner-test" },
    { headRepository: "fork/Cake" }, { repository: "fork/Cake" }, { mainSha: "c".repeat(40) }, { path: ".github/workflows/other.yml" },
    { trustedMain: false }, { attempt: 2 }, { binding: null }, { binding: { planId: 102, digest: plan.digest, state: "approved" } },
    { binding: { planId: 101, digest: "d".repeat(64), state: "approved" } }, { binding: { planId: 101, digest: plan.digest, state: "revoked" } },
    { status: "in_progress", conclusion: null }, { conclusion: "failure" }]) {
    assert.equal(validateOwnerDecisionProvenance(decision, { ...valid, ...change } as OwnerRunEvidence, owner), false);
  }
  assert.equal(validateOwnerDecisionProvenance(decision, valid, { ...owner, login: "imposter" } as unknown as OwnerIdentity), false);
  assert.equal(validateOwnerDecisionProvenance(decision, { ...valid, verified: true } as OwnerRunEvidence, owner), false);
  assert.equal(validateOwnerDecisionProvenance(decision, { ...valid, actorType: { toString: () => "User" } } as unknown as OwnerRunEvidence, owner), false);
});

test("decision creation is permitted in its running authenticated job, but consumption waits for completion", () => {
  const plan = makeOwnerPlan(target(), mainSha, now), decision = decisionFor(plan), currentRuns = runs(plan, [decision]);
  currentRuns.set(decision.runId, { ...currentRuns.get(decision.runId)!, status: "in_progress", conclusion: null });
  const pending = replayApprovalEvents([event(101, plan), event(102, decision)], currentRuns, owner, now + 2000).get(101)!;
  assert.equal(pending.status, "PENDING"); assert.equal(pending.decision?.id, 102);
  currentRuns.set(decision.runId, { ...currentRuns.get(decision.runId)!, status: "completed", conclusion: "success" });
  assert.equal(replayApprovalEvents([event(101, plan), event(102, decision)], currentRuns, owner, now + 2000).get(101)!.status, "APPROVED");
});

test("expiry is exact and cannot be extended by a decision", () => {
  const plan = makeOwnerPlan(target(), mainSha, now), decision = decisionFor(plan), records = [event(101, plan), event(102, decision)];
  const expiry = Date.parse(plan.expiresAt);
  assert.equal(replayApprovalEvents(records, runs(plan, [decision]), owner, expiry - 1).get(101)!.status, "APPROVED");
  assert.equal(replayApprovalEvents(records, runs(plan, [decision]), owner, expiry).get(101)!.status, "EXPIRED");
  assert.throws(() => decisionFor(plan, "approved", 201, undefined, expiry), invalidMessage);
  const extended = { ...decision, expiresAt: new Date(expiry + 1000).toISOString() };
  assert.throws(() => replayApprovalEvents([event(101, plan), event(102, extended)], runs(plan, [extended]), owner, now + 2000), invalidMessage);
  assert.equal(decisionFor(plan, "revoked", 201, undefined, expiry).expiresAt, plan.expiresAt);
});

test("revocation is latest, immutable, replay-order independent and cannot resurrect an older owner run", () => {
  const plan = makeOwnerPlan(target(), mainSha, now), approved = decisionFor(plan);
  const revoked = decisionFor(plan, "revoked", 201, { id: 102, payload: approved }, now + 2000);
  const records = [event(103, revoked), event(101, plan), event(102, approved)];
  assert.equal(replayApprovalEvents(records, runs(plan, [approved, revoked]), owner, now + 3000).get(101)!.status, "REVOKED");
  assert.throws(() => decisionFor(plan, "approved", 200, { id: 103, payload: revoked }, now + 3000), invalidMessage);
  const transplanted = { ...approved, sequence: 3, previousDecisionId: 103, createdAt: new Date(now + 3000).toISOString() };
  assert.throws(() => replayApprovalEvents([...records, event(104, transplanted)], runs(plan, [approved, revoked]), owner, now + 4000), invalidMessage);
});

test("failed or unfinished latest receipts deny older approvals and can recover only through a fresh linked owner run", () => {
  const plan = makeOwnerPlan(target(), mainSha, now), approved = decisionFor(plan);
  const revoked = decisionFor(plan, "revoked", 201, { id: 102, payload: approved }, now + 2000);
  const currentRuns = runs(plan, [approved, revoked]), records = [event(101, plan), event(102, approved), event(103, revoked)];
  for (const change of [{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "failure" }] as const) {
    currentRuns.set(revoked.runId, { ...currentRuns.get(revoked.runId)!, ...change });
    assert.equal(replayApprovalEvents(records, currentRuns, owner, now + 3000).get(101)!.status, "PENDING");
  }
  const renewed = decisionFor(plan, "approved", 202, { id: 103, payload: revoked }, now + 3000);
  currentRuns.set(renewed.runId, evidence({ binding: { planId: 101, digest: plan.digest, state: "approved" } }));
  assert.equal(replayApprovalEvents([...records, event(104, renewed)], currentRuns, owner, now + 4000).get(101)!.status, "APPROVED");
});

test("missing run evidence never falls back to an older approval", () => {
  const plan = makeOwnerPlan(target(), mainSha, now), approved = decisionFor(plan);
  const revoked = decisionFor(plan, "revoked", 201, { id: 102, payload: approved }, now + 2000), currentRuns = runs(plan, [approved]);
  assert.throws(() => replayApprovalEvents([event(101, plan), event(102, approved), event(103, revoked)], currentRuns, owner, now + 3000), invalidMessage);
});

test("branches, duplicate IDs, incomplete decision chains and unknown own-task records fail closed", () => {
  const plan = makeOwnerPlan(target(), mainSha, now), approved = decisionFor(plan), complete = runs(plan, [approved]);
  const malformed: OwnerApprovalEvent[][] = [
    [event(101, plan), event(101, plan)], [event(102, approved)],
    [event(101, plan), event(102, { ...approved, sequence: 2, previousDecisionId: 99 })],
    [event(101, plan), event(102, { ...approved, pr: 43 })], [event(101, plan), event(102, { ...approved, leaseId: "00000000-0000-4000-8000-000000000043" })],
    [event(101, plan), { ...event(102, approved), sha: mainSha }],
    [event(101, plan), { ...event(102, approved), environment: "Production" }],
    [event(101, plan), { ...event(102, approved), creator: { login: "tyask", type: "User" } } as unknown as OwnerApprovalEvent],
    [{ ...event(101, plan), payload: { ...plan, kind: "comment", approval: true } }],
    [event(101, plan), { ...event(102, approved), payload: { ...approved, token: "PRIVATE_SENTINEL" } }],
    [event(101, plan), { ...event(102, approved), verified: true } as OwnerApprovalEvent],
  ];
  for (const records of malformed) assert.throws(() => replayApprovalEvents(records, complete, owner, now + 3000), invalidMessage);
  const unrelated = { ...event(99, plan), task: "deploy", payload: { host: privateSentinel } };
  assert.equal(replayApprovalEvents([unrelated, event(101, plan)], runs(plan), owner, now + 1000).get(101)!.status, "PENDING");
});

test("rerun decision receipts, malformed decisions and backdated chains are rejected", () => {
  const plan = makeOwnerPlan(target(), mainSha, now), approved = decisionFor(plan);
  for (const value of [{ ...approved, runAttempt: 2 }, { ...approved, sequence: 1, previousDecisionId: 102 },
    { ...approved, state: { toString: () => "approved", token: "PRIVATE_SENTINEL" } }, { ...approved, planId: "101" },
    { ...approved, actorId: 0 }, { ...approved, sourceUrl: "PRIVATE_SENTINEL" }, "{"]) assert.throws(() => parseDecision(value), invalidMessage);
  assert.throws(() => decisionFor(plan, "approved", 100), invalidMessage);
  assert.throws(() => decisionFor(plan, "revoked", 201, { id: 102, payload: approved }, now), invalidMessage);
  assert.deepEqual(parseDecision(JSON.stringify(approved)), approved);
});

test("attempt-qualified plan metadata is supported without accepting evidence from another attempt", () => {
  const plan = makeOwnerPlan(target({ runAttempt: 2 }), mainSha, now), issuedRuns = new Map<number | string, OwnerRunEvidence>([
    [100, evidence({ attempt: 3 })], ["100:2", evidence({ attempt: 2 })],
  ]);
  assert.equal(replayApprovalEvents([event(101, plan)], issuedRuns, owner, now).get(101)!.status, "PENDING");
  issuedRuns.delete("100:2");
  assert.throws(() => replayApprovalEvents([event(101, plan)], issuedRuns, owner, now), invalidMessage);
});

test("source accessors are rejected before sort, task filtering or array iteration can execute them", () => {
  const plan = makeOwnerPlan(target(), mainSha, now);
  for (const property of ["task", "id"] as const) {
    let reads = 0;
    const source = { ...event(101, plan) };
    Object.defineProperty(source, property, { enumerable: true, get: () => { reads++; return property === "task" ? "deploy" : 101; } });
    assert.throws(() => replayApprovalEvents([source], runs(plan), owner, now), invalidMessage);
    assert.equal(reads, 0);
  }
  let reads = 0;
  const sources: OwnerApprovalEvent[] = [];
  Object.defineProperty(sources, "0", { enumerable: true, get: () => { reads++; return event(101, plan); } });
  assert.throws(() => replayApprovalEvents(sources, runs(plan), owner, now), invalidMessage);
  assert.equal(reads, 0);
});

test("public rendering and fixed failures contain no raw host, credential fields, provider body or input mutation", () => {
  const input = target({ action: "cleanup", database, deploymentIds: ["dpl_old"] }), plan = makeOwnerPlan(input, mainSha, now);
  const snapshot = structuredClone(plan), summary = safePlanSummary(plan, 101);
  assert.deepEqual(plan, snapshot);
  assert.equal(JSON.stringify(summary).includes(privateSentinel), false);
  assert.equal(Object.hasOwn(summary.resources.database!, "host"), false);
  assert.throws(() => parsePlan({ ...plan, body: `postgresql://user:PRIVATE_SENTINEL@${privateSentinel}/db` }), (error: unknown) => {
    assert.equal(error instanceof Error && error.message.includes("PRIVATE_SENTINEL"), false);
    assert.equal(error instanceof Error && error.message.includes(privateSentinel), false);
    return true;
  });
  summary.resources.deploymentIds.push("dpl_changed");
  assert.deepEqual(plan, snapshot);
});

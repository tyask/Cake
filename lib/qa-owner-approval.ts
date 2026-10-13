import { createHash } from "node:crypto";
import { fullSha, featureBranch, leaseToken, qaAlias, validDatabase, QA_ENVIRONMENT, QA_PROJECT_ID, QA_NEON_PROJECT_ID, QA_REPOSITORY, SLOTS,
  type DatabaseIdentity, type Slot } from "./qa-pool";

export const QA_APPROVAL_TASK = "cake-qa-approval";
export const QA_APPROVAL_PROTOCOL = "cake-qa-approval/v1";
export const QA_APPROVAL_WORKFLOW = ".github/workflows/qa-pool.yml";
export const QA_APPROVAL_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
export const QA_APPROVAL_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export type OwnerPlanAction = "preview" | "cleanup";
export type OwnerDecisionState = "approved" | "revoked";
export type OwnerPlanResources = {
  deploymentIds: string[]; alias: string | null; database: Omit<DatabaseIdentity, "host"> | null;
};
/** This input is private. Only its digest and explicit hostless projection may be published. */
export type OwnerPlanPrivateTarget = {
  action: OwnerPlanAction; projectId: typeof QA_PROJECT_ID; pr: number; branch: string; sha: string; slot: Slot;
  leaseId: string; previousLeaseRecordId: number | null; deploymentIds: string[]; alias: string | null;
  database: DatabaseIdentity | null; parentBranchId: string; runId: number; runAttempt: number;
};
export type OwnerPlan = {
  protocol: typeof QA_APPROVAL_PROTOCOL; kind: "plan"; action: OwnerPlanAction; projectId: typeof QA_PROJECT_ID;
  pr: number; branch: string; sha: string; slot: Slot; leaseId: string; previousLeaseRecordId: number | null;
  generatedMainSha: string; parentBranchId: string; createdAt: string; expiresAt: string; runId: number; runAttempt: number;
  resources: OwnerPlanResources; maximumNewDeployments: 2 | 1 | 0; maximumNewDatabases: 1 | 0; digest: string;
};
export type OwnerDecision = {
  protocol: typeof QA_APPROVAL_PROTOCOL; kind: "decision"; state: OwnerDecisionState; planId: number; digest: string;
  action: OwnerPlanAction; projectId: typeof QA_PROJECT_ID; pr: number; branch: string; sha: string; slot: Slot;
  leaseId: string; previousLeaseRecordId: number | null; generatedMainSha: string; expiresAt: string; createdAt: string;
  actorId: number; runId: number; runAttempt: 1; sequence: number; previousDecisionId: number | null;
};
export type OwnerIdentity = { id: number; login: "tyask"; type: "User" };
export type OwnerRunBinding = { planId: number; digest: string; state: OwnerDecisionState };
/** Only populate this evidence from authenticated GitHub GETs, never from deployment payload claims.
 * trustedMain includes verification of the referenced reusable workflow's exact main SHA.
 * A decision binding comes from the trusted workflow's actual run title and immutable plan lookup.
 */
export type OwnerRunEvidence = {
  mainSha: string; event: "workflow_dispatch" | "schedule" | "pull_request_target"; branch: string;
  path: typeof QA_APPROVAL_WORKFLOW; repository: typeof QA_REPOSITORY; headRepository: typeof QA_REPOSITORY;
  actorId: number; triggeringActorId: number; actorType: "User" | "Bot"; triggeringActorType: "User" | "Bot";
  attempt: number; trustedMain: boolean; binding: OwnerRunBinding | null;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "action_required" | "neutral" | null;
};
export type OwnerDecisionProvenance = OwnerRunEvidence & { runId: number };
export type SavedOwnerDecision = { id: number; payload: OwnerDecision };
export type OwnerApprovalEvent = {
  id: number; task: string; environment: string; sha: string; payload: unknown;
  creator: { login: "github-actions[bot]"; type: "Bot" };
};
export type OwnerApprovalStatus = "PENDING" | "APPROVED" | "REVOKED" | "EXPIRED";
export type OwnerApprovalState = { planId: number; plan: OwnerPlan; decision: SavedOwnerDecision | null; status: OwnerApprovalStatus };
export type OwnerPlanSummary = OwnerPlan & {
  planId: number | null; databaseDataLossRequiresApproval: boolean; dataLossNotice: string | null;
};
/** Attempt-qualified keys allow immutable plan issuance evidence from older run attempts. */
export type OwnerRunEvidenceMap = ReadonlyMap<number | string, OwnerRunEvidence>;

function invalid(): never { throw new Error("QA owner approvalの形式または検証証拠を確認できません。"); }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const digestValue = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const deploymentId = (value: unknown): value is string => typeof value === "string" && /^dpl_[a-zA-Z0-9_-]+$/.test(value);
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => plain(value)
  && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
const parseInput = (input: unknown): unknown => typeof input === "string" ? JSON.parse(input) : input;
const copiedKeys = ["action", "projectId", "pr", "branch", "sha", "slot", "leaseId", "previousLeaseRecordId", "generatedMainSha", "expiresAt", "digest"] as const;
const targetKeys = ["action", "projectId", "pr", "branch", "sha", "slot", "leaseId", "previousLeaseRecordId", "deploymentIds", "alias", "database", "parentBranchId", "runId", "runAttempt"] as const;
const planKeys = ["protocol", "kind", "action", "projectId", "pr", "branch", "sha", "slot", "leaseId", "previousLeaseRecordId",
  "generatedMainSha", "parentBranchId", "createdAt", "expiresAt", "runId", "runAttempt", "resources", "maximumNewDeployments", "maximumNewDatabases", "digest"] as const;
const decisionKeys = ["protocol", "kind", "state", "planId", "digest", "action", "projectId", "pr", "branch", "sha", "slot", "leaseId",
  "previousLeaseRecordId", "generatedMainSha", "expiresAt", "createdAt", "actorId", "runId", "runAttempt", "sequence", "previousDecisionId"] as const;
const evidenceKeys = ["mainSha", "event", "branch", "path", "repository", "headRepository", "actorId", "triggeringActorId", "actorType",
  "triggeringActorType", "attempt", "trustedMain", "binding", "status", "conclusion"] as const;

function dateValue(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || (value.includes(".") ? new Date(time).toISOString() : new Date(time).toISOString().replace(/\.000Z$/, "Z")) !== value) invalid();
  return time;
}
function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) invalid();
}
function binding(value: Record<string, unknown>): void {
  if (typeof value.action !== "string" || !["preview", "cleanup"].includes(value.action) || value.projectId !== QA_PROJECT_ID || !integer(value.pr)
    || !featureBranch(value.branch) || !fullSha(value.sha) || !SLOTS.includes(value.slot as Slot) || !leaseToken(value.leaseId)
    || !(value.previousLeaseRecordId === null || integer(value.previousLeaseRecordId))) invalid();
}
function ids(value: unknown, requireSorted = false): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1
    || Array.from({ length: value.length }, (_, index) => index).some((index) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, index) ?? {}, "value") || !deploymentId(value[index]))
    || new Set(value).size !== value.length) invalid();
  const sorted = [...value].sort();
  if (requireSorted && value.some((id, index) => id !== sorted[index])) invalid();
  return sorted as string[];
}
function privateDatabase(value: unknown): DatabaseIdentity | null {
  if (value === null) return null;
  if (!exact(value, ["projectId", "branchId", "endpointId", "host"]) || !validDatabase(value)) invalid();
  return { projectId: value.projectId, branchId: value.branchId, endpointId: value.endpointId, host: value.host } as DatabaseIdentity;
}
function publicDatabase(value: unknown): OwnerPlanResources["database"] {
  if (value === null) return null;
  if (!exact(value, ["projectId", "branchId", "endpointId"]) || value.projectId !== QA_NEON_PROJECT_ID
    || typeof value.branchId !== "string" || !/^br-[a-z0-9-]+$/.test(value.branchId)
    || typeof value.endpointId !== "string" || !/^ep-[a-z0-9-]+$/.test(value.endpointId)) invalid();
  return { projectId: value.projectId, branchId: value.branchId, endpointId: value.endpointId };
}
function alias(value: unknown, slot: Slot, action: OwnerPlanAction): string | null {
  if (value !== qaAlias(slot) && !(action === "cleanup" && value === null)) invalid();
  return value as string | null;
}
function privateTarget(input: unknown): OwnerPlanPrivateTarget {
  const value = parseInput(input);
  if (!exact(value, targetKeys)) invalid();
  binding(value);
  if (!integer(value.runId) || !integer(value.runAttempt) || typeof value.parentBranchId !== "string" || !/^br-[a-z0-9-]+$/.test(value.parentBranchId)) invalid();
  const database = privateDatabase(value.database), deploymentIds = ids(value.deploymentIds);
  if (database?.branchId === value.parentBranchId || value.action === "cleanup" && deploymentIds.length && !database) invalid();
  return { action: value.action as OwnerPlanAction, projectId: QA_PROJECT_ID, pr: value.pr as number, branch: value.branch as string,
    sha: value.sha as string, slot: value.slot as Slot, leaseId: value.leaseId as string, previousLeaseRecordId: value.previousLeaseRecordId as number | null,
    deploymentIds, alias: alias(value.alias, value.slot as Slot, value.action as OwnerPlanAction), database,
    parentBranchId: value.parentBranchId, runId: value.runId, runAttempt: value.runAttempt };
}
function limits(action: OwnerPlanAction, hasDatabase: boolean): Pick<OwnerPlan, "maximumNewDeployments" | "maximumNewDatabases"> {
  return action === "cleanup" ? { maximumNewDeployments: 0, maximumNewDatabases: 0 }
    : hasDatabase ? { maximumNewDeployments: 1, maximumNewDatabases: 0 } : { maximumNewDeployments: 2, maximumNewDatabases: 1 };
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!plain(value)) invalid();
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function manifestDigest(target: OwnerPlanPrivateTarget, generatedMainSha: string, createdAt: string, expiresAt: string): string {
  return createHash("sha256").update(`${QA_APPROVAL_PROTOCOL}\0`).update(canonicalJson({ repository: QA_REPOSITORY, ...target,
    generatedMainSha, createdAt, expiresAt, ...limits(target.action, Boolean(target.database)) })).digest("hex");
}

export function makeOwnerPlan(inputTargetPrivate: OwnerPlanPrivateTarget, currentMainSha: string, now = Date.now(), expiresAt?: string): OwnerPlan {
  try {
    clock(now);
    if (!fullSha(currentMainSha)) invalid();
    const target = privateTarget(inputTargetPrivate), createdAt = new Date(now).toISOString();
    const expiry = expiresAt ?? new Date(now + QA_APPROVAL_DEFAULT_DURATION_MS).toISOString();
    const expiryTime = dateValue(expiry);
    if (expiryTime <= now || expiryTime - now > QA_APPROVAL_MAX_DURATION_MS) invalid();
    const database = target.database ? { projectId: target.database.projectId, branchId: target.database.branchId, endpointId: target.database.endpointId } : null;
    return parsePlan({ protocol: QA_APPROVAL_PROTOCOL, kind: "plan", action: target.action, projectId: target.projectId,
      pr: target.pr, branch: target.branch, sha: target.sha, slot: target.slot, leaseId: target.leaseId,
      previousLeaseRecordId: target.previousLeaseRecordId, generatedMainSha: currentMainSha, parentBranchId: target.parentBranchId, createdAt, expiresAt: expiry,
      runId: target.runId, runAttempt: target.runAttempt, resources: { deploymentIds: [...target.deploymentIds], alias: target.alias, database },
      ...limits(target.action, Boolean(target.database)), digest: manifestDigest(target, currentMainSha, createdAt, expiry) });
  } catch { return invalid(); }
}

export function parsePlan(input: unknown): OwnerPlan {
  try {
    const value = parseInput(input);
    if (!exact(value, planKeys) || value.protocol !== QA_APPROVAL_PROTOCOL || value.kind !== "plan") invalid();
    binding(value);
    if (!fullSha(value.generatedMainSha) || typeof value.parentBranchId !== "string" || !/^br-[a-z0-9-]+$/.test(value.parentBranchId)
      || !integer(value.runId) || !integer(value.runAttempt) || !digestValue(value.digest)) invalid();
    const start = dateValue(value.createdAt), end = dateValue(value.expiresAt);
    if (end <= start || end - start > QA_APPROVAL_MAX_DURATION_MS || !exact(value.resources, ["deploymentIds", "alias", "database"])) invalid();
    const deploymentIds = ids(value.resources.deploymentIds, true), database = publicDatabase(value.resources.database);
    const expected = limits(value.action as OwnerPlanAction, Boolean(database));
    if (database?.branchId === value.parentBranchId || value.maximumNewDeployments !== expected.maximumNewDeployments || value.maximumNewDatabases !== expected.maximumNewDatabases
      || value.action === "cleanup" && deploymentIds.length && !database) invalid();
    return { protocol: QA_APPROVAL_PROTOCOL, kind: "plan", action: value.action as OwnerPlanAction, projectId: QA_PROJECT_ID,
      pr: value.pr as number, branch: value.branch as string, sha: value.sha as string, slot: value.slot as Slot, leaseId: value.leaseId as string,
      previousLeaseRecordId: value.previousLeaseRecordId as number | null, generatedMainSha: value.generatedMainSha, parentBranchId: value.parentBranchId,
      createdAt: value.createdAt as string, expiresAt: value.expiresAt as string, runId: value.runId, runAttempt: value.runAttempt,
      resources: { deploymentIds, alias: alias(value.resources.alias, value.slot as Slot, value.action as OwnerPlanAction), database },
      ...expected, digest: value.digest };
  } catch { return invalid(); }
}

/** Compare the original private plan snapshot, not an implicitly widened later lease snapshot. */
export function planMatches(inputPlan: unknown, inputTargetPrivate: OwnerPlanPrivateTarget, currentMainSha: string, now = Date.now()): boolean {
  try {
    clock(now);
    const plan = parsePlan(inputPlan), target = privateTarget(inputTargetPrivate);
    if (currentMainSha !== plan.generatedMainSha || now < dateValue(plan.createdAt) || now >= dateValue(plan.expiresAt)) return false;
    const expected = makeOwnerPlan(target, currentMainSha, dateValue(plan.createdAt), plan.expiresAt);
    return canonicalJson(plan) === canonicalJson(expected);
  } catch { return false; }
}

export function parseDecision(input: unknown): OwnerDecision {
  try {
    const value = parseInput(input);
    if (!exact(value, decisionKeys) || value.protocol !== QA_APPROVAL_PROTOCOL || value.kind !== "decision"
      || typeof value.state !== "string" || !["approved", "revoked"].includes(value.state)) invalid();
    binding(value);
    if (!integer(value.planId) || !digestValue(value.digest) || !fullSha(value.generatedMainSha) || !integer(value.actorId)
      || !integer(value.runId) || value.runAttempt !== 1 || !integer(value.sequence)
      || !(value.previousDecisionId === null || integer(value.previousDecisionId))
      || (value.sequence === 1) !== (value.previousDecisionId === null)) invalid();
    dateValue(value.expiresAt); dateValue(value.createdAt);
    return JSON.parse(JSON.stringify(value)) as OwnerDecision;
  } catch { return invalid(); }
}

function ownerIdentity(input: unknown): OwnerIdentity {
  if (!exact(input, ["id", "login", "type"]) || !integer(input.id) || input.login !== "tyask" || input.type !== "User") invalid();
  return input as OwnerIdentity;
}
function runEvidence(input: unknown): OwnerRunEvidence {
  if (!exact(input, evidenceKeys) || !fullSha(input.mainSha) || typeof input.event !== "string" || !["workflow_dispatch", "schedule", "pull_request_target"].includes(input.event)
    || typeof input.branch !== "string" || input.path !== QA_APPROVAL_WORKFLOW || input.repository !== QA_REPOSITORY || input.headRepository !== QA_REPOSITORY
    || !integer(input.actorId) || !integer(input.triggeringActorId) || typeof input.actorType !== "string" || !["User", "Bot"].includes(input.actorType)
    || typeof input.triggeringActorType !== "string" || !["User", "Bot"].includes(input.triggeringActorType) || !integer(input.attempt) || input.trustedMain !== true
    || typeof input.status !== "string" || !["queued", "in_progress", "completed"].includes(input.status)
    || !(input.conclusion === null || typeof input.conclusion === "string" && ["success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral"].includes(input.conclusion))) invalid();
  if (input.binding !== null && (!exact(input.binding, ["planId", "digest", "state"]) || !integer(input.binding.planId)
    || !digestValue(input.binding.digest) || typeof input.binding.state !== "string" || !["approved", "revoked"].includes(input.binding.state))) invalid();
  return JSON.parse(JSON.stringify(input)) as OwnerRunEvidence;
}
function evidenceFor(runs: OwnerRunEvidenceMap, runId: number, attempt: number): OwnerRunEvidence {
  const evidence = runEvidence(runs.get(`${runId}:${attempt}`) ?? runs.get(runId));
  if (evidence.attempt !== attempt) invalid();
  return evidence;
}
export function validatePlanProvenance(planInput: unknown, provenanceInput: OwnerRunEvidence): boolean {
  try {
    const plan = parsePlan(planInput), evidence = runEvidence(provenanceInput);
    return evidence.mainSha === plan.generatedMainSha && evidence.attempt === plan.runAttempt && evidence.binding === null
      && (evidence.event === "pull_request_target" ? evidence.branch === "main" || featureBranch(evidence.branch) : evidence.branch === "main");
  } catch { return false; }
}
export function validateOwnerDecisionProvenance(decisionInput: unknown, provenanceInput: OwnerRunEvidence, ownerInput: OwnerIdentity,
  requireCompleted = true): boolean {
  try {
    const decision = parseDecision(decisionInput), evidence = runEvidence(provenanceInput), owner = ownerIdentity(ownerInput);
    return evidence.mainSha === decision.generatedMainSha && evidence.event === "workflow_dispatch" && evidence.branch === "main"
      && evidence.attempt === 1 && decision.actorId === owner.id && evidence.actorId === owner.id && evidence.triggeringActorId === owner.id
      && evidence.actorType === "User" && evidence.triggeringActorType === "User"
      && evidence.binding?.planId === decision.planId && evidence.binding.digest === decision.digest && evidence.binding.state === decision.state
      && (!requireCompleted || evidence.status === "completed" && evidence.conclusion === "success");
  } catch { return false; }
}
function decisionMatchesPlan(decision: OwnerDecision, planId: number, plan: OwnerPlan): boolean {
  return decision.planId === planId && copiedKeys.every((key) => decision[key] === plan[key])
    && dateValue(decision.createdAt) >= dateValue(plan.createdAt)
    && (decision.state === "revoked" || dateValue(decision.createdAt) < dateValue(plan.expiresAt));
}
export function makeOwnerDecision(planId: number, inputPlan: OwnerPlan, state: OwnerDecisionState,
  provenance: OwnerDecisionProvenance, owner: OwnerIdentity, previous?: SavedOwnerDecision, now = Date.now()): OwnerDecision {
  try {
    clock(now);
    const plan = parsePlan(inputPlan);
    if (!integer(planId) || !exact(provenance, ["runId", ...evidenceKeys]) || !integer(provenance.runId) || provenance.runId <= plan.runId
      || !["approved", "revoked"].includes(state) || now < dateValue(plan.createdAt)
      || state === "approved" && now >= dateValue(plan.expiresAt)) invalid();
    const { runId, ...rawEvidence } = provenance, evidence = runEvidence(rawEvidence);
    const prior = previous ? parseDecision(previous.payload) : undefined;
    if (previous && (!exact(previous, ["id", "payload"]) || !integer(previous.id) || !prior
      || !decisionMatchesPlan(prior, planId, plan) || runId <= prior.runId || now < dateValue(prior.createdAt))) invalid();
    const decision = parseDecision({ protocol: QA_APPROVAL_PROTOCOL, kind: "decision", state, planId, digest: plan.digest,
      action: plan.action, projectId: plan.projectId, pr: plan.pr, branch: plan.branch, sha: plan.sha, slot: plan.slot,
      leaseId: plan.leaseId, previousLeaseRecordId: plan.previousLeaseRecordId, generatedMainSha: plan.generatedMainSha,
      expiresAt: plan.expiresAt, createdAt: new Date(now).toISOString(), actorId: ownerIdentity(owner).id, runId,
      runAttempt: 1, sequence: (prior?.sequence ?? 0) + 1, previousDecisionId: previous?.id ?? null });
    if (!validateOwnerDecisionProvenance(decision, evidence, owner, false)) invalid();
    return decision;
  } catch { return invalid(); }
}

/** All pages of the dedicated task and independently authenticated run evidence are required.
 * Invalid own-task records or missing provenance reject the whole replay; no older approval fallback.
 * Authenticated receipts from unfinished/failed runs remain in the chain but never authorize mutations.
 */
export function replayApprovalEvents(events: readonly OwnerApprovalEvent[], runs: OwnerRunEvidenceMap, owner: OwnerIdentity,
  now = Date.now()): Map<number, OwnerApprovalState> {
  try {
    clock(now); ownerIdentity(owner);
    const states = new Map<number, OwnerApprovalState>(), seen = new Set<number>(), usedDecisionRuns = new Set<number>();
    // Check data descriptors before sort/filter can invoke a hostile source accessor.
    if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype || Reflect.ownKeys(events).length !== events.length + 1) invalid();
    const records: OwnerApprovalEvent[] = [];
    for (let index = 0; index < events.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(events, index);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
      const event: unknown = descriptor.value;
      if (!plain(event) || !Object.hasOwn(Object.getOwnPropertyDescriptor(event, "id") ?? {}, "value")
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(event, "task") ?? {}, "value") || !integer(event.id) || typeof event.task !== "string") invalid();
      records.push(event as OwnerApprovalEvent);
    }
    for (const event of records.sort((a, b) => a.id - b.id)) {
      if (event.task !== QA_APPROVAL_TASK) continue;
      if (!exact(event, ["id", "task", "environment", "sha", "payload", "creator"]) || !integer(event.id) || seen.has(event.id)
        || event.environment !== QA_ENVIRONMENT || !fullSha(event.sha)
        || !exact(event.creator, ["login", "type"]) || event.creator.login !== "github-actions[bot]" || event.creator.type !== "Bot") invalid();
      seen.add(event.id);
      const payload = parseInput(event.payload);
      if (!plain(payload)) invalid();
      if (payload.kind === "plan") {
        const plan = parsePlan(payload);
        if (event.sha !== plan.sha || now < dateValue(plan.createdAt)
          || !validatePlanProvenance(plan, evidenceFor(runs, plan.runId, plan.runAttempt))) invalid();
        states.set(event.id, { planId: event.id, plan, decision: null, status: now >= dateValue(plan.expiresAt) ? "EXPIRED" : "PENDING" });
      } else if (payload.kind === "decision") {
        const decision = parseDecision(payload), state = states.get(decision.planId);
        if (!state || event.sha !== decision.sha || !decisionMatchesPlan(decision, state.planId, state.plan)
          || dateValue(decision.createdAt) > now || decision.sequence !== (state.decision?.payload.sequence ?? 0) + 1
          || decision.previousDecisionId !== (state.decision?.id ?? null) || usedDecisionRuns.has(decision.runId) || decision.runId <= state.plan.runId
          || state.decision && decision.runId <= state.decision.payload.runId
          || state.decision && dateValue(decision.createdAt) < dateValue(state.decision.payload.createdAt)) invalid();
        const evidence = evidenceFor(runs, decision.runId, decision.runAttempt);
        if (!validateOwnerDecisionProvenance(decision, evidence, owner, false)) invalid();
        usedDecisionRuns.add(decision.runId);
        state.decision = { id: event.id, payload: decision };
        state.status = evidence.status !== "completed" || evidence.conclusion !== "success" ? "PENDING"
          : decision.state === "revoked" ? "REVOKED" : now >= dateValue(state.plan.expiresAt) ? "EXPIRED" : "APPROVED";
      } else invalid();
    }
    return states;
  } catch { return invalid(); }
}

export function safePlanSummary(inputPlan: unknown, planId: number | null = null): OwnerPlanSummary {
  try {
    if (planId !== null && !integer(planId)) invalid();
    const plan = parsePlan(inputPlan), dataLoss = plan.action === "cleanup" && Boolean(plan.resources.database);
    return { ...plan, planId, databaseDataLossRequiresApproval: dataLoss,
      dataLossNotice: dataLoss ? "削除するとQA DBと入力データを失います。deploymentの復元はDBの復旧を保証しません。" : null };
  } catch { return invalid(); }
}

import { QA_PROJECT_ID, SLOTS, fullSha, leaseToken, parseLeaseRecord, sameDatabase, validDatabase, qaAlias, type QaLeaseRecord, type DatabaseIdentity, type Slot } from "./qa-pool";

export type ProbeApproval = { projectId: typeof QA_PROJECT_ID; pr: number; sha: string; slot: Slot; expiresAt: string };
export type AliasPlan = {
  projectId: typeof QA_PROJECT_ID; pr: number; headSha: string; slot: Slot; leaseId: string;
  deploymentId: string; database: DatabaseIdentity; alias: string;
};
export type AliasApproval = AliasPlan & { expiresAt: string };
export type DeletePlan = {
  projectId: typeof QA_PROJECT_ID; pr: number; slot: Slot; leaseId: string; headSha: string;
  deploymentIds: string[]; alias: string | null; database: DatabaseIdentity | null;
};
export type DeleteApproval = DeletePlan & { expiresAt: string };
export type DeletionApprovalExpiry = "ACTIVE" | "EXPIRED" | "INVALID" | "NO_MATCH" | "UNCONFIRMED";
export type DeletionApprovalDecision = "ALLOWED" | "DENIED" | "VALIDATION_ERROR" | "UNCONFIRMED";
export type DeletionApprovalDiagnosticReason = "ACTIVE_APPROVAL" | "NO_TARGET_MATCH" | "EXPIRED_APPROVAL" | "INVALID_EXPIRY"
  | "INVALID_JSON" | "NOT_ARRAY" | "PLAN_UNCONFIRMED" | "PLAN_INVALID" | "CLOCK_UNCONFIRMED" | "VALIDATION_ERROR";
export type DeletionApprovalDiagnosis = {
  valid: boolean; matches: boolean | null; expiry: DeletionApprovalExpiry;
  decision: DeletionApprovalDecision; reason: DeletionApprovalDiagnosticReason;
};
export function deletePlan(record: QaLeaseRecord): DeletePlan {
  return { projectId: QA_PROJECT_ID, pr: record.pr, slot: record.slot, leaseId: record.leaseId, headSha: record.headSha,
    deploymentIds: record.deployments.map((d) => d.id).sort(), alias: record.purpose === "probe" ? record.aliasAssignment?.alias ?? null : qaAlias(record.slot), database: record.database ?? null };
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const active = (value: unknown, now: number) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
const list = (text: string | undefined): unknown[] => {
  try {
    const values: unknown = JSON.parse(text?.trim() || "[]");
    if (!Array.isArray(values)) throw new Error();
    return values;
  } catch { throw new Error("QA承認設定はJSON配列で指定してください。"); }
};
const aliasPlanKeys = ["projectId", "pr", "headSha", "slot", "leaseId", "deploymentId", "database", "alias"] as const;
const aliasApprovalKeys = [...aliasPlanKeys, "expiresAt"] as const;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
  && Object.keys(value).every((key) => keys.includes(key));
const validAliasTarget = (value: Record<string, unknown>): boolean => value.projectId === QA_PROJECT_ID
  && integer(value.pr) && fullSha(value.headSha) && SLOTS.includes(value.slot as Slot) && leaseToken(value.leaseId)
  && typeof value.deploymentId === "string" && /^dpl_[a-zA-Z0-9_-]+$/.test(value.deploymentId)
  && validDatabase(value.database) && value.alias === qaAlias(value.slot as Slot);

/** Alias-only plans never select or create a deployment. The caller verifies live READY and ownership. */
export function aliasPlan(record: QaLeaseRecord, deploymentId: string): AliasPlan {
  const current = parseLeaseRecord(record);
  if (current.state !== "held" || !current.database || current.readyDeploymentId !== deploymentId
    || !current.deployments.some((deployment) => deployment.id === deploymentId
      && deployment.phase === "application" && deployment.sha === current.headSha)) {
    throw new Error("alias対象は現在HEADのREADY記録とNative DBを持つ使用中の貸出に限ります。");
  }
  return { projectId: QA_PROJECT_ID, pr: current.pr, headSha: current.headSha, slot: current.slot,
    leaseId: current.leaseId, deploymentId, database: { ...current.database }, alias: qaAlias(current.slot) };
}

/** Validate the whole array before accepting one exact target; malformed unrelated entries fail closed. */
export function aliasApproval(text: string | undefined, plan: AliasPlan, now = Date.now()): boolean {
  if (!Number.isFinite(now) || !object(plan) || !exactKeys(plan, aliasPlanKeys) || !validAliasTarget(plan)) return false;
  let values: unknown[];
  try { values = list(text); } catch { return false; }
  let matching: AliasApproval | undefined;
  for (const value of values) {
    if (!object(value) || !exactKeys(value, aliasApprovalKeys) || !validAliasTarget(value)
      || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return false;
    if (value.projectId !== plan.projectId || value.pr !== plan.pr || value.headSha !== plan.headSha
      || value.slot !== plan.slot || value.leaseId !== plan.leaseId || value.deploymentId !== plan.deploymentId
      || value.alias !== plan.alias || !sameDatabase(value.database as DatabaseIdentity, plan.database)) continue;
    if (matching) return false;
    matching = value as AliasApproval;
  }
  return matching !== undefined && active(matching.expiresAt, now);
}

/** A probe may create only the reviewed PR/SHA in the explicitly named free slot. */
export function probeApproval(text: string | undefined, pr: number, sha: string, now = Date.now()): ProbeApproval | null {
  const matches: ProbeApproval[] = [];
  for (const value of list(text)) {
    if (!object(value) || Object.keys(value).some((key) => !["projectId", "pr", "sha", "slot", "expiresAt"].includes(key))
      || value.projectId !== QA_PROJECT_ID || !integer(value.pr) || !fullSha(value.sha) || !SLOTS.includes(value.slot as Slot)
      || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error("限定probe承認が不正です。");
    if (value.pr === pr && value.sha === sha && active(value.expiresAt, now)) matches.push(value as ProbeApproval);
  }
  if (matches.length > 1) throw new Error("限定probe承認が重複しています。");
  return matches[0] ?? null;
}

/** The complete recorded set must match: no wildcard, pool boolean or subset approvals. */
export function deletionApproval(text: string | undefined, plan: DeletePlan, now = Date.now()): boolean {
  if (!leaseToken(plan.leaseId) || !fullSha(plan.headSha) || plan.projectId !== QA_PROJECT_ID
    || !integer(plan.pr) || !SLOTS.includes(plan.slot) || !Array.isArray(plan.deploymentIds)
    || plan.deploymentIds.some((id) => !/^dpl_[a-zA-Z0-9_-]+$/.test(id))
    || new Set(plan.deploymentIds).size !== plan.deploymentIds.length
    || (plan.alias !== null && plan.alias !== qaAlias(plan.slot)) || (plan.database !== null && !validDatabase(plan.database))
    || (plan.deploymentIds.length > 0 && !plan.database)) return false;
  const ids = [...plan.deploymentIds].sort();
  return list(text).some((value) => {
    if (!object(value) || Object.keys(value).some((key) => !["projectId", "pr", "slot", "leaseId", "headSha", "deploymentIds", "alias", "database", "expiresAt"].includes(key))) return false;
    if (value.projectId !== plan.projectId || value.pr !== plan.pr || value.slot !== plan.slot || value.leaseId !== plan.leaseId
      || value.headSha !== plan.headSha || !active(value.expiresAt, now) || !Array.isArray(value.deploymentIds)
      || value.deploymentIds.some((id) => typeof id !== "string") || new Set(value.deploymentIds).size !== value.deploymentIds.length
      || JSON.stringify([...value.deploymentIds].sort()) !== JSON.stringify(ids)) return false;
    if (value.alias !== plan.alias) return false;
    return plan.database === null ? value.database === null : validDatabase(value.database) && sameDatabase(value.database, plan.database);
  });
}

const confirmedDeletionPlan = (plan: unknown): plan is DeletePlan => object(plan)
  && leaseToken(plan.leaseId) && fullSha(plan.headSha) && plan.projectId === QA_PROJECT_ID
  && integer(plan.pr) && SLOTS.includes(plan.slot as Slot) && Array.isArray(plan.deploymentIds)
  && !plan.deploymentIds.some((id) => !/^dpl_[a-zA-Z0-9_-]+$/.test(id))
  && new Set(plan.deploymentIds).size === plan.deploymentIds.length
  && (plan.alias === null || plan.alias === qaAlias(plan.slot as Slot))
  && (plan.database === null || validDatabase(plan.database))
  && (plan.deploymentIds.length === 0 || Boolean(plan.database));

/** The operational target predicate, excluding only the expiry check. */
const matchesDeletionTarget = (value: unknown, plan: DeletePlan, ids: string[]): value is Record<string, unknown> => {
  if (!object(value) || Object.keys(value).some((key) => !["projectId", "pr", "slot", "leaseId", "headSha", "deploymentIds", "alias", "database", "expiresAt"].includes(key))) return false;
  if (value.projectId !== plan.projectId || value.pr !== plan.pr || value.slot !== plan.slot || value.leaseId !== plan.leaseId
    || value.headSha !== plan.headSha || !Array.isArray(value.deploymentIds)
    || value.deploymentIds.some((id) => typeof id !== "string") || new Set(value.deploymentIds).size !== value.deploymentIds.length
    || JSON.stringify([...value.deploymentIds].sort()) !== JSON.stringify(ids)) return false;
  if (value.alias !== plan.alias) return false;
  return plan.database === null ? value.database === null : validDatabase(value.database) && sameDatabase(value.database, plan.database);
};

/** A pure, non-sensitive report. It never changes the operational validator's some/throw policy. */
export function diagnoseDeletionApproval(text: string | undefined, plan: DeletePlan | undefined, now = Date.now()): DeletionApprovalDiagnosis {
  let parsed: unknown;
  try { parsed = JSON.parse(text?.trim() || "[]"); }
  catch { return { valid: false, matches: null, expiry: "UNCONFIRMED", decision: "VALIDATION_ERROR", reason: "INVALID_JSON" }; }
  if (!Array.isArray(parsed)) return { valid: false, matches: null, expiry: "UNCONFIRMED", decision: "VALIDATION_ERROR", reason: "NOT_ARRAY" };
  const unconfirmed = (reason: DeletionApprovalDiagnosticReason): DeletionApprovalDiagnosis => ({
    valid: true, matches: null, expiry: "UNCONFIRMED", decision: "UNCONFIRMED", reason,
  });
  if (plan === undefined) return unconfirmed("PLAN_UNCONFIRMED");
  try { if (!confirmedDeletionPlan(plan)) return unconfirmed("PLAN_INVALID"); }
  catch { return unconfirmed("PLAN_INVALID"); }
  if (!Number.isFinite(now)) return unconfirmed("CLOCK_UNCONFIRMED");
  const ids = [...plan.deploymentIds].sort();
  const matching = parsed.filter((value): value is Record<string, unknown> => matchesDeletionTarget(value, plan, ids));
  const deadlines = matching.map((value) => typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN);
  const expiry: DeletionApprovalExpiry = !matching.length ? "NO_MATCH"
    : deadlines.some((deadline) => Number.isFinite(deadline) && deadline > now) ? "ACTIVE"
    : deadlines.some((deadline) => !Number.isFinite(deadline)) ? "INVALID" : "EXPIRED";
  let allowed: boolean;
  try { allowed = deletionApproval(text, plan, now); }
  catch { return { valid: true, matches: matching.length > 0, expiry, decision: "VALIDATION_ERROR", reason: "VALIDATION_ERROR" }; }
  const reason: DeletionApprovalDiagnosticReason = expiry === "ACTIVE" ? "ACTIVE_APPROVAL"
    : expiry === "INVALID" ? "INVALID_EXPIRY" : expiry === "EXPIRED" ? "EXPIRED_APPROVAL" : "NO_TARGET_MATCH";
  return { valid: true, matches: matching.length > 0, expiry, decision: allowed ? "ALLOWED" : "DENIED", reason };
}

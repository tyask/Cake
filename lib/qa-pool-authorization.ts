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

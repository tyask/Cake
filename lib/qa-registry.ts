import {
  SLOTS, QA_REPOSITORY, fullSha, leaseToken, featureBranch, parseLeaseRecord, sameDatabase,
  type Slot, type QaLeaseRecord, type QaDeployment, type DatabaseIdentity, type QaAliasAssignment,
} from "./qa-pool";

export const QA_REGISTRY_PROTOCOL = "cake-qa-registry/v1" as const;
export type QaRegistryState = "reserved" | "published" | "deleting" | "free";
/** Private registry record. Never put this whole object into logs or artifacts. */
export type QaRegistryLease = {
  protocol: typeof QA_REGISTRY_PROTOCOL;
  slot: Slot; leaseId: string; pr: number; branch: string; headSha: string;
  state: QaRegistryState; version: number; requestId: string;
  createdAt: string; updatedAt: string;
  deployments: QaDeployment[]; database?: DatabaseIdentity; retiredDatabases: DatabaseIdentity[];
  readyDeploymentId?: string; aliasSha?: string; aliasAssignment?: QaAliasAssignment;
  intent?: QaLeaseRecord["intent"];
};
export type RegistryPool = {
  slots: Record<Slot, QaRegistryLease | null>;
  retiredDatabases: DatabaseIdentity[];
};
export type RegistryExpected = { leaseId: string; version: number };
export type RegistryReservation = {
  repository: typeof QA_REPOSITORY; base: "main";
  pr: number; branch: string; headSha: string; leaseId: string; requestId: string; now: string; slot?: Slot;
};
export interface QaRegistryStore {
  read(): Promise<RegistryPool>;
  reserve(input: RegistryReservation): Promise<QaRegistryLease | null>;
  writeSnapshot(slot: Slot, expected: RegistryExpected, next: QaRegistryLease): Promise<QaRegistryLease>;
}

/** Adapter only: a registry version replaces the legacy Deployment record ID. */
export function registryLeaseToPoolRecord(record: QaRegistryLease): QaLeaseRecord {
  const legacy: Record<string, unknown> = { ...record };
  delete legacy.version; delete legacy.requestId; delete legacy.aliasAssignment;
  return parseLeaseRecord({ ...legacy, protocol: "cake-qa/v1", state: record.state === "reserved" || record.state === "published" ? "held" : record.state,
    sequence: record.version, previousRecordId: record.version === 1 ? null : record.version - 1 });
}

export function parseRegistryLease(input: unknown): QaRegistryLease {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("QA管理DBの記録形式が不正です。");
  const value = input as Record<string, unknown>;
  if (value.protocol !== QA_REGISTRY_PROTOCOL || !["reserved", "published", "deleting", "free"].includes(String(value.state))
    || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || !leaseToken(value.requestId)) throw new Error("QA管理DBの記録形式が不正です。");
  const allowed = new Set(["protocol", "slot", "leaseId", "pr", "branch", "headSha", "state", "version", "requestId", "createdAt", "updatedAt", "deployments", "database", "retiredDatabases", "readyDeploymentId", "aliasSha", "aliasAssignment", "intent"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("QA管理DBに未知の記録があります。");
  // Legacy validation requires aliasAssignment only for probes; registry uses the
  // same pending/assigned safety manifest for every normal publication.
  const { aliasAssignment, ...withoutAssignment } = value;
  const canonical = JSON.parse(JSON.stringify(withoutAssignment)) as QaRegistryLease;
  registryLeaseToPoolRecord(canonical);
  if (aliasAssignment !== undefined) {
    const legacy = registryLeaseToPoolRecord({ ...canonical, aliasSha: undefined });
    parseLeaseRecord({ ...legacy, purpose: "probe", aliasAssignment });
    canonical.aliasAssignment = JSON.parse(JSON.stringify(aliasAssignment)) as QaAliasAssignment;
  }
  if (canonical.state === "published" && (!canonical.database || !canonical.readyDeploymentId || canonical.aliasSha !== canonical.headSha
    || canonical.aliasAssignment?.state === "pending")) throw new Error("公開済みQAの対象確認が不足しています。");
  return canonical;
}

export function validateRegistryReservation(input: RegistryReservation): void {
  if (input.repository !== QA_REPOSITORY || input.base !== "main" || !Number.isSafeInteger(input.pr) || input.pr < 1
    || !featureBranch(input.branch) || !fullSha(input.headSha) || !leaseToken(input.leaseId) || !leaseToken(input.requestId)
    || !Number.isFinite(Date.parse(input.now)) || input.slot !== undefined && !SLOTS.includes(input.slot)) throw new Error("QA予約の対象が不正です。");
}

export function validateRegistryTransition(previous: QaRegistryLease, next: QaRegistryLease): void {
  parseRegistryLease(previous); parseRegistryLease(next);
  if (previous.slot !== next.slot || previous.leaseId !== next.leaseId || previous.pr !== next.pr || previous.branch !== next.branch
    || previous.createdAt !== next.createdAt || next.version !== previous.version + 1 || next.requestId === previous.requestId) throw new Error("古い貸出または別の作業からの更新を拒否しました。");
  if (previous.state === "free" || previous.state === "deleting" && next.state !== "deleting" && next.state !== "free"
    || previous.state !== "deleting" && next.state === "free") throw new Error("QA管理DBの状態遷移が不正です。");
  if (previous.state === "deleting" && (next.headSha !== previous.headSha
    || next.intent !== undefined && JSON.stringify(next.intent) !== JSON.stringify(previous.intent))) throw new Error("削除中の作成・対象変更を拒否しました。");
  if (previous.database && !sameDatabase(previous.database, next.database)) throw new Error("貸出中のDB識別情報を変更できません。");
  for (const deployment of previous.deployments) if (!next.deployments.some((d) => d.id === deployment.id && d.sha === deployment.sha && d.phase === deployment.phase)) throw new Error("削除対象Deploymentの記録を失う更新を拒否しました。");
  if (previous.retiredDatabases.some((db) => !next.retiredDatabases.some((d) => sameDatabase(d, db)))) throw new Error("返却済みDBの履歴を失う更新を拒否しました。");
  if (next.state === "free" && next.database && !next.retiredDatabases.some((db) => sameDatabase(db, next.database))) throw new Error("返却済みDBの履歴がありません。");
  if (next.state !== "free" && next.database && next.retiredDatabases.some((db) => sameDatabase(db, next.database))) throw new Error("返却済みDBを再利用できません。");
}

export function registryPublicSummary(record: QaRegistryLease | null) {
  return record === null ? null : { slot: record.slot, state: record.state, leaseId: record.leaseId, pr: record.pr,
    branch: record.branch, headSha: record.headSha, version: record.version, updatedAt: record.updatedAt,
    readyDeploymentId: record.readyDeploymentId, aliasSha: record.aliasSha,
    deployments: record.deployments.map((deployment) => ({ ...deployment })),
    database: record.database ? { projectId: record.database.projectId, branchId: record.database.branchId, endpointId: record.database.endpointId } : undefined,
    deploymentIds: record.deployments.map((deployment) => deployment.id) };
}

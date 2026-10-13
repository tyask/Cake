/** Deployment statuses never define lease state. Only the serialized writer appends snapshots. */
export const SLOTS = ["qa1", "qa2", "qa3"] as const;
export type Slot = typeof SLOTS[number];
export const QA_TASK = "cake-qa-lease";
export const QA_ENVIRONMENT = "Preview";
export const QA_PROJECT_ID = "prj_Z37vquodhpRd08ZTAtYnP0qa59jD";
export const QA_NEON_PROJECT_ID = "misty-meadow-88903426";
export const QA_REPOSITORY = "tyask/Cake";
export type DatabaseIdentity = { projectId: typeof QA_NEON_PROJECT_ID; branchId: string; endpointId: string; host: string };
export type QaDeployment = { id: string; sha: string; url?: string; phase: "provisioning" | "application" };
export type QaAliasAssignment = { alias: string; deploymentId: string; sha: string; state: "pending" | "assigned" };
export type QaLeaseRecord = {
  protocol: "cake-qa/v1"; slot: Slot; leaseId: string; pr: number; branch: string; headSha: string;
  state: "held" | "deleting" | "free"; createdAt: string; updatedAt: string;
  purpose?: "probe";
  sequence: number; previousRecordId: number | null; deployments: QaDeployment[];
  database?: DatabaseIdentity; retiredDatabases: DatabaseIdentity[];
  readyDeploymentId?: string; aliasSha?: string;
  aliasAssignment?: QaAliasAssignment;
  intent?: { sha: string; phase: QaDeployment["phase"]; attemptId: string; startedAt: string };
};
export type GithubDeployment = { id: number; task: string; environment: string; sha: string; payload: unknown };
export type SavedLease = { id: number; payload: QaLeaseRecord };
export type Pool = Record<Slot, SavedLease | null>;
export function sameDatabase(a: DatabaseIdentity | undefined, b: DatabaseIdentity | undefined): boolean {
  return a === undefined || b === undefined ? a === b : (["projectId", "branchId", "endpointId", "host"] as const).every((key) => a[key] === b[key]);
}
export const fullSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export const leaseToken = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const featureBranch = (value: unknown): value is string => typeof value === "string" && /^codex\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 66;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const deploymentId = (value: unknown): value is string => typeof value === "string" && /^dpl_[a-zA-Z0-9_-]+$/.test(value);
const phase = (value: unknown) => value === "provisioning" || value === "application";
export function qaAlias(slot: Slot): string { return `cake-${slot}-fumin.vercel.app`; }
export function validDatabase(value: unknown): value is DatabaseIdentity {
  return object(value) && value.projectId === QA_NEON_PROJECT_ID
    && Object.keys(value).every((key) => ["projectId", "branchId", "endpointId", "host"].includes(key))
    && typeof value.branchId === "string" && /^br-[a-z0-9-]+$/.test(value.branchId)
    && typeof value.endpointId === "string" && /^ep-[a-z0-9-]+$/.test(value.endpointId)
    && typeof value.host === "string" && /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(value.host)
    && value.host.split(".")[0] === value.endpointId;
}
export function parseLeaseRecord(input: unknown): QaLeaseRecord {
  let value: unknown = input;
  try { if (typeof value === "string") value = JSON.parse(value); } catch { throw new Error("QA貸出payloadが不正です。"); }
  if (!object(value) || value.protocol !== "cake-qa/v1" || !SLOTS.includes(value.slot as Slot)
    || !leaseToken(value.leaseId) || !integer(value.pr) || !featureBranch(value.branch) || !fullSha(value.headSha)
    || !["held", "deleting", "free"].includes(String(value.state)) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || !integer(value.sequence) || !(value.previousRecordId === null || integer(value.previousRecordId))
    || !Array.isArray(value.deployments) || !Array.isArray(value.retiredDatabases)
    || value.retiredDatabases.some((db) => !validDatabase(db))
    || (value.database !== undefined && !validDatabase(value.database))) throw new Error("QA貸出payloadが不正です。");
  const allowed = new Set(["protocol", "slot", "leaseId", "pr", "branch", "headSha", "state", "purpose", "createdAt", "updatedAt", "sequence", "previousRecordId", "deployments", "database", "retiredDatabases", "readyDeploymentId", "aliasSha", "aliasAssignment", "intent"]);
  if (value.purpose !== undefined && value.purpose !== "probe" || value.purpose === "probe" && value.aliasSha !== undefined) throw new Error("限定probeの用途またはalias記録が不正です。");
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("QA貸出payloadに未知の情報があります。");
  const ids = new Set<string>();
  for (const deployment of value.deployments) {
    if (!object(deployment) || !deploymentId(deployment.id) || ids.has(deployment.id)
      || Object.keys(deployment).some((key) => !["id", "sha", "url", "phase"].includes(key))
      || !fullSha(deployment.sha) || !phase(deployment.phase)) throw new Error("QA deployment記録が不正です。");
    if (deployment.url !== undefined && (typeof deployment.url !== "string" || !/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(deployment.url))) throw new Error("QA deployment URLが不正です。");
    ids.add(deployment.id);
  }
  if (value.intent !== undefined && (!object(value.intent) || !fullSha(value.intent.sha)
    || Object.keys(value.intent).some((key) => !["sha", "phase", "attemptId", "startedAt"].includes(key))
    || !phase(value.intent.phase) || !leaseToken(value.intent.attemptId) || !timestamp(value.intent.startedAt))) throw new Error("QA作成intentが不正です。");
  if (value.readyDeploymentId !== undefined && (!deploymentId(value.readyDeploymentId) || !value.deployments.some((d) => d.id === value.readyDeploymentId && d.phase === "application"))) throw new Error("QA READY記録が不正です。");
  if (value.aliasSha !== undefined && (!fullSha(value.aliasSha) || !value.readyDeploymentId || !value.database)) throw new Error("QA alias記録が不正です。");
  if (value.aliasSha !== undefined && (value.aliasSha !== value.headSha || !value.deployments.some((d) => d.id === value.readyDeploymentId && d.sha === value.aliasSha))) throw new Error("QA aliasの最新SHAが一致しません。");
  if (value.aliasAssignment !== undefined) {
    const assignment = value.aliasAssignment;
    if (value.purpose !== "probe" || !value.database || value.intent || !object(assignment)
      || Object.keys(assignment).some((key) => !["alias", "deploymentId", "sha", "state"].includes(key))
      || assignment.alias !== qaAlias(value.slot as Slot) || !deploymentId(assignment.deploymentId) || !fullSha(assignment.sha)
      || !["pending", "assigned"].includes(String(assignment.state))
      || !value.deployments.some((d) => d.id === assignment.deploymentId && d.sha === assignment.sha && d.phase === "application")
      || (value.state === "free" && assignment.state !== "assigned")
      || (value.state === "held" && (value.readyDeploymentId !== assignment.deploymentId || value.headSha !== assignment.sha))) {
      throw new Error("限定aliasの対象記録が不正です。");
    }
  }
  if (value.state !== "held" && (value.readyDeploymentId !== undefined || value.aliasSha !== undefined)
    || value.state === "free" && value.intent !== undefined) throw new Error("返却中・返却済みのREADYまたはintent記録が不正です。");
  // Canonicalize optional undefined fields exactly as the immutable JSON API does.
  return JSON.parse(JSON.stringify(value)) as QaLeaseRecord;
}
function validateTransition(previous: QaLeaseRecord, next: QaLeaseRecord): void {
  if (previous.slot !== next.slot) throw new Error("貸出枠を変更できません。");
  if (previous.state === "free") {
    if (next.state !== "held" || next.leaseId === previous.leaseId || next.branch === previous.branch
      || next.database || next.deployments.length || next.intent || next.aliasAssignment) throw new Error("新貸出には新しいPR枝とleaseが必要です。");
  } else {
    if (previous.purpose !== next.purpose) throw new Error("貸出の用途を途中で変更できません。");
    if (next.leaseId !== previous.leaseId || next.pr !== previous.pr || next.branch !== previous.branch || next.createdAt !== previous.createdAt) throw new Error("古いleaseまたは別の所有者の更新を拒否しました。");
    if (previous.state === "deleting" && next.state === "held" || previous.state === "held" && next.state === "free") throw new Error("QA返却の状態遷移が不正です。");
    if (previous.state === "deleting" && next.headSha !== previous.headSha) throw new Error("削除中のhead SHAを変更できません。");
    if (previous.database && !sameDatabase(previous.database, next.database)) throw new Error("使用中のNative DB識別子が変わりました。");
    if (previous.aliasAssignment) {
      const before = previous.aliasAssignment, after = next.aliasAssignment;
      if (!after || before.alias !== after.alias || before.deploymentId !== after.deploymentId || before.sha !== after.sha
        || before.state === "assigned" && after.state !== "assigned") throw new Error("限定aliasの対象・確認記録を変更できません。");
    } else if (next.aliasAssignment && (previous.state !== "held" || next.state !== "held"
      || previous.purpose !== "probe" || next.aliasAssignment.state !== "pending"
      || previous.readyDeploymentId !== next.aliasAssignment.deploymentId || previous.headSha !== next.aliasAssignment.sha)) {
      throw new Error("限定aliasは使用中probeの確認済みREADYから開始してください。");
    }
    for (const deployment of previous.deployments) {
      if (!next.deployments.some((d) => d.id === deployment.id && d.sha === deployment.sha && d.phase === deployment.phase)) throw new Error("QA deployment削除対象の記録が失われました。");
    }
  }
  if (previous.retiredDatabases.some((db) => !next.retiredDatabases.some((d) => sameDatabase(d, db)))) throw new Error("返却済みDBの記録が失われました。");
  if (next.state === "free" && next.database && !next.retiredDatabases.some((d) => sameDatabase(d, next.database))) throw new Error("返却済みDBの識別情報がありません。");
  if (next.state === "held" && next.database && next.retiredDatabases.some((d) => d.branchId === next.database!.branchId || d.endpointId === next.database!.endpointId || d.host === next.database!.host)) throw new Error("前貸出のDBが新貸出に再利用されています。");
}
/** Call with all pages of the dedicated task. Ordinary Vercel records are ignored. */
export function replayDeployments(records: readonly GithubDeployment[]): Pool {
  const pool: Pool = { qa1: null, qa2: null, qa3: null };
  const ids = new Set<number>();
  const usedBranches = new Map<string, string>();
  const leaseOwners = new Map<string, string>();
  const deploymentOwners = new Map<string, string>();
  const retiredDatabases = new Map<string, DatabaseIdentity>();
  for (const deployment of [...records].sort((a, b) => a.id - b.id)) {
    if (deployment.task !== QA_TASK) continue;
    if (!integer(deployment.id) || ids.has(deployment.id) || deployment.environment !== QA_ENVIRONMENT) throw new Error("QA台帳の記録が不正です。");
    ids.add(deployment.id);
    const next = parseLeaseRecord(deployment.payload);
    if (deployment.sha !== next.headSha) throw new Error("QA台帳SHAが一致しません。");
    const previous = pool[next.slot];
    if (next.previousRecordId !== (previous?.id ?? null) || next.sequence !== (previous?.payload.sequence ?? 0) + 1) throw new Error("QA台帳の更新系列が分岐しています。枠は解放しません。");
    if (previous) validateTransition(previous.payload, next);
    else if (next.state !== "held" || next.database || next.deployments.length || next.intent || next.readyDeploymentId || next.aliasSha || next.aliasAssignment) throw new Error("QA初回貸出が不正です。");
    const owner = JSON.stringify([next.slot, next.pr, next.branch]);
    if (leaseOwners.has(next.leaseId) && (leaseOwners.get(next.leaseId) !== owner || previous?.payload.state === "free")) throw new Error("貸出tokenが別の所有者または返却済み貸出に再利用されています。");
    leaseOwners.set(next.leaseId, owner);
    if (usedBranches.has(next.branch) && usedBranches.get(next.branch) !== next.leaseId) throw new Error("返却済みのfeature枝を再貸出できません。");
    usedBranches.set(next.branch, next.leaseId);
    if (next.state === "held" && next.database && [...retiredDatabases.values()].some((db) => db.branchId === next.database!.branchId || db.endpointId === next.database!.endpointId || db.host === next.database!.host)) throw new Error("別枠の返却済みDBが再利用されています。");
    for (const db of next.retiredDatabases) {
      const old = retiredDatabases.get(db.branchId);
      if (old && !sameDatabase(old, db)) throw new Error("返却済みDBの識別情報が衝突しています。");
      retiredDatabases.set(db.branchId, db);
    }
    for (const resource of next.deployments) {
      if (deploymentOwners.has(resource.id) && deploymentOwners.get(resource.id) !== next.leaseId) throw new Error("deployment IDが別の貸出に共有されています。");
      deploymentOwners.set(resource.id, next.leaseId);
    }
    pool[next.slot] = { id: deployment.id, payload: next };
    const active = Object.values(pool).filter((saved) => saved && saved.payload.state !== "free").map((saved) => saved!.payload);
    if (new Set(active.map((lease) => lease.pr)).size !== active.length || new Set(active.map((lease) => lease.branch)).size !== active.length) throw new Error("PRまたはfeature枝が複数枠に貸出されています。");
    const databases = active.flatMap((record) => record.database ? [record.database] : []);
    for (const key of ["branchId", "endpointId", "host"] as const) if (new Set(databases.map((db) => db[key])).size !== databases.length) throw new Error("Native DBが複数枠で共有されています。");
  }
  return pool;
}
export function nextRecord(saved: SavedLease, changes: Partial<QaLeaseRecord>, now: string): QaLeaseRecord {
  const next = parseLeaseRecord({ ...saved.payload, ...changes, sequence: saved.payload.sequence + 1, previousRecordId: saved.id, updatedAt: now });
  validateTransition(saved.payload, next);
  return next;
}
export function claimRecord(pool: Pool, input: { pr: number; branch: string; sha: string; leaseId: string; now: string; slot?: Slot; purpose?: "probe" }): QaLeaseRecord | null {
  if (Object.values(pool).some((saved) => saved && saved.payload.state !== "free" && saved.payload.pr === input.pr)) throw new Error("PRは既に枠を取得しています。");
  const slot = input.slot ?? SLOTS.find((s) => !pool[s] || pool[s]!.payload.state === "free");
  if (!slot || pool[slot] && pool[slot]!.payload.state !== "free") return null;
  const saved = pool[slot];
  const retiredDatabases = Object.values(pool).flatMap((s) => s?.payload.retiredDatabases ?? []);
  const next = parseLeaseRecord({ protocol: "cake-qa/v1", slot, leaseId: input.leaseId, pr: input.pr, branch: input.branch, headSha: input.sha, state: "held", purpose: input.purpose, createdAt: input.now, updatedAt: input.now, sequence: (saved?.payload.sequence ?? 0) + 1, previousRecordId: saved?.id ?? null, deployments: [], retiredDatabases: [...new Map(retiredDatabases.map((db) => [db.branchId, db])).values()] });
  if (saved) validateTransition(saved.payload, next);
  if (Object.values(pool).some((s) => s && s.payload.branch === next.branch && s.payload.leaseId !== next.leaseId)) throw new Error("新しいPR枝で貸出を取得してください。");
  return next;
}

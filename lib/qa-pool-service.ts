import { randomUUID } from "node:crypto";
import {
  claimRecord, fullSha, featureBranch, nextRecord, sameDatabase, QA_PROJECT_ID, QA_REPOSITORY, SLOTS,
  type Pool, type SavedLease, type QaLeaseRecord, type DatabaseIdentity, type QaDeployment,
} from "./qa-pool";

export type QaPullRequest = { number: number; state: "open" | "closed"; branch: string; sha: string; repository: string; base: string; approved: boolean };
export type RemoteDeployment = {
  id: string; projectId: string; target: string | null; branch: string; sha: string; leaseId: string;
  pr: number; attemptId: string; phase: QaDeployment["phase"]; state: string; url?: string;
};
export type AliasTarget = { projectId: string; deploymentId: string };
export interface QaGateway {
  pool(): Promise<Pool>;
  save(record: QaLeaseRecord): Promise<SavedLease>;
  pullRequest(pr: number): Promise<QaPullRequest>;
  openPullRequests(): Promise<QaPullRequest[]>;
  assertGate(): Promise<void>;
  deployments(record: QaLeaseRecord): Promise<RemoteDeployment[]>;
  deployment(id: string): Promise<RemoteDeployment | null>;
  create(record: QaLeaseRecord): Promise<RemoteDeployment>;
  database(record: QaLeaseRecord): Promise<DatabaseIdentity | null>;
  databaseGone(identity: DatabaseIdentity): Promise<boolean>;
  alias(slot: QaLeaseRecord["slot"]): Promise<AliasTarget | null>;
  assignAlias(record: QaLeaseRecord, deployment: RemoteDeployment): Promise<void>;
  deleteAlias(record: QaLeaseRecord): Promise<void>;
  deleteDeployment(deployment: RemoteDeployment): Promise<void>;
  deletionApproved(): boolean;
}
export type QaRequest = { action: "claim" | "refresh" | "release"; pr?: number; leaseId?: string };
const terminal = (state: string) => ["READY", "ERROR", "CANCELED", "BLOCKED"].includes(state);

/** One bounded reconciliation pass; never waits for a build or Native cleanup. */
export async function runQaRequest(gateway: QaGateway, request: QaRequest, options: { now?: () => string; token?: () => string; log?: (message: string) => void } = {}): Promise<void> {
  const now = options.now ?? (() => new Date().toISOString());
  const token = options.token ?? randomUUID;
  const log = options.log ?? console.log;
  await gateway.assertGate();
  let pool = await gateway.pool();
  const assertCurrent = async (saved: SavedLease) => {
    const latest = (await gateway.pool())[saved.payload.slot];
    if (latest?.id !== saved.id || latest.payload.leaseId !== saved.payload.leaseId || latest.payload.state !== saved.payload.state) throw new Error("貸出世代が変わりました。旧処理を停止します。");
  };
  const save = async (saved: SavedLease, changes: Partial<QaLeaseRecord>) => {
    // Catch any out-of-protocol writer before every mutation. Actions owns the serialization.
    await assertCurrent(saved);
    return gateway.save(nextRecord(saved, changes, now()));
  };
  const check = (record: QaLeaseRecord, deployment: RemoteDeployment) => {
    if (deployment.projectId !== QA_PROJECT_ID || !(deployment.target === null || deployment.target === "preview")
      || deployment.branch !== record.branch || deployment.leaseId !== record.leaseId || deployment.pr !== record.pr
      || !fullSha(deployment.sha) || !/^dpl_[a-zA-Z0-9_-]+$/.test(deployment.id)) throw new Error("deploymentが貸出・project・feature枝に一致しません。");
    const known = record.deployments.find((d) => d.id === deployment.id);
    if (known && (known.sha !== deployment.sha || known.phase !== deployment.phase)) throw new Error("deploymentの保存済みSHAが一致しません。");
  };
  const validPr = (pr: QaPullRequest) => pr.repository === QA_REPOSITORY && pr.base === "main" && featureBranch(pr.branch) && fullSha(pr.sha);
  const recover = async (initial: SavedLease): Promise<SavedLease> => {
    let saved = initial;
    const remote = await gateway.deployments(saved.payload);
    for (const deployment of remote) {
      check(saved.payload, deployment);
      if (saved.payload.deployments.some((d) => d.id === deployment.id)) continue;
      const intent = saved.payload.intent;
      if (!intent || deployment.attemptId !== intent.attemptId || deployment.sha !== intent.sha || deployment.phase !== intent.phase) throw new Error("記録外deploymentがあります。貸出を保持して調査してください。");
      saved = await save(saved, { deployments: [...saved.payload.deployments, { id: deployment.id, sha: deployment.sha, phase: deployment.phase, url: deployment.url }], intent: undefined });
    }
    return saved;
  };
  const reconcile = async (initial: SavedLease): Promise<void> => {
    let saved = initial;
    let record = saved.payload;
    const pr = await gateway.pullRequest(record.pr);
    if (!validPr(pr) || pr.branch !== record.branch) throw new Error("PRのfeature枝を確認できません。貸出を保持します。");
    if (pr.state === "closed" && record.state === "held") {
      saved = await save(saved, { state: "deleting", readyDeploymentId: undefined, aliasSha: undefined });
      record = saved.payload;
    }
    saved = await recover(saved);
    record = saved.payload;
    if (record.state === "deleting") {
      // Ambiguous POST remains quarantined; absence from one list is not proof of no creation.
      if (record.intent) { log(`Cake: ${record.slot} の作成応答が未確認です。削除・解放を保留します。`); return; }
      if (!gateway.deletionApproved()) { log(`Cake: ${record.slot} は削除待ちです。不可逆削除の承認設定が必要です。`); return; }
      if (!record.database && record.deployments.length) {
        const database = await gateway.database(record);
        if (!database) { log(`Cake: ${record.slot} のNative DB所属が未確認です。枠を保持します。`); return; }
        saved = await save(saved, { database }); record = saved.payload;
      }
      const alias = await gateway.alias(record.slot);
      if (alias) {
        if (alias.projectId !== QA_PROJECT_ID || !record.deployments.some((d) => d.id === alias.deploymentId)) throw new Error("固定aliasが別の貸出を指しています。削除を拒否します。");
        await assertCurrent(saved);
        await gateway.deleteAlias(record);
        if (await gateway.alias(record.slot)) throw new Error("固定aliasの削除を確認できません。");
      }
      // GET each recorded ID before deleting it; never infer an ID from a URL or slot name.
      const deletionTargets: RemoteDeployment[] = [];
      for (const known of record.deployments) {
        const deployment = await gateway.deployment(known.id);
        if (!deployment) continue;
        check(record, deployment);
        deletionTargets.push(deployment);
      }
      for (const deployment of deletionTargets) {
        await assertCurrent(saved);
        await gateway.deleteDeployment(deployment);
      }
      if ((await gateway.deployments(record)).length) { log(`Cake: ${record.slot} のdeployment削除を待っています。`); return; }
      for (const known of record.deployments) if (await gateway.deployment(known.id)) throw new Error("deployment消失を確認できません。");
      if (record.database && !(await gateway.databaseGone(record.database))) { log(`Cake: ${record.slot} のNative branch/endpoint消失を待っています。`); return; }
      const retiredDatabases = record.database ? [...record.retiredDatabases, record.database] : record.retiredDatabases;
      await save(saved, { state: "free", retiredDatabases });
      log(`Cake: ${record.slot} の返却確認が完了しました。`);
      return;
    }
    if (pr.state !== "open" || !pr.approved) { log(`Cake: PR #${record.pr} の最新SHA承認を待っています。`); return; }
    if (pr.sha !== record.headSha) {
      saved = await save(saved, { headSha: pr.sha, readyDeploymentId: undefined, aliasSha: undefined });
      record = saved.payload;
    }
    if (record.intent) { log(`Cake: ${record.slot} の作成応答が未確認です。重複作成しません。`); return; }
    if (!record.database && record.deployments.length) {
      const database = await gateway.database(record);
      if (!database) { log(`Cake: ${record.slot} のNative DB識別を待っています。`); return; }
      saved = await save(saved, { database }); record = saved.payload;
    }
    // Keep all deployment IDs, including failed provisioning builds and older head SHAs.
    const candidate = [...record.deployments].reverse().find((d) => d.sha === record.headSha && d.phase === (record.database ? "application" : "provisioning"));
    if (!candidate) {
      // An in-flight old provisioning build must finish before creating a build with verified host.
      for (const older of record.deployments) {
        const remote = await gateway.deployment(older.id);
        if (!remote) throw new Error("使用中deploymentが消失しました。Native DB再作成を防ぐため停止します。");
        check(record, remote);
        if (!terminal(remote.state)) { log(`Cake: ${record.slot} の既存build完了を待っています。`); return; }
      }
      const current = await gateway.pullRequest(record.pr);
      if (!validPr(current) || current.branch !== record.branch || current.state !== "open" || current.sha !== record.headSha || !current.approved) return;
      saved = await save(saved, { intent: { sha: record.headSha, phase: record.database ? "application" : "provisioning", attemptId: token(), startedAt: now() } });
      await assertCurrent(saved);
      const deployment = await gateway.create(saved.payload); // intent survives any response loss
      check(saved.payload, deployment);
      if (deployment.sha !== saved.payload.intent!.sha || deployment.attemptId !== saved.payload.intent!.attemptId || deployment.phase !== saved.payload.intent!.phase) throw new Error("作成応答のSHAまたはintentが一致しません。");
      await save(saved, { deployments: [...saved.payload.deployments, { id: deployment.id, sha: deployment.sha, phase: deployment.phase, url: deployment.url }], intent: undefined });
      log(`Cake: ${record.slot} の${deployment.phase} deploymentを記録しました。`);
      return;
    }
    const deployment = await gateway.deployment(candidate.id);
    if (!deployment) throw new Error("使用中deploymentが消失しました。枠を保持します。");
    check(record, deployment);
    if (deployment.phase !== "application" || deployment.state !== "READY") { log(`Cake: ${record.slot} deployment ${deployment.state}`); return; }
    // Native identity is re-read even on same-PR pushes; no silent branch recreation.
    const identity = await gateway.database(record);
    if (!identity || !sameDatabase(identity, record.database)) throw new Error("Native DB識別子が変更・消失しました。");
    if (record.readyDeploymentId === deployment.id && record.aliasSha === record.headSha) {
      const alias = await gateway.alias(record.slot);
      if (alias?.projectId !== QA_PROJECT_ID || alias.deploymentId !== deployment.id) throw new Error("貸出中の固定aliasが変更されました。");
      return;
    }
    const current = await gateway.pullRequest(record.pr);
    const latest = (await gateway.pool())[record.slot];
    if (!validPr(current) || current.branch !== record.branch || current.state !== "open" || current.sha !== deployment.sha || !current.approved || latest?.id !== saved.id || latest.payload.state !== "held") return;
    const alias = await gateway.alias(record.slot);
    if (alias && (alias.projectId !== QA_PROJECT_ID || !record.deployments.some((d) => d.id === alias.deploymentId))) throw new Error("候補aliasは別deploymentに割当済みです。上書きしません。");
    if (alias?.deploymentId !== deployment.id) {
      await assertCurrent(saved);
      await gateway.assignAlias(record, deployment);
    }
    const assigned = await gateway.alias(record.slot);
    if (assigned?.projectId !== QA_PROJECT_ID || assigned.deploymentId !== deployment.id) throw new Error("alias割当を確認できません。");
    const url = deployment.url;
    if (!url) throw new Error("READY deployment固有URLを確認できません。");
    await save(saved, { readyDeploymentId: deployment.id, aliasSha: deployment.sha, deployments: record.deployments.map((d) => d.id === deployment.id ? { ...d, url } : d) });
    log(`Cake: ${record.slot} READY (PR #${record.pr}, ${deployment.sha.slice(0, 7)})`);
  };
  if (request.action === "release") {
    const saved = Object.values(pool).find((s) => s && s.payload.state !== "free" && s.payload.pr === request.pr);
    if (!saved || !request.leaseId || saved.payload.leaseId !== request.leaseId) throw new Error("手動返却には現在のPRとlease IDが必要です。古い貸出を拒否します。");
    const deleting = saved.payload.state === "deleting" ? saved : await save(saved, { state: "deleting", readyDeploymentId: undefined, aliasSha: undefined });
    await reconcile(deleting); return;
  }
  for (const slot of SLOTS) {
    const saved = pool[slot];
    if (saved && saved.payload.state !== "free") {
      try { await reconcile(saved); } catch { log(`Cake: ${slot} の確認に失敗しました。貸出を保持します。`); }
    }
  }
  pool = await gateway.pool();
  const candidates = request.action === "claim" && request.pr ? [await gateway.pullRequest(request.pr)] : await gateway.openPullRequests();
  for (const pr of candidates.sort((a, b) => a.number - b.number)) {
    if (!validPr(pr) || pr.state !== "open" || !pr.approved || Object.values(pool).some((s) => s && s.payload.state !== "free" && s.payload.pr === pr.number)) continue;
    // A feature branch is single-use even when the same closed PR is reopened.
    if (Object.values(pool).some((s) => s?.payload.branch === pr.branch)) { log(`Cake: PR #${pr.number} は返却済みです。新しいタスク枝とPRを作成してください。`); continue; }
    const record = claimRecord(pool, { pr: pr.number, branch: pr.branch, sha: pr.sha, leaseId: token(), now: now() });
    if (!record) { log(`Cake: PR #${pr.number} は空きQA枠を待っています。`); break; }
    const saved = await gateway.save(record);
    pool[record.slot] = saved;
    await reconcile(saved);
  }
}

import { randomUUID } from "node:crypto";
import {
  claimRecord, fullSha, featureBranch, leaseToken, nextRecord, sameDatabase, QA_PROJECT_ID, QA_REPOSITORY, SLOTS,
  type Pool, type SavedLease, type QaLeaseRecord, type DatabaseIdentity, type QaDeployment,
} from "./qa-pool";
import { aliasPlan, deletePlan, type AliasPlan, type DeletePlan, type ProbeApproval } from "./qa-pool-authorization";

export type QaPullRequest = { number: number; state: "open" | "closed"; branch: string; sha: string; repository: string; base: string; approved: boolean };
export type RemoteDeployment = {
  id: string; projectId: string; target: string | null; branch: string; sha: string; leaseId: string;
  pr: number; attemptId: string; phase: QaDeployment["phase"]; state: string; url?: string;
};
export type AliasTarget = { projectId: string; deploymentId: string };
export type QaGateTarget = { pr: number; branch: string; sha: string };
export interface QaGateway {
  pool(): Promise<Pool>;
  save(record: QaLeaseRecord): Promise<SavedLease>;
  pullRequest(pr: number): Promise<QaPullRequest>;
  openPullRequests(): Promise<QaPullRequest[]>;
  generationEnabled(): boolean;
  assertGate(mode: "create" | "probe" | "cleanup" | "alias", target?: QaGateTarget): Promise<void>;
  probeAuthorization(pr: number, sha: string): ProbeApproval | null;
  aliasApproved(plan: AliasPlan): boolean;
  deployments(record: QaLeaseRecord): Promise<RemoteDeployment[]>;
  deployment(id: string): Promise<RemoteDeployment | null>;
  create(record: QaLeaseRecord): Promise<RemoteDeployment>;
  database(record: QaLeaseRecord, mode?: "create" | "cleanup"): Promise<DatabaseIdentity | null>;
  databaseGone(identity: DatabaseIdentity): Promise<boolean>;
  alias(slot: QaLeaseRecord["slot"]): Promise<AliasTarget | null>;
  assignAlias(record: QaLeaseRecord, deployment: RemoteDeployment): Promise<void>;
  assignReadyAlias(record: QaLeaseRecord, deployment: RemoteDeployment, plan: AliasPlan): Promise<void>;
  deleteAlias(record: QaLeaseRecord, plan: DeletePlan): Promise<void>;
  deleteDeployment(record: QaLeaseRecord, deployment: RemoteDeployment, plan: DeletePlan): Promise<void>;
  deletionApproved(plan: DeletePlan): boolean;
}
export type QaRequest = { action: "claim" | "refresh" | "release" | "probe" | "alias-only" | "close";
  pr?: number; leaseId?: string; sha?: string; slot?: QaLeaseRecord["slot"]; deploymentId?: string };
const terminal = (state: string) => ["READY", "ERROR", "CANCELED", "BLOCKED"].includes(state);

/** One bounded reconciliation pass; never waits for a build or Native cleanup. */
export async function runQaRequest(gateway: QaGateway, request: QaRequest, options: { now?: () => string; token?: () => string; log?: (message: string) => void } = {}): Promise<void> {
  const now = options.now ?? (() => new Date().toISOString());
  const token = options.token ?? randomUUID;
  const log = options.log ?? console.log;
  let pool = await gateway.pool();
  const gateTarget = (pr: QaPullRequest): QaGateTarget => ({ pr: pr.number, branch: pr.branch, sha: pr.sha });
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
  const reconcile = async (initial: SavedLease, mode: "normal" | "probe" | "release" | "close" = "normal"): Promise<void> => {
    let saved = initial;
    let record = saved.payload;
    const pr = await gateway.pullRequest(record.pr);
    if (!validPr(pr) || pr.branch !== record.branch) throw new Error("PRのfeature枝を確認できません。貸出を保持します。");
    if (mode === "close" && pr.state !== "closed") return;
    if (mode === "probe" && (record.state !== "held" || pr.state !== "open")) throw new Error("probeは使用中のOPEN PRだけを進めます。返却は別の操作で行ってください。");
    if ((pr.state === "closed" || mode === "release") && record.state === "held") {
      saved = await save(saved, { state: "deleting", readyDeploymentId: undefined, aliasSha: undefined });
      record = saved.payload;
    }
    if (record.state === "deleting") {
      await gateway.assertGate("cleanup");
      saved = await recover(saved);
      record = saved.payload;
      // Ambiguous POST remains quarantined; absence from one list is not proof of no creation.
      if (record.intent) { log(`Cake: ${record.slot} の作成応答が未確認です。削除・解放を保留します。`); return; }
      if (!record.database) {
        const database = await gateway.database(record, "cleanup");
        if (database) {
          if (!record.deployments.length) throw new Error("作成記録のないNative DBがあります。枠を保持します。");
          saved = await save(saved, { database }); record = saved.payload;
        } else if (record.deployments.length) {
          log(`Cake: ${record.slot} のNative DB所属が未確認です。枠を保持します。`); return;
        }
      }
      if (record.database) {
        const database = await gateway.database(record, "cleanup");
        if (database ? !sameDatabase(database, record.database) : !(await gateway.databaseGone(record.database))) {
          throw new Error("削除前のNative DB識別子が変更・確認不能です。削除を開始しません。");
        }
      }
      // Validate every recorded resource before the first irreversible mutation.
      const deletionTargets: RemoteDeployment[] = [];
      for (const known of record.deployments) {
        const deployment = await gateway.deployment(known.id);
        if (!deployment) continue;
        check(record, deployment);
        deletionTargets.push(deployment);
      }
      const trackedAlias = record.aliasAssignment;
      const alias = record.purpose === "probe" && !trackedAlias ? null : await gateway.alias(record.slot);
      const plan = deletePlan(record);
      const assertDeletionApproval = () => {
        if (!gateway.deletionApproved(plan)) throw new Error("現在のlease・全resource IDに一致する有効な削除承認がありません。");
      };
      if (alias) {
        if (alias.projectId !== QA_PROJECT_ID || !record.deployments.some((d) => d.id === alias.deploymentId)
          || trackedAlias && alias.deploymentId !== trackedAlias.deploymentId) throw new Error("固定aliasが別の貸出を指しています。削除を拒否します。");
      }
      if (trackedAlias?.state === "pending" && !alias) { log(`Cake: ${record.slot} のalias作成応答が未確認です。削除・解放を保留します。`); return; }
      if (!gateway.deletionApproved(plan)) { log(`Cake: ${record.slot} は削除対象manifestの承認待ちです。`); return; }
      if (trackedAlias?.state === "pending" && alias) {
        assertDeletionApproval();
        saved = await save(saved, { aliasAssignment: { ...trackedAlias, state: "assigned" } });
        record = saved.payload;
      }
      if (alias) {
        await assertCurrent(saved);
        assertDeletionApproval();
        await gateway.deleteAlias(record, plan);
        if (await gateway.alias(record.slot)) throw new Error("固定aliasの削除を確認できません。");
      }
      for (const deployment of deletionTargets) {
        await assertCurrent(saved);
        assertDeletionApproval();
        await gateway.deleteDeployment(record, deployment, plan);
      }
      if ((await gateway.deployments(record)).length) { log(`Cake: ${record.slot} のdeployment削除を待っています。`); return; }
      for (const known of record.deployments) if (await gateway.deployment(known.id)) throw new Error("deployment消失を確認できません。");
      if (record.database && !(await gateway.databaseGone(record.database))) { log(`Cake: ${record.slot} のNative branch/endpoint消失を待っています。`); return; }
      if ((record.purpose !== "probe" || trackedAlias) && await gateway.alias(record.slot)) throw new Error("返却前の固定alias消失を確認できません。");
      const retiredDatabases = record.database ? [...record.retiredDatabases, record.database] : record.retiredDatabases;
      assertDeletionApproval();
      await save(saved, { state: "free", retiredDatabases });
      log(`Cake: ${record.slot} の返却確認が完了しました。`);
      return;
    }
    const probing = mode === "probe";
    if (record.purpose === "probe" && !probing) { log(`Cake: ${record.slot} のprobeは対象SHAの限定実行でのみ進めます。`); return; }
    if (probing) {
      if (record.aliasAssignment && request.sha !== record.aliasAssignment.sha) throw new Error("固定alias確認中のprobe対象SHAを変更できません。");
      const approval = gateway.probeAuthorization(record.pr, request.sha!);
      if (record.purpose !== "probe" || !approval || approval.slot !== record.slot
        || pr.state !== "open" || pr.sha !== request.sha) {
        throw new Error("probeのPR・SHA・枠または期限付き承認が一致しません。");
      }
      await gateway.assertGate("probe", gateTarget(pr));
    } else {
      if (!gateway.generationEnabled()) { log(`Cake: ${record.slot} は生成無効のため保持します。`); return; }
      if (pr.state !== "open" || !pr.approved) { log(`Cake: PR #${record.pr} の最新SHA承認を待っています。`); return; }
      await gateway.assertGate("create", gateTarget(pr));
    }
    saved = await recover(saved);
    record = saved.payload;
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
      if (!validPr(current) || current.branch !== record.branch || current.state !== "open" || current.sha !== record.headSha) return;
      if (probing ? gateway.probeAuthorization(record.pr, record.headSha)?.slot !== record.slot : !current.approved || !gateway.generationEnabled()) return;
      await gateway.assertGate(probing ? "probe" : "create", gateTarget(current));
      saved = await save(saved, { intent: { sha: record.headSha, phase: record.database ? "application" : "provisioning", attemptId: token(), startedAt: now() } });
      await assertCurrent(saved);
      if (probing && gateway.probeAuthorization(record.pr, record.headSha)?.slot !== record.slot) {
        // No creation request has been sent, so this prepared intent is safe to clear.
        await save(saved, { intent: undefined });
        throw new Error("probe承認が期限切れです。生成を停止します。");
      }
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
    if (probing) {
      const current = await gateway.pullRequest(record.pr);
      if (!validPr(current) || current.branch !== record.branch || current.state !== "open" || current.sha !== record.headSha
        || gateway.probeAuthorization(record.pr, record.headSha)?.slot !== record.slot) throw new Error("probeの最新SHAまたは承認が変わりました。");
      if (!deployment.url) throw new Error("probeのREADY Deployment URLを確認できません。");
      if (record.readyDeploymentId !== deployment.id) {
        await save(saved, { readyDeploymentId: deployment.id, deployments: record.deployments.map((d) => d.id === deployment.id ? { ...d, url: deployment.url } : d) });
      }
      log(`Cake: ${record.slot} probe READY (PR #${record.pr}, ${deployment.sha.slice(0, 7)})`);
      return;
    }
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
  if (request.action === "alias-only") {
    if (!Number.isSafeInteger(request.pr) || Number(request.pr) < 1 || !fullSha(request.sha)
      || !leaseToken(request.leaseId) || !SLOTS.includes(request.slot as QaLeaseRecord["slot"])
      || typeof request.deploymentId !== "string" || !/^dpl_[a-zA-Z0-9_-]+$/.test(request.deploymentId)) {
      throw new Error("限定aliasには対象PR・完全SHA・枠・lease・READY deploymentが必要です。");
    }
    let saved = pool[request.slot!];
    if (!saved) throw new Error("限定aliasの既存貸出がありません。新しい貸出は作成しません。");
    const verify = async (target: SavedLease) => {
      await assertCurrent(target);
      const record = target.payload;
      if (record.state !== "held" || record.purpose !== "probe" || record.pr !== request.pr || record.slot !== request.slot
        || record.leaseId !== request.leaseId || record.headSha !== request.sha || record.intent
        || record.readyDeploymentId !== request.deploymentId) throw new Error("限定aliasの現在貸出・SHA・READY対象が一致しません。");
      const plan = aliasPlan(record, request.deploymentId!);
      if (!gateway.aliasApproved(plan)) throw new Error("対象lease・READY deployment・DBへの有効なalias承認がありません。");
      const pr = await gateway.pullRequest(record.pr);
      if (!validPr(pr) || pr.state !== "open" || pr.branch !== record.branch || pr.sha !== record.headSha) throw new Error("限定aliasのOPEN PR・現在HEADが一致しません。");
      await gateway.assertGate("alias", gateTarget(pr));
      const deployment = await gateway.deployment(request.deploymentId!);
      if (!deployment) throw new Error("限定aliasのREADY deploymentが消失しました。");
      check(record, deployment);
      if (deployment.id !== request.deploymentId || deployment.sha !== record.headSha
        || deployment.phase !== "application" || deployment.state !== "READY") throw new Error("限定aliasには指定ID・現在HEADのREADY applicationだけを使えます。");
      const database = await gateway.database(record);
      if (!database || !sameDatabase(database, plan.database)) throw new Error("限定aliasのNative DB識別子が変更・消失しました。");
      const alias = await gateway.alias(record.slot);
      if (alias && (alias.projectId !== QA_PROJECT_ID || alias.deploymentId !== deployment.id)) throw new Error("固定aliasは別の対象に割当済みです。上書きしません。");
      const current = await gateway.pullRequest(record.pr);
      if (!validPr(current) || current.state !== "open" || current.branch !== record.branch || current.sha !== record.headSha) throw new Error("限定aliasのPR・現在HEADが確認中に変わりました。");
      await assertCurrent(target);
      if (!gateway.aliasApproved(plan)) throw new Error("限定alias承認が期限切れまたは変更されました。");
      return { deployment, plan, alias };
    };
    let verified = await verify(saved);
    const existing = saved.payload.aliasAssignment;
    if (existing) {
      if (existing.alias !== verified.plan.alias || existing.deploymentId !== request.deploymentId || existing.sha !== request.sha) throw new Error("限定aliasの保存済み対象を変更できません。");
      if (!verified.alias) {
        if (existing.state === "assigned") throw new Error("確認済み固定aliasが消失しました。再割当しません。");
        log(`Cake: ${saved.payload.slot} のalias作成応答が未確認です。再POSTせず保持します。`); return;
      }
      if (existing.state === "assigned") return;
    } else {
      saved = await save(saved, { aliasAssignment: { alias: verified.plan.alias, deploymentId: request.deploymentId!, sha: request.sha!, state: "pending" } });
      verified = await verify(saved);
      if (!verified.alias) await gateway.assignReadyAlias(saved.payload, verified.deployment, verified.plan);
    }
    verified = await verify(saved);
    if (!verified.alias) throw new Error("固定alias割当を確認できません。pending記録を保持します。");
    await save(saved, { aliasAssignment: { ...saved.payload.aliasAssignment!, state: "assigned" } });
    log(`Cake: ${saved.payload.slot} の限定READY alias割当を確認しました。`);
    return;
  }
  if (request.action === "close") {
    if (!Number.isSafeInteger(request.pr) || Number(request.pr) < 1) throw new Error("close確認には対象PRが必要です。");
    const saved = Object.values(pool).find((s) => s && s.payload.state !== "free" && s.payload.pr === request.pr);
    if (!saved) return;
    if (request.leaseId && request.leaseId !== saved.payload.leaseId) throw new Error("close対象のleaseが一致しません。");
    await reconcile(saved, "close");
    return;
  }
  if (request.action === "release") {
    const saved = Object.values(pool).find((s) => s && s.payload.state !== "free" && s.payload.pr === request.pr);
    if (!saved || !request.leaseId || saved.payload.leaseId !== request.leaseId) throw new Error("手動返却には現在のPRとlease IDが必要です。古い貸出を拒否します。");
    await reconcile(saved, "release"); return;
  }
  if (request.action === "probe") {
    if (!Number.isSafeInteger(request.pr) || Number(request.pr) < 1 || !fullSha(request.sha)) throw new Error("probeには対象PRと完全SHAが必要です。");
    const approval = gateway.probeAuthorization(request.pr!, request.sha);
    if (!approval) throw new Error("対象PR・SHAへの期限付きprobe承認がありません。");
    const pr = await gateway.pullRequest(request.pr!);
    if (!validPr(pr) || pr.state !== "open" || pr.sha !== request.sha) throw new Error("probe対象PRの最新SHAが一致しません。");
    await gateway.assertGate("probe", gateTarget(pr));
    if (gateway.probeAuthorization(pr.number, pr.sha)?.slot !== approval.slot) throw new Error("probe承認が期限切れまたは変更されました。貸出を開始しません。");
    const existing = Object.values(pool).find((saved) => saved && saved.payload.state !== "free" && saved.payload.pr === pr.number);
    if (existing) {
      if (existing.payload.state !== "held" || existing.payload.purpose !== "probe" || existing.payload.slot !== approval.slot
        || request.leaseId && existing.payload.leaseId !== request.leaseId) throw new Error("probeは別の貸出・SHAを更新できません。");
      await reconcile(existing, "probe"); return;
    }
    if (request.leaseId) throw new Error("指定したprobe貸出がありません。");
    const record = claimRecord(pool, { pr: pr.number, branch: pr.branch, sha: pr.sha, leaseId: token(), now: now(), slot: approval.slot, purpose: "probe" });
    if (!record) { log(`Cake: PR #${pr.number} の承認済みprobe枠は使用中です。`); return; }
    const saved = await gateway.save(record);
    await reconcile(saved, "probe"); return;
  }
  for (const slot of SLOTS) {
    const saved = pool[slot];
    if (saved && saved.payload.state !== "free") {
      try { await reconcile(saved); } catch { log(`Cake: ${slot} の確認に失敗しました。貸出を保持します。`); }
    }
  }
  pool = await gateway.pool();
  if (!gateway.generationEnabled()) return;
  const candidates = request.action === "claim" && request.pr ? [await gateway.pullRequest(request.pr)] : await gateway.openPullRequests();
  for (const pr of candidates.sort((a, b) => a.number - b.number)) {
    if (!validPr(pr) || pr.state !== "open" || !pr.approved || Object.values(pool).some((s) => s && s.payload.state !== "free" && s.payload.pr === pr.number)) continue;
    // A feature branch is single-use even when the same closed PR is reopened.
    if (Object.values(pool).some((s) => s?.payload.branch === pr.branch)) { log(`Cake: PR #${pr.number} は返却済みです。新しいタスク枝とPRを作成してください。`); continue; }
    const record = claimRecord(pool, { pr: pr.number, branch: pr.branch, sha: pr.sha, leaseId: token(), now: now() });
    if (!record) { log(`Cake: PR #${pr.number} は空きQA枠を待っています。`); break; }
    await gateway.assertGate("create", gateTarget(pr));
    const saved = await gateway.save(record);
    pool[record.slot] = saved;
    await reconcile(saved);
  }
}

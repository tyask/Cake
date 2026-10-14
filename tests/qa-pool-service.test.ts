import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runQaRequestWithWaiting } from "../lib/qa-pool-runner";
import { runQaRequest, type AliasTarget, type QaGateTarget, type QaGateway, type QaPullRequest, type QaRequest, type RemoteDeployment } from "../lib/qa-pool-service";
import { HttpQaGateway, runQaWriter, type QaTransport } from "../scripts/qa-pool-writer";
import { aliasApproval, deletePlan, deletionApproval, probeApproval, type AliasApproval, type AliasPlan, type DeleteApproval, type DeletePlan, type ProbeApproval } from "../lib/qa-pool-authorization";
import {
  nextRecord, QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK, replayDeployments,
  type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord, type SavedLease, type Slot,
} from "../lib/qa-pool";

const sha = "a".repeat(40), newSha = "b".repeat(40);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-native", endpointId: "ep-native", host: "ep-native.ap-southeast-1.aws.neon.tech" };
const now = "2026-10-12T01:00:00.000Z";
function lease(pr = 42, slot: Slot = "qa1"): QaLeaseRecord {
  return { protocol: "cake-qa/v1", slot, leaseId: uuid(pr), pr, branch: `codex/task-${pr}`, headSha: sha,
    state: "held", createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z",
    sequence: 1, previousRecordId: null, deployments: [], retiredDatabases: [] };
}
function pullRequest(record = lease()): QaPullRequest {
  return { number: record.pr, state: "open", branch: record.branch, sha: record.headSha, repository: QA_REPOSITORY, base: "main", approved: true };
}
function remote(record: QaLeaseRecord, id = "dpl_application", state = "READY", phase: RemoteDeployment["phase"] = "application", head = record.headSha): RemoteDeployment {
  return { id, state, phase, projectId: QA_PROJECT_ID, target: null, branch: record.branch, sha: head,
    leaseId: record.leaseId, pr: record.pr, attemptId: uuid(900), url: `https://${id.replaceAll("_", "-")}.vercel.app` };
}
function application(record = lease()): QaLeaseRecord {
  const deployment = remote(record);
  return { ...record, database, deployments: [{ id: deployment.id, sha: record.headSha, phase: "application", url: deployment.url }],
    readyDeploymentId: deployment.id, aliasSha: record.headSha };
}
class MemoryGateway implements QaGateway {
  records: GithubDeployment[] = [];
  prs = new Map<number, QaPullRequest>();
  remotes = new Map<string, RemoteDeployment>();
  aliases = new Map<Slot, AliasTarget>();
  native: DatabaseIdentity | null = null;
  gone = false;
  deletionAllowed = true;
  generationAllowed = true;
  cleanupGateError = false;
  probeApprovals: ProbeApproval[] = [];
  aliasApprovals: AliasApproval[] = [];
  deleteApprovals: DeleteApproval[] = [];
  createBehavior: "ok" | "lost" | "failed" = "ok";
  createState = "BUILDING";
  databaseError = false;
  deleteError = false;
  gateError = false;
  gateTargets: { mode: string; target?: QaGateTarget }[] = [];
  gateTargetError?: (target: QaGateTarget) => boolean;
  calls: string[] = [];
  logs: string[] = [];
  poolReads = 0;
  prReads = 0;
  prQueries: number[] = [];
  onPool?: () => void;
  onPr?: () => void;
  onSave?: (saved: SavedLease) => void;
  seed(record: QaLeaseRecord) {
    const id = (this.records.at(-1)?.id ?? 0) + 1;
    const initial = { ...record, deployments: [], database: undefined, intent: undefined, readyDeploymentId: undefined, aliasSha: undefined, aliasAssignment: undefined };
    this.records.push({ id, task: QA_TASK, environment: QA_ENVIRONMENT, sha: record.headSha, payload: structuredClone(initial) });
    if (record.deployments.length || record.database || record.intent || record.readyDeploymentId || record.aliasSha || record.aliasAssignment) {
      this.records.push({ id: id + 1, task: QA_TASK, environment: QA_ENVIRONMENT, sha: record.headSha,
        payload: { ...structuredClone(record), sequence: 2, previousRecordId: id } });
    }
    this.prs.set(record.pr, pullRequest(record));
    this.deleteApprovals.push({ ...deletePlan(record), expiresAt: "2026-10-12T02:00:00.000Z" });
    for (const d of record.deployments) this.remotes.set(d.id, remote(record, d.id, "READY", d.phase, d.sha));
  }
  generationEnabled() { return this.generationAllowed; }
  async assertGate(mode: "create" | "probe" | "cleanup" | "alias", target?: QaGateTarget) {
    this.calls.push(`gate:${mode}`);
    this.gateTargets.push({ mode, target: target && structuredClone(target) });
    if (mode === "cleanup" ? this.cleanupGateError : this.gateError) throw new Error("gate failed");
    if (mode !== "cleanup") {
      assert.ok(target, "creation gates require their exact PR target");
      if (this.gateTargetError?.(target)) throw new Error("target gate failed");
    }
  }
  probeAuthorization(pr: number, head: string) { return probeApproval(JSON.stringify(this.probeApprovals), pr, head, Date.parse(now)); }
  aliasApproved(plan: AliasPlan) { return aliasApproval(JSON.stringify(this.aliasApprovals), plan, Date.parse(now)); }
  async pool() { this.poolReads += 1; this.onPool?.(); return replayDeployments(this.records); }
  async save(record: QaLeaseRecord): Promise<SavedLease> {
    this.calls.push(`save:${record.state}`);
    const id = (this.records.at(-1)?.id ?? 0) + 1;
    const entry = { id, task: QA_TASK, environment: QA_ENVIRONMENT, sha: record.headSha, payload: structuredClone(record) };
    replayDeployments([...this.records, entry]);
    this.records.push(entry);
    const saved = { id, payload: structuredClone(record) };
    this.onSave?.(saved);
    return saved;
  }
  async pullRequest(pr: number) { this.prReads += 1; this.prQueries.push(pr); this.onPr?.(); return structuredClone(this.prs.get(pr)!); }
  async openPullRequests() { return [...this.prs.values()].filter((pr) => pr.state === "open").map((pr) => structuredClone(pr)); }
  async deployments(record: QaLeaseRecord) { this.calls.push("list"); return [...this.remotes.values()].filter((d) => d.branch === record.branch).map((d) => structuredClone(d)); }
  async deployment(id: string) { this.calls.push(`get:${id}`); return structuredClone(this.remotes.get(id) ?? null); }
  async create(record: QaLeaseRecord) {
    this.calls.push("create");
    if (this.createBehavior === "failed") throw new Error("create failed");
    const result = { ...remote(record, `dpl_created${this.calls.filter((c) => c === "create").length}`, this.createState, record.intent!.phase), attemptId: record.intent!.attemptId };
    this.remotes.set(result.id, result);
    if (this.createBehavior === "lost") throw new Error("response lost");
    return structuredClone(result);
  }
  async database() { this.calls.push("database"); if (this.databaseError) throw new Error("database unavailable"); return structuredClone(this.native); }
  async databaseGone() { this.calls.push("databaseGone"); if (this.databaseError) throw new Error("Neon unavailable"); return this.gone; }
  async alias(slot: Slot) { return structuredClone(this.aliases.get(slot) ?? null); }
  async assignAlias(record: QaLeaseRecord, deployment: RemoteDeployment) { this.calls.push("assignAlias"); this.aliases.set(record.slot, { projectId: QA_PROJECT_ID, deploymentId: deployment.id }); }
  async assignReadyAlias(record: QaLeaseRecord, deployment: RemoteDeployment, plan: AliasPlan) {
    assert.ok(this.aliasApproved(plan));
    this.calls.push("assignReadyAlias"); this.aliases.set(record.slot, { projectId: QA_PROJECT_ID, deploymentId: deployment.id });
  }
  deletionApproved(plan: DeletePlan) { return this.deletionAllowed && deletionApproval(JSON.stringify(this.deleteApprovals), plan, Date.parse(now)); }
  async deleteAlias(record: QaLeaseRecord, plan: DeletePlan) {
    assert.deepEqual(plan, deletePlan(record)); assert.ok(this.deletionApproved(plan));
    this.calls.push("deleteAlias"); this.aliases.delete(record.slot);
  }
  async deleteDeployment(record: QaLeaseRecord, deployment: RemoteDeployment, plan: DeletePlan) {
    assert.deepEqual(plan, deletePlan(record)); assert.ok(this.deletionApproved(plan)); assert.ok(plan.deploymentIds.includes(deployment.id));
    this.calls.push(`delete:${deployment.id}`); if (this.deleteError) throw new Error("delete failed"); this.remotes.delete(deployment.id);
  }
  async run(action: QaRequest["action"] = "refresh", pr?: number, leaseId?: string, requestSha?: string) {
    let tokens = 1000;
    await runQaRequest(this, { action, pr, leaseId, sha: requestSha }, { now: () => now, token: () => uuid(++tokens), log: (message) => { this.logs.push(message); } });
  }
  latest(slot: Slot = "qa1") { return replayDeployments(this.records)[slot]!; }
}

test("入口gate失敗と未承認PRは枠取得や生成APIに到達しない", async () => {
  const g = new MemoryGateway();
  g.prs.set(42, pullRequest());
  g.gateError = true;
  await assert.rejects(() => g.run("claim", 42));
  assert.deepEqual(g.calls.filter((call) => call.startsWith("gate:")), ["gate:create"]);
  g.gateError = false;
  g.prs.get(42)!.approved = false;
  await g.run("claim", 42);
  assert.equal(g.records.length, 0);
  assert.equal(g.calls.includes("create"), false);
});

test("空き枠取得は永続intentを先に保存し、provisioningのIDを追跡する", async () => {
  const g = new MemoryGateway();
  g.prs.set(42, pullRequest());
  await g.run("claim", 42);
  const current = g.latest().payload;
  assert.equal(current.state, "held");
  assert.equal(current.pr, 42);
  assert.equal(current.deployments.length, 1);
  assert.equal(current.deployments[0].phase, "provisioning");
  assert.equal(current.intent, undefined);
  const intentIndex = g.records.findIndex((r) => (r.payload as QaLeaseRecord).intent);
  assert.ok(intentIndex > 0);
  assert.ok(g.calls.indexOf("create") > g.calls.indexOf("save:held"));
  assert.equal(g.calls.includes("assignAlias"), false);
  assert.ok(g.gateTargets.filter((entry) => entry.mode === "create").every((entry) => entry.target?.pr === 42 && entry.target.branch === "codex/task-42" && entry.target.sha === sha));
});

test("通常refreshの各PRは個別の対象ゲートを通り、不適合PRのclaimを保存しない", async () => {
  const g = new MemoryGateway();
  g.prs.set(42, pullRequest()); g.prs.set(43, pullRequest(lease(43)));
  g.gateTargetError = (target) => target.pr === 43;
  await assert.rejects(() => g.run(), /target gate/);
  assert.equal(g.calls.filter((call) => call === "create").length, 1);
  assert.equal(g.records.some((entry) => (entry.payload as QaLeaseRecord).pr === 43), false);
  assert.ok(g.gateTargets.some((entry) => entry.target?.pr === 43));
});

test("probeのPR適格性確認は生成ゲートと最初のlease保存より先に行う", async () => {
  const g = new MemoryGateway();
  g.prs.set(42, { ...pullRequest(), state: "closed" });
  g.probeApprovals = [{ projectId: QA_PROJECT_ID, pr: 42, sha, slot: "qa1", expiresAt: "2026-10-12T02:00:00.000Z" }];
  await assert.rejects(() => g.run("probe", 42, undefined, sha), /最新SHA/);
  assert.deepEqual(g.gateTargets, []); assert.deepEqual(g.records, []);
});

test("3枠使用中は4番目のPRを待機させ、追加Deployment/DBを生成しない", async () => {
  const g = new MemoryGateway();
  for (const [index, slot] of (["qa1", "qa2", "qa3"] as const).entries()) {
    const record = lease(42 + index, slot);
    record.deployments = [{ id: `dpl_busy${index}`, sha, phase: "provisioning" }];
    g.seed(record);
  }
  g.prs.set(45, pullRequest(lease(45)));
  await g.run("claim", 45);
  assert.equal(g.records.length, 6);
  assert.equal(g.calls.includes("create"), false);
  assert.ok(g.logs.some((line) => line.includes("空きQA枠を待っています")));
});

test("POST成功後の応答喪失をintentから復元し、同じ作成を再POSTしない", async () => {
  const g = new MemoryGateway();
  g.prs.set(42, pullRequest());
  g.createBehavior = "lost";
  await assert.rejects(() => g.run("claim", 42), /response lost/);
  const pending = g.latest().payload;
  assert.equal(pending.state, "held");
  assert.ok(pending.intent);
  assert.deepEqual(pending.deployments, []);
  g.createBehavior = "ok";
  await g.run();
  assert.equal(g.latest().payload.intent, undefined);
  assert.equal(g.latest().payload.deployments.length, 1);
  assert.equal(g.calls.filter((c) => c === "create").length, 1);
});

test("POSTの成否が不明で一覧にも見つからない場合はheld/intentを維持する", async () => {
  const g = new MemoryGateway();
  g.prs.set(42, pullRequest());
  g.createBehavior = "failed";
  await assert.rejects(() => g.run("claim", 42));
  await g.run();
  assert.equal(g.latest().payload.state, "held");
  assert.ok(g.latest().payload.intent);
  assert.equal(g.calls.filter((c) => c === "create").length, 1);
  g.prs.get(42)!.state = "closed";
  await g.run();
  assert.equal(g.latest().payload.state, "deleting");
  assert.equal(g.calls.some((c) => c.startsWith("delete:")), false);
});

test("Native DB確認後にapplicationを作り、provisioning失敗IDも返却対象として保持する", async () => {
  const g = new MemoryGateway();
  const record = lease();
  record.deployments = [{ id: "dpl_provisioning", sha, phase: "provisioning" }];
  g.seed(record);
  g.remotes.get("dpl_provisioning")!.state = "ERROR";
  g.native = database;
  await g.run();
  assert.deepEqual(g.latest().payload.database, database);
  assert.equal(g.latest().payload.deployments.length, 2);
  assert.equal(g.latest().payload.deployments[1].phase, "application");
  assert.equal(g.calls.includes("assignAlias"), false);
});

test("同一PRへのpushは同じslot/lease/Native DBを保ち、承認済み新SHAのREADYだけaliasへ割り当てる", async () => {
  const g = new MemoryGateway();
  const record = application();
  g.seed(record);
  g.native = database;
  g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId: "dpl_application" });
  g.prs.get(42)!.sha = newSha;
  g.prs.get(42)!.approved = false;
  await g.run();
  assert.equal(g.latest().payload.headSha, sha);
  assert.equal(g.calls.includes("create"), false);
  g.prs.get(42)!.approved = true;
  await g.run();
  const updating = g.latest().payload;
  assert.equal(updating.slot, record.slot);
  assert.equal(updating.leaseId, record.leaseId);
  assert.deepEqual(updating.database, database);
  assert.equal(updating.headSha, newSha);
  assert.equal(updating.readyDeploymentId, undefined);
  assert.equal(g.aliases.get("qa1")!.deploymentId, "dpl_application");
  g.remotes.get("dpl_created1")!.state = "READY";
  await g.run();
  assert.equal(g.latest().payload.aliasSha, newSha);
  assert.equal(g.latest().payload.readyDeploymentId, "dpl_created1");
  assert.equal(g.aliases.get("qa1")!.deploymentId, "dpl_created1");
  assert.equal(g.calls.filter((c) => c === "create").length, 1);
});

test("最新候補のERRORから古いREADYへ戻らず、DBが変わればalias更新を拒否する", async () => {
  for (const badDatabase of [false, true]) {
    const g = new MemoryGateway();
    const record = application();
    record.readyDeploymentId = undefined; record.aliasSha = undefined;
    record.deployments.push({ id: "dpl_latest", sha, phase: "application" });
    g.seed(record);
    g.remotes.get("dpl_latest")!.state = badDatabase ? "READY" : "ERROR";
    g.native = badDatabase ? { ...database, branchId: "br-recreated" } : database;
    await g.run();
    assert.equal(g.latest().payload.state, "held");
    assert.equal(g.latest().payload.readyDeploymentId, undefined);
    assert.equal(g.calls.includes("assignAlias"), false);
  }
});

test("古いleaseでの手動返却と台帳世代変更は生成/alias/削除を拒否する", async () => {
  const g = new MemoryGateway();
  const record = application();
  g.seed(record);
  await assert.rejects(() => g.run("release", 42, uuid(43)), /古い貸出/);
  assert.equal(g.calls.some((c) => c === "create" || c === "assignAlias" || c.startsWith("delete:")), false);
  g.prs.get(42)!.state = "closed";
  g.poolReads = 0;
  g.onPool = () => {
    if (g.poolReads === 2) {
      const replacement = { ...lease(), leaseId: uuid(44) };
      g.records = [{ id: 100, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: replacement }];
    }
  };
  await g.run();
  assert.equal(g.latest().payload.leaseId, uuid(44));
  assert.equal(g.latest().payload.state, "held");
  assert.equal(g.calls.some((c) => c.startsWith("delete:")), false);
});

test("PR closeはdeletingへ進め、全世代/失敗Deploymentを削除しNeon消失確認後だけfreeにする", async () => {
  const g = new MemoryGateway();
  const record = application();
  record.deployments.unshift({ id: "dpl_provisioning", sha, phase: "provisioning" }, { id: "dpl_older", sha: newSha, phase: "application" });
  g.seed(record);
  g.remotes.get("dpl_provisioning")!.state = "ERROR";
  g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId: "dpl_application" });
  g.native = database;
  g.prs.get(42)!.state = "closed";
  await g.run();
  assert.equal(g.latest().payload.state, "deleting");
  assert.equal(g.aliases.has("qa1"), false);
  assert.equal(g.remotes.size, 0);
  for (const d of record.deployments) assert.ok(g.calls.includes(`delete:${d.id}`));
  assert.equal(g.calls.indexOf("deleteAlias") < g.calls.indexOf("delete:dpl_application"), true);
  g.gone = true;
  await g.run();
  assert.equal(g.latest().payload.state, "free");
  assert.deepEqual(g.latest().payload.retiredDatabases, [database]);
});

test("不可逆削除未承認/DELETE失敗/Neon照会失敗はdeletingを保持してfreeにしない", async () => {
  for (const failure of ["approval", "delete", "neon"] as const) {
    const g = new MemoryGateway();
    g.seed(application());
    g.prs.get(42)!.state = "closed";
    g.native = database;
    g.gone = true;
    g.deletionAllowed = failure !== "approval";
    g.deleteError = failure === "delete";
    g.databaseError = failure === "neon";
    await g.run();
    assert.equal(g.latest().payload.state, "deleting");
    assert.equal(g.records.some((r) => (r.payload as QaLeaseRecord).state === "free"), false);
    if (failure === "approval") assert.equal(g.calls.some((c) => c.startsWith("delete:")), false);
  }
});

test("別project/leaseの記録外Deploymentや固定aliasを採用・上書き・削除しない", async () => {
  for (const foreign of ["deployment", "alias"] as const) {
    const g = new MemoryGateway();
    const record = application();
    g.seed(record);
    g.native = database;
    g.prs.get(42)!.state = "closed";
    if (foreign === "deployment") g.remotes.set("dpl_foreign", { ...remote(record, "dpl_foreign"), leaseId: uuid(99) });
    else g.aliases.set("qa1", { projectId: "prj_other", deploymentId: "dpl_other" });
    await g.run();
    assert.notEqual(g.latest().payload.state, "free");
    assert.equal(g.calls.some((c) => c === "assignAlias" || c.startsWith("delete:")), false);
  }
});

test("生成無効/生成gate失敗/未承認HEADでもcloseはdeletingと承認済みcleanupへ進む", async () => {
  const g = new MemoryGateway();
  g.seed(application());
  g.native = database;
  g.generationAllowed = false;
  g.gateError = true;
  g.prs.get(42)!.state = "closed";
  g.prs.get(42)!.approved = false;
  g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId: "dpl_application" });
  await g.run();
  assert.equal(g.latest().payload.state, "deleting");
  assert.ok(g.calls.includes("gate:cleanup"));
  assert.equal(g.calls.includes("gate:create"), false);
  assert.equal(g.calls.includes("create"), false);
  assert.equal(g.remotes.size, 0);
  g.native = null; g.gone = true;
  await g.run();
  assert.equal(g.latest().payload.state, "free");
});

test("手動releaseはopenの新HEAD承認や生成条件を必要とせず現在leaseの削除承認を使う", async () => {
  const g = new MemoryGateway();
  const record = application();
  g.seed(record);
  g.native = database; g.gone = true;
  g.generationAllowed = false; g.gateError = true;
  g.prs.get(42)!.sha = newSha; g.prs.get(42)!.approved = false;
  await g.run("release", 42, record.leaseId);
  assert.equal(g.latest().payload.state, "free");
  assert.equal(g.latest().payload.headSha, sha);
  assert.equal(g.calls.includes("create"), false);
});

test("削除manifestの全ID/lease/SHA/DB/alias/期限が違えばaliasもDeploymentも削除しない", async () => {
  for (const mismatch of ["subset", "extra", "lease", "sha", "database", "alias", "expiry"] as const) {
    const g = new MemoryGateway();
    const record = application();
    record.deployments.push({ id: "dpl_second", sha, phase: "application" });
    g.seed(record); g.native = database;
    g.prs.get(42)!.state = "closed";
    g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId: "dpl_application" });
    const approval = g.deleteApprovals[0];
    if (mismatch === "subset") approval.deploymentIds.pop();
    if (mismatch === "extra") approval.deploymentIds.push("dpl_unknown");
    if (mismatch === "lease") approval.leaseId = uuid(99);
    if (mismatch === "sha") approval.headSha = newSha;
    if (mismatch === "database") approval.database = { ...database, branchId: "br-other" };
    if (mismatch === "alias") approval.alias = "other.vercel.app";
    if (mismatch === "expiry") approval.expiresAt = "2026-10-12T00:00:00.000Z";
    await g.run();
    assert.equal(g.latest().payload.state, "deleting");
    assert.equal(g.remotes.size, 2, mismatch);
    assert.equal(g.aliases.get("qa1")!.deploymentId, "dpl_application");
    assert.equal(g.calls.some((call) => call === "deleteAlias" || call.startsWith("delete:")), false, mismatch);
  }
});

test("全IDのGET所属検証はalias削除より先に行い、後段IDがforeignなら何も削除しない", async () => {
  const g = new MemoryGateway();
  const record = application();
  record.deployments.push({ id: "dpl_wrong", sha, phase: "application" });
  g.seed(record); g.native = database;
  g.prs.get(42)!.state = "closed";
  g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId: "dpl_application" });
  const get = g.deployment.bind(g);
  g.deployment = async (id) => {
    const result = await get(id);
    return id === "dpl_wrong" ? { ...result!, projectId: "prj_foreign" } : result;
  };
  await g.run();
  assert.equal(g.calls.some((call) => call === "deleteAlias" || call.startsWith("delete:")), false);
  assert.equal(g.aliases.has("qa1"), true);
});

test("alias削除成功後のDELETE失敗も同じ全ID manifestで再開できる", async () => {
  const g = new MemoryGateway();
  g.seed(application()); g.native = database;
  g.prs.get(42)!.state = "closed";
  g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId: "dpl_application" });
  const approved = structuredClone(g.deleteApprovals[0]);
  g.deleteError = true;
  await g.run();
  assert.equal(g.latest().payload.state, "deleting");
  assert.equal(g.aliases.has("qa1"), false);
  g.deleteError = false; g.gone = true;
  await g.run();
  assert.equal(g.latest().payload.state, "free");
  assert.deepEqual(g.deleteApprovals[0], approved);
});

test("alias削除後に承認が期限切れになれば残りDeploymentとfree更新を止める", async () => {
  const g = new MemoryGateway();
  g.seed(application()); g.native = database;
  g.prs.get(42)!.state = "closed";
  g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId: "dpl_application" });
  const remove = g.deleteAlias.bind(g);
  g.deleteAlias = async (record, plan) => {
    await remove(record, plan);
    g.deleteApprovals[0].expiresAt = "2026-10-12T00:00:00.000Z";
  };
  await g.run();
  assert.equal(g.aliases.has("qa1"), false);
  assert.equal(g.remotes.size, 1);
  assert.equal(g.latest().payload.state, "deleting");
  assert.equal(g.calls.some((call) => call.startsWith("delete:")), false);
  g.deleteApprovals[0].expiresAt = "2026-10-12T02:00:00.000Z";
  g.gone = true;
  await g.run();
  assert.equal(g.latest().payload.state, "free");
});

test("DeploymentがありNative DBが不明なら削除manifestを許可せずdeletingを保持する", async () => {
  const g = new MemoryGateway();
  const record = lease();
  record.deployments = [{ id: "dpl_provisioning", sha, phase: "provisioning" }];
  g.seed(record);
  g.prs.get(42)!.state = "closed";
  await g.run();
  assert.equal(g.latest().payload.state, "deleting");
  assert.equal(g.calls.some((call) => call === "deleteAlias" || call.startsWith("delete:")), false);
});

test("作成前に返却する空leaseもNative存在を確認し、記録外DBがあればfreeにしない", async () => {
  for (const unexpected of [false, true]) {
    const g = new MemoryGateway();
    g.seed(lease());
    g.generationAllowed = false;
    g.prs.get(42)!.state = "closed";
    g.native = unexpected ? database : null;
    await g.run();
    assert.equal(g.latest().payload.state, unexpected ? "deleting" : "free");
    assert.ok(g.calls.includes("database"));
    assert.equal(g.calls.some((call) => call === "deleteAlias" || call.startsWith("delete:")), false);
  }
});

test("disabled refreshはopen PRの新規claimを行わず既存cleanupだけを処理する", async () => {
  const g = new MemoryGateway();
  g.seed(application(lease(43, "qa2")));
  g.native = database; g.generationAllowed = false;
  g.prs.get(43)!.state = "closed";
  g.prs.set(42, pullRequest());
  g.openPullRequests = async () => { assert.fail("disabled must not enumerate creation candidates"); };
  await g.run();
  assert.equal(g.latest("qa2").payload.state, "deleting");
  assert.equal(g.latest("qa1"), null);
  assert.equal(g.calls.includes("create"), false);
});

test("probeは明示された単一PR/SHA/slotだけを使い他枠のcloseやaliasに触らない", async () => {
  const g = new MemoryGateway();
  const other = application(lease(43));
  g.seed(other);
  g.prs.get(43)!.state = "closed";
  g.aliases.set("qa1", { projectId: QA_PROJECT_ID, deploymentId: "dpl_application" });
  g.prs.set(42, { ...pullRequest(), approved: false });
  g.generationAllowed = false;
  g.probeApprovals = [{ projectId: QA_PROJECT_ID, pr: 42, sha, slot: "qa3", expiresAt: "2026-10-12T02:00:00.000Z" }];
  await g.run("probe", 42, undefined, sha);
  const probe = g.latest("qa3").payload;
  assert.equal(probe.purpose, "probe");
  assert.equal(probe.pr, 42);
  assert.equal(g.latest("qa1").payload.state, "held");
  assert.equal(g.prQueries.includes(43), false);
  assert.equal(g.calls.includes("gate:create"), false);
  assert.equal(g.calls.includes("gate:cleanup"), false);
  assert.equal(g.calls.includes("assignAlias"), false);
  assert.equal(g.aliases.get("qa1")!.deploymentId, "dpl_application");
});

test("probeは未承認/期限切れ/SHA不一致や承認枠使用中なら別枠へfallbackしない", async () => {
  for (const failure of ["missing", "expired", "sha", "occupied"] as const) {
    const g = new MemoryGateway();
    g.generationAllowed = false;
    g.prs.set(42, pullRequest());
    if (failure !== "missing") g.probeApprovals = [{ projectId: QA_PROJECT_ID, pr: 42, sha,
      slot: "qa2", expiresAt: failure === "expired" ? "2026-10-12T00:00:00.000Z" : "2026-10-12T02:00:00.000Z" }];
    if (failure === "sha") g.prs.get(42)!.sha = newSha;
    if (failure === "occupied") g.seed(lease(43, "qa2"));
    if (failure === "occupied") await g.run("probe", 42, undefined, sha);
    else await assert.rejects(() => g.run("probe", 42, undefined, sha));
    assert.equal(g.calls.includes("create"), false);
    assert.equal(g.latest("qa1"), null);
  }
});

test("probe READYはaliasを作らず、通常refreshで新HEADを進めず、次SHA限定承認でDBを保持する", async () => {
  const g = new MemoryGateway();
  g.generationAllowed = false;
  g.prs.set(42, { ...pullRequest(), approved: false });
  g.probeApprovals = [{ projectId: QA_PROJECT_ID, pr: 42, sha, slot: "qa2", expiresAt: "2026-10-12T02:00:00.000Z" }];
  await g.run("probe", 42, undefined, sha);
  const leased = g.latest("qa2").payload;
  g.native = database;
  g.remotes.get("dpl_created1")!.state = "ERROR";
  await g.run("probe", 42, leased.leaseId, sha);
  g.remotes.get("dpl_created2")!.state = "READY";
  await g.run("probe", 42, leased.leaseId, sha);
  assert.equal(g.latest("qa2").payload.readyDeploymentId, "dpl_created2");
  assert.equal(g.latest("qa2").payload.aliasSha, undefined);
  const count = g.records.length;
  g.prs.get(42)!.sha = newSha;
  g.generationAllowed = true;
  await g.run();
  assert.equal(g.records.length, count);
  await assert.rejects(() => g.run("probe", 42, leased.leaseId, newSha), /probe承認/);
  g.probeApprovals.push({ projectId: QA_PROJECT_ID, pr: 42, sha: newSha, slot: "qa2", expiresAt: "2026-10-12T02:00:00.000Z" });
  await g.run("probe", 42, leased.leaseId, newSha);
  assert.equal(g.latest("qa2").payload.headSha, newSha);
  assert.equal(g.latest("qa2").payload.leaseId, leased.leaseId);
  assert.deepEqual(g.latest("qa2").payload.database, database);
  assert.equal(g.calls.includes("assignAlias"), false);
  assert.equal(g.aliases.size, 0);
});

test("probe承認がintent保存直後に期限切れなら未送信intentを消し、再承認後に生成を再試行できる", async () => {
  const g = new MemoryGateway();
  g.generationAllowed = false;
  g.prs.set(42, pullRequest());
  g.probeApprovals = [{ projectId: QA_PROJECT_ID, pr: 42, sha, slot: "qa1", expiresAt: "2026-10-12T02:00:00.000Z" }];
  g.onSave = (saved) => { if (saved.payload.intent) g.probeApprovals[0].expiresAt = "2026-10-12T00:00:00.000Z"; };
  await assert.rejects(() => g.run("probe", 42, undefined, sha), /期限切れ/);
  assert.equal(g.calls.includes("create"), false);
  assert.equal(g.latest().payload.state, "held");
  assert.equal(g.latest().payload.intent, undefined);
  assert.deepEqual(g.latest().payload.deployments, []);
  g.onSave = undefined;
  g.probeApprovals[0].expiresAt = "2026-10-12T02:00:00.000Z";
  await g.run("probe", 42, g.latest().payload.leaseId, sha);
  assert.equal(g.calls.filter((call) => call === "create").length, 1);
  assert.equal(g.latest().payload.deployments[0].phase, "provisioning");
});

test("deletingへのprobeは有効な削除manifestがあってもcleanupを進めない", async () => {
  const g = new MemoryGateway();
  const record: QaLeaseRecord = { ...application(), purpose: "probe", aliasSha: undefined };
  g.seed(record); g.native = database; g.gone = true;
  const saved = g.latest();
  await g.save(nextRecord(saved, { state: "deleting", readyDeploymentId: undefined }, now));
  g.probeApprovals = [{ projectId: QA_PROJECT_ID, pr: 42, sha, slot: "qa1", expiresAt: "2026-10-12T02:00:00.000Z" }];
  const count = g.records.length;
  await assert.rejects(() => g.run("probe", 42, record.leaseId, sha), /probe/);
  assert.equal(g.records.length, count);
  assert.equal(g.latest().payload.state, "deleting");
  assert.equal(g.remotes.size, 1);
  assert.equal(g.calls.includes("gate:cleanup"), false);
  assert.equal(g.calls.some((call) => call === "create" || call === "deleteAlias" || call.startsWith("delete:")), false);
});

test("probe入口のOPEN確認後にPRがcloseされても同じprobe実行からcleanupへ進まない", async () => {
  const g = new MemoryGateway();
  const record: QaLeaseRecord = { ...application(), purpose: "probe", aliasSha: undefined };
  g.seed(record); g.native = database; g.gone = true;
  g.probeApprovals = [{ projectId: QA_PROJECT_ID, pr: 42, sha, slot: "qa1", expiresAt: "2026-10-12T02:00:00.000Z" }];
  g.onPr = () => { if (g.prReads === 2) g.prs.get(42)!.state = "closed"; };
  await assert.rejects(() => g.run("probe", 42, record.leaseId, sha), /返却は別/);
  assert.equal(g.latest().payload.state, "held");
  assert.equal(g.calls.includes("gate:cleanup"), false);
  assert.equal(g.calls.some((call) => call.startsWith("delete:")), false);
});

test("closed probeのcleanupはalias:null manifestを使い同名の外部aliasへ触らない", async () => {
  const g = new MemoryGateway();
  const record: QaLeaseRecord = { ...application(), purpose: "probe", aliasSha: undefined };
  g.seed(record); g.native = database; g.gone = true; g.generationAllowed = false;
  g.prs.get(42)!.state = "closed";
  const foreign = { projectId: "prj_foreign", deploymentId: "dpl_other" };
  g.aliases.set("qa1", foreign);
  g.alias = async () => { assert.fail("probe never owns a fixed alias"); };
  await g.run();
  assert.equal(g.deleteApprovals[0].alias, null);
  assert.equal(g.latest().payload.state, "free");
  assert.deepEqual(g.aliases.get("qa1"), foreign);
  assert.equal(g.calls.includes("deleteAlias"), false);
});

const environment = { GITHUB_TOKEN: "private-gh", VERCEL_TOKEN: "private-vercel", NEON_API_KEY: "private-neon",
  CAKE_QA_APPROVED_HEADS: JSON.stringify({ "42": sha }), CAKE_QA_POOL_ENABLED: "true", CAKE_QA_GIT_GATE_CONFIRMED: "true",
  CAKE_QA_NATIVE_CONFIRMED: "true", CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.ap-southeast-1.aws.neon.tech", CAKE_QA_PARENT_BRANCH_ID: "br-parent" };

function gitFile() {
  const source = Buffer.from(JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true } } }));
  return { type: "file", name: "vercel.json", path: "vercel.json", encoding: "base64", size: source.length,
    content: source.toString("base64"), sha: createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex") };
}

test("GitHub台帳は全pageを読み、Deployments statusに依存せず最新payloadを復元する", async () => {
  const first = lease(), saved = { id: 1, payload: first };
  const next = nextRecord(saved, { state: "deleting" }, now);
  const calls: string[] = [];
  const transport: QaTransport = async (_method, url) => {
    calls.push(url);
    const page = new URL(url).searchParams.get("page");
    if (page === "1") return { status: 200, data: [
      { id: 1, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: first },
      ...Array.from({ length: 99 }, (_, index) => ({ id: index + 500, task: "deploy", environment: "Preview" })),
    ] };
    return { status: 200, data: [{ id: 2, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: next }] };
  };
  const pool = await new HttpQaGateway(environment, transport).pool();
  assert.equal(pool.qa1!.id, 2);
  assert.equal(pool.qa1!.payload.state, "deleting");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => !url.includes("statuses")));
});

function vercelValue(deployment: RemoteDeployment) {
  return { id: deployment.id, projectId: deployment.projectId, target: deployment.target,
    readyState: deployment.state, url: deployment.url?.slice("https://".length),
    gitSource: { ref: deployment.branch, sha: deployment.sha },
    meta: { githubCommitRef: deployment.branch, githubCommitSha: deployment.sha, cakeQaLeaseId: deployment.leaseId,
      cakeQaPr: String(deployment.pr), cakeQaAttemptId: deployment.attemptId, cakeQaPhase: deployment.phase } };
}

test("Vercel一覧はpagination.nextを辿り、循環や矛盾metadataを拒否する", async () => {
  const record = lease();
  const calls: string[] = [];
  const transport: QaTransport = async (_method, url) => {
    calls.push(url);
    const after = new URL(url).searchParams.get("until");
    return { status: 200, data: { deployments: [vercelValue(remote(record, after ? "dpl_old" : "dpl_new"))], pagination: { next: after ? null : 1000 } } };
  };
  const rows = await new HttpQaGateway(environment, transport).deployments(record);
  assert.deepEqual(rows.map((d) => d.id), ["dpl_new", "dpl_old"]);
  assert.equal(calls.length, 2);
  const cycle: QaTransport = async () => ({ status: 200, data: { deployments: [], pagination: { next: 1000 } } });
  await assert.rejects(() => new HttpQaGateway(environment, cycle).deployments(record), /循環/);
  const contradictory: QaTransport = async () => ({ status: 200, data: { ...vercelValue(remote(record)), gitSource: { ref: record.branch, sha: newSha } } });
  await assert.rejects(() => new HttpQaGateway(environment, contradictory).deployment("dpl_application"), /矛盾/);
});

test("生成APIはoriginal feature枝/完全SHA/attemptを使い、build/runtimeのQA識別値へ認証情報を渡さない", async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const claim = lease();
  const record = { ...claim, sequence: 2, previousRecordId: 1,
    intent: { sha, phase: "provisioning" as const, attemptId: uuid(900), startedAt: now } };
  const transport: QaTransport = async (method, url, _token, body) => {
    calls.push({ method, url, body });
    if (method === "POST") return { status: 200, data: vercelValue(remote(record, "dpl_provisioning", "BUILDING", "provisioning")) };
    const path = new URL(url).pathname;
    if (path === `/v9/projects/${QA_PROJECT_ID}`) return { status: 200, data: { id: QA_PROJECT_ID, name: "cake",
      accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub", previewDeploymentsDisabled: false,
      deploymentPolicy: { deploymentSources: [{ enabled: true, environments: [{ type: "system", target: "preview" }], sources: ["rest-api"] }] },
      link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main", repoId: 1318171856 } } };
    if (path.endsWith("/pulls/42")) return { status: 200, data: { number: 42, state: "open", head: { ref: record.branch, sha, repo: { full_name: QA_REPOSITORY } }, base: { ref: "main" } } };
    if (path.endsWith("/branches/main")) return { status: 200, data: { name: "main", commit: { sha: newSha } } };
    if (path.endsWith("/contents/vercel.json")) return { status: 200, data: gitFile() };
    if (path === `/repos/${QA_REPOSITORY}/deployments`) return { status: 200, data: [
      { id: 1, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: claim },
      { id: 2, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: record },
    ] };
    return { status: 200, data: { project: { id: QA_NEON_PROJECT_ID } } };
  };
  const gateway = new HttpQaGateway(environment, transport, "write");
  await gateway.assertGate("create", { pr: record.pr, branch: record.branch, sha: record.headSha });
  await gateway.create(record);
  const post = calls.find((call) => call.method === "POST")!;
  const body = post.body as { project: string; gitSource: { ref: string; sha: string; repoId: number }; target?: string;
    env: Record<string, string>; build: { env: Record<string, string> }; meta: Record<string, string> };
  assert.equal(body.project, QA_PROJECT_ID);
  assert.equal(new URL(post.url).searchParams.get("forceNew"), "1");
  assert.equal(body.gitSource.ref, record.branch);
  assert.equal(body.gitSource.sha, sha);
  assert.equal(body.gitSource.repoId, 1318171856);
  assert.equal(body.target, undefined);
  assert.equal(body.meta.cakeQaAttemptId, record.intent.attemptId);
  assert.equal(body.meta.cakeQaPhase, "provisioning");
  assert.deepEqual(body.env, body.build.env);
  assert.equal(body.env.CAKE_QA_DATABASE_HOST, "");
  assert.equal(body.env.CAKE_QA_SLOT, "qa1");
  assert.equal(body.env.CAKE_QA_SOURCE_BRANCH, record.branch);
  for (const token of [environment.GITHUB_TOKEN, environment.VERCEL_TOKEN, environment.NEON_API_KEY]) assert.equal(JSON.stringify(post).includes(token), false);
});

test("Neon枝paginationとbranch/endpoint双方の404で消失を証明し、片側の残存をfreeにしない", async () => {
  const calls: string[] = [];
  const transport: QaTransport = async (_method, url) => {
    calls.push(url);
    const path = new URL(url).pathname, cursor = new URL(url).searchParams.get("cursor");
    if (path.endsWith("/branches")) return { status: 200, data: { branches: [], pagination: { next: cursor ? undefined : "second" } } };
    if (path.endsWith("/endpoints")) return { status: 200, data: { endpoints: [] } };
    return { status: 404, data: null };
  };
  assert.equal(await new HttpQaGateway(environment, transport).databaseGone(database), true);
  assert.equal(calls.filter((url) => new URL(url).pathname.endsWith("/branches")).length, 2);
  assert.ok(calls.some((url) => url.endsWith(`/branches/${database.branchId}`)));
  assert.ok(calls.some((url) => url.endsWith(`/endpoints/${database.endpointId}`)));
  const remaining: QaTransport = async (method, url, token, body) => url.endsWith(`/endpoints/${database.endpointId}`)
    ? { status: 200, data: { endpoint: { id: database.endpointId } } } : transport(method, url, token, body);
  assert.equal(await new HttpQaGateway(environment, remaining).databaseGone(database), false);
});

test("公式pagination.nextの2page目からNative DBを特定し、project/親/endpoint所属を照合する", async () => {
  const calls: string[] = [];
  const record = lease();
  const transport: QaTransport = async (_method, url) => {
    calls.push(url);
    const path = new URL(url).pathname, cursor = new URL(url).searchParams.get("cursor");
    if (path.endsWith("/branches")) return { status: 200, data: { branches: cursor ? [{
      id: database.branchId, project_id: QA_NEON_PROJECT_ID, name: `preview/${record.branch}`,
      parent_id: environment.CAKE_QA_PARENT_BRANCH_ID, default: false, protected: false, created_at: now,
    }] : [], pagination: { next: cursor ? undefined : "second" } } };
    return { status: 200, data: { endpoints: [{ id: database.endpointId, project_id: QA_NEON_PROJECT_ID,
      branch_id: database.branchId, host: database.host, type: "read_write" }] } };
  };
  const gateway = new HttpQaGateway(environment, transport);
  assert.deepEqual(await gateway.database(record), database);
  assert.equal(calls.filter((url) => new URL(url).pathname.endsWith("/branches")).length, 2);
  assert.ok(calls.some((url) => new URL(url).searchParams.get("cursor") === "second"));
});

test("PR workflowの空QA_ACTIONはclaimへ解決し、環境payloadをshell引数へ流さない", async () => {
  const gateway = new MemoryGateway();
  gateway.prs.set(42, pullRequest());
  gateway.prs.set(43, pullRequest(lease(43)));
  await runQaWriter({ CAKE_QA_POOL_ENABLED: "true", EVENT_NAME: "pull_request_target", QA_ACTION: "", QA_PR_NUMBER: "42",
    GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: QA_REPOSITORY, GITHUB_REF: "refs/heads/main" }, undefined, gateway);
  assert.equal(gateway.latest().payload.pr, 42);
  assert.equal(gateway.records.some((entry) => (entry.payload as QaLeaseRecord).pr === 43), false);
});

test("disabled writerの手動Actions refreshは新規生成せず、local変更入口は拒否する", async () => {
  let apiCalls = 0;
  const gateway = new MemoryGateway();
  gateway.generationAllowed = false;
  gateway.prs.set(42, pullRequest());
  const transport: QaTransport = async () => { apiCalls++; return { status: 200, data: {} }; };
  await runQaWriter({ CAKE_QA_POOL_ENABLED: "false", EVENT_NAME: "workflow_dispatch", GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: QA_REPOSITORY, GITHUB_REF: "refs/heads/main" }, { action: "refresh" }, gateway);
  assert.ok(gateway.poolReads > 0);
  assert.equal(gateway.calls.includes("create"), false);
  assert.equal(gateway.records.length, 0);
  await assert.rejects(() => runQaWriter({ CAKE_QA_POOL_ENABLED: "false" }, { action: "refresh" },
    new HttpQaGateway(environment, transport)), /信頼済みmain/);
  assert.equal(apiCalls, 0);
});

test("disabled writerでもclosed leaseのexactmanifest cleanupはActions入口から進められる", async () => {
  const gateway = new MemoryGateway();
  gateway.seed(application()); gateway.native = database; gateway.gone = true; gateway.generationAllowed = false;
  gateway.prs.get(42)!.state = "closed";
  await runQaWriter({ CAKE_QA_POOL_ENABLED: "false", GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: QA_REPOSITORY,
    GITHUB_REF: "refs/heads/main" }, { action: "refresh" }, gateway);
  assert.equal(gateway.latest().payload.state, "free");
  assert.equal(gateway.calls.includes("create"), false);
});

test("QA workflow has no scheduled trigger and a stale schedule event is rejected before any API call", async () => {
  const source = readFileSync(new URL("../.github/workflows/qa-pool.yml", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*schedule:|\bcron:|github\.event_name == 'schedule'/m);
  assert.match(source, /types: \[opened, synchronize, reopened, closed\]/);
  const gateway = new MemoryGateway();
  await assert.rejects(() => runQaWriter({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: QA_REPOSITORY,
    GITHUB_REF: "refs/heads/main", EVENT_NAME: "schedule" }, { action: "refresh" }, gateway), /定期監視は廃止/);
  assert.equal(gateway.poolReads, 0); assert.equal(gateway.calls.length, 0);
});

test("request-preview finishes provisioning and application in one dispatch without scheduled refresh", async () => {
  const gateway = new MemoryGateway(); gateway.seed(lease());
  const adapter: QaGateway = gateway;
  adapter.requestOwnerPlan = async () => {};
  let clock = 0, sleeps = 0;
  await runQaRequestWithWaiting(adapter, { action: "request-preview", pr: 42, sha }, {
    now: () => clock, timeoutMs: 100, pollIntervalMs: 10, log: () => {},
    sleep: async (delay) => {
      clock += delay; sleeps++; gateway.native = database;
      for (const deployment of gateway.remotes.values()) deployment.state = deployment.phase === "application" ? "READY" : "ERROR";
    },
  });
  assert.equal(sleeps, 2); assert.equal(gateway.calls.filter(call => call === "create").length, 2);
  assert.equal(gateway.latest().payload.readyDeploymentId, "dpl_created2");
  assert.equal(gateway.latest().payload.aliasSha, sha);
  assert.ok(gateway.prQueries.every(pr => pr === 42));
});

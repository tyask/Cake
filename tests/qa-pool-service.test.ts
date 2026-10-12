import test from "node:test";
import assert from "node:assert/strict";
import { runQaRequest, type AliasTarget, type QaGateway, type QaPullRequest, type RemoteDeployment } from "../lib/qa-pool-service";
import { HttpQaGateway, runQaWriter, type QaTransport } from "../scripts/qa-pool-writer";
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
  createBehavior: "ok" | "lost" | "failed" = "ok";
  createState = "BUILDING";
  databaseError = false;
  deleteError = false;
  gateError = false;
  calls: string[] = [];
  logs: string[] = [];
  poolReads = 0;
  prReads = 0;
  onPool?: () => void;
  onPr?: () => void;
  onSave?: (saved: SavedLease) => void;
  seed(record: QaLeaseRecord) {
    const id = (this.records.at(-1)?.id ?? 0) + 1;
    const initial = { ...record, deployments: [], database: undefined, intent: undefined, readyDeploymentId: undefined, aliasSha: undefined };
    this.records.push({ id, task: QA_TASK, environment: QA_ENVIRONMENT, sha: record.headSha, payload: structuredClone(initial) });
    if (record.deployments.length || record.database || record.intent || record.readyDeploymentId || record.aliasSha) {
      this.records.push({ id: id + 1, task: QA_TASK, environment: QA_ENVIRONMENT, sha: record.headSha,
        payload: { ...structuredClone(record), sequence: 2, previousRecordId: id } });
    }
    this.prs.set(record.pr, pullRequest(record));
    for (const d of record.deployments) this.remotes.set(d.id, remote(record, d.id, "READY", d.phase, d.sha));
  }
  async assertGate() { this.calls.push("gate"); if (this.gateError) throw new Error("gate failed"); }
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
  async pullRequest(pr: number) { this.prReads += 1; this.onPr?.(); return structuredClone(this.prs.get(pr)!); }
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
  deletionApproved() { return this.deletionAllowed; }
  async deleteAlias(record: QaLeaseRecord) { this.calls.push("deleteAlias"); this.aliases.delete(record.slot); }
  async deleteDeployment(deployment: RemoteDeployment) { this.calls.push(`delete:${deployment.id}`); if (this.deleteError) throw new Error("delete failed"); this.remotes.delete(deployment.id); }
  async run(action: "claim" | "refresh" | "release" = "refresh", pr?: number, leaseId?: string) {
    let tokens = 1000;
    await runQaRequest(this, { action, pr, leaseId }, { now: () => now, token: () => uuid(++tokens), log: (message) => { this.logs.push(message); } });
  }
  latest(slot: Slot = "qa1") { return replayDeployments(this.records)[slot]!; }
}

test("入口gate失敗と未承認PRは枠取得や生成APIに到達しない", async () => {
  const g = new MemoryGateway();
  g.prs.set(42, { ...pullRequest(), approved: false });
  g.gateError = true;
  await assert.rejects(() => g.run("claim", 42));
  assert.deepEqual(g.calls, ["gate"]);
  g.gateError = false;
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

const environment = { GITHUB_TOKEN: "private-gh", VERCEL_TOKEN: "private-vercel", NEON_API_KEY: "private-neon",
  CAKE_QA_APPROVED_HEADS: JSON.stringify({ "42": sha }), CAKE_QA_POOL_ENABLED: "true", CAKE_QA_GIT_GATE_CONFIRMED: "true",
  CAKE_QA_NATIVE_CONFIRMED: "true", CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.ap-southeast-1.aws.neon.tech", CAKE_QA_PARENT_BRANCH_ID: "br-parent" };

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
  const record = { ...lease(), intent: { sha, phase: "provisioning" as const, attemptId: uuid(900), startedAt: now } };
  const transport: QaTransport = async (method, url, _token, body) => {
    calls.push({ method, url, body });
    if (method === "POST") return { status: 200, data: vercelValue(remote(record, "dpl_provisioning", "BUILDING", "provisioning")) };
    const path = new URL(url).pathname;
    if (path === `/v9/projects/${QA_PROJECT_ID}`) return { status: 200, data: { id: QA_PROJECT_ID, name: "cake",
      accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub", link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main", repoId: 1318171856 } } };
    if (path.endsWith("/pulls")) return { status: 200, data: [] };
    return { status: 200, data: { project: { id: QA_NEON_PROJECT_ID } } };
  };
  const gateway = new HttpQaGateway(environment, transport);
  await gateway.assertGate();
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

test("disabled writerはevent読込/認証/API/台帳変更前に停止する", async () => {
  let apiCalls = 0;
  const gateway = new MemoryGateway();
  const transport: QaTransport = async () => { apiCalls++; return { status: 200, data: {} }; };
  await runQaWriter({ CAKE_QA_POOL_ENABLED: "false", EVENT_PATH: "/missing/private-event" }, undefined, gateway);
  assert.equal(gateway.calls.length, 0);
  await runQaWriter({ CAKE_QA_POOL_ENABLED: "false" }, { action: "refresh" }, new HttpQaGateway(environment, transport));
  assert.equal(apiCalls, 0);
});

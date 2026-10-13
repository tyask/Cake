import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HttpQaGateway, runQaWriter, type QaTransport } from "../scripts/qa-pool-writer";
import { runQaInspection } from "../scripts/qa-pool-inspect";
import { deletePlan } from "../lib/qa-pool-authorization";
import {
  qaAlias, QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK,
  type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord,
} from "../lib/qa-pool";

const sha = "a".repeat(40), otherSha = "b".repeat(40);
function gitFile(config: unknown = { git: { deploymentEnabled: { "**": false, main: true } } }) {
  const source = Buffer.from(JSON.stringify(config));
  return { type: "file", name: "vercel.json", path: "vercel.json", encoding: "base64", size: source.length,
    content: source.toString("base64"), sha: createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex") };
}
const leaseId = "00000000-0000-4000-8000-000000000042";
const attemptId = "00000000-0000-4000-8000-000000000900";
const secrets = ["inspect-secret-github", "inspect-secret-vercel", "inspect-secret-neon", "inspect-secret-response", "postgresql://inspect-secret-db"];
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-native", endpointId: "ep-native", host: "ep-native.ap-southeast-1.aws.neon.tech" };
type Response = { status: number; data: unknown };
type Report = Awaited<ReturnType<HttpQaGateway["inspect"]>>;
const environment = () => ({
  GITHUB_TOKEN: secrets[0], VERCEL_TOKEN: secrets[1], NEON_API_KEY: secrets[2],
  CAKE_QA_POOL_ENABLED: "false", CAKE_QA_GIT_GATE_CONFIRMED: "false", CAKE_QA_NATIVE_CONFIRMED: "false",
  CAKE_QA_APPROVED_HEADS: "{}", CAKE_QA_PARENT_BRANCH_ID: "br-parent",
  CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.ap-southeast-1.aws.neon.tech",
  DATABASE_URL: secrets[4],
});
function lease(): QaLeaseRecord {
  return { protocol: "cake-qa/v1", slot: "qa2", leaseId, pr: 42, branch: "codex/task-42", headSha: sha,
    state: "held", createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z",
    sequence: 1, previousRecordId: null, deployments: [], retiredDatabases: [] };
}
function application(): QaLeaseRecord {
  return { ...lease(), database, deployments: [
    { id: "dpl_provisioning", sha, phase: "provisioning" },
    { id: "dpl_application", sha, phase: "application" },
  ] };
}
function history(record: QaLeaseRecord): GithubDeployment[] {
  const first = { ...lease(), purpose: record.purpose };
  return [
    { id: 1, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: first },
    { id: 2, task: QA_TASK, environment: QA_ENVIRONMENT, sha: record.headSha,
      payload: { ...record, sequence: 2, previousRecordId: 1 } },
  ];
}
function remote(record: QaLeaseRecord, id: string) {
  const known = record.deployments.find((d) => d.id === id);
  return { id, projectId: QA_PROJECT_ID, target: null as string | null, readyState: "READY", url: "inspect-preview.vercel.app",
    gitSource: { ref: record.branch, sha: known?.sha ?? record.headSha },
    meta: { githubCommitRef: record.branch, githubCommitSha: known?.sha ?? record.headSha,
      cakeQaLeaseId: record.leaseId, cakeQaPr: String(record.pr), cakeQaAttemptId: attemptId,
      cakeQaPhase: known?.phase ?? "application" }, privateValue: secrets[3] };
}
class ReadFixture {
  env: Record<string, string | undefined> = environment();
  calls: { method: string; path: string; search: string; body?: unknown }[] = [];
  responses = new Map<string, Response>();
  records: GithubDeployment[] = [];
  record?: QaLeaseRecord;
  project = { id: QA_PROJECT_ID, name: "cake", accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub",
    previewDeploymentsDisabled: false,
    link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main", repoId: 1318171856 },
    env: [{ key: "DATABASE_URL", value: secrets[4] }], privateValue: secrets[3] };
  pr = { number: 42, state: "open", head: { sha, ref: "codex/task-42", repo: { full_name: QA_REPOSITORY } }, base: { ref: "main" }, privateValue: secrets[3] };
  variableNames = ["CAKE_QA_POOL_ENABLED", "CAKE_QA_GIT_GATE_CONFIRMED", "CAKE_QA_NATIVE_CONFIRMED",
    "CAKE_QA_PRODUCTION_DATABASE_HOST", "CAKE_QA_PARENT_BRANCH_ID", "CAKE_QA_APPROVED_HEADS", "CAKE_QA_PROBE_APPROVALS", "CAKE_QA_DELETE_APPROVALS"];
  setRecord(record: QaLeaseRecord) { this.record = structuredClone(record); this.records = history(record); }
  request: QaTransport = async (method, address, _token, body) => {
    const url = new URL(address), path = url.pathname.replace(/^\/api\/v2(?=\/)/, "");
    this.calls.push({ method, path, search: url.search, body });
    assert.equal(method, "GET", "the fixture must never receive a mutation");
    assert.equal(body, undefined);
    const override = this.responses.get(path + url.search) ?? this.responses.get(path);
    if (override) return structuredClone(override);
    if (path === `/v9/projects/${QA_PROJECT_ID}`) return { status: 200, data: structuredClone(this.project) };
    if (path === `/repos/${QA_REPOSITORY}/branches/main`) return { status: 200, data: { name: "main", commit: { sha: otherSha } } };
    if (path === `/repos/${QA_REPOSITORY}/contents/vercel.json`) {
      assert.ok([sha, otherSha].includes(url.searchParams.get("ref") ?? ""), "configuration reads must be pinned to a complete commit");
      return { status: 200, data: gitFile() };
    }
    if (path === `/repos/${QA_REPOSITORY}/deployments`) return { status: 200, data: structuredClone(this.records) };
    if (path === `/repos/${QA_REPOSITORY}/actions/variables`) {
      const page = Number(url.searchParams.get("page")), names = this.variableNames.slice((page - 1) * 30, page * 30);
      return { status: 200, data: { variables: names.map((name) => ({ name, value: secrets[3] })) } };
    }
    if (path === `/repos/${QA_REPOSITORY}/pulls/${this.pr.number}` || path === `/repos/${QA_REPOSITORY}/pulls/42`) return { status: 200, data: structuredClone(this.pr) };
    if (path === `/projects/${QA_NEON_PROJECT_ID}`) return { status: 200, data: { project: { id: QA_NEON_PROJECT_ID, connection_uri: secrets[4] } } };
    const parent = { id: "br-parent", project_id: QA_NEON_PROJECT_ID, name: "qa-native-empty-parent", default: false, protected: true, created_at: "2026-10-11T00:00:00.000Z" };
    if (path === `/projects/${QA_NEON_PROJECT_ID}/branches/br-parent`) return { status: 200, data: { branch: parent } };
    if (path === `/projects/${QA_NEON_PROJECT_ID}/branches`) return { status: 200, data: { branches: [parent, ...(this.record?.database ? [{
      id: database.branchId, project_id: QA_NEON_PROJECT_ID, name: `preview/${this.record.branch}`, parent_id: "br-parent",
      default: false, protected: false, created_at: "2026-10-12T00:01:00.000Z",
    }] : [])], pagination: { next: null } } };
    if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`) return { status: 200, data: { endpoints: this.record?.database ? [{
      id: database.endpointId, project_id: QA_NEON_PROJECT_ID, branch_id: database.branchId, host: database.host, type: "read_write",
    }] : [] } };
    if (path === "/v7/deployments") return { status: 200, data: {
      deployments: this.record?.deployments.map((d) => remote(this.record!, d.id)) ?? [], pagination: { next: null },
    } };
    if (path.startsWith("/v13/deployments/") && this.record) {
      const id = path.slice("/v13/deployments/".length);
      return this.record.deployments.some((d) => d.id === id) ? { status: 200, data: remote(this.record, id) } : { status: 404, data: { message: secrets[3] } };
    }
    if (path.startsWith("/v4/aliases/")) return this.record && path.endsWith(qaAlias(this.record.slot)) && this.record.purpose !== "probe"
      ? { status: 200, data: { projectId: QA_PROJECT_ID, deploymentId: "dpl_application", privateValue: secrets[3] } }
      : { status: 404, data: { message: secrets[3] } };
    assert.fail(`unexpected read path: ${path}`);
  };
  reader() { return new HttpQaGateway(this.env, this.request); }
  assertReadOnly() { assert.ok(this.calls.every((call) => call.method === "GET" && call.body === undefined)); }
}
function checked(report: Report, name: string) {
  const result = report.checks.find((c) => c.name === name);
  assert.ok(result, `missing check ${name}`);
  return result;
}
function assertPrivate(report: unknown) {
  const output = JSON.stringify(report);
  for (const value of [...secrets, database.host, environment().CAKE_QA_PRODUCTION_DATABASE_HOST]) {
    assert.equal(output.includes(value), false, "inspection must curate hosts and secrets from output");
  }
}
function assertPublicPlan(plan: unknown, record: QaLeaseRecord) {
  const exact = deletePlan(record);
  assert.deepEqual(plan, { ...exact, database: exact.database ? {
    projectId: exact.database.projectId, branchId: exact.database.branchId, endpointId: exact.database.endpointId,
  } : null, approvalManifestRequiresPrivateHost: Boolean(exact.database),
  databaseDataLossRequiresApproval: Boolean(exact.database),
  dataLossNotice: exact.database ? "削除するとQA DBと入力データを失います。deploymentの復元はDBの復旧を保証しません。" : null });
  assertPrivate(plan);
}

test("disabled・未承認でもpreflightは読取を実施し、環境flag・資源を変更しない", async () => {
  const f = new ReadFixture(), before = structuredClone(f.env);
  const report = await f.reader().inspect({ action: "preflight" });
  assert.equal(report.readOnly, true);
  for (const name of ["Vercel project", "Preview enabled", "Main Git configuration", "GitHub lease ledger", "GitHub repository Variables read", "Neon metadata read"]) assert.equal(checked(report, name).ok, true);
  assert.deepEqual(report.gitConfiguration.main, { branch: "main", commitSha: otherSha, blobSha: gitFile().sha });
  assert.equal(report.gitConfiguration.target, null);
  assert.equal(report.gitConfiguration.scope, "repository-git-trigger-configuration");
  assert.equal(report.gitConfiguration.backendForcedDeploymentPreventionProven, false);
  assert.equal(report.plan, null);
  assert.deepEqual(report.missingRepositoryVariables, []);
  assert.deepEqual(f.env, before);
  f.assertReadOnly(); assertPrivate(report);
});

test("Variablesを全page読むが値は返さず、必要な変数名の不足だけ報告する", async () => {
  const f = new ReadFixture();
  f.variableNames = [...f.variableNames.filter((name) => name !== "CAKE_QA_DELETE_APPROVALS"), ...Array.from({ length: 25 }, (_, n) => `OTHER_${n}`)];
  const report = await f.reader().inspect({ action: "preflight" });
  assert.deepEqual(report.missingRepositoryVariables, ["CAKE_QA_DELETE_APPROVALS"]);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/actions/variables")).length, 2);
  assertPrivate(report); f.assertReadOnly();
});

test("preflightの対象PR指定はcurrent headへ固定し、mainとtargetのcommit/blob証跡を返す", async () => {
  const f = new ReadFixture();
  const report = await f.reader().inspect({ action: "preflight", pr: 42 });
  assert.equal(report.generationBlocked, false);
  assert.deepEqual(report.gitConfiguration.target, { pr: 42, branch: "codex/task-42", commitSha: sha, blobSha: gitFile().sha });
  assert.equal(checked(report, "Target Git configuration").ok, true);
  const refs = f.calls.filter((call) => call.path.endsWith("/contents/vercel.json")).map((call) => new URLSearchParams(call.search).get("ref"));
  assert.deepEqual(refs, [otherSha, sha]);
  f.assertReadOnly(); assertPrivate(report);
});

test("main-only設定の未mergeはpreflightでblockedと報告し、対象の証明と他のGET結果を保持する", async () => {
  const f = new ReadFixture();
  f.responses.set(`/repos/${QA_REPOSITORY}/contents/vercel.json?ref=${otherSha}`, { status: 200, data: gitFile({ buildCommand: secrets[3] }) });
  const report = await f.reader().inspect({ action: "preflight", pr: 42 });
  assert.equal(report.generationBlocked, true);
  assert.equal(checked(report, "Main Git configuration").ok, false);
  assert.equal(checked(report, "Target Git configuration").ok, true);
  assert.equal(report.gitConfiguration.main, null);
  assert.equal(report.gitConfiguration.target?.commitSha, sha);
  assert.equal(checked(report, "GitHub lease ledger").ok, true);
  f.assertReadOnly(); assertPrivate(report);
});

test("Git設定の401/403/404・無効JSON・非boolean・target有効化はprobe計画をblockedにする", async () => {
  for (const ref of [otherSha, sha]) for (const response of [
    { status: 401, data: { message: secrets[3] } }, { status: 403, data: { message: secrets[3] } }, { status: 404, data: null },
    { status: 200, data: { ...gitFile(), content: Buffer.from(secrets[3]).toString("base64") } },
    { status: 200, data: gitFile({ git: { deploymentEnabled: { "**": false, main: "true" } } }) },
    { status: 200, data: gitFile({ git: { deploymentEnabled: { "**": false, main: true, "codex/*": true } } }) },
  ]) {
    const f = new ReadFixture(); f.responses.set(`/repos/${QA_REPOSITORY}/contents/vercel.json?ref=${ref}`, response);
    const report = await f.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
    assert.equal(report.generationBlocked, true);
    assert.equal((report.plan as { executionBlocked: boolean }).executionBlocked, true);
    assert.equal(checked(report, ref === sha ? "Target Git configuration" : "Main Git configuration").ok, false);
    f.assertReadOnly(); assertPrivate(report);
  }
});

test("生成設定が欠落していてもplan-releaseはGitの読取なしで正確なmanifestを返す", async () => {
  const f = new ReadFixture(), record = application(); f.setRecord(record);
  f.responses.set(`/repos/${QA_REPOSITORY}/branches/main`, { status: 403, data: { message: secrets[3] } });
  f.responses.set(`/repos/${QA_REPOSITORY}/contents/vercel.json`, { status: 404, data: null });
  const report = await f.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assertPublicPlan(report.plan, record);
  assert.equal(f.calls.some((call) => call.path.endsWith("/branches/main") || call.path.endsWith("/contents/vercel.json")), false);
  f.assertReadOnly(); assertPrivate(report);
});

test("NEON_API_KEYなしはNative確認をblockedにして他の読取結果を保持する", async () => {
  const f = new ReadFixture(); delete f.env.NEON_API_KEY;
  const report = await f.reader().inspect({ action: "preflight" });
  assert.equal(checked(report, "Neon metadata read").ok, false);
  assert.equal(checked(report, "Vercel project").ok, true);
  assert.equal(report.native, null);
  assert.equal(f.calls.some((call) => call.path.startsWith("/projects/")), false);
  assertPrivate(report); f.assertReadOnly();
});

test("403・project 404は資源なしにせず、remote error bodyを伏せて未確認を返す", async () => {
  for (const status of [403, 404]) {
    const f = new ReadFixture();
    f.responses.set(`/v9/projects/${QA_PROJECT_ID}`, { status, data: { error: { message: secrets[3], url: secrets[4] } } });
    const report = await f.reader().inspect({ action: "preflight" });
    assert.equal(checked(report, "Vercel project").ok, false);
    assert.match(checked(report, "Vercel project").detail, new RegExp(String(status)));
    assert.equal(checked(report, "Preview enabled").ok, false);
    assertPrivate(report); f.assertReadOnly();
  }
});

test("台帳またはVariablesの権限不足では空台帳・変数不足と推定しない", async () => {
  const f = new ReadFixture();
  f.responses.set(`/repos/${QA_REPOSITORY}/deployments`, { status: 403, data: { message: secrets[3] } });
  f.responses.set(`/repos/${QA_REPOSITORY}/actions/variables`, { status: 403, data: { message: secrets[3] } });
  const report = await f.reader().inspect({ action: "preflight" });
  assert.equal(report.slots, null);
  assert.equal(report.missingRepositoryVariables, null);
  assert.equal(checked(report, "GitHub lease ledger").ok, false);
  assert.equal(checked(report, "GitHub repository Variables read").ok, false);
  assertPrivate(report);
});

test("projectのGit連携種別・repo ID不一致を読取成功と扱わない", async () => {
  for (const link of [{ ...new ReadFixture().project.link, type: "gitlab" }, { ...new ReadFixture().project.link, repoId: "1318171856" }]) {
    const f = new ReadFixture();
    f.responses.set(`/v9/projects/${QA_PROJECT_ID}`, { status: 200, data: { ...f.project, link } });
    const report = await f.reader().inspect({ action: "preflight" });
    assert.equal(checked(report, "Vercel project").ok, false);
    assert.equal(checked(report, "Preview enabled").ok, false);
    f.assertReadOnly();
  }
});

test("Native親の所属確認は空DB証明ではなく、aliasの403は404と区別する", async () => {
  const f = new ReadFixture();
  f.responses.set(`/v4/aliases/${qaAlias("qa2")}`, { status: 403, data: { message: secrets[3] } });
  const report = await f.reader().inspect({ action: "preflight" });
  assert.deepEqual(report.parent, { projectId: QA_NEON_PROJECT_ID, branchId: "br-parent", emptyStateProven: false });
  assert.equal(report.aliases.qa1, null);
  assert.equal(report.aliases.qa2, "unconfirmed");
  assert.equal(checked(report, "Alias qa1").ok, true);
  assert.equal(checked(report, "Alias qa2").ok, false);
  assert.equal(f.calls.some((call) => call.path.endsWith("/pulls/42")), false);
  assertPrivate(report);
});

test("plan-probeは現在OPEN headと指定slotだけを計画し、承認やalias変更を行わない", async () => {
  const f = new ReadFixture();
  const report = await f.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
  const result = report.plan as { pr: number; sha: string; slot: string; maximumNewDeployments: number; fixedAliasChanges: boolean; deletionRequiresSeparateExactResourceApproval: boolean };
  assert.equal(result.pr, 42); assert.equal(result.sha, sha); assert.equal(result.slot, "qa2");
  assert.equal(result.maximumNewDeployments, 2);
  assert.equal(result.fixedAliasChanges, false);
  assert.deepEqual(report.gitConfiguration.target, { pr: 42, branch: "codex/task-42", commitSha: sha, blobSha: gitFile().sha });
  assert.equal(result.deletionRequiresSeparateExactResourceApproval, true);
  assert.equal(f.env.CAKE_QA_PROBE_APPROVALS, undefined);
  assert.equal(f.calls.some((call) => call.path === "/v7/deployments"), false);
  f.assertReadOnly(); assertPrivate(report);
});

test("plan-probeは短いSHA・古いSHA・closed PR・slot未指定を拒否する", async () => {
  for (const changes of [{ sha: sha.slice(0, 7) }, { sha: otherSha }, { slot: undefined }]) {
    const f = new ReadFixture();
    await assert.rejects(() => f.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2", ...changes }), /完全SHA/);
    f.assertReadOnly();
  }
  const f = new ReadFixture(); f.pr.state = "closed";
  await assert.rejects(() => f.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" }), /OPEN PR/);
});

test("plan-probeはfork・別base・別PR番号の応答で計画を作らない", async () => {
  for (const change of ["fork", "base", "number"] as const) {
    const f = new ReadFixture();
    if (change === "fork") f.pr.head.repo.full_name = "other/Cake";
    if (change === "base") f.pr.base.ref = "develop";
    if (change === "number") f.pr.number = 43;
    const report = await f.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
    assert.equal(report.plan, null, change); f.assertReadOnly();
  }
});

test("別の通常leaseのslotはprobeへ貸せず、同PR probeはDBを保持した更新計画になる", async () => {
  const normal = new ReadFixture(); normal.setRecord(lease());
  await assert.rejects(() => normal.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" }), /使用中/);
  const f = new ReadFixture(); f.setRecord({ ...application(), purpose: "probe" });
  const report = await f.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
  assert.equal((report.plan as { maximumNewDeployments: number }).maximumNewDeployments, 1);
  assert.equal(f.calls.some((call) => call.path === "/v7/deployments"), false);
  f.assertReadOnly();
});

test("返却済みslotに旧DB情報があっても次PRの初回probeは最大2deploymentと計画する", async () => {
  const f = new ReadFixture(), old = application();
  f.records = [
    { id: 1, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: lease() },
    { id: 2, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: { ...old, state: "deleting", sequence: 2, previousRecordId: 1 } },
    { id: 3, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: { ...old, state: "free", retiredDatabases: [database], sequence: 3, previousRecordId: 2 } },
  ];
  f.pr.number = 43; f.pr.head.ref = "codex/task-43";
  const report = await f.reader().inspect({ action: "plan-probe", pr: 43, sha, slot: "qa2" });
  assert.equal((report.plan as { maximumNewDeployments: number }).maximumNewDeployments, 2);
  f.assertReadOnly();
});

test("Variables API403は診断情報を保持し、Native認証不足はprobe実行blockedにする", async () => {
  const f = new ReadFixture();
  f.responses.set(`/repos/${QA_REPOSITORY}/actions/variables`, { status: 403, data: { message: secrets[3] } });
  const read = await f.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
  assert.equal(checked(read, "GitHub repository Variables read").ok, false);
  assert.equal((read.plan as { executionBlocked: boolean }).executionBlocked, false);
  delete f.env.NEON_API_KEY;
  const blocked = await f.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
  assert.equal((blocked.plan as { executionBlocked: boolean }).executionBlocked, true);
  f.assertReadOnly(); assertPrivate(blocked);
});

test("plan-releaseは全記録IDとDB・aliasを照合し、削除承認なしでもmanifestだけ返す", async () => {
  const f = new ReadFixture(), record = application(); f.setRecord(record);
  const before = structuredClone(f.records);
  const report = await f.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assertPublicPlan(report.plan, record);
  assert.equal(checked(report, "Exact deletion resources").ok, true);
  for (const d of record.deployments) assert.ok(f.calls.some((call) => call.path === `/v13/deployments/${d.id}`));
  assert.deepEqual(f.records, before);
  assert.equal(f.env.CAKE_QA_DELETE_APPROVALS, undefined);
  f.assertReadOnly(); assertPrivate(report);
});

test("plan-releaseはlease不一致を拒否し、intentまたはDB未確認ではmanifestを作らない", async () => {
  const wrong = new ReadFixture(); wrong.setRecord(application());
  await assert.rejects(() => wrong.reader().inspect({ action: "plan-release", pr: 42, leaseId: attemptId }), /現在のPRとlease/);
  for (const record of [
    { ...lease(), intent: { sha, phase: "provisioning" as const, attemptId, startedAt: "2026-10-12T00:01:00.000Z" } },
    { ...application(), database: undefined },
  ]) {
    const f = new ReadFixture(); f.setRecord(record);
    const report = await f.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    assert.equal(report.plan, null);
    assert.equal(checked(report, "Exact deletion resources").ok, false);
    assert.equal(f.calls.some((call) => call.path === "/v7/deployments"), false);
    f.assertReadOnly();
  }
});

test("既に404の記録IDもmanifestに保持し、ID GET403は消失扱いしない", async () => {
  for (const status of [404, 403]) {
    const f = new ReadFixture(), record = application(); f.setRecord(record);
    f.responses.set("/v13/deployments/dpl_provisioning", { status, data: { message: secrets[3] } });
    const report = await f.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    if (status === 404) assertPublicPlan(report.plan, record);
    else { assert.equal(report.plan, null); assert.match(checked(report, "Exact deletion resources").detail, /403/); }
    f.assertReadOnly(); assertPrivate(report);
  }
});

test("一覧に未記録deploymentがある、または記録ID所属が違う場合は削除計画を停止する", async () => {
  for (const change of ["orphan", "project", "lease", "sha", "phase", "production"] as const) {
    const f = new ReadFixture(), record = application(); f.setRecord(record);
    if (change === "orphan") f.responses.set("/v7/deployments", { status: 200, data: { deployments: [remote(record, "dpl_unknown")], pagination: { next: null } } });
    else {
      const value = remote(record, "dpl_application");
      if (change === "project") value.projectId = "prj_other";
      if (change === "lease") value.meta.cakeQaLeaseId = attemptId;
      if (change === "sha") { value.gitSource.sha = otherSha; value.meta.githubCommitSha = otherSha; }
      if (change === "phase") value.meta.cakeQaPhase = "provisioning";
      if (change === "production") value.target = "production";
      f.responses.set("/v13/deployments/dpl_application", { status: 200, data: value });
    }
    const report = await f.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    assert.equal(report.plan, null, change);
    assert.equal(checked(report, "Exact deletion resources").ok, false, change);
    f.assertReadOnly();
  }
});

test("alias403・外部alias・DB host不一致は削除manifestを承認可能にしない", async () => {
  for (const change of ["alias403", "foreignAlias", "database"] as const) {
    const f = new ReadFixture(); f.setRecord(application());
    if (change === "alias403") f.responses.set(`/v4/aliases/${qaAlias("qa2")}`, { status: 403, data: { message: secrets[3] } });
    if (change === "foreignAlias") f.responses.set(`/v4/aliases/${qaAlias("qa2")}`, { status: 200, data: { projectId: "prj_other", deploymentId: "dpl_other" } });
    if (change === "database") f.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: { endpoints: [{
      id: "ep-other", project_id: QA_NEON_PROJECT_ID, branch_id: database.branchId,
      host: "ep-other.ap-southeast-1.aws.neon.tech", type: "read_write",
    }] } });
    const report = await f.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    assert.equal(report.plan, null, change); f.assertReadOnly(); assertPrivate(report);
  }
});

test("消失済みDBはbranch・endpoint両IDの404で確認し、403ではmanifestを返さない", async () => {
  for (const status of [404, 403]) {
    const f = new ReadFixture(), record = application(); f.setRecord(record);
    f.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: { branches: [], pagination: { next: null } } });
    f.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: { endpoints: [] } });
    f.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches/${database.branchId}`, { status: 404, data: { message: secrets[3] } });
    f.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints/${database.endpointId}`, { status, data: { message: secrets[3] } });
    const report = await f.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    if (status === 404) assertPublicPlan(report.plan, record);
    else { assert.equal(report.plan, null); assert.match(checked(report, "Exact deletion resources").detail, /403/); }
    for (const id of [database.branchId, database.endpointId]) assert.ok(f.calls.some((call) => call.path.endsWith(`/${id}`)));
    f.assertReadOnly(); assertPrivate(report);
  }
});

test("probe返却manifestはalias nullで、aliasの追加照合・変更をしない", async () => {
  const f = new ReadFixture(), record = { ...application(), purpose: "probe" as const }; f.setRecord(record);
  const report = await f.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assertPublicPlan(report.plan, record);
  assert.equal((report.plan as { alias: unknown }).alias, null);
  assert.equal(f.calls.filter((call) => call.path === `/v4/aliases/${qaAlias("qa2")}`).length, 1);
  f.assertReadOnly();
});

test("default readerは正確な承認があってもPOST・DELETEをtransport前に拒否する", async () => {
  const f = new ReadFixture();
  f.env.CAKE_QA_APPROVED_HEADS = JSON.stringify({ "42": sha });
  Object.assign(f.env, { CAKE_QA_POOL_ENABLED: "true", CAKE_QA_GIT_GATE_CONFIRMED: "true", CAKE_QA_NATIVE_CONFIRMED: "true" });
  const record = { ...application(), state: "deleting" as const }, target = deletePlan(record);
  f.env.CAKE_QA_DELETE_APPROVALS = JSON.stringify([{ ...target, expiresAt: "2099-01-01T00:00:00.000Z" }]);
  const reader = f.reader();
  await assert.rejects(() => reader.save(lease()), /GET専用/);
  await assert.rejects(() => reader.assignAlias(application(), {
    id: "dpl_application", projectId: QA_PROJECT_ID, target: null, branch: record.branch, sha,
    leaseId, pr: 42, attemptId, phase: "application", state: "READY",
  }), /GET専用/);
  await assert.rejects(() => reader.deleteAlias(record, target), /GET専用/);
  await assert.rejects(() => reader.deleteDeployment(record, {
    id: "dpl_application", projectId: QA_PROJECT_ID, target: null, branch: record.branch, sha,
    leaseId, pr: 42, attemptId, phase: "application", state: "READY",
  }, target), /GET専用/);
  await assert.rejects(() => reader.create({ ...lease(), intent: { sha, phase: "provisioning", attemptId, startedAt: "2026-10-12T00:01:00.000Z" } }), /GET専用/);
  f.assertReadOnly();
});

test("write adapterのinspectを拒否して検査と変更transportを混在させない", async () => {
  const f = new ReadFixture();
  await assert.rejects(() => new HttpQaGateway(f.env, f.request, "write").inspect({ action: "preflight" }), /GET専用adapter/);
  assert.equal(f.calls.length, 0);
});

test("CLI検査は未知・重複・欠落引数と不正PR・SHA・slot・leaseをAPI前に拒否する", async () => {
  let requests = 0;
  const transport: QaTransport = async () => { requests++; return { status: 200, data: {} }; };
  for (const args of [
    ["--unknown", "value"], ["--action"], ["--action", "preflight", "--action", "preflight"],
    ["--action", "probe"], ["--pr", "0"], ["--pr", "42.5"], ["--pr", "NaN"],
    ["--sha", sha.slice(0, 7)], ["--slot", "qa4"], ["--lease-id", "*"],
  ]) await assert.rejects(() => runQaInspection(args, environment(), transport));
  assert.equal(requests, 0);
});

test("CLI計画の必須引数欠落は外部GETより先に拒否する", async () => {
  const f = new ReadFixture();
  for (const args of [
    ["--action", "plan-probe"], ["--action", "plan-probe", "--pr", "42", "--slot", "qa2"],
    ["--action", "plan-probe", "--pr", "42", "--sha", sha],
    ["--action", "plan-release", "--pr", "42"], ["--action", "plan-release", "--lease-id", leaseId],
  ]) await assert.rejects(() => runQaInspection(args, f.env, f.request));
  assert.equal(f.calls.length, 0);
});

test("CLIとwriterの計画dispatchは注入GETtransportだけを使い、Actions有効化を要求しない", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (value: unknown) => { logs.push(String(value)); });
  for (const action of ["preflight", "plan-probe", "plan-release"] as const) {
    const f = new ReadFixture(); if (action === "plan-release") f.setRecord(application());
    const args = action === "preflight" ? [] : action === "plan-probe"
      ? ["--action", action, "--pr", "42", "--sha", sha, "--slot", "qa2"]
      : ["--action", action, "--pr", "42", "--lease-id", leaseId];
    const report = await runQaInspection(args, f.env, f.request);
    assert.equal(report.readOnly, true); assertPrivate(report);
    await runQaWriter({ ...f.env, QA_ACTION: action, QA_PR_NUMBER: "42", QA_SOURCE_SHA: sha, QA_SLOT: "qa2", QA_LEASE_ID: leaseId }, undefined, undefined, f.request);
    f.assertReadOnly();
  }
  assert.equal(logs.length, 3);
  for (const log of logs) { assert.equal(JSON.parse(log).readOnly, true); assertPrivate(JSON.parse(log)); }
});

test("CLIとwriterの読取入口はActions・有効化flagなしでも不足認証を安全に報告する", async (t) => {
  const report = await runQaInspection([], {});
  assert.equal(report.readOnly, true);
  assert.ok(report.checks.some((check) => !check.ok));
  assertPrivate(report);
  const logs: string[] = [];
  t.mock.method(console, "log", (value: unknown) => { logs.push(String(value)); });
  await runQaWriter({ QA_ACTION: "preflight", CAKE_QA_POOL_ENABLED: "false" });
  assert.equal(logs.length, 1);
  const logged = JSON.parse(logs[0]);
  assert.equal(logged.readOnly, true);
  assertPrivate(logged);
});

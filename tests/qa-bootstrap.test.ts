import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ReadOnlyQaBootstrap, type QaBootstrapTransport } from "../lib/qa-bootstrap";
import { runQaBootstrap } from "../scripts/qa-bootstrap";
import {
  qaAlias, QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK,
  parseLeaseRecord, replayDeployments, type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord,
} from "../lib/qa-bootstrap-ledger";

const sha = "a".repeat(40), otherSha = "b".repeat(40);
function gitFile(config: unknown = { git: { deploymentEnabled: { "**": false, main: true } } }) {
  const bytes = Buffer.from(typeof config === "string" ? config : JSON.stringify(config));
  return { type: "file", path: "vercel.json", name: "vercel.json", encoding: "base64", size: bytes.length,
    content: bytes.toString("base64"), sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") };
}
const leaseId = "00000000-0000-4000-8000-000000000042";
const attemptId = "00000000-0000-4000-8000-000000000900";
const secrets = ["bootstrap-secret-github", "bootstrap-secret-vercel", "bootstrap-secret-neon", "bootstrap-secret-response", "postgresql://bootstrap-secret-db"];
const database: DatabaseIdentity = {
  projectId: QA_NEON_PROJECT_ID, branchId: "br-native", endpointId: "ep-native",
  host: "ep-native.ap-southeast-1.aws.neon.tech",
};
type Response = { status: number; data: unknown };
type Report = Awaited<ReturnType<ReadOnlyQaBootstrap["inspect"]>>;
type Responder = (url: URL) => Response;
const environment = () => ({
  GITHUB_TOKEN: secrets[0], VERCEL_TOKEN: secrets[1], NEON_API_KEY: secrets[2],
  CAKE_QA_POOL_ENABLED: "false", CAKE_QA_GIT_GATE_CONFIRMED: "false", CAKE_QA_NATIVE_CONFIRMED: "false",
  CAKE_QA_APPROVED_HEADS: "{}", CAKE_QA_PARENT_BRANCH_ID: "br-parent",
  CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.ap-southeast-1.aws.neon.tech",
  DATABASE_URL: secrets[4],
});
function lease(): QaLeaseRecord {
  return {
    protocol: "cake-qa/v1", slot: "qa2", leaseId, pr: 42, branch: "codex/task-42", headSha: sha,
    state: "held", createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z",
    sequence: 1, previousRecordId: null, deployments: [], retiredDatabases: [],
  };
}
function application(): QaLeaseRecord {
  return {
    ...lease(), database, deployments: [
      { id: "dpl_provisioning", sha, phase: "provisioning" },
      { id: "dpl_application", sha, phase: "application" },
    ],
  };
}
function history(record: QaLeaseRecord): GithubDeployment[] {
  return [
    { id: 1, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: { ...lease(), purpose: record.purpose } },
    { id: 2, task: QA_TASK, environment: QA_ENVIRONMENT, sha: record.headSha,
      payload: { ...record, sequence: 2, previousRecordId: 1 } },
  ];
}
function remote(record: QaLeaseRecord, id: string) {
  const known = record.deployments.find((deployment) => deployment.id === id);
  return {
    id, projectId: QA_PROJECT_ID, target: null as string | null, readyState: "READY", url: "bootstrap-preview.vercel.app",
    gitSource: { ref: record.branch, sha: known?.sha ?? record.headSha },
    meta: {
      githubCommitRef: record.branch, githubCommitSha: known?.sha ?? record.headSha,
      cakeQaLeaseId: record.leaseId, cakeQaPr: String(record.pr), cakeQaAttemptId: attemptId,
      cakeQaPhase: known?.phase ?? "application",
    },
    privateValue: secrets[3],
  };
}
const parent = {
  id: "br-parent", project_id: QA_NEON_PROJECT_ID, name: "qa-native-empty-parent", default: false,
  protected: true, created_at: "2026-10-11T00:00:00.000Z",
};
function nativeBranch(record: QaLeaseRecord) {
  return {
    id: database.branchId, project_id: QA_NEON_PROJECT_ID, name: `preview/${record.branch}`,
    parent_id: parent.id, default: false, protected: false, created_at: "2026-10-12T00:01:00.000Z",
  };
}
function nativeEndpoint() {
  return { id: database.endpointId, project_id: QA_NEON_PROJECT_ID, branch_id: database.branchId, host: database.host, type: "read_write" };
}
class ReadFixture {
  env: Record<string, string | undefined> = environment();
  calls: { method: string; hostname: string; path: string; search: string; token: string }[] = [];
  responses = new Map<string, Response | Responder>();
  records: GithubDeployment[] = [];
  record?: QaLeaseRecord;
  project = {
    id: QA_PROJECT_ID, name: "cake", accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub", previewDeploymentsDisabled: false,
    link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main", repoId: 1318171856 },
    env: [{ key: "DATABASE_URL", value: secrets[4] }], privateValue: secrets[3],
  };
  pr = {
    number: 42, state: "open", head: { sha, ref: "codex/task-42", repo: { full_name: QA_REPOSITORY } },
    base: { ref: "main", repo: { full_name: QA_REPOSITORY } }, privateValue: secrets[3],
  };
  variableNames = [
    "CAKE_QA_POOL_ENABLED", "CAKE_QA_GIT_GATE_CONFIRMED", "CAKE_QA_NATIVE_CONFIRMED", "CAKE_QA_PRODUCTION_DATABASE_HOST",
    "CAKE_QA_PARENT_BRANCH_ID", "CAKE_QA_APPROVED_HEADS", "CAKE_QA_PROBE_APPROVALS", "CAKE_QA_DELETE_APPROVALS",
  ];
  setRecord(record: QaLeaseRecord) { this.record = structuredClone(record); this.records = history(record); }
  request: QaBootstrapTransport = async (method, address, token) => {
    const url = new URL(address), path = url.pathname.replace(/^\/api\/v2(?=\/)/, "");
    this.calls.push({ method, hostname: url.hostname, path, search: url.search, token });
    assert.equal(method, "GET", "bootstrap transport must never receive a mutation");
    assert.ok(["api.vercel.com", "api.github.com", "console.neon.tech"].includes(url.hostname));
    const override = this.responses.get(path + url.search) ?? this.responses.get(path);
    if (override) return structuredClone(typeof override === "function" ? override(url) : override);
    if (path === `/v9/projects/${QA_PROJECT_ID}`) return { status: 200, data: structuredClone(this.project) };
    if (path === `/repos/${QA_REPOSITORY}/branches/main`) return { status: 200, data: { name: "main", commit: { sha: otherSha } } };
    if (path === `/repos/${QA_REPOSITORY}/contents/vercel.json`) {
      assert.ok([sha, otherSha].includes(url.searchParams.get("ref") ?? ""), "configuration reads must use pinned complete commit SHAs");
      return { status: 200, data: gitFile() };
    }
    if (path === `/repos/${QA_REPOSITORY}/deployments`) {
      const page = Number(url.searchParams.get("page") ?? 1), limit = Number(url.searchParams.get("per_page") ?? 100);
      return { status: 200, data: structuredClone(this.records.slice((page - 1) * limit, page * limit)) };
    }
    if (path === `/repos/${QA_REPOSITORY}/actions/variables`) {
      const page = Number(url.searchParams.get("page") ?? 1), limit = Number(url.searchParams.get("per_page") ?? 30);
      const names = this.variableNames.slice((page - 1) * limit, page * limit);
      return { status: 200, data: { total_count: this.variableNames.length, variables: names.map((name) => ({ name, value: secrets[3] })) } };
    }
    if (path === `/repos/${QA_REPOSITORY}/pulls/42`) return { status: 200, data: structuredClone(this.pr) };
    if (path === `/projects/${QA_NEON_PROJECT_ID}`) return { status: 200, data: { project: { id: QA_NEON_PROJECT_ID, connection_uri: secrets[4] } } };
    if (path === `/projects/${QA_NEON_PROJECT_ID}/branches/${parent.id}`) return { status: 200, data: { branch: structuredClone(parent) } };
    if (path === `/projects/${QA_NEON_PROJECT_ID}/branches`) return { status: 200, data: {
      branches: [parent, ...(this.record?.database ? [nativeBranch(this.record)] : [])], pagination: { next: null },
    } };
    if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`) return { status: 200, data: {
      endpoints: this.record?.database ? [nativeEndpoint()] : [], pagination: { next: null },
    } };
    if (path === `/projects/${QA_NEON_PROJECT_ID}/branches/${database.branchId}` && this.record?.database) return { status: 200, data: { branch: nativeBranch(this.record) } };
    if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints/${database.endpointId}` && this.record?.database) return { status: 200, data: { endpoint: nativeEndpoint() } };
    if (path === "/v7/deployments") return { status: 200, data: {
      deployments: this.record?.deployments.map((deployment) => remote(this.record!, deployment.id)) ?? [], pagination: { next: null },
    } };
    if (path.startsWith("/v13/deployments/") && this.record) {
      const id = path.slice("/v13/deployments/".length);
      return this.record.deployments.some((deployment) => deployment.id === id)
        ? { status: 200, data: remote(this.record, id) }
        : { status: 404, data: { message: secrets[3] } };
    }
    if (path.startsWith("/v4/aliases/")) return this.record && path.endsWith(qaAlias(this.record.slot)) && this.record.purpose !== "probe"
      ? { status: 200, data: { projectId: QA_PROJECT_ID, deploymentId: "dpl_application", privateValue: secrets[3] } }
      : { status: 404, data: { message: secrets[3] } };
    assert.fail(`unexpected read path: ${path}`);
  };
  reader() { return new ReadOnlyQaBootstrap(this.env, this.request); }
  assertReadOnly() {
    assert.ok(this.calls.every((call) => call.method === "GET"));
    assert.ok(this.calls.every((call) => !/connection_uri|connection-string|\/sql\b/.test(call.path)));
  }
}
function checked(report: Report, name: string) {
  const result = report.checks.find((check) => check.name === name);
  assert.ok(result, `missing check ${name}`);
  assert.equal(typeof result.reason.code, "string");
  return result;
}
function assertPrivate(value: unknown) {
  const output = JSON.stringify(value);
  for (const secret of [...secrets, database.host, environment().CAKE_QA_PRODUCTION_DATABASE_HOST]) {
    assert.equal(output.includes(secret), false, "reports must curate secrets and hosts from output");
  }
}
function assertDisabled(report: Report) {
  assert.equal(report.readOnly, true);
  assert.equal(report.executionEnabled, false);
  if (report.plan) assert.equal(report.plan.executionEnabled, false);
}
function assertReleasePlan(report: Report, record: QaLeaseRecord) {
  assert.ok(report.plan);
  assert.ok(report.plan.action === "plan-release");
  const plan = report.plan;
  assert.equal(plan.projectId, QA_PROJECT_ID);
  assert.equal(plan.neonProjectId, QA_NEON_PROJECT_ID);
  assert.equal(plan.pr, record.pr);
  assert.equal(plan.branch, record.branch);
  assert.equal(plan.headSha, record.headSha);
  assert.equal(plan.slot, record.slot);
  assert.equal(plan.leaseId, record.leaseId);
  assert.deepEqual(plan.deploymentIds, record.deployments.map((deployment) => deployment.id).sort());
  assert.equal(plan.alias, record.purpose === "probe" ? record.aliasAssignment?.alias ?? null : qaAlias(record.slot));
  assert.deepEqual(plan.database, { projectId: record.database!.projectId, branchId: record.database!.branchId, endpointId: record.database!.endpointId });
  assert.equal(plan.approvalManifestRequiresPrivateHost, true);
  assert.equal(plan.databaseDataLossRequiresApproval, true);
  assert.match(plan.dataLossNotice, /QA DBと入力データ.*失います/);
  assertDisabled(report); assertPrivate(report);
}

test("preflightは有効化flagや承認なしでもGETだけを実施し、設定と資源を変更しない", async () => {
  const fixture = new ReadFixture(), before = structuredClone(fixture.env);
  const report = await fixture.reader().inspect({ action: "preflight" });
  for (const name of ["Vercel project", "Preview enabled", "Main Git configuration", "GitHub lease ledger", "GitHub repository Variables read", "Neon metadata read", "Native parent configuration", "Production comparison host configured"]) {
    assert.equal(checked(report, name).ok, true, name);
  }
  assert.equal(report.plan, null);
  assert.deepEqual(fixture.env, before);
  assert.equal(fixture.calls.some((call) => call.path.includes("/pulls/")), false);
  assert.deepEqual(fixture.calls.map(({ method, hostname, path, search }) => ({ method, hostname, path, search })), [
    { method: "GET", hostname: "api.vercel.com", path: `/v9/projects/${QA_PROJECT_ID}`, search: "?slug=fumin1" },
    { method: "GET", hostname: "api.github.com", path: `/repos/${QA_REPOSITORY}/branches/main`, search: "" },
    { method: "GET", hostname: "api.github.com", path: `/repos/${QA_REPOSITORY}/contents/vercel.json`, search: `?ref=${otherSha}` },
    { method: "GET", hostname: "api.github.com", path: `/repos/${QA_REPOSITORY}/deployments`, search: `?task=${QA_TASK}&per_page=100&page=1` },
    { method: "GET", hostname: "api.github.com", path: `/repos/${QA_REPOSITORY}/actions/variables`, search: "?per_page=30&page=1" },
    { method: "GET", hostname: "console.neon.tech", path: `/projects/${QA_NEON_PROJECT_ID}`, search: "" },
    { method: "GET", hostname: "console.neon.tech", path: `/projects/${QA_NEON_PROJECT_ID}/branches`, search: "?limit=100" },
    { method: "GET", hostname: "console.neon.tech", path: `/projects/${QA_NEON_PROJECT_ID}/endpoints`, search: "" },
    { method: "GET", hostname: "console.neon.tech", path: `/projects/${QA_NEON_PROJECT_ID}/branches/${parent.id}`, search: "" },
    ...["qa1", "qa2", "qa3"].map((slot) => ({ method: "GET", hostname: "api.vercel.com", path: `/v4/aliases/${qaAlias(slot as "qa1" | "qa2" | "qa3")}`, search: "?slug=fumin1" })),
  ]);
  assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
});

test("任意のpreflight対象PRは現在OPEN headへ固定し、commitとblobだけを証跡に返す", async () => {
  const fixture = new ReadFixture(), before = structuredClone(fixture.env);
  const report = await fixture.reader().inspect({ action: "preflight", pr: 42, sha });
  assert.deepEqual(report.gitConfiguration.target, { pr: 42, branch: fixture.pr.head.ref, commitSha: sha, blobSha: gitFile().sha });
  assert.equal(checked(report, "Target Git configuration").ok, true);
  assert.equal(report.prerequisites.find((entry) => entry.name === "Target Git configuration")?.confirmed, true);
  assert.deepEqual(fixture.calls.filter((call) => call.path.endsWith("/contents/vercel.json")).map((call) => new URLSearchParams(call.search).get("ref")), [otherSha, sha]);
  assert.deepEqual(fixture.env, before); assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
});

test("mainまたは対象のGit設定が欠落・権限不足・不正なら未確認として他の読取結果を保持する", async () => {
  const failures: Response[] = [
    ...[401, 403, 404].map((status) => ({ status, data: { message: secrets[3], url: secrets[4] } })),
    { status: 200, data: gitFile({ buildCommand: secrets[3] }) },
    { status: 200, data: gitFile({ git: { deploymentEnabled: { "**": false, main: true, "codex/*": true } } }) },
    { status: 200, data: gitFile({ git: { deploymentEnabled: { "**": false, main: "true" } } }) },
    { status: 200, data: gitFile("private-unparseable-json") },
    { status: 200, data: { ...gitFile(), sha: "c".repeat(40) } },
  ];
  for (const ref of [otherSha, sha]) for (const response of failures) {
    const fixture = new ReadFixture();
    fixture.responses.set(`/repos/${QA_REPOSITORY}/contents/vercel.json?ref=${ref}`, response);
    const report = await fixture.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
    const name = ref === otherSha ? "Main Git configuration" : "Target Git configuration";
    assert.equal(checked(report, name).ok, false);
    assert.equal(report.prerequisites.find((entry) => entry.name === name)?.confirmed, false);
    assert.equal(ref === otherSha ? report.gitConfiguration.main : report.gitConfiguration.target, null);
    assert.equal(checked(report, "Neon metadata read").ok, true);
    assert.equal(checked(report, "GitHub lease ledger").ok, true);
    assert.ok(report.plan, "the plan remains information with explicit unmet prerequisites");
    if (response.status >= 400) assert.equal(checked(report, name).reason.status, response.status);
    else assert.equal(checked(report, name).reason.code, "git-configuration-unconfirmed");
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("現在mainのbranch名と完全SHAが未確認ならContentsを取得せず安全な理由を返す", async () => {
  for (const response of [
    { status: 403, data: { message: secrets[3] } }, { status: 404, data: null },
    { status: 200, data: { name: "other", commit: { sha: otherSha } } },
    { status: 200, data: { name: "main", commit: { sha: otherSha.slice(0, 7) } } },
    { status: 200, data: { name: "main", commit: { sha: otherSha.toUpperCase() } } },
  ]) {
    const fixture = new ReadFixture(); fixture.responses.set(`/repos/${QA_REPOSITORY}/branches/main`, response);
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(checked(report, "Main Git configuration").ok, false);
    assert.equal(report.gitConfiguration.main, null);
    assert.equal(fixture.calls.some((call) => call.path.endsWith("/contents/vercel.json")), false);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("preflightのclosedまたは古いSHAの対象はGit証跡を返さず固定Contentsを読まない", async () => {
  for (const failure of ["closed", "stale"] as const) {
    const fixture = new ReadFixture();
    if (failure === "closed") fixture.pr.state = "closed";
    const report = await fixture.reader().inspect({ action: "preflight", pr: 42, sha: failure === "stale" ? otherSha : sha });
    assert.equal(report.gitConfiguration.target, null);
    assert.equal(checked(report, "Target Git configuration").reason.code, "stale-sha");
    assert.equal(fixture.calls.filter((call) => call.path.endsWith("/contents/vercel.json")).length, 1);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("返却manifestはmainと対象Git設定の欠落に依存せずGit APIを追加しない", async () => {
  const fixture = new ReadFixture(), record = application(); fixture.setRecord(record);
  fixture.responses.set(`/repos/${QA_REPOSITORY}/branches/main`, { status: 403, data: { message: secrets[3] } });
  fixture.responses.set(`/repos/${QA_REPOSITORY}/contents/vercel.json`, { status: 404, data: null });
  const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assertReleasePlan(report, record);
  assert.equal(report.gitConfiguration.main, null); assert.equal(report.gitConfiguration.target, null);
  assert.equal(fixture.calls.some((call) => call.path.endsWith("/branches/main") || call.path.endsWith("/contents/vercel.json")), false);
  fixture.assertReadOnly(); assertPrivate(report);
});

test("Neon summaryはAPIのdefault・直接の親子関係・endpoint所属を観測し、名前から推測しない", async () => {
  const fixture = new ReadFixture(), root = { ...parent, parent_id: null };
  const branch = (id: string, name: string, parentId: string | null, isDefault = false) => ({
    id, project_id: QA_NEON_PROJECT_ID, name, parent_id: parentId, default: isDefault,
  });
  fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches/${parent.id}`, { status: 200, data: { branch: root } });
  fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: { branches: [
    branch("br-z-preview", "preview/codex/task-42", parent.id),
    branch("br-default-z", "another-default", null, true),
    { id: "br-main", project_id: QA_NEON_PROJECT_ID, name: "main" },
    branch("br-c-grandchild", "preview/codex/grandchild", "br-z-preview"),
    branch("br-b-other", "preview/codex/elsewhere", "br-default-a"), root,
    branch("br-a-direct", "experiment/one", parent.id),
    branch("br-default-a", "observed-default", null, true),
    { id: "br-production", project_id: QA_NEON_PROJECT_ID, name: "production", default: "true", parent_id: undefined },
  ], pagination: { next: null } } });
  fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: { endpoints: [
    { id: "ep-z-preview", project_id: QA_NEON_PROJECT_ID, branch_id: "br-z-preview", host: database.host },
    { id: "ep-a-direct", project_id: QA_NEON_PROJECT_ID, branch_id: "br-a-direct" },
    { id: "ep-unavailable", project_id: QA_NEON_PROJECT_ID },
  ], pagination: { next: null } } });
  const report = await fixture.reader().inspect({ action: "preflight" });
  assert.ok(report.native && report.parent);
  assert.equal(report.native.projectId, QA_NEON_PROJECT_ID);
  assert.equal(report.native.branchCount, 9); assert.equal(report.native.endpointCount, 3);
  assert.deepEqual(report.native.branches.map((entry) => entry.branchId), [
    "br-a-direct", "br-b-other", "br-c-grandchild", "br-default-a", "br-default-z", "br-main", "br-parent", "br-production", "br-z-preview",
  ]);
  assert.ok(report.native.branches.every((entry) => entry.projectId === QA_NEON_PROJECT_ID));
  assert.deepEqual(report.native.defaultBranchIds, ["br-default-a", "br-default-z"]);
  assert.deepEqual(report.native.observedPreviewCodexBranchIds, ["br-b-other", "br-c-grandchild", "br-z-preview"]);
  assert.deepEqual(report.parent.candidateSummary, {
    branch: { projectId: QA_NEON_PROJECT_ID, branchId: parent.id, name: parent.name, nameEvidence: "branch.name",
      parentId: null, parentIdEvidence: "branch.parent_id", default: false, defaultEvidence: "branch.default" },
    observedChildBranchIds: ["br-a-direct", "br-z-preview"], observedPreviewCodexChildBranchIds: ["br-z-preview"], childEvidence: "listed branch.parent_id",
  });
  for (const id of ["br-main", "br-production"]) {
    const observed: NonNullable<Report["native"]>["branches"][number] = report.native.branches.find((entry) => entry.branchId === id)!;
    assert.equal(observed.parentId, null); assert.equal(observed.parentIdEvidence, "unavailable");
    assert.equal(observed.default, null); assert.equal(observed.defaultEvidence, "unavailable");
  }
  assert.deepEqual(report.native.endpoints, [
    { projectId: QA_NEON_PROJECT_ID, endpointId: "ep-a-direct", branchId: "br-a-direct", branchIdEvidence: "endpoint.branch_id" },
    { projectId: QA_NEON_PROJECT_ID, endpointId: "ep-unavailable", branchId: null, branchIdEvidence: "unavailable" },
    { projectId: QA_NEON_PROJECT_ID, endpointId: "ep-z-preview", branchId: "br-z-preview", branchIdEvidence: "endpoint.branch_id" },
  ]);
  assert.equal(report.parent.emptyStateProven, false);
  for (const name of ["Native parent initial state", "Native build and runtime identity", "Native cleanup behavior"]) {
    assert.equal(report.prerequisites.find((entry) => entry.name === name)?.confirmed, false);
  }
  assert.equal(fixture.calls.length, 12);
  assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
});

test("Neon branch.defaultはbooleanだけを採用し、欠落・未知値を既定判定に使わない", async () => {
  for (const value of [true, false, undefined, null, "true", 1, {}]) {
    const fixture = new ReadFixture();
    const observed = { ...parent, name: "main", default: value, parent_id: null };
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: { branches: [observed] } });
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches/${parent.id}`, { status: 200, data: { branch: observed } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.ok(report.native && report.parent);
    assert.equal(report.native.branches[0].default, typeof value === "boolean" ? value : null);
    assert.equal(report.native.branches[0].defaultEvidence, typeof value === "boolean" ? "branch.default" : "unavailable");
    assert.deepEqual(report.native.defaultBranchIds, value === true ? [parent.id] : []);
    assert.equal(report.native.branches[0].parentIdEvidence, "branch.parent_id");
    assert.equal(report.parent.emptyStateProven, false);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("Neon summaryは許可項目だけを返し、URIや資格情報のbranch名・不正参照は未確認にする", async () => {
  for (const name of ["postgresql://qa-role:qa-password@ep-secret.neon.tech/db", "https://private.example/path", "//private.example/path",
    "preview/codex/task\n", "a".repeat(256), "bootstrap-secret-fallback", ...secrets.slice(0, 3)]) {
    const fixture = new ReadFixture();
    fixture.env.GH_TOKEN = "bootstrap-secret-fallback";
    const extras = { connection_uri: secrets[4], connection_string: secrets[4], role: "private-qa-role", password: "private-qa-password",
      host: "ep-private.ap-southeast-1.aws.neon.tech", env: [{ key: "PRIVATE_API_KEY", value: secrets[3] }], user: "private-qa-user", privateValue: secrets[3] };
    const observed = { ...parent, ...extras, name, parent_id: secrets[4], default: secrets[3] };
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}`, { status: 200, data: { project: { id: QA_NEON_PROJECT_ID, ...extras } } });
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: { branches: [observed] } });
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches/${parent.id}`, { status: 200, data: { branch: observed } });
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: {
      endpoints: [{ id: "ep-observed", project_id: QA_NEON_PROJECT_ID, branch_id: secrets[4], ...extras }],
    } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.ok(report.native && report.parent);
    assert.deepEqual(report.native.branches[0], {
      projectId: QA_NEON_PROJECT_ID, branchId: parent.id, name: null, nameEvidence: "unavailable",
      parentId: null, parentIdEvidence: "unavailable", default: null, defaultEvidence: "unavailable",
    });
    assert.deepEqual(report.native.endpoints[0], {
      projectId: QA_NEON_PROJECT_ID, endpointId: "ep-observed", branchId: null, branchIdEvidence: "unavailable",
    });
    assert.deepEqual(report.native.defaultBranchIds, []);
    assert.deepEqual(report.native.observedPreviewCodexBranchIds, []);
    assert.deepEqual(report.parent.candidateSummary.observedChildBranchIds, []);
    assert.equal(report.parent.emptyStateProven, false);
    const output = JSON.stringify(report);
    for (const forbidden of [name, "private-qa-role", "private-qa-password", extras.host, "PRIVATE_API_KEY", "private-qa-user", "connection_uri", "connection_string"]) {
      assert.equal(output.includes(forbidden), false, "complete report must contain only allowlisted metadata");
    }
    assert.equal(fixture.calls.length, 12);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("Neon projectまたは一覧resourceの所属・IDが不正ならsummaryを公開しない", async () => {
  for (const kind of ["project", "branch-project", "endpoint-project", "branch-id", "endpoint-id"] as const) {
    const fixture = new ReadFixture();
    if (kind === "project") fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}`, { status: 200, data: { project: { id: "wrong-project" } } });
    else if (kind.startsWith("branch")) fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: {
      branches: [{ ...parent, project_id: kind === "branch-project" ? "wrong-project" : QA_NEON_PROJECT_ID,
        id: kind === "branch-id" ? `${parent.id}\n` : parent.id }],
    } });
    else fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: {
      endpoints: [{ id: kind === "endpoint-id" ? "ep-unsafe\n" : "ep-observed", branch_id: parent.id,
        project_id: kind === "endpoint-project" ? "wrong-project" : QA_NEON_PROJECT_ID }],
    } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(checked(report, "Neon metadata read").ok, false, kind);
    assert.equal(checked(report, "Neon metadata read").reason.code, "identity-mismatch", kind);
    assert.equal(report.native, null, kind);
    assert.ok(report.parent);
    assert.equal(report.parent.candidateSummary.childEvidence, "unavailable");
    assert.equal(report.parent.candidateSummary.observedChildBranchIds, null);
    assert.equal(report.parent.candidateSummary.observedPreviewCodexChildBranchIds, null);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("候補親の一覧と既存個別GETの確認済みmetadataが矛盾した場合は親を未確認にする", async () => {
  for (const change of [{ name: "different-parent" }, { parent_id: "br-other" }, { default: true }]) {
    const fixture = new ReadFixture(), listed = { ...parent, parent_id: null };
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: { branches: [listed] } });
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches/${parent.id}`, { status: 200, data: { branch: { ...listed, ...change } } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(checked(report, "Neon metadata read").ok, true);
    assert.equal(checked(report, "Native parent configuration").ok, false);
    assert.equal(checked(report, "Native parent configuration").reason.code, "identity-mismatch");
    assert.equal(report.parent, null);
    assert.equal(fixture.calls.length, 12);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("本番host比較はpoolerを第一DNSlabelだけで正規化し、DNSの大小文字も同一視する", async () => {
  const direct = "ep-shared.ap-southeast-1.aws.neon.tech", pooled = "ep-shared-pooler.ap-southeast-1.aws.neon.tech";
  for (const [production, observed] of [[direct, direct], [pooled, direct], [direct, pooled], [pooled, pooled], [direct.toUpperCase(), pooled.toUpperCase()]]) {
    const fixture = new ReadFixture(); fixture.env.CAKE_QA_PRODUCTION_DATABASE_HOST = production;
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: { endpoints: [
      { id: "ep-shared", project_id: QA_NEON_PROJECT_ID, branch_id: parent.id, host: observed },
    ] } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.deepEqual(report.productionHostComparison, { result: "match", endpoints: [{ endpointId: "ep-shared", result: "match" }] });
    assert.equal(JSON.stringify(report).includes(".neon.tech"), false);
    assert.equal(fixture.calls.length, 12);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("全endpointの確認済み不一致だけをno-matchにし、隔離・Native起源・空DBの証明にしない", async () => {
  const fixture = new ReadFixture();
  fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: { endpoints: [
    { id: "ep-z", project_id: QA_NEON_PROJECT_ID, branch_id: parent.id, host: "ep-z-pooler.us-east-2.aws.neon.tech" },
    { id: "ep-a", project_id: QA_NEON_PROJECT_ID, branch_id: parent.id, host: "ep-a.ap-southeast-1.aws.neon.tech" },
  ] } });
  const report = await fixture.reader().inspect({ action: "preflight" });
  assert.deepEqual(report.productionHostComparison, { result: "no-match", endpoints: [
    { endpointId: "ep-a", result: "no-match" }, { endpointId: "ep-z", result: "no-match" },
  ] });
  assert.equal(report.parent?.emptyStateProven, false);
  for (const name of ["Native parent initial state", "Native build and runtime identity", "Native cleanup behavior"]) {
    assert.equal(report.prerequisites.find((entry) => entry.name === name)?.confirmed, false);
  }
  assert.equal(JSON.stringify(report).includes(".neon.tech"), false);
  assert.equal(fixture.calls.length, 12);
  assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
});

test("確認済みmatchを集約し、不明endpointまたは同IDの異なるsuffixをno-matchにしない", async () => {
  const same = { id: "ep-production", project_id: QA_NEON_PROJECT_ID, branch_id: parent.id,
    host: "ep-production.ap-southeast-1.aws.neon.tech" };
  const other = { id: "ep-other", project_id: QA_NEON_PROJECT_ID, branch_id: parent.id,
    host: "ep-other.ap-southeast-1.aws.neon.tech" };
  const unknown = { id: "ep-unknown", project_id: QA_NEON_PROJECT_ID, branch_id: parent.id };
  for (const [endpoints, result] of [
    [[unknown, other], "unknown"], [[unknown, same, other], "match"],
    [[{ ...same, host: "ep-production.us-east-2.aws.neon.tech" }], "unknown"],
    [[{ ...same, host: "ep-production.ap-southeast-1-pooler.aws.neon.tech" }], "unknown"],
  ] as const) {
    const fixture = new ReadFixture();
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: { endpoints } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(report.productionHostComparison.result, result);
    assert.ok(report.productionHostComparison.endpoints);
    assert.deepEqual(report.productionHostComparison.endpoints.map((entry) => entry.endpointId), endpoints.map((entry) => entry.id).sort());
    if (endpoints.length === 1) assert.equal(report.productionHostComparison.endpoints[0].result, "unknown");
    assert.equal(JSON.stringify(report).includes(".neon.tech"), false);
    assert.equal(fixture.calls.length, 12);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("本番またはendpointのhost欠落・不正形式・endpoint ID矛盾はunknownを返す", async () => {
  const invalid = [undefined, null, false, 42, {}, "", secrets[4], "https://ep-production.ap-southeast-1.aws.neon.tech",
    "ep-production.ap-southeast-1.aws.neon.tech:5432", "ep-production.ap-southeast-1.aws.neon.tech/db",
    "ep-production.ap-southeast-1.aws.neon.tech\n", " ep-production.ap-southeast-1.aws.neon.tech",
    "ep-production.ap-southeast-1.aws.neon.tech.", "ep-production..aws.neon.tech", "ep-production.-region.aws.neon.tech",
    "ep-production.region-.aws.neon.tech", `ep-production.${"a".repeat(64)}.neon.tech`, `ep-${"a".repeat(240)}.aws.neon.tech`];
  for (const side of ["production", "endpoint"] as const) for (const value of invalid) {
    const fixture = new ReadFixture();
    if (side === "production") fixture.env.CAKE_QA_PRODUCTION_DATABASE_HOST = value as string | undefined;
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: { endpoints: [
      { id: "ep-production", project_id: QA_NEON_PROJECT_ID, branch_id: parent.id,
        host: side === "endpoint" ? value : "ep-production.ap-southeast-1.aws.neon.tech" },
    ] } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.deepEqual(report.productionHostComparison, { result: "unknown", endpoints: [{ endpointId: "ep-production", result: "unknown" }] });
    assert.equal(JSON.stringify(report).includes(".neon.tech"), false);
    assert.equal(fixture.calls.length, 12);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
  const fixture = new ReadFixture();
  fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: { endpoints: [
    { id: "ep-contradiction", project_id: QA_NEON_PROJECT_ID, branch_id: parent.id, host: "ep-production.ap-southeast-1.aws.neon.tech" },
  ] } });
  const report = await fixture.reader().inspect({ action: "preflight" });
  assert.deepEqual(report.productionHostComparison, { result: "unknown", endpoints: [{ endpointId: "ep-contradiction", result: "unknown" }] });
  assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();

  const malformed = new ReadFixture();
  malformed.env.CAKE_QA_PRODUCTION_DATABASE_HOST = "ep-edge--pooler.ap-southeast-1.aws.neon.tech";
  malformed.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: { endpoints: [
    { id: "ep-edge-", project_id: QA_NEON_PROJECT_ID, branch_id: parent.id, host: malformed.env.CAKE_QA_PRODUCTION_DATABASE_HOST },
  ] } });
  const malformedReport = await malformed.reader().inspect({ action: "preflight" });
  assert.deepEqual(malformedReport.productionHostComparison, { result: "unknown", endpoints: [{ endpointId: "ep-edge-", result: "unknown" }] });
  assert.equal(JSON.stringify(malformedReport).includes(".neon.tech"), false);
  assert.equal(malformed.calls.length, 12);
  assertDisabled(malformedReport); assertPrivate(malformedReport); malformed.assertReadOnly();
});

test("Neon一覧が空または未確認なら本番host比較をunknownとし、部分一覧を公開しない", async () => {
  for (const kind of ["empty", "project-denied", "branch-page-denied", "endpoint-incomplete"] as const) {
    const fixture = new ReadFixture();
    if (kind === "project-denied") fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}`, { status: 403, data: { message: secrets[3] } });
    if (kind === "branch-page-denied") fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, (url) => url.searchParams.has("cursor")
      ? { status: 403, data: { message: secrets[3] } } : { status: 200, data: { branches: [parent], pagination: { next: "next-branches" } } });
    if (kind === "endpoint-incomplete") fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: {
      endpoints: [{ id: "ep-production", project_id: QA_NEON_PROJECT_ID, host: fixture.env.CAKE_QA_PRODUCTION_DATABASE_HOST }], pagination: { next: "unknown-page" },
    } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.deepEqual(report.productionHostComparison, { result: "unknown", endpoints: kind === "empty" ? [] : null });
    assert.equal(checked(report, "Neon metadata read").ok, kind === "empty");
    assert.equal(JSON.stringify(report).includes(".neon.tech"), false);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("本番hostやpooler同値をbranch名に注入してもmetadata summaryから出力しない", async () => {
  for (const name of ["ep-production.ap-southeast-1.aws.neon.tech", "ep-production-pooler.ap-southeast-1.aws.neon.tech", "ep-production.ap-southeast-1.aws.neon.tech".toUpperCase()]) {
    const fixture = new ReadFixture(), observed = { ...parent, name };
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: { branches: [observed] } });
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches/${parent.id}`, { status: 200, data: { branch: observed } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(report.native?.branches[0].name, null);
    assert.equal(report.native?.branches[0].nameEvidence, "unavailable");
    assert.equal(report.parent?.candidateSummary.branch.name, null);
    assert.equal(JSON.stringify(report).toLowerCase().includes(".neon.tech"), false);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("Native名に埋め込まれたprefix/suffix・大小文字・poolerのhostも要約から省略する", async () => {
  const host = environment().CAKE_QA_PRODUCTION_DATABASE_HOST;
  const poolerHost = host.replace("ep-production.", "ep-production-pooler.");
  for (const name of [`preview/${host}`, `${host}/copied`, `preview/${host.toUpperCase()}/copied`,
    `preview/${poolerHost}`, `${poolerHost.toUpperCase()}/copied`, "preview/ep-unknown.us-east-2.aws.neon.tech/copied"]) {
    const fixture = new ReadFixture(), observed = { ...parent, name };
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: { branches: [observed] } });
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches/${parent.id}`, { status: 200, data: { branch: observed } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(report.native?.branches[0].name, null);
    assert.equal(report.native?.branches[0].nameEvidence, "unavailable");
    assert.equal(report.parent?.candidateSummary.branch.name, null);
    assert.equal(JSON.stringify(report.native).toLowerCase().includes(".neon.tech"), false);
    assert.equal(JSON.stringify(report.parent).toLowerCase().includes(".neon.tech"), false);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("Native名に埋め込まれた既知credentialと供給host文字列も要約から省略する", async () => {
  const names = [secrets[0], secrets[1], secrets[2], "bootstrap-secret-fallback", "supplied-production-marker"]
    .flatMap((value) => [`preview/${value}`, `${value}/copied`, `preview/${value.toUpperCase()}/copied`]);
  for (const name of names) {
    const fixture = new ReadFixture(), observed = { ...parent, name };
    fixture.env.GH_TOKEN = "bootstrap-secret-fallback";
    fixture.env.CAKE_QA_PRODUCTION_DATABASE_HOST = "supplied-production-marker";
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: { branches: [observed] } });
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches/${parent.id}`, { status: 200, data: { branch: observed } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(report.native?.branches[0].name, null);
    assert.equal(report.parent?.candidateSummary.branch.name, null);
    assert.equal(JSON.stringify(report.native).toLowerCase().includes(name.toLowerCase()), false);
    assert.equal(JSON.stringify(report.parent).toLowerCase().includes(name.toLowerCase()), false);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
  const fixture = new ReadFixture(); fixture.env.GH_TOKEN = "";
  const report = await fixture.reader().inspect({ action: "preflight" });
  assert.equal(report.native?.branches[0].name, parent.name, "an empty credential must not hide safe branch names");
});

test("本番hostの大小文字・pooler表記が一致する場合は返却計画を作らない", async () => {
  for (const productionHost of [database.host.toUpperCase(),
    database.host.replace("ep-native.", "ep-native-pooler."), database.host.replace("ep-native.", "ep-native-pooler.").toUpperCase()]) {
    const fixture = new ReadFixture(); fixture.setRecord(application());
    fixture.env.CAKE_QA_PRODUCTION_DATABASE_HOST = productionHost;
    const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    assert.equal(report.productionHostComparison.result, "match");
    assert.equal(report.plan, null);
    assert.equal(checked(report, "Exact release resources").reason.code, "identity-mismatch");
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("本番host比較は既存probe・release計画とGET集合を変更しない", async () => {
  for (const action of ["plan-probe", "plan-release"] as const) {
    const fixture = new ReadFixture(); fixture.setRecord(application());
    // A normal held lease cannot become a probe; release remains valid.
    const report = await fixture.reader().inspect(action === "plan-probe" ? { action, pr: 42, sha, slot: "qa1" } : { action, pr: 42, leaseId });
    assert.deepEqual(report.productionHostComparison, { result: "no-match", endpoints: [{ endpointId: database.endpointId, result: "no-match" }] });
    if (action === "plan-release") assertReleasePlan(report, fixture.record!);
    else assert.equal(report.plan, null);
    assert.equal(fixture.calls.length, action === "plan-release" ? 15 : 14);
    assert.equal(JSON.stringify(report.productionHostComparison).includes(".neon.tech"), false);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
  const fixture = new ReadFixture(); fixture.setRecord(application()); fixture.env.CAKE_QA_PRODUCTION_DATABASE_HOST = database.host;
  const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assert.equal(report.productionHostComparison.result, "match");
  assert.equal(report.plan, null);
  assert.equal(checked(report, "Exact release resources").reason.code, "identity-mismatch");
  assert.equal(fixture.calls.length, 11);
  assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
});

test("個別の認証不足を資格情報名付きで報告し、他providerの読取を保持する", async () => {
  for (const [credential, check, hostname, survivingCheck] of [
    ["GITHUB_TOKEN", "GitHub lease ledger", "api.github.com", "Vercel project"],
    ["VERCEL_TOKEN", "Vercel project", "api.vercel.com", "Neon metadata read"],
    ["NEON_API_KEY", "Neon metadata read", "console.neon.tech", "Vercel project"],
  ]) {
    const fixture = new ReadFixture(); delete fixture.env[credential];
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(checked(report, check).ok, false, credential);
    assert.equal(checked(report, check).reason.code, "missing-credential", credential);
    assert.equal(checked(report, check).reason.credential, credential);
    assert.equal(checked(report, survivingCheck).ok, true, credential);
    assert.equal(fixture.calls.some((call) => call.hostname === hostname), false, credential);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("空の環境でも認証不足を安全に返し、transportを呼ばない", async () => {
  let requests = 0;
  const report = await runQaBootstrap([], {}, async () => { requests++; return { status: 200, data: {} }; });
  assert.equal(requests, 0);
  for (const [name, credential] of [["Vercel project", "VERCEL_TOKEN"], ["GitHub lease ledger", "GITHUB_TOKEN"], ["Neon metadata read", "NEON_API_KEY"]]) {
    assert.equal(checked(report, name).reason.code, "missing-credential");
    assert.equal(checked(report, name).reason.credential, credential);
  }
  assertDisabled(report); assertPrivate(report);
});

test("403と404を区別し、remote error bodyを公開しない", async () => {
  for (const [path, name] of [
    [`/v9/projects/${QA_PROJECT_ID}`, "Vercel project"],
    [`/repos/${QA_REPOSITORY}/deployments`, "GitHub lease ledger"],
    [`/repos/${QA_REPOSITORY}/actions/variables`, "GitHub repository Variables read"],
    [`/projects/${QA_NEON_PROJECT_ID}`, "Neon metadata read"],
  ]) for (const status of [403, 404]) {
    const fixture = new ReadFixture();
    fixture.responses.set(path, { status, data: { error: { message: secrets[3], url: secrets[4] } } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(checked(report, name).ok, false, name);
    assert.equal(checked(report, name).reason.code, status === 403 ? "authorization-denied" : "resource-unconfirmed");
    assert.equal(checked(report, name).reason.status, status);
    assertPrivate(report); fixture.assertReadOnly();
  }
});

test("aliasの404は不在確認成功、403は未確認で返す", async () => {
  const fixture = new ReadFixture();
  fixture.responses.set(`/v4/aliases/${qaAlias("qa2")}`, { status: 403, data: { message: secrets[3] } });
  const report = await fixture.reader().inspect({ action: "preflight" });
  for (const slot of ["qa1", "qa3"]) {
    assert.equal(checked(report, `Alias ${slot}`).ok, true);
    assert.equal(checked(report, `Alias ${slot}`).reason.code, "resource-absent");
  }
  assert.equal(checked(report, "Alias qa2").ok, false);
  assert.equal(checked(report, "Alias qa2").reason.code, "authorization-denied");
  assert.equal(checked(report, "Alias qa2").reason.status, 403);
  assertPrivate(report); fixture.assertReadOnly();
});

test("Git連携種別・repo ID・production branchの不一致を成功としない", async () => {
  for (const change of ["type", "repoId", "productionBranch"] as const) {
    const fixture = new ReadFixture();
    const link: Record<string, unknown> = { ...fixture.project.link };
    if (change === "type") link.type = "gitlab";
    if (change === "repoId") link.repoId = "1318171856";
    if (change === "productionBranch") link.productionBranch = "develop";
    fixture.responses.set(`/v9/projects/${QA_PROJECT_ID}`, { status: 200, data: { ...fixture.project, link } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(checked(report, "Vercel project").ok, false, change);
    assert.equal(checked(report, "Preview enabled").ok, false, change);
    fixture.assertReadOnly();
  }
});

test("Variablesと台帳を全page読み、最後のpageの使用中leaseも見落とさない", async () => {
  const fixture = new ReadFixture(); fixture.setRecord(lease());
  const recordHistory = fixture.records;
  fixture.responses.set(`/repos/${QA_REPOSITORY}/deployments`, (url) => {
    const limit = Number(url.searchParams.get("per_page") ?? 100), page = Number(url.searchParams.get("page") ?? 1);
    const filler = Array.from({ length: limit }, (_, index) => ({ id: index + 100, task: "ordinary-vercel-task", environment: "Preview", sha, payload: { secret: secrets[3] } }));
    return { status: 200, data: page === 1 ? filler : page === 2 ? recordHistory : [] };
  });
  fixture.responses.set(`/repos/${QA_REPOSITORY}/actions/variables`, (url) => {
    const limit = Number(url.searchParams.get("per_page") ?? 30), page = Number(url.searchParams.get("page") ?? 1);
    const names = page === 1 ? Array.from({ length: limit }, (_, index) => `OTHER_${index}`) : fixture.variableNames;
    return { status: 200, data: { total_count: limit + fixture.variableNames.length, variables: page > 2 ? [] : names.map((name) => ({ name, value: secrets[3] })) } };
  });
  const report = await fixture.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
  assert.equal(checked(report, "GitHub lease ledger").ok, true);
  assert.equal(checked(report, "GitHub repository Variables read").ok, true);
  assert.equal(report.plan, null);
  assert.equal(checked(report, "Probe prerequisites").ok, false);
  for (const suffix of ["/deployments", "/actions/variables"]) assert.ok(fixture.calls.filter((call) => call.path.endsWith(suffix)).length >= 2);
  assertPrivate(report); fixture.assertReadOnly();
});

test("Native親設定と本番比較hostの不足は、認証不足と区別して返す", async () => {
  for (const [variable, name] of [["CAKE_QA_PARENT_BRANCH_ID", "Native parent configuration"], ["CAKE_QA_PRODUCTION_DATABASE_HOST", "Production comparison host configured"]]) {
    const fixture = new ReadFixture(); delete fixture.env[variable];
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(checked(report, name).ok, false);
    assert.notEqual(checked(report, name).reason.code, "missing-credential");
    assert.equal(checked(report, "Neon metadata read").ok, true);
    assertPrivate(report); fixture.assertReadOnly();
  }
});

test("plan-probeは現在OPEN headと指定slotの情報だけを返し、実行を常に無効にする", async () => {
  const fixture = new ReadFixture(), before = structuredClone(fixture.env);
  const report = await fixture.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
  assert.ok(report.plan);
  assert.equal(report.plan.action, "plan-probe");
  assert.equal(report.plan.projectId, QA_PROJECT_ID);
  assert.equal(report.plan.neonProjectId, QA_NEON_PROJECT_ID);
  assert.equal(report.plan.pr, 42);
  assert.equal(report.plan.branch, "codex/task-42");
  assert.equal(report.plan.headSha, sha);
  assert.equal(report.plan.slot, "qa2");
  assert.equal(checked(report, "Target PR").ok, true);
  assert.equal(checked(report, "Probe prerequisites").ok, true);
  assert.deepEqual(fixture.env, before);
  assert.equal(fixture.calls.some((call) => call.path === "/v7/deployments"), false);
  assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
});

test("古いSHA・closed PR・fork・別base・PR番号不一致ではprobe計画を作らない", async () => {
  for (const change of ["sha", "closed", "fork", "base", "number"] as const) {
    const fixture = new ReadFixture();
    if (change === "closed") fixture.pr.state = "closed";
    if (change === "fork") fixture.pr.head.repo.full_name = "other/Cake";
    if (change === "base") fixture.pr.base.ref = "develop";
    if (change === "number") fixture.pr.number = 43;
    const report = await fixture.reader().inspect({ action: "plan-probe", pr: 42, sha: change === "sha" ? otherSha : sha, slot: "qa2" });
    assert.equal(report.plan, null, change);
    assert.equal(checked(report, change === "sha" || change === "closed" ? "Probe prerequisites" : "Target PR").ok, false, change);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("使用中の通常leaseをprobeへ貸さず、同PRのprobe leaseは情報計画だけを返す", async () => {
  const occupied = new ReadFixture(); occupied.setRecord(lease());
  const refused = await occupied.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
  assert.equal(refused.plan, null);
  assert.equal(checked(refused, "Probe prerequisites").ok, false);
  const fixture = new ReadFixture(); fixture.setRecord({ ...application(), purpose: "probe" });
  const report = await fixture.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
  assert.ok(report.plan);
  assertDisabled(report); assertPrivate(report); occupied.assertReadOnly(); fixture.assertReadOnly();
});

test("不正payload・系列分岐・台帳SHA不一致を空台帳と扱わない", async () => {
  for (const change of ["payload", "sequence", "sha"] as const) {
    const fixture = new ReadFixture(); fixture.setRecord(application());
    if (change === "payload") fixture.records[1].payload = { ...application(), privateValue: secrets[3] };
    if (change === "sequence") fixture.records[1].payload = { ...application(), sequence: 3, previousRecordId: 1 };
    if (change === "sha") fixture.records[1].sha = otherSha;
    const report = await fixture.reader().inspect({ action: "plan-probe", pr: 42, sha, slot: "qa2" });
    assert.equal(report.plan, null, change);
    assert.equal(checked(report, "GitHub lease ledger").ok, false, change);
    assertPrivate(report); fixture.assertReadOnly();
  }
});

test("plan-releaseは全記録deployment ID・DB・aliasを厳密照合しhost無しの承認レビューを返す", async () => {
  const fixture = new ReadFixture(), record = application(); fixture.setRecord(record);
  const before = structuredClone(fixture.records);
  const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assert.equal(checked(report, "Exact release resources").ok, true);
  assertReleasePlan(report, record);
  for (const deployment of record.deployments) assert.ok(fixture.calls.some((call) => call.path === `/v13/deployments/${deployment.id}`));
  assert.deepEqual(fixture.records, before);
  assert.deepEqual(report.slots?.qa2?.database, {
    projectId: database.projectId, branchId: database.branchId, endpointId: database.endpointId,
  });
  fixture.assertReadOnly();
});

test("local GET診断はhostを返さず、Actionsはledger/Neon読取時にhostをmaskする", async () => {
  for (const actions of [false, true]) {
    const fixture = new ReadFixture(); fixture.setRecord(application());
    if (actions) fixture.env.GITHUB_ACTIONS = "true";
    const commands: string[] = [], previous = console.log;
    let report: Report;
    try {
      console.log = (message: string) => { commands.push(message); };
      report = await runQaBootstrap(["--action", "plan-release", "--pr", "42", "--lease-id", leaseId], fixture.env, fixture.request);
    } finally { console.log = previous; }
    assertReleasePlan(report!, fixture.record!);
    if (actions) {
      assert.ok(commands.includes(`::add-mask::${database.host}`));
      assert.ok(commands.includes(`::add-mask::${database.host.replace("ep-native.", "ep-native-pooler.")}`));
      for (const command of commands) {
        assert.match(command, /^::add-mask::ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/);
        for (const secret of secrets) assert.ok(!command.includes(secret));
      }
    } else assert.deepEqual(commands, []);
    fixture.assertReadOnly();
  }
});

test("更新済み・closed PRのreleaseは台帳SHAに固定し、明示SHAも台帳との一致を要求する", async () => {
  for (const state of ["open", "closed"] as const) {
    const fixture = new ReadFixture(), record = application(); fixture.setRecord(record);
    fixture.pr.state = state; fixture.pr.head.sha = otherSha;
    const current = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    assertReleasePlan(current, record);
    const savedSha = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId, sha });
    assertReleasePlan(savedSha, record);
    const newerSha = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId, sha: otherSha });
    assert.equal(newerSha.plan, null, state);
    assert.equal(checked(newerSha, "Exact release resources").ok, false);
    assert.equal(checked(newerSha, "Exact release resources").reason.code, "stale-sha");
    assertDisabled(newerSha); assertPrivate(newerSha); fixture.assertReadOnly();
  }
});

test("lease不一致・未完了intent・DB記録不足ではrelease manifestを返さない", async () => {
  for (const change of ["lease", "intent", "database"] as const) {
    const fixture = new ReadFixture();
    const record = change === "intent" ? { ...lease(), intent: { sha, phase: "provisioning" as const, attemptId, startedAt: "2026-10-12T00:01:00.000Z" } }
      : change === "database" ? { ...application(), database: undefined } : application();
    fixture.setRecord(record);
    const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId: change === "lease" ? attemptId : leaseId });
    assert.equal(report.plan, null, change);
    assert.equal(checked(report, "Exact release resources").ok, false, change);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("記録deploymentの404はmanifestにIDを残し、403は消失扱いしない", async () => {
  for (const status of [404, 403]) {
    const fixture = new ReadFixture(), record = application(); fixture.setRecord(record);
    fixture.responses.set("/v13/deployments/dpl_provisioning", { status, data: { message: secrets[3] } });
    if (status === 404) fixture.responses.set("/v7/deployments", { status: 200, data: {
      deployments: [remote(record, "dpl_application")], pagination: { next: null },
    } });
    const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    if (status === 404) assertReleasePlan(report, record);
    else {
      assert.equal(report.plan, null);
      assert.equal(checked(report, "Exact release resources").ok, false);
      assert.equal(checked(report, "Exact release resources").reason.code, "authorization-denied");
      assert.equal(checked(report, "Exact release resources").reason.status, 403);
    }
    assertPrivate(report); fixture.assertReadOnly();
  }
});

test("deployment所属・lease・SHA・phaseの不一致とProductionをrelease対象から除外する", async () => {
  for (const change of ["id", "project", "lease", "pr", "branch", "sha", "phase", "production", "missingTarget"] as const) {
    const fixture = new ReadFixture(), record = application(); fixture.setRecord(record);
    const value = remote(record, "dpl_application");
    if (change === "id") value.id = "dpl_other";
    if (change === "project") value.projectId = "prj_other";
    if (change === "lease") value.meta.cakeQaLeaseId = attemptId;
    if (change === "pr") value.meta.cakeQaPr = "43";
    if (change === "branch") { value.gitSource.ref = "codex/another"; value.meta.githubCommitRef = "codex/another"; }
    if (change === "sha") { value.gitSource.sha = otherSha; value.meta.githubCommitSha = otherSha; }
    if (change === "phase") value.meta.cakeQaPhase = "provisioning";
    if (change === "production") value.target = "production";
    if (change === "missingTarget") Reflect.deleteProperty(value, "target");
    fixture.responses.set("/v13/deployments/dpl_application", { status: 200, data: value });
    const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    assert.equal(report.plan, null, change);
    assert.equal(checked(report, "Exact release resources").ok, false, change);
    assertPrivate(report); fixture.assertReadOnly();
  }
});

test("Vercel一覧の次pageにある未記録deploymentもreleaseを停止する", async () => {
  const fixture = new ReadFixture(), record = application(); fixture.setRecord(record);
  fixture.responses.set("/v7/deployments", (url) => ({ status: 200, data: url.searchParams.has("until")
    ? { deployments: [remote(record, "dpl_unknown")], pagination: { next: null } }
    : { deployments: record.deployments.map((deployment) => remote(record, deployment.id)), pagination: { next: 12345 } } }));
  const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assert.equal(report.plan, null);
  assert.equal(checked(report, "Exact release resources").ok, false);
  assert.equal(fixture.calls.filter((call) => call.path === "/v7/deployments").length, 2);
  assertPrivate(report); fixture.assertReadOnly();
});

test("alias403・別project alias・Native identity不一致はmanifestを生成しない", async () => {
  for (const change of ["alias403", "aliasProject", "aliasDeployment", "endpoint", "branchName", "branchDefault", "branchProtected", "productionHost"] as const) {
    const fixture = new ReadFixture(); fixture.setRecord(application());
    if (change === "alias403") fixture.responses.set(`/v4/aliases/${qaAlias("qa2")}`, { status: 403, data: { message: secrets[3] } });
    if (change === "aliasProject") fixture.responses.set(`/v4/aliases/${qaAlias("qa2")}`, { status: 200, data: { projectId: "prj_other", deploymentId: "dpl_application" } });
    if (change === "aliasDeployment") fixture.responses.set(`/v4/aliases/${qaAlias("qa2")}`, { status: 200, data: { projectId: QA_PROJECT_ID, deploymentId: "dpl_other" } });
    if (change === "endpoint") {
      const endpoint = { ...nativeEndpoint(), host: "ep-other.ap-southeast-1.aws.neon.tech" };
      fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: { endpoints: [endpoint] } });
      fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints/${database.endpointId}`, { status: 200, data: { endpoint } });
    }
    if (change === "branchName" || change === "branchDefault" || change === "branchProtected") {
      const branch = { ...nativeBranch(fixture.record!), name: change === "branchName" ? "preview/codex/other" : `preview/${fixture.record!.branch}`,
        default: change === "branchDefault", protected: change === "branchProtected" };
      fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: { branches: [parent, branch], pagination: { next: null } } });
      fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches/${database.branchId}`, { status: 200, data: { branch } });
    }
    if (change === "productionHost") fixture.env.CAKE_QA_PRODUCTION_DATABASE_HOST = database.host;
    const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    assert.equal(report.plan, null, change);
    assert.equal(checked(report, "Exact release resources").ok, false, change);
    assertPrivate(report); fixture.assertReadOnly();
  }
});

test("消失済みNative DBはbranchとendpoint両IDの404で確定し、403では計画しない", async () => {
  for (const status of [404, 403]) {
    const fixture = new ReadFixture(), record = application(); fixture.setRecord(record);
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: { branches: [parent], pagination: { next: null } } });
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: { endpoints: [] } });
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches/${database.branchId}`, { status: 404, data: { message: secrets[3] } });
    fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints/${database.endpointId}`, { status, data: { message: secrets[3] } });
    const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    if (status === 404) assertReleasePlan(report, record);
    else {
      assert.equal(report.plan, null);
      assert.equal(checked(report, "Exact release resources").reason.code, "authorization-denied");
      assert.equal(checked(report, "Exact release resources").reason.status, 403);
    }
    for (const id of [database.branchId, database.endpointId]) assert.ok(fixture.calls.some((call) => call.path.endsWith(`/${id}`)));
    assertPrivate(report); fixture.assertReadOnly();
  }
});

test("probeのrelease manifestはalias nullで、固定aliasを資源に含めない", async () => {
  const fixture = new ReadFixture(), record = { ...application(), purpose: "probe" as const }; fixture.setRecord(record);
  const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assertReleasePlan(report, record);
  fixture.assertReadOnly();
});

function aliasFixture(state: "pending" | "assigned") {
  const fixture = new ReadFixture();
  const ready = { ...application(), purpose: "probe" as const, readyDeploymentId: "dpl_application" };
  fixture.setRecord(ready);
  const pending = { ...ready, sequence: 3, previousRecordId: 2,
    aliasAssignment: { alias: qaAlias(ready.slot), deploymentId: "dpl_application", sha, state: "pending" as const } };
  fixture.records.push({ id: 3, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: pending });
  fixture.record = pending;
  if (state === "assigned") {
    const assigned = { ...pending, sequence: 4, previousRecordId: 3, aliasAssignment: { ...pending.aliasAssignment, state: "assigned" as const } };
    fixture.records.push({ id: 4, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: assigned });
    fixture.record = assigned;
  }
  return fixture;
}

test("承認されたprobe aliasを削除レビューへ含め、旧alias nullへ縮めない", async () => {
  for (const present of [true, false]) {
    const fixture = aliasFixture("assigned");
    fixture.responses.set(`/v4/aliases/${qaAlias("qa2")}`, present
      ? { status: 200, data: { projectId: QA_PROJECT_ID, deploymentId: "dpl_application" } }
      : { status: 404, data: { message: secrets[3] } });
    const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    assertReleasePlan(report, fixture.record!);
    assert.equal(report.plan?.action === "plan-release" && report.plan.alias, qaAlias("qa2"));
    fixture.assertReadOnly();
  }
});

test("pending aliasのGET nullは削除レビューを確定せず、別deploymentへの割当も拒否する", async () => {
  for (const response of [{ status: 404, data: { message: secrets[3] } },
    { status: 200, data: { projectId: QA_PROJECT_ID, deploymentId: "dpl_provisioning" } }]) {
    const fixture = aliasFixture("pending");
    fixture.responses.set(`/v4/aliases/${qaAlias("qa2")}`, response);
    const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    assert.equal(report.plan, null);
    assert.equal(checked(report, "Exact release resources").reason.code, response.status === 404 ? "unresolved-alias-intent" : "identity-mismatch");
    assertPrivate(report); fixture.assertReadOnly();
  }
});

test("一覧でphaseが異なる記録は個別GET404でも消失扱いしない", async () => {
  const fixture = new ReadFixture(), record = application(); fixture.setRecord(record);
  const wrongPhase = remote(record, "dpl_application"); wrongPhase.meta.cakeQaPhase = "provisioning";
  fixture.responses.set("/v7/deployments", { status: 200, data: { deployments: [wrongPhase], pagination: { next: null } } });
  fixture.responses.set("/v13/deployments/dpl_application", { status: 404, data: { message: secrets[3] } });
  const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assert.equal(report.plan, null);
  assert.equal(checked(report, "Neon metadata read").ok, true);
  assert.equal(checked(report, "Exact release resources").ok, false);
  assert.equal(checked(report, "Exact release resources").reason.code, "identity-mismatch");
  assertPrivate(report); fixture.assertReadOnly();
});

test("一覧に存在するdeploymentの個別GET404を消失扱いしない", async () => {
  const fixture = new ReadFixture(); fixture.setRecord(application());
  fixture.responses.set("/v13/deployments/dpl_application", { status: 404, data: { message: secrets[3] } });
  const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assert.equal(report.plan, null);
  assert.equal(checked(report, "Exact release resources").ok, false);
  fixture.assertReadOnly();
});

test("Native枝の後続pageを取得してからexact identityを照合する", async () => {
  const fixture = new ReadFixture(), record = application(); fixture.setRecord(record);
  fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, (url) => ({ status: 200, data: url.searchParams.has("cursor")
    ? { branches: [nativeBranch(record)], pagination: { next: null } }
    : { branches: [parent], pagination: { next: "next-branches" } } }));
  const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assertReleasePlan(report, record);
  assert.equal(fixture.calls.filter((call) => call.path === `/projects/${QA_NEON_PROJECT_ID}/branches`).length, 2);
  assert.equal(fixture.calls.filter((call) => call.path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`).length, 1);
  fixture.assertReadOnly();
});

test("Native枝が404でも同branchの別endpointが残れば消失扱いしない", async () => {
  const fixture = new ReadFixture(); fixture.setRecord(application());
  fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: { branches: [parent], pagination: { next: null } } });
  fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: {
    endpoints: [{ ...nativeEndpoint(), id: "ep-leftover", host: "ep-leftover.ap-southeast-1.aws.neon.tech", type: "read_only" }],
  } });
  fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches/${database.branchId}`, { status: 404, data: { message: secrets[3] } });
  fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints/${database.endpointId}`, { status: 404, data: { message: secrets[3] } });
  const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assert.equal(report.plan, null);
  assert.equal(checked(report, "Neon metadata read").ok, true);
  assert.equal(checked(report, "Exact release resources").ok, false);
  assert.equal(checked(report, "Exact release resources").reason.code, "identity-mismatch");
  assertPrivate(report); fixture.assertReadOnly();
});

test("Neon endpointsの未対応paginationを完全一覧と扱わない", async () => {
  const fixture = new ReadFixture(); fixture.setRecord(application());
  fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: {
    endpoints: [nativeEndpoint()], pagination: { next: "unconfirmed-next-page" },
  } });
  const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assert.equal(report.plan, null);
  assert.equal(checked(report, "Neon metadata read").ok, false);
  assert.equal(checked(report, "Neon metadata read").reason.code, "pagination-unconfirmed");
  assert.equal(fixture.calls.filter((call) => call.path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`).length, 1);
  assertPrivate(report); fixture.assertReadOnly();
});

test("後続page403を部分的な成功や空台帳と扱わない", async () => {
  for (const kind of ["ledger", "variables", "native", "vercel"] as const) {
    const fixture = new ReadFixture(); fixture.setRecord(application());
    let name: string;
    if (kind === "ledger") {
      name = "GitHub lease ledger";
      fixture.responses.set(`/repos/${QA_REPOSITORY}/deployments`, (url) => ({ status: url.searchParams.get("page") === "1" ? 200 : 403,
        data: url.searchParams.get("page") === "1" ? Array.from({ length: 100 }, (_, index) => ({ id: index + 100, task: "ordinary", environment: "Preview", sha, payload: {} })) : { message: secrets[3] } }));
    } else if (kind === "variables") {
      name = "GitHub repository Variables read";
      fixture.responses.set(`/repos/${QA_REPOSITORY}/actions/variables`, (url) => ({ status: url.searchParams.get("page") === "1" ? 200 : 403,
        data: url.searchParams.get("page") === "1" ? { variables: Array.from({ length: 30 }, (_, index) => ({ name: `OTHER_${index}`, value: secrets[3] })) } : { message: secrets[3] } }));
    } else if (kind === "native") {
      name = "Neon metadata read";
      fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, (url) => url.searchParams.has("cursor")
        ? { status: 403, data: { message: secrets[3] } }
        : { status: 200, data: { branches: [parent], pagination: { next: "next-branches" } } });
    } else {
      name = "Exact release resources";
      fixture.responses.set("/v7/deployments", (url) => url.searchParams.has("until")
        ? { status: 403, data: { message: secrets[3] } }
        : { status: 200, data: { deployments: [], pagination: { next: 12345 } } });
    }
    const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    assert.equal(checked(report, name).ok, false, kind);
    assert.equal(checked(report, name).reason.code, "authorization-denied", kind);
    assert.equal(checked(report, name).reason.status, 403, kind);
    if (kind !== "variables") assert.equal(report.plan, null, kind);
    if (kind === "variables") assert.equal(report.missingRepositoryVariables, null);
    assertPrivate(report); fixture.assertReadOnly();
  }
});

test("不正または循環cursorを完全取得と扱わない", async () => {
  for (const provider of ["neon", "vercel"] as const) for (const cursor of ["invalid", "repeated"] as const) {
    const fixture = new ReadFixture(); fixture.setRecord(application());
    const path = provider === "neon" ? `/projects/${QA_NEON_PROJECT_ID}/branches` : "/v7/deployments";
    fixture.responses.set(path, { status: 200, data: provider === "neon"
      ? { branches: [parent], pagination: { next: cursor === "invalid" ? 12345 : "repeat" } }
      : { deployments: [], pagination: { next: cursor === "invalid" ? "12345" : 12345 } } });
    const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
    const name = provider === "neon" ? "Neon metadata read" : "Exact release resources";
    assert.equal(report.plan, null, `${provider}:${cursor}`);
    assert.equal(checked(report, name).ok, false);
    assert.equal(checked(report, name).reason.code, "pagination-unconfirmed");
    assert.ok(fixture.calls.filter((call) => call.path === path).length <= 2);
    assertPrivate(report); fixture.assertReadOnly();
  }
});

test("既知のNative identityの返却計画は生成時だけ必要な設定なしでも情報manifestを返す", async () => {
  const fixture = new ReadFixture(), record = application(); fixture.setRecord(record);
  delete fixture.env.CAKE_QA_PARENT_BRANCH_ID; delete fixture.env.CAKE_QA_PRODUCTION_DATABASE_HOST;
  const report = await fixture.reader().inspect({ action: "plan-release", pr: 42, leaseId });
  assert.equal(checked(report, "Native parent configuration").ok, false);
  assert.equal(checked(report, "Production comparison host configured").ok, false);
  assertReleasePlan(report, record);
  fixture.assertReadOnly();
});

test("Hobbyのpolicy未設定や未知のpolicy項目を代替ゲートにせず、Git設定の証跡だけを返す", async () => {
  for (const deploymentPolicy of [undefined, {}, { deploymentSources: [{ enabled: true, sources: ["git", secrets[3]] }] }]) {
    const fixture = new ReadFixture();
    fixture.responses.set(`/v9/projects/${QA_PROJECT_ID}`, { status: 200, data: { ...fixture.project, deploymentPolicy } });
    const report = await fixture.reader().inspect({ action: "preflight" });
    assert.equal(checked(report, "Preview enabled").ok, true);
    assert.equal(checked(report, "Main Git configuration").ok, true);
    assert.deepEqual(report.gitConfiguration, {
      scope: "repository-git-trigger-configuration", backendForcedDeploymentPreventionProven: false,
      main: { branch: "main", commitSha: otherSha, blobSha: gitFile().sha }, target: null,
    });
    assert.equal(Object.hasOwn(report, "sourcePolicy"), false);
    assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
  }
});

test("正確な承認と有効化flagがあってもGET guardはmutationをtransport前に拒否する", async () => {
  const fixture = new ReadFixture();
  Object.assign(fixture.env, {
    CAKE_QA_POOL_ENABLED: "true", CAKE_QA_GIT_GATE_CONFIRMED: "true", CAKE_QA_NATIVE_CONFIRMED: "true",
    CAKE_QA_DELETE_APPROVALS: JSON.stringify([{ ...application(), expiresAt: "2099-01-01T00:00:00.000Z" }]),
  });
  const reader = fixture.reader();
  // Exercise the final guard directly: even runtime access cannot bypass it.
  const api = Reflect.get(reader, "api") as (provider: string, path: string, method: string) => Promise<unknown>;
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) await assert.rejects(() => api.call(reader, "vercel", "/v13/deployments/dpl_application", method));
  assert.equal(fixture.calls.length, 0);
});

test("ledger parserとreplayは秘密を含む未知payload・分岐・ID共有を拒否する", () => {
  assert.deepEqual(parseLeaseRecord(JSON.stringify(lease())), lease());
  assert.throws(() => parseLeaseRecord({ ...lease(), databaseUrl: secrets[4] }));
  assert.throws(() => parseLeaseRecord({ ...application(), deployments: [...application().deployments, application().deployments[0]] }));
  const valid = history(application());
  assert.deepEqual(replayDeployments([...valid].reverse()).qa2?.payload.database, database);
  assert.throws(() => replayDeployments([valid[0], { ...valid[1], payload: { ...application(), sequence: 3, previousRecordId: 1 } }]));
  assert.throws(() => replayDeployments([valid[0], { ...valid[1], sha: otherSha }]));
  const otherLease = { ...lease(), slot: "qa3" as const, pr: 43, branch: "codex/task-43", leaseId: attemptId };
  assert.throws(() => replayDeployments([
    ...valid,
    { id: 3, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: otherLease },
    { id: 4, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: { ...otherLease, sequence: 2, previousRecordId: 3, deployments: [application().deployments[0]] } },
  ]));
});

test("CLIは未知・重複・欠落引数と不正PR・SHA・slot・leaseをAPI前に拒否する", async () => {
  let requests = 0;
  const transport: QaBootstrapTransport = async () => { requests++; return { status: 200, data: {} }; };
  for (const args of [
    ["--unknown", secrets[3]], ["--action"], ["--action", "preflight", "--action", "preflight"], ["--action", "probe"],
    ["--pr", "0"], ["--pr", "42.5"], ["--pr", "NaN"], ["--sha", sha.slice(0, 7)], ["--slot", "qa4"], ["--lease-id", "*"],
    ["--action", "plan-probe"], ["--action", "plan-probe", "--pr", "42", "--slot", "qa2"],
    ["--action", "plan-probe", "--pr", "42", "--sha", sha], ["--action", "plan-release", "--pr", "42"],
    ["--action", "plan-release", "--lease-id", leaseId],
  ]) await assert.rejects(() => runQaBootstrap(args, environment(), transport), (error) => { assertPrivate(String(error)); return true; });
  assert.equal(requests, 0);
});

test("QA_BOOTSTRAP環境入力もAPI前に検証し、旧writer環境変数はactionに使わない", async () => {
  let requests = 0;
  const transport: QaBootstrapTransport = async () => { requests++; return { status: 200, data: {} }; };
  for (const values of [
    { QA_BOOTSTRAP_ACTION: "probe" }, { QA_BOOTSTRAP_PR_NUMBER: "0" }, { QA_BOOTSTRAP_PR_NUMBER: "42.5" },
    { QA_BOOTSTRAP_SOURCE_SHA: sha.slice(0, 7) }, { QA_BOOTSTRAP_SLOT: "qa4" }, { QA_BOOTSTRAP_LEASE_ID: "*" },
    { QA_BOOTSTRAP_ACTION: "plan-probe", QA_BOOTSTRAP_PR_NUMBER: "42", QA_BOOTSTRAP_SLOT: "qa2" },
    { QA_BOOTSTRAP_ACTION: "plan-release", QA_BOOTSTRAP_PR_NUMBER: "42" },
  ]) await assert.rejects(() => runQaBootstrap([], { ...environment(), ...values }, transport));
  assert.equal(requests, 0);
  const fixture = new ReadFixture(); fixture.env.QA_ACTION = "probe";
  const report = await runQaBootstrap([], fixture.env, fixture.request);
  assert.equal(report.plan, null);
  assertDisabled(report); fixture.assertReadOnly();
});

test("CLIとQA_BOOTSTRAP環境入力は注入GET transportで全read-only actionを実行する", async () => {
  for (const action of ["preflight", "plan-probe", "plan-release"] as const) {
    for (const mode of ["arguments", "environment"] as const) {
      const fixture = new ReadFixture(); if (action === "plan-release") fixture.setRecord(application());
      const args = mode === "environment" || action === "preflight" ? [] : action === "plan-probe"
        ? ["--action", action, "--pr", "42", "--sha", sha, "--slot", "qa2"]
        : ["--action", action, "--pr", "42", "--lease-id", leaseId];
      if (mode === "environment") Object.assign(fixture.env, {
        QA_BOOTSTRAP_ACTION: action, QA_BOOTSTRAP_PR_NUMBER: "42", QA_BOOTSTRAP_SOURCE_SHA: sha,
        QA_BOOTSTRAP_SLOT: "qa2", QA_BOOTSTRAP_LEASE_ID: leaseId,
      });
      const report = await runQaBootstrap(args, fixture.env, fixture.request);
      if (action === "preflight") assert.equal(report.plan, null);
      else assert.equal(report.plan?.action, action, `${mode}: ${action}`);
      assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
    }
  }
});

test("CLIはGH_TOKENをfallbackとして使い、資格情報はreportへ返さない", async () => {
  const fixture = new ReadFixture(); delete fixture.env.GITHUB_TOKEN; fixture.env.GH_TOKEN = secrets[0];
  const report = await runQaBootstrap([], fixture.env, fixture.request);
  assert.equal(checked(report, "GitHub lease ledger").ok, true);
  assert.ok(fixture.calls.filter((call) => call.hostname === "api.github.com").every((call) => call.token === secrets[0]));
  assertPrivate(report); fixture.assertReadOnly();
});

test("workflowの空optional環境入力はpreflightで未指定として扱う", async () => {
  const fixture = new ReadFixture();
  Object.assign(fixture.env, {
    QA_BOOTSTRAP_ACTION: "preflight", QA_BOOTSTRAP_PR_NUMBER: "", QA_BOOTSTRAP_SOURCE_SHA: "",
    QA_BOOTSTRAP_SLOT: "", QA_BOOTSTRAP_LEASE_ID: "",
  });
  const report = await runQaBootstrap([], fixture.env, fixture.request);
  assert.equal(report.plan, null);
  assert.equal(fixture.calls.some((call) => call.path.includes("/pulls/")), false);
  assertDisabled(report); assertPrivate(report); fixture.assertReadOnly();
});

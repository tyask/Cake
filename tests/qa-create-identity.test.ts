import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HttpQaGateway, type QaTransport } from "../scripts/qa-pool-writer";
import {
  QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK,
  parseLeaseRecord, replayDeployments, type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord,
} from "../lib/qa-pool";

const sha = "a".repeat(40), mainSha = "b".repeat(40), newerSha = "c".repeat(40);
const leaseId = "00000000-0000-4000-8000-000000000042";
const attemptId = "00000000-0000-4000-8000-000000000900";
const createdAt = "2026-10-13T00:00:00.000Z";
const secrets = ["create-fixture-github", "create-fixture-vercel", "create-fixture-neon", "create-fixture-response"];
const database: DatabaseIdentity = {
  projectId: QA_NEON_PROJECT_ID, branchId: "br-native", endpointId: "ep-native",
  host: "ep-native.ap-southeast-1.aws.neon.tech",
};
type Response = { status: number; data: unknown };
type Phase = "provisioning" | "application";
type Purpose = "probe" | "normal";
function gitFile(): Response {
  const bytes = Buffer.from(JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true } } }));
  return { status: 200, data: {
    type: "file", name: "vercel.json", path: "vercel.json", encoding: "base64", size: bytes.length,
    content: bytes.toString("base64"), sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
  } };
}
function claim(purpose: Purpose): QaLeaseRecord {
  return {
    protocol: "cake-qa/v1", slot: "qa2", leaseId, pr: 42, branch: "codex/task-42", headSha: sha,
    state: "held", createdAt, updatedAt: createdAt, sequence: 1, previousRecordId: null,
    deployments: [], retiredDatabases: [], ...(purpose === "probe" ? { purpose } : {}),
  };
}
function deployment(record: QaLeaseRecord, id: number): GithubDeployment {
  return { id, task: QA_TASK, environment: QA_ENVIRONMENT, sha: record.headSha, payload: structuredClone(record) };
}
class CreateFixture {
  env: Record<string, string | undefined> = {
    GITHUB_TOKEN: secrets[0], VERCEL_TOKEN: secrets[1], NEON_API_KEY: secrets[2],
    CAKE_QA_POOL_ENABLED: "false", CAKE_QA_GIT_GATE_CONFIRMED: "false", CAKE_QA_NATIVE_CONFIRMED: "false",
    CAKE_QA_APPROVED_HEADS: "{}", CAKE_QA_PARENT_BRANCH_ID: "br-parent",
    CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.ap-southeast-1.aws.neon.tech",
    CAKE_QA_PROBE_APPROVALS: JSON.stringify([{ projectId: QA_PROJECT_ID, pr: 42, sha, slot: "qa2", expiresAt: "2099-01-01T00:00:00.000Z" }]),
  };
  project = { id: QA_PROJECT_ID, name: "cake", accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub", previewDeploymentsDisabled: false,
    link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main", repoId: 1318171856 } };
  pr = { number: 42, state: "open", head: { ref: "codex/task-42", sha, repo: { full_name: QA_REPOSITORY } },
    base: { ref: "main", repo: { full_name: QA_REPOSITORY } } };
  branch = { id: database.branchId, project_id: QA_NEON_PROJECT_ID, name: "preview/codex/task-42", parent_id: "br-parent",
    default: false, protected: false, created_at: "2026-10-13T00:01:00.000Z" };
  endpoint = { id: database.endpointId, project_id: QA_NEON_PROJECT_ID, branch_id: database.branchId, host: database.host, type: "read_write" };
  record: QaLeaseRecord;
  records: GithubDeployment[];
  calls: { method: string; path: string; ref: string | null; body?: unknown }[] = [];
  responses = new Map<string, Response | Error>();
  afterExactNeonRead?: (path: string) => void;
  afterPrRead?: (count: number) => void;
  prReads = 0;
  constructor(readonly phase: Phase = "application", purpose: Purpose = "probe") {
    const first = claim(purpose);
    const withDatabase: QaLeaseRecord = { ...first, sequence: 2, previousRecordId: 1, database,
      deployments: [{ id: "dpl_provisioning", sha, phase: "provisioning" }] };
    const previous = phase === "application" ? withDatabase : first;
    this.record = parseLeaseRecord({ ...previous, sequence: previous.sequence + 1, previousRecordId: previous.sequence,
      intent: { sha, phase, attemptId, startedAt: "2026-10-13T00:02:00.000Z" } });
    this.records = [deployment(first, 1), ...(phase === "application" ? [deployment(withDatabase, 2)] : []), deployment(this.record, this.record.sequence)];
    assert.deepEqual(replayDeployments(this.records).qa2?.payload, this.record, "fixture must have a complete valid history");
    if (purpose === "normal") {
      for (const flag of ["CAKE_QA_POOL_ENABLED", "CAKE_QA_GIT_GATE_CONFIRMED", "CAKE_QA_NATIVE_CONFIRMED"]) this.env[flag] = "true";
      this.env.CAKE_QA_APPROVED_HEADS = JSON.stringify({ "42": sha });
    }
  }
  request: QaTransport = async (method, address, _token, body) => {
    const url = new URL(address), path = url.pathname.replace(/^\/api\/v2(?=\/)/, "");
    this.calls.push({ method, path, ref: url.searchParams.get("ref"), body });
    const override = this.responses.get(path);
    if (override instanceof Error) throw override;
    if (override) return structuredClone(override);
    if (method === "GET") {
      if (path === `/v9/projects/${QA_PROJECT_ID}`) return { status: 200, data: structuredClone(this.project) };
      if (path === `/projects/${QA_NEON_PROJECT_ID}`) return { status: 200, data: { project: { id: QA_NEON_PROJECT_ID } } };
      if (path === `/repos/${QA_REPOSITORY}/branches/main`) return { status: 200, data: { name: "main", commit: { sha: mainSha } } };
      if (path === `/repos/${QA_REPOSITORY}/contents/vercel.json`) {
        assert.ok([mainSha, sha].includes(url.searchParams.get("ref")!), "Git configuration must use an exact approved SHA");
        return gitFile();
      }
      if (path === `/repos/${QA_REPOSITORY}/pulls/42`) {
        const response = { status: 200, data: structuredClone(this.pr) };
        this.prReads++;
        this.afterPrRead?.(this.prReads);
        return response;
      }
      if (path === `/repos/${QA_REPOSITORY}/deployments`) return { status: 200, data: structuredClone(this.records) };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/branches`) return { status: 200, data: { branches: [structuredClone(this.branch)], pagination: { next: null } } };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`) return { status: 200, data: { endpoints: [structuredClone(this.endpoint)] } };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/branches/${database.branchId}`) {
        const response = { status: 200, data: { branch: structuredClone(this.branch) } };
        this.afterExactNeonRead?.(path); return response;
      }
      if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints/${database.endpointId}`) {
        const response = { status: 200, data: { endpoint: structuredClone(this.endpoint) } };
        this.afterExactNeonRead?.(path); return response;
      }
    }
    if (method === "POST" && path === "/v13/deployments") {
      const value = body as { gitSource: { ref: string; sha: string }; meta: Record<string, string> };
      return { status: 201, data: { id: "dpl_new", projectId: QA_PROJECT_ID, target: null, readyState: "BUILDING",
        gitSource: value.gitSource, meta: { ...value.meta, githubCommitRef: value.gitSource.ref, githubCommitSha: value.gitSource.sha } } };
    }
    assert.fail(`unexpected fixture request ${method} ${path}`);
  };
  gateway() { return new HttpQaGateway(this.env, this.request, "write"); }
  posts() { return this.calls.filter((call) => call.method === "POST"); }
  changeLedger(changes: Partial<QaLeaseRecord> = {}) {
    const latest = replayDeployments(this.records).qa2!;
    const next = parseLeaseRecord({ ...latest.payload, ...changes, sequence: latest.payload.sequence + 1,
      previousRecordId: latest.id, updatedAt: "2026-10-13T00:03:00.000Z" });
    this.records.push(deployment(next, latest.id + 1));
    replayDeployments(this.records);
  }
  async assertBlocked() {
    const before = structuredClone(this.record);
    await assert.rejects(() => this.gateway().create(this.record), (error) => {
      const output = `${String(error)} ${JSON.stringify(error)}`;
      for (const privateValue of [...secrets, database.host, this.env.CAKE_QA_PRODUCTION_DATABASE_HOST!]) assert.equal(output.includes(privateValue), false);
      return true;
    });
    assert.equal(this.posts().length, 0, "identity or ownership uncertainty must stop before any POST");
    assert.deepEqual(this.record, before);
  }
}

test("保存済みDBを持つapplication作成はexact IDと一覧を照合し、直前に台帳とOPEN PRを再読込する", async () => {
  const fixture = new CreateFixture(), before = structuredClone(fixture.records);
  const result = await fixture.gateway().create(fixture.record);
  assert.equal(result.id, "dpl_new");
  assert.equal(result.phase, "application");
  assert.equal(fixture.posts().length, 1);
  assert.equal(fixture.posts()[0].path, "/v13/deployments");
  assert.equal(fixture.calls[0].path, `/v9/projects/${QA_PROJECT_ID}`);
  for (const path of [`/projects/${QA_NEON_PROJECT_ID}/branches/${database.branchId}`, `/projects/${QA_NEON_PROJECT_ID}/endpoints/${database.endpointId}`,
    `/projects/${QA_NEON_PROJECT_ID}/branches`, `/projects/${QA_NEON_PROJECT_ID}/endpoints`]) assert.ok(fixture.calls.some((call) => call.method === "GET" && call.path === path), path);
  const postIndex = fixture.calls.findIndex((call) => call.method === "POST");
  assert.equal(fixture.calls[postIndex - 1].path, `/repos/${QA_REPOSITORY}/pulls/42`);
  assert.equal(fixture.calls[postIndex - 2].path, `/repos/${QA_REPOSITORY}/deployments`);
  assert.ok(fixture.prReads >= 2);
  assert.deepEqual(fixture.records, before);
});

test("初回provisioningはexact DB GETを行わず、最新台帳・PR確認後に1回だけPOSTする", async () => {
  const fixture = new CreateFixture("provisioning");
  const result = await fixture.gateway().create(fixture.record);
  assert.equal(result.phase, "provisioning");
  assert.equal(fixture.posts().length, 1);
  assert.equal(fixture.calls.some((call) => /\/branches\/br-|\/endpoints\/ep-/.test(call.path)), false);
  assert.ok(fixture.calls.some((call) => call.path === `/repos/${QA_REPOSITORY}/deployments`));
  assert.ok(fixture.prReads >= 2);
});

test("Git gateの不一致はNative exact照合より先に停止する", async () => {
  const fixture = new CreateFixture(); fixture.project.previewDeploymentsDisabled = true;
  await fixture.assertBlocked();
  assert.equal(fixture.calls.some((call) => call.path.includes(`/branches/${database.branchId}`) || call.path.includes(`/endpoints/${database.endpointId}`)), false);
});

test("保存済みNative branch・endpointのexact GET404/403/transport failureはPOSTしない", async () => {
  for (const resource of ["branch", "endpoint"] as const) for (const status of [404, 403, "transport"] as const) {
    const fixture = new CreateFixture();
    const path = resource === "branch" ? `/projects/${QA_NEON_PROJECT_ID}/branches/${database.branchId}` : `/projects/${QA_NEON_PROJECT_ID}/endpoints/${database.endpointId}`;
    fixture.responses.set(path, status === "transport" ? new Error(secrets[3]) : { status, data: { message: secrets[3] } });
    await fixture.assertBlocked();
  }
});

test("Native branchのID・project・名前・親・default/protected・作成時刻の不一致はPOSTしない", async () => {
  for (const change of ["id", "project", "name", "parent", "default", "protected", "old", "invalidTime"] as const) {
    const fixture = new CreateFixture();
    if (change === "id") fixture.branch.id = "br-other";
    if (change === "project") fixture.branch.project_id = "other-project";
    if (change === "name") fixture.branch.name = "preview/codex/other";
    if (change === "parent") fixture.branch.parent_id = "br-other";
    if (change === "default") fixture.branch.default = true;
    if (change === "protected") fixture.branch.protected = true;
    if (change === "old") fixture.branch.created_at = "2026-10-12T23:59:59.000Z";
    if (change === "invalidTime") fixture.branch.created_at = secrets[3];
    await fixture.assertBlocked();
  }
});

test("Native endpointのID・project・branch・type・host不一致とProduction identityはPOSTしない", async () => {
  for (const change of ["id", "project", "branch", "type", "host", "production"] as const) {
    const fixture = new CreateFixture();
    if (change === "id") fixture.endpoint.id = "ep-other";
    if (change === "project") fixture.endpoint.project_id = "other-project";
    if (change === "branch") fixture.endpoint.branch_id = "br-other";
    if (change === "type") fixture.endpoint.type = "read_only";
    if (change === "host") fixture.endpoint.host = "ep-other.ap-southeast-1.aws.neon.tech";
    if (change === "production") fixture.env.CAKE_QA_PRODUCTION_DATABASE_HOST = database.host;
    await fixture.assertBlocked();
  }
});

test("pooled hostは正規化して保存済みNative identityへ一致させる", async () => {
  const fixture = new CreateFixture(); fixture.endpoint.host = database.host.replace("ep-native.", "ep-native-pooler.");
  await fixture.gateway().create(fixture.record);
  assert.equal(fixture.posts().length, 1);
});

test("exact GETと全一覧の不一致・重複・複数writable endpointはPOSTしない", async () => {
  for (const change of ["missingBranch", "missingEndpoint", "branchMismatch", "endpointMismatch", "duplicateBranch", "duplicateEndpoint", "secondWritable"] as const) {
    const fixture = new CreateFixture();
    if (["missingBranch", "branchMismatch", "duplicateBranch"].includes(change)) fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/branches`, { status: 200, data: {
      branches: change === "missingBranch" ? [] : change === "branchMismatch" ? [{ ...fixture.branch, parent_id: "br-other" }] : [fixture.branch, fixture.branch], pagination: { next: null },
    } });
    else fixture.responses.set(`/projects/${QA_NEON_PROJECT_ID}/endpoints`, { status: 200, data: {
      endpoints: change === "missingEndpoint" ? [] : change === "endpointMismatch" ? [{ ...fixture.endpoint, host: "ep-other.ap-southeast-1.aws.neon.tech" }]
        : change === "duplicateEndpoint" ? [fixture.endpoint, fixture.endpoint]
          : [fixture.endpoint, { ...fixture.endpoint, id: "ep-second", host: "ep-second.ap-southeast-1.aws.neon.tech" }],
    } });
    await fixture.assertBlocked();
  }
});

test("保存済みDBがretired identityと重なる場合は再作成POSTしない", async () => {
  const fixture = new CreateFixture();
  fixture.record = parseLeaseRecord({ ...fixture.record, retiredDatabases: [database] });
  fixture.records[fixture.records.length - 1].payload = structuredClone(fixture.record);
  await fixture.assertBlocked();
});

test("DB有無とintent phaseが逆の作成はPOSTしない", async () => {
  for (const phase of ["provisioning", "application"] as const) {
    const fixture = new CreateFixture(phase);
    fixture.record = parseLeaseRecord({ ...fixture.record, intent: { ...fixture.record.intent!, phase: phase === "application" ? "provisioning" : "application" } });
    fixture.records[fixture.records.length - 1].payload = structuredClone(fixture.record);
    await fixture.assertBlocked();
  }
});

test("Native exact GET後の台帳更新を再照合し、旧intentのPOSTを止める", async () => {
  const fixture = new CreateFixture();
  let changed = false;
  fixture.afterExactNeonRead = () => { if (!changed) { changed = true; fixture.changeLedger(); } };
  await fixture.assertBlocked();
  assert.equal(changed, true);
});

test("Native exact GET後のPR close・新SHA・別repo/base/refを直前に再確認する", async () => {
  for (const change of ["closed", "sha", "repository", "base", "branch"] as const) {
    const fixture = new CreateFixture();
    fixture.afterExactNeonRead = () => {
      if (change === "closed") fixture.pr.state = "closed";
      if (change === "sha") fixture.pr.head.sha = newerSha;
      if (change === "repository") fixture.pr.head.repo.full_name = "other/Cake";
      if (change === "base") fixture.pr.base.ref = "develop";
      if (change === "branch") fixture.pr.head.ref = "codex/other";
    };
    await fixture.assertBlocked();
    assert.ok(fixture.prReads >= 2);
  }
});

test("最後のPR読取中にprobe承認slotが変わればPOSTしない", async () => {
  const fixture = new CreateFixture();
  fixture.afterPrRead = (count) => { if (count >= 2) fixture.env.CAKE_QA_PROBE_APPROVALS = JSON.stringify([
    { projectId: QA_PROJECT_ID, pr: 42, sha, slot: "qa3", expiresAt: "2099-01-01T00:00:00.000Z" },
  ]); };
  await fixture.assertBlocked();
  assert.ok(fixture.prReads >= 2);
});

test("通常生成は保存済みDBと最新台帳・現在SHA承認を確認して1回だけPOSTする", async () => {
  const fixture = new CreateFixture("application", "normal");
  await fixture.gateway().create(fixture.record);
  assert.equal(fixture.posts().length, 1);
  assert.ok(fixture.prReads >= 2);
});

test("通常生成の最終PR読取中にpool有効化または現在SHA承認が失われればPOSTしない", async () => {
  for (const change of ["enabled", "approval"] as const) {
    const fixture = new CreateFixture("application", "normal");
    fixture.afterPrRead = (count) => {
      if (count < 2) return;
      if (change === "enabled") fixture.env.CAKE_QA_POOL_ENABLED = "false";
      else fixture.env.CAKE_QA_APPROVED_HEADS = "{}";
    };
    await fixture.assertBlocked();
    assert.ok(fixture.prReads >= 2);
  }
});

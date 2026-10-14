import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HttpQaGateway, type QaTransport } from "../scripts/qa-pool-writer";
import { contextualQaFailure, QaDiagnosticFailure, qaDiagnosticFields, qaFailureAnnotation } from "../lib/qa-diagnostics";
import { deletePlan } from "../lib/qa-pool-authorization";
import { nextRecord, QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK, qaAlias,
  type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord } from "../lib/qa-pool";

const sha = "a".repeat(40), leaseId = "00000000-0000-4000-8000-000000000037";
const aliasUid = "alias_fixture";
const host = "ep-diagnostics.us-east-1.aws.neon.tech";
const privateSentinel = "DO_NOT_PRINT_PROVIDER_PAYLOAD";
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-diagnostics", endpointId: "ep-diagnostics", host };
const timestamp = "2026-10-13T00:00:00.000Z";
const expiresAt = () => new Date(Date.now() + 3_600_000).toISOString();

test("PR一覧のGET失敗もREAD_PRとして分類しprovider bodyを出さない", async () => {
  const gateway = new HttpQaGateway({ GITHUB_TOKEN: "SENTINEL_GITHUB_TOKEN" }, async (method, address, _token, body) => {
    assert.equal(method, "GET");
    assert.equal(body, undefined);
    assert.equal(new URL(address).pathname, `/repos/${QA_REPOSITORY}/pulls`);
    return { status: 403, data: { message: privateSentinel, token: "SENTINEL_GITHUB_TOKEN" } };
  });
  await assert.rejects(() => gateway.openPullRequests(), (error: unknown) => {
    assert.deepEqual(qaDiagnosticFields(error), { stage: "READ_PR", provider: "GITHUB", method: "GET", status: 403, reason: "HTTP_ERROR" });
    assertPrivate(qaFailureAnnotation(error));
    return true;
  });
});

function fixture() {
  const initial: QaLeaseRecord = { protocol: "cake-qa/v1", slot: "qa1", pr: 37, leaseId, branch: "codex/diagnostics", headSha: sha,
    state: "held", purpose: "probe", createdAt: timestamp, updatedAt: timestamp, sequence: 1, previousRecordId: null,
    deployments: [], retiredDatabases: [] };
  const records: GithubDeployment[] = [{ id: 1, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: initial }];
  const ready = nextRecord({ id: 1, payload: initial }, { database, readyDeploymentId: "dpl_application",
    deployments: [{ id: "dpl_provisioning", phase: "provisioning", sha }, { id: "dpl_application", phase: "application", sha }] }, timestamp);
  records.push({ id: 2, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: ready });
  const pending = nextRecord({ id: 2, payload: ready }, { aliasAssignment: {
    alias: qaAlias("qa1"), deploymentId: "dpl_application", sha, state: "pending" } }, timestamp);
  records.push({ id: 3, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: pending });
  const assigned = nextRecord({ id: 3, payload: pending }, { aliasAssignment: { ...pending.aliasAssignment!, state: "assigned" } }, timestamp);
  records.push({ id: 4, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: assigned });
  const record = nextRecord({ id: 4, payload: assigned }, { state: "deleting", readyDeploymentId: undefined }, timestamp);
  records.push({ id: 5, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: record });
  const env: Record<string, string | undefined> = { GITHUB_TOKEN: "SENTINEL_GITHUB_TOKEN", VERCEL_TOKEN: "SENTINEL_VERCEL_TOKEN",
    NEON_API_KEY: "SENTINEL_NEON_API_KEY", CAKE_QA_APPROVED_HEADS: "{}", CAKE_QA_PARENT_BRANCH_ID: "br-parent",
    CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.us-east-1.aws.neon.tech",
    CAKE_QA_DELETE_APPROVALS: JSON.stringify([{ ...deletePlan(record), expiresAt: expiresAt() }]) };
  const calls: { method: string; path: string }[] = [];
  const request: QaTransport = async (method, address, _token, body) => {
    const path = new URL(address).pathname.replace(/^\/api\/v2(?=\/)/, "");
    calls.push({ method, path });
    assert.equal(method, "GET", "read-only plan must not call a mutation transport");
    assert.equal(body, undefined);
    if (path === `/v9/projects/${QA_PROJECT_ID}`) return { status: 200, data: { id: QA_PROJECT_ID, name: "cake",
      accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub", previewDeploymentsDisabled: false,
      link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main", repoId: 1318171856 } } };
    if (path === `/repos/${QA_REPOSITORY}/deployments`) return { status: 200, data: structuredClone(records) };
    if (path === `/repos/${QA_REPOSITORY}/actions/variables`) return { status: 200, data: { variables: [] } };
    if (path === `/repos/${QA_REPOSITORY}/pulls/37`) return { status: 200, data: { number: 37, state: "closed",
      head: { sha, ref: record.branch, repo: { full_name: QA_REPOSITORY } }, base: { ref: "main" } } };
    if (path === `/projects/${QA_NEON_PROJECT_ID}`) return { status: 200, data: { project: { id: QA_NEON_PROJECT_ID } } };
    const parent = { id: "br-parent", project_id: QA_NEON_PROJECT_ID, name: "parent", default: false, protected: true };
    if (path === `/projects/${QA_NEON_PROJECT_ID}/branches/br-parent`) return { status: 200, data: { branch: parent } };
    if (path === `/projects/${QA_NEON_PROJECT_ID}/branches`) return { status: 200, data: { branches: [parent,
      { id: database.branchId, project_id: QA_NEON_PROJECT_ID, name: `preview/${record.branch}`, parent_id: "br-parent",
        default: false, protected: false, created_at: timestamp }], pagination: { next: null } } };
    if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`) return { status: 200, data: { endpoints: [
      { id: database.endpointId, project_id: QA_NEON_PROJECT_ID, branch_id: database.branchId, type: "read_write", host }] } };
    if (path.startsWith("/v4/aliases/")) return [qaAlias("qa1"), aliasUid].some((id) => path === `/v4/aliases/${id}`)
      ? { status: 200, data: { uid: aliasUid, alias: qaAlias("qa1"), projectId: QA_PROJECT_ID, deploymentId: "dpl_application" } }
      : { status: 404, data: { message: privateSentinel } };
    const remote = (id: string) => ({ id, projectId: QA_PROJECT_ID, target: "preview", state: "READY",
      gitSource: { ref: record.branch, sha }, meta: { githubCommitRef: record.branch, githubCommitSha: sha,
        cakeQaPhase: id === "dpl_application" ? "application" : "provisioning", cakeQaLeaseId: leaseId, cakeQaPr: "37",
        cakeQaAttemptId: "00000000-0000-4000-8000-000000000900" } });
    if (path === "/v7/deployments") return { status: 200, data: { deployments: record.deployments.map((d) => remote(d.id)), pagination: { next: null } } };
    if (path.startsWith("/v13/deployments/")) return { status: 200, data: remote(path.split("/").at(-1)!) };
    assert.fail("unexpected fixture route");
  };
  return { record, records, env, calls, request };
}
function assertPrivate(output: unknown) {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  for (const value of [host, privateSentinel, "SENTINEL_GITHUB_TOKEN", "SENTINEL_VERCEL_TOKEN", "SENTINEL_NEON_API_KEY", "postgresql://"]) {
    assert.ok(!text.includes(value));
  }
}

test("plan-releaseは完全private planで承認を診断し、JSONへは判定だけを追加する", async () => {
  for (const mode of ["valid", "mismatch", "malformed", "not-array"] as const) {
    const f = fixture(), before = structuredClone(f.records);
    if (mode === "mismatch") f.env.CAKE_QA_DELETE_APPROVALS = JSON.stringify([{ ...deletePlan(f.record), leaseId: "00000000-0000-4000-8000-000000000038", expiresAt: expiresAt() }]);
    if (mode === "malformed") f.env.CAKE_QA_DELETE_APPROVALS = `{${privateSentinel}`;
    if (mode === "not-array") f.env.CAKE_QA_DELETE_APPROVALS = "{}";
    const report = await new HttpQaGateway(f.env, f.request).inspect({ action: "plan-release", pr: 37, leaseId });
    assert.ok(report.plan);
    assert.ok(report.checks.every((check) => check.ok), "the successful GET fixture must confirm all reads");
    assert.equal(report.readOnly, true);
    assert.equal(report.deleteApproval?.decision, mode === "valid" ? "ALLOWED" : mode === "mismatch" ? "DENIED" : "VALIDATION_ERROR");
    assert.equal(report.deleteApproval?.matches, mode === "valid" ? true : mode === "mismatch" ? false : null);
    assert.equal(report.deleteApproval?.valid, mode === "valid" || mode === "mismatch");
    assert.equal(f.calls.filter((c) => c.method !== "GET").length, 0);
    assert.deepEqual(f.records, before);
    assertPrivate(report);
  }
});

test("読取403はcheckに固定分類を追加し、opaque provider本文を保持しない", async () => {
  const f = fixture();
  const transport: QaTransport = async (method, url, token, body) => new URL(url).pathname.startsWith("/v9/projects/")
    ? { status: 403, data: { message: privateSentinel, url: `https://provider.invalid/${privateSentinel}` } }
    : f.request(method, url, token, body);
  const report = await new HttpQaGateway(f.env, transport).inspect({ action: "plan-release", pr: 37, leaseId });
  assert.deepEqual(report.checks.find((c) => c.name === "Vercel project")?.failure,
    { stage: "READ_PROJECT", provider: "VERCEL", method: "GET", status: 403, reason: "HTTP_ERROR" });
  assertPrivate(report);
});

test("DELETE_ALIASの403・transport failureを固定annotationへ変換する", async () => {
  for (const failure of ["http", "transport"] as const) {
    const f = fixture(); let deleteCalls = 0;
    const mock: QaTransport = async (method, url, token, body) => {
      const address = new URL(url);
      if (method === "GET" && address.pathname.startsWith("/v4/aliases/")) {
        assert.equal(address.searchParams.get("teamId"), "team_D1Mcx2TdFWPKcypfu8KzNMub");
        assert.equal(address.searchParams.has("slug"), false);
      }
      if (method !== "DELETE") return f.request(method, url, token, body);
      assert.equal(address.pathname, `/v2/aliases/${aliasUid}`);
      assert.equal(address.searchParams.get("teamId"), "team_D1Mcx2TdFWPKcypfu8KzNMub");
      assert.equal(address.searchParams.has("slug"), false);
      assert.equal(body, undefined);
      deleteCalls++;
      if (failure === "transport") throw new Error(`${privateSentinel} ${host}`);
      return { status: 403, data: { error: { message: privateSentinel, host } } };
    };
    await assert.rejects(() => new HttpQaGateway(f.env, mock, "write").deleteAlias(f.record, deletePlan(f.record)), (error: unknown) => {
      assert.deepEqual(qaDiagnosticFields(error), { stage: "DELETE_ALIAS", provider: "VERCEL", method: "DELETE",
        status: failure === "http" ? 403 : null, reason: failure === "http" ? "HTTP_ERROR" : "TRANSPORT_ERROR" });
      assert.match(qaFailureAnnotation(error), /^::error title=QA writer failure::stage=DELETE_ALIAS provider=VERCEL method=DELETE status=(?:403|NONE) reason=(?:HTTP_ERROR|TRANSPORT_ERROR)$/);
      assertPrivate(qaFailureAnnotation(error));
      assertPrivate(error);
      return true;
    });
    assert.equal(deleteCalls, 1);
  }
});

test("認証不足・shape不正はAPIの固定分類で報告し、transport前guardを保つ", async () => {
  const missing = fixture(); delete missing.env.VERCEL_TOKEN;
  await assert.rejects(() => new HttpQaGateway(missing.env, missing.request).alias("qa1"), (error: unknown) => {
    assert.deepEqual(qaDiagnosticFields(error), { stage: "READ_ALIAS", provider: "VERCEL", method: "GET", status: null, reason: "AUTH_MISSING" }); return true;
  });
  assert.equal(missing.calls.length, 0);
  const f = fixture();
  await assert.rejects(() => new HttpQaGateway(f.env, async () => ({ status: 200, data: privateSentinel })).alias("qa1"), (error: unknown) => {
    assert.deepEqual(qaDiagnosticFields(error), { stage: "READ_ALIAS", provider: "VERCEL", method: "GET", status: null, reason: "INVALID_RESPONSE" });
    assertPrivate(qaFailureAnnotation(error)); return true;
  });
});

test("不正statusやenum、unknown errorのmessage/stack/bodyをannotationへ流さない", () => {
  for (const status of [Number.NaN, Infinity, 99, 600, "403", `${privateSentinel}\n::error::injected`]) {
    const error = new QaDiagnosticFailure({ stage: "DELETE_ALIAS", provider: "VERCEL", method: "DELETE", reason: "HTTP_ERROR", status: status as number });
    assert.equal(qaDiagnosticFields(error).status, null);
    assertPrivate(qaFailureAnnotation(error));
    assert.ok(!qaFailureAnnotation(error).includes("\n"));
  }
  const unknown = new Error(privateSentinel);
  Object.defineProperty(unknown, "message", { get() { assert.fail("arbitrary error message must not be read"); } });
  assert.deepEqual(qaDiagnosticFields(unknown), { stage: "UNKNOWN", provider: "UNKNOWN", method: "UNKNOWN", status: null, reason: "UNKNOWN" });
  assertPrivate(qaFailureAnnotation(unknown));
  const injected = new QaDiagnosticFailure({ stage: privateSentinel as "UNKNOWN", provider: privateSentinel as "UNKNOWN",
    method: privateSentinel as "UNKNOWN", reason: privateSentinel as "UNKNOWN" });
  assert.deepEqual(qaDiagnosticFields(injected), qaDiagnosticFields(unknown));
  assert.equal(qaDiagnosticFields(contextualQaFailure(unknown, { stage: "DELETE_ALIAS", provider: "VERCEL", method: "DELETE" })).reason, "UNKNOWN");
});

test("operational承認は既存matcherを1回だけ使い、不正JSONは引続きthrowする", () => {
  const f = fixture(), originalNow = Date.now; let calls = 0;
  const now = originalNow();
  try {
    Date.now = () => { calls++; return now; };
    assert.equal(new HttpQaGateway(f.env, f.request).deletionApproved(deletePlan(f.record)), true);
    assert.equal(calls, 1);
  } finally { Date.now = originalNow; }
  f.env.CAKE_QA_DELETE_APPROVALS = `{${privateSentinel}`;
  assert.throws(() => new HttpQaGateway(f.env, f.request).deletionApproved(deletePlan(f.record)), (error: unknown) => {
    assert.deepEqual(qaDiagnosticFields(error), { stage: "APPROVAL_VALIDATE", provider: "NONE", method: "NONE", status: null, reason: "VALIDATION_ERROR" });
    assertPrivate(qaFailureAnnotation(error)); return true;
  });
});

test("writer CLIはgeneric errorと安全annotationを出してexit 1を維持する", () => {
  const script = fileURLToPath(new URL("../scripts/qa-pool-writer.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8",
    env: { PATH: process.env.PATH, NODE_ENV: "test", QA_ACTION: privateSentinel, GITHUB_ACTIONS: "false",
      GITHUB_TOKEN: "SENTINEL_GITHUB_TOKEN", VERCEL_TOKEN: "SENTINEL_VERCEL_TOKEN", NEON_API_KEY: "SENTINEL_NEON_API_KEY",
      CAKE_QA_DELETE_APPROVALS: `{${privateSentinel}`, CAKE_QA_PRODUCTION_DATABASE_HOST: host } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QA writerが確認不能で停止しました。枠・削除対象記録を保持します。/);
  assert.match(result.stderr, /::error title=QA writer failure::stage=UNKNOWN provider=UNKNOWN method=UNKNOWN status=NONE reason=UNKNOWN/);
  assertPrivate(result.stdout + result.stderr);
});

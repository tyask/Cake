import test from "node:test";
import assert from "node:assert/strict";
import { HttpQaGateway, type QaTransport } from "../scripts/qa-pool-writer";
import { claimRecord, nextRecord, replayDeployments, QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK,
  type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord } from "../lib/qa-pool";
import type { QaPullRequest, RemoteDeployment } from "../lib/qa-pool-service";

const sha = "a".repeat(40), leaseId = "00000000-0000-4000-8000-000000000042";
const timestamp = "2026-10-13T12:00:00.000Z", expiry = Date.parse(timestamp) + 60_000;
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-alias-consent", endpointId: "ep-alias-consent",
  host: "ep-alias-consent.fixture.aws.neon.tech" };
type Call = { method: string; path: string };

class AliasFixture {
  env = { GITHUB_TOKEN: "FAKE_GITHUB_TOKEN", VERCEL_TOKEN: "FAKE_VERCEL_TOKEN", NEON_API_KEY: "FAKE_NEON_TOKEN",
    CAKE_QA_POOL_ENABLED: "true", CAKE_QA_APPROVED_HEADS: "{}", CAKE_QA_PARENT_BRANCH_ID: "br-alias-parent",
    CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.fixture.aws.neon.tech" };
  records: GithubDeployment[] = [];
  record: QaLeaseRecord;
  current: QaPullRequest = { number: 42, state: "open", branch: "codex/alias-consent", sha, repository: QA_REPOSITORY, base: "main", approved: true };
  deployment: RemoteDeployment = { id: "dpl_alias_consent", projectId: QA_PROJECT_ID, target: null, branch: this.current.branch,
    sha, leaseId, pr: 42, attemptId: "00000000-0000-4000-8000-000000000142", phase: "application", state: "READY", url: undefined };
  identity = structuredClone(database);
  calls: Call[] = [];
  time = Date.parse(timestamp);
  revoked = false;
  aliasOwner: { projectId: string; deploymentId: string } | null = null;
  beforeGet?: (path: string) => void;
  constructor() {
    const first = claimRecord({ qa1: null, qa2: null, qa3: null }, { pr: 42, branch: this.current.branch, sha, leaseId, slot: "qa1", now: timestamp })!;
    this.append(first);
    this.record = nextRecord({ id: 1, payload: first }, { database, deployments: [{ id: this.deployment.id, sha, phase: "application" }] }, timestamp);
    this.append(this.record);
  }
  append(payload: QaLeaseRecord) {
    this.records.push({ id: this.records.length + 1, task: QA_TASK, environment: QA_ENVIRONMENT, sha: payload.headSha, payload: structuredClone(payload) });
  }
  replaceLease() {
    let saved = replayDeployments(this.records).qa1!;
    this.append(nextRecord(saved, { state: "deleting" }, timestamp));
    saved = replayDeployments(this.records).qa1!;
    this.append(nextRecord(saved, { state: "free", retiredDatabases: [database] }, timestamp));
    this.append(claimRecord(replayDeployments(this.records), { pr: 43, branch: "codex/alias-other-lease", sha,
      leaseId: "00000000-0000-4000-8000-000000000043", slot: "qa1", now: timestamp })!);
  }
  transport: QaTransport = async (method, address, _token, body) => {
    const path = new URL(address).pathname.replace(/^\/api\/v2(?=\/)/, "");
    this.calls.push({ method, path });
    if (method === "GET") {
      this.beforeGet?.(path); assert.equal(body, undefined);
      if (path === "/v4/aliases/cake-qa1-fumin.vercel.app") return { status: this.aliasOwner ? 200 : 404, data: this.aliasOwner };
      if (path === `/repos/${QA_REPOSITORY}/deployments`) return { status: 200, data: structuredClone(this.records) };
      if (path === `/v13/deployments/${this.deployment.id}`) return { status: 200, data: {
        id: this.deployment.id, projectId: QA_PROJECT_ID, target: null, readyState: "READY", gitSource: { ref: this.current.branch, sha },
        meta: { githubCommitRef: this.current.branch, githubCommitSha: sha, cakeQaPr: "42", cakeQaLeaseId: leaseId,
          cakeQaAttemptId: this.deployment.attemptId, cakeQaPhase: "application" } } };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/branches`) return { status: 200, data: { branches: [{
        id: this.identity.branchId, project_id: QA_NEON_PROJECT_ID, name: `preview/${this.current.branch}`, parent_id: "br-alias-parent",
        default: false, protected: false, created_at: timestamp }], pagination: { next: null } } };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`) return { status: 200, data: { endpoints: [{
        id: this.identity.endpointId, project_id: QA_NEON_PROJECT_ID, branch_id: this.identity.branchId, type: "read_write", host: this.identity.host }] } };
    }
    if (method === "POST" && path === `/v2/deployments/${this.deployment.id}/aliases`) {
      assert.deepEqual(body, { alias: "cake-qa1-fumin.vercel.app" }); return { status: 200, data: {} };
    }
    assert.fail(`unexpected fixture request ${method} ${path}`);
  };
  gateway() {
    const gateway = new HttpQaGateway(this.env, this.transport, "write");
    // The owner store itself has separate HTTP provenance/expiry tests. This controlled
    // current-PR boundary verifies the final consumer rereads its authorization result.
    gateway.pullRequest = async () => {
      this.calls.push({ method: "GET", path: "current-owner-consent" });
      return { ...this.current, approved: !this.revoked && this.time < expiry };
    };
    return gateway;
  }
  assign() { return this.gateway().assignAlias(this.record, this.deployment); }
  posts() { return this.calls.filter((call) => call.method === "POST"); }
  consentReads() { return this.calls.filter((call) => call.path === "current-owner-consent").length; }
  assertReadOnly() { assert.equal(this.posts().length, 0); assert.ok(this.calls.every((call) => call.method === "GET")); }
}

test("normal alias POST rechecks current consent after READY, DB and lease reads", async () => {
  const f = new AliasFixture(); await f.assign();
  assert.equal(f.posts().length, 1); assert.ok(f.consentReads() >= 2);
  const lastConsent = f.calls.findLastIndex((call) => call.path === "current-owner-consent");
  assert.ok(lastConsent > f.calls.findLastIndex((call) => call.path === `/v13/deployments/${f.deployment.id}`));
  assert.ok(lastConsent > f.calls.findLastIndex((call) => call.path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`));
  assert.ok(lastConsent > f.calls.findLastIndex((call) => call.path === `/repos/${QA_REPOSITORY}/deployments`));
  assert.equal(f.calls.at(-1)?.method, "POST"); assert.equal(f.records.length, 2);
});

test("foreign alias observed immediately before assignment prevents overwrite", async () => {
  const f = new AliasFixture();
  f.aliasOwner = { projectId: QA_PROJECT_ID, deploymentId: "dpl_foreign_lease" };
  await assert.rejects(() => f.assign(), /別の貸出/);
  f.assertReadOnly();
});

test("consent expiry during the READY GET stops the alias POST", async () => {
  const f = new AliasFixture(); f.beforeGet = (path) => { if (path === `/v13/deployments/${f.deployment.id}`) f.time = expiry; };
  await assert.rejects(() => f.assign()); f.assertReadOnly(); assert.ok(f.consentReads() >= 2);
});

test("owner revoke during the Native endpoint GET stops the alias POST", async () => {
  const f = new AliasFixture(); f.beforeGet = (path) => { if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`) f.revoked = true; };
  await assert.rejects(() => f.assign()); f.assertReadOnly(); assert.ok(f.consentReads() >= 2);
});

test("a replacement lease during Native metadata GET cannot consume the old READY alias target", async () => {
  const f = new AliasFixture(); let replaced = false;
  f.beforeGet = (path) => { if (!replaced && path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`) { replaced = true; f.replaceLease(); } };
  await assert.rejects(() => f.assign()); assert.equal(replaced, true); f.assertReadOnly();
  assert.notEqual(replayDeployments(f.records).qa1!.payload.leaseId, leaseId);
});

test("changed full Native identity is rejected before normal alias mutation", async () => {
  const f = new AliasFixture(); f.beforeGet = (path) => { if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`) f.identity.host = "ep-alias-consent.changed.aws.neon.tech"; };
  await assert.rejects(() => f.assign()); f.assertReadOnly();
});

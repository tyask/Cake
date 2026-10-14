import test from "node:test";
import assert from "node:assert/strict";
import { deletePlan } from "../lib/qa-pool-authorization";
import { qaDiagnosticFields, qaFailureAnnotation } from "../lib/qa-diagnostics";
import { runQaRequest } from "../lib/qa-pool-service";
import { nextRecord, QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK, qaAlias,
  type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord } from "../lib/qa-pool";
import { HttpQaGateway, type QaTransport } from "../scripts/qa-pool-writer";

const sha = "a".repeat(40), otherSha = "b".repeat(40);
const leaseId = "00000000-0000-4000-8000-000000000042";
const teamId = "team_D1Mcx2TdFWPKcypfu8KzNMub", uid = "alias_uid_fixture_42";
const timestamp = "2026-10-13T00:00:00.000Z";
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-uid-fixture", endpointId: "ep-uid-fixture",
  host: "ep-uid-fixture.mock.aws.neon.tech" };
type AliasResource = { uid: string; alias: string; projectId: string; deploymentId: string };
type Call = { method: string; path: string; query: URLSearchParams };

class Fixture {
  records: GithubDeployment[] = [];
  record: QaLeaseRecord;
  env: Record<string, string | undefined> = { GITHUB_TOKEN: "FAKE_GITHUB_TOKEN", VERCEL_TOKEN: "FAKE_VERCEL_TOKEN",
    NEON_API_KEY: "FAKE_NEON_TOKEN", CAKE_QA_APPROVED_HEADS: "{}", CAKE_QA_PARENT_BRANCH_ID: "br-parent",
    CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.mock.aws.neon.tech" };
  project = { id: QA_PROJECT_ID, name: "cake", accountId: teamId,
    link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main", repoId: 1318171856 } };
  pr = { number: 42, state: "closed", head: { sha, ref: "codex/uid-fixture", repo: { full_name: QA_REPOSITORY } }, base: { ref: "main" } };
  identity = structuredClone(database);
  resourceUid = uid;
  alias: AliasResource | null = { uid, alias: qaAlias("qa1"), projectId: QA_PROJECT_ID, deploymentId: "dpl_application" };
  uidAlias: unknown = undefined;
  remotes = ["dpl_provisioning", "dpl_application"].map((id, index) => ({ id, projectId: QA_PROJECT_ID,
    target: "preview", readyState: index ? "READY" : "ERROR", gitSource: { ref: this.pr.head.ref, sha },
    meta: { githubCommitRef: this.pr.head.ref, githubCommitSha: sha, cakeQaPr: "42", cakeQaLeaseId: leaseId,
      cakeQaAttemptId: "00000000-0000-4000-8000-000000000100", cakeQaPhase: index ? "application" : "provisioning" } }));
  calls: Call[] = [];
  before?: (call: Call) => void;
  reply?: (call: Call) => { status: number; data: unknown } | undefined;
  deleteStatus = 200;
  afterDelete?: () => void;
  constructor() {
    const first: QaLeaseRecord = { protocol: "cake-qa/v1", slot: "qa1", purpose: "probe", leaseId, pr: 42,
      branch: this.pr.head.ref, headSha: sha, state: "held", createdAt: timestamp, updatedAt: timestamp,
      sequence: 1, previousRecordId: null, deployments: [], retiredDatabases: [] };
    this.append(first);
    let record = nextRecord({ id: 1, payload: first }, { database, readyDeploymentId: "dpl_application",
      deployments: this.remotes.map(d => ({ id: d.id, sha, phase: d.meta.cakeQaPhase as "application" | "provisioning" })) }, timestamp);
    this.append(record);
    record = nextRecord({ id: 2, payload: record }, { aliasAssignment: { alias: qaAlias("qa1"), deploymentId: "dpl_application", sha, state: "pending" } }, timestamp);
    this.append(record);
    record = nextRecord({ id: 3, payload: record }, { aliasAssignment: { ...record.aliasAssignment!, state: "assigned" } }, timestamp);
    this.append(record);
    this.record = nextRecord({ id: 4, payload: record }, { state: "deleting", readyDeploymentId: undefined }, timestamp);
    this.append(this.record); this.approve();
  }
  append(payload: QaLeaseRecord) { this.records.push({ id: payload.sequence, task: QA_TASK, environment: QA_ENVIRONMENT, sha: payload.headSha, payload: structuredClone(payload) }); }
  approve() { this.env.CAKE_QA_DELETE_APPROVALS = JSON.stringify([{ ...deletePlan(this.record), expiresAt: "2099-01-01T00:00:00.000Z" }]); }
  request: QaTransport = async (method, address, _token, body) => {
    const url = new URL(address), path = url.pathname.replace(/^\/api\/v2(?=\/)/, "");
    const call = { method, path, query: url.searchParams }; this.calls.push(call); this.before?.(call);
    const overridden = this.reply?.(call); if (overridden) return overridden;
    assert.equal(body, undefined);
    if (method === "GET") {
      if (path === `/repos/${QA_REPOSITORY}/deployments`) return { status: 200, data: structuredClone(this.records) };
      if (path === `/repos/${QA_REPOSITORY}/pulls/42`) return { status: 200, data: structuredClone(this.pr) };
      if (path === `/v9/projects/${QA_PROJECT_ID}`) return { status: 200, data: structuredClone(this.project) };
      if (path === `/projects/${QA_NEON_PROJECT_ID}`) return { status: 200, data: { project: { id: QA_NEON_PROJECT_ID } } };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/branches`) return { status: 200, data: { branches: [{
        id: this.identity.branchId, name: `preview/${this.record.branch}`, project_id: QA_NEON_PROJECT_ID, parent_id: "br-parent",
        default: false, protected: false, created_at: timestamp }], pagination: { next: null } } };
      if (path === `/projects/${QA_NEON_PROJECT_ID}/endpoints`) return { status: 200, data: { endpoints: [{
        id: this.identity.endpointId, project_id: QA_NEON_PROJECT_ID, branch_id: this.identity.branchId, type: "read_write", host: this.identity.host }] } };
      if (path === "/v7/deployments") return { status: 200, data: { deployments: structuredClone(this.remotes), pagination: { next: null } } };
      if (path.startsWith("/v13/deployments/")) {
        const found = this.remotes.find(d => path === `/v13/deployments/${d.id}`);
        return { status: found ? 200 : 404, data: found ? structuredClone(found) : null };
      }
      if (path === `/v4/aliases/${qaAlias("qa1")}`) return { status: this.alias ? 200 : 404, data: structuredClone(this.alias) };
      if (path === `/v4/aliases/${encodeURIComponent(this.resourceUid)}`) {
        const value = this.uidAlias === undefined ? this.alias : this.uidAlias;
        return { status: value ? 200 : 404, data: structuredClone(value) };
      }
    }
    if (method === "DELETE" && path === `/v2/aliases/${encodeURIComponent(this.resourceUid)}`) {
      if (this.deleteStatus === 200) this.alias = null;
      this.afterDelete?.(); return { status: this.deleteStatus, data: this.deleteStatus === 200 ? { status: "SUCCESS" } : { message: "PRIVATE_PROVIDER_BODY" } };
    }
    assert.fail("unexpected mock request");
  };
  gateway(access: "read" | "write" = "write") { return new HttpQaGateway(this.env, this.request, access); }
  remove() { return this.gateway().deleteAlias(this.record, deletePlan(this.record)); }
  deletes() { return this.calls.filter(c => c.method === "DELETE"); }
  reads(path: string) { return this.calls.filter(c => c.method === "GET" && c.path === path).length; }
}

test("alias deletion resolves the exact UID and uses only the verified team-scoped UID DELETE", async () => {
  const f = new Fixture(), before = structuredClone(f.records);
  await f.remove();
  assert.deepEqual(f.deletes().map(c => c.path), [`/v2/aliases/${encodeURIComponent(uid)}`]);
  assert.equal(f.deletes()[0].query.get("teamId"), teamId);
  assert.equal(f.deletes()[0].path.includes(qaAlias("qa1")), false);
  assert.ok(f.reads(`/v4/aliases/${qaAlias("qa1")}`) >= 2);
  assert.ok(f.reads(`/v4/aliases/${uid}`) >= 2);
  assert.equal(f.alias, null); assert.deepEqual(f.records, before);
});

test("already absent hostname is read-only and never sends an alias DELETE", async () => {
  const f = new Fixture(); f.alias = null;
  await f.remove(); assert.equal(f.deletes().length, 0);
});

test("valid UID punctuation is URI encoded and a 128 character hexadecimal UID is accepted", async () => {
  for (const resourceUid of ["uid:qa+1", "a".repeat(128)]) {
    const f = new Fixture(); f.resourceUid = resourceUid; f.alias!.uid = resourceUid;
    await f.remove();
    assert.deepEqual(f.deletes().map(c => c.path), [`/v2/aliases/${encodeURIComponent(resourceUid)}`]);
    assert.equal(f.deletes()[0].query.get("teamId"), teamId);
  }
});

test("invalid or unsafe UID values fail closed before DELETE", async () => {
  for (const invalid of [undefined, null, 42, [], "", "../alias", "uid/path", "uid?query", "uid#fragment", "uid%2Fpath", " uid ", "uid\n", "別UID", "x".repeat(257)]) {
    const f = new Fixture(); f.alias = { ...f.alias!, uid: invalid as string };
    await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
    assert.equal(f.calls.some(call => call.method === "GET" && call.path.startsWith("/v4/aliases/") && call.path !== `/v4/aliases/${qaAlias("qa1")}`), false);
  }
});

test("hostname, UID, project and recorded alias deployment must all agree", async () => {
  for (const difference of [{ alias: qaAlias("qa2") }, { projectId: "prj_foreign" }, { deploymentId: "dpl_provisioning" }, { deploymentId: "dpl_foreign" }, { uid: "alias_foreign" }]) {
    const f = new Fixture(); f.uidAlias = { ...f.alias!, ...difference };
    await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
  }
  for (const difference of [{ alias: qaAlias("qa2") }, { projectId: "prj_foreign" }, { deploymentId: "dpl_foreign" }]) {
    const f = new Fixture(); Object.assign(f.alias!, difference);
    await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
  }
});

test("nested deployment identity is accepted only when every provided identifier agrees", async () => {
  const f = new Fixture();
  f.uidAlias = { uid, alias: qaAlias("qa1"), projectId: QA_PROJECT_ID, deployment: { id: "dpl_application", projectId: QA_PROJECT_ID } };
  f.afterDelete = () => { f.uidAlias = null; };
  await f.remove(); assert.equal(f.deletes().length, 1);
  for (const nested of [{ id: "dpl_foreign" }, { id: "dpl_application", projectId: "prj_foreign" }]) {
    const blocked = new Fixture(); blocked.uidAlias = { ...blocked.alias!, deployment: nested };
    await assert.rejects(() => blocked.remove()); assert.equal(blocked.deletes().length, 0);
  }
});

test("a UID disappearance with the hostname still assigned is not treated as successful cleanup", async () => {
  const f = new Fixture(); f.uidAlias = null;
  await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
});

test("the expected project account is verified before using team scope", async () => {
  const f = new Fixture(); f.project.accountId = "team_foreign";
  await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
});

test("explicit alias ownership fields must match the verified project team", async () => {
  for (const field of ["teamId", "ownerId", "accountId", "team"] as const) {
    const f = new Fixture();
    f.uidAlias = { ...f.alias!, [field]: field === "team" ? { id: "team_foreign" } : "team_foreign" };
    await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
  }
  const f = new Fixture(); Object.assign(f.alias!, { ownerId: teamId, teamId, accountId: teamId, team: { id: teamId }, creator: { uid: "unrelated_creator" } });
  await f.remove(); assert.equal(f.deletes().length, 1);
});

test("nested team and owner claims reject malformed or contradictory identifiers", async () => {
  for (const field of ["team", "owner"] as const) {
    for (const invalid of [null, [], 42, true, "", "team_foreign", {}, { id: "team_foreign" },
      { id: teamId, uid: "team_foreign" }, { id: "team_foreign", uid: teamId }]) {
      const f = new Fixture(); f.uidAlias = { ...f.alias!, [field]: invalid };
      await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
    }
  }
  for (const owner of [teamId, { id: teamId }, { uid: teamId }, { id: teamId, uid: teamId }]) {
    const f = new Fixture(); Object.assign(f.alias!, { owner, team: structuredClone(owner), creator: { id: "unrelated_creator" } });
    await f.remove(); assert.equal(f.deletes().length, 1);
  }
});

test("name and UID are re-read so reassignment during ownership checks blocks DELETE", async () => {
  for (const route of [qaAlias("qa1"), uid]) {
    const f = new Fixture();
    f.before = call => {
      if (call.method === "GET" && call.path === `/v4/aliases/${route}` && f.reads(call.path) === (route === uid ? 1 : 2)) {
        if (route === uid) f.uidAlias = { ...f.alias!, deploymentId: "dpl_foreign" };
        else f.alias = { ...f.alias!, uid: "alias_reassigned", deploymentId: "dpl_foreign" };
      }
    };
    await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
  }
});

test("expired, malformed, missing or subset deletion approvals cannot reach DELETE", async () => {
  for (const approval of [undefined, "[]", "{PRIVATE_APPROVAL_BODY", JSON.stringify([{ ...deletePlan(new Fixture().record), expiresAt: "2020-01-01T00:00:00Z" }]),
    JSON.stringify([{ ...deletePlan(new Fixture().record), deploymentIds: ["dpl_application"], expiresAt: "2099-01-01T00:00:00Z" }])]) {
    const f = new Fixture(); f.env.CAKE_QA_DELETE_APPROVALS = approval;
    await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
  }
});

test("approval revocation or ledger changes during alias reads stop the pending DELETE", async () => {
  for (const change of ["approval", "updatedAt", "lease", "head"] as const) {
    const f = new Fixture();
    f.before = call => {
      if (call.method !== "GET" || call.path !== `/v4/aliases/${uid}` || f.reads(call.path) !== 1) return;
      if (change === "approval") f.env.CAKE_QA_DELETE_APPROVALS = "[]";
      else {
        const latest = f.records.at(-1)!.payload as QaLeaseRecord;
        if (change === "updatedAt") latest.updatedAt = "2026-10-13T00:01:00.000Z";
        if (change === "lease") latest.leaseId = "00000000-0000-4000-8000-000000000043";
        if (change === "head") latest.headSha = otherSha;
      }
    };
    await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
  }
});

test("PR ownership, complete DB identity and every recorded deployment are verified before DELETE", async () => {
  for (const change of ["invalidPrHead", "prBranch", "prRepository", "prBase", "dbHost", "dbBranch", "deploymentLease", "deploymentHead", "deploymentProject", "orphan", "wrongRecordedId"] as const) {
    const f = new Fixture();
    if (change === "invalidPrHead") f.pr.head.sha = "invalid";
    if (change === "prBranch") f.pr.head.ref = "codex/foreign";
    if (change === "prRepository") f.pr.head.repo.full_name = "foreign/Cake";
    if (change === "prBase") f.pr.base.ref = "foreign";
    if (change === "dbHost") f.identity.host = "ep-uid-fixture.other.aws.neon.tech";
    if (change === "dbBranch") f.identity.branchId = "br-foreign";
    if (change === "deploymentLease") f.remotes[0].meta.cakeQaLeaseId = "00000000-0000-4000-8000-000000000043";
    if (change === "deploymentHead") { f.remotes[0].gitSource.sha = otherSha; f.remotes[0].meta.githubCommitSha = otherSha; }
    if (change === "deploymentProject") f.remotes[0].projectId = "prj_foreign";
    if (change === "orphan") f.remotes.push({ ...structuredClone(f.remotes[0]), id: "dpl_unrecorded" });
    if (change === "wrongRecordedId") f.reply = call => call.method === "GET" && call.path === "/v13/deployments/dpl_provisioning"
      ? { status: 200, data: structuredClone(f.remotes[1]) } : undefined;
    await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
  }
});

test("manual release supports an OPEN PR with a later head and retains already absent IDs in the exact approved manifest", async () => {
  const f = new Fixture(); f.pr.state = "open"; f.pr.head.sha = otherSha; f.remotes = f.remotes.filter(d => d.id !== "dpl_provisioning");
  await f.remove(); assert.equal(f.deletes().length, 1);
  assert.deepEqual(deletePlan(f.record).deploymentIds, ["dpl_application", "dpl_provisioning"]);
});

test("DB identity is checked again after the final alias ownership reads", async () => {
  const f = new Fixture();
  f.before = call => {
    if (call.method === "GET" && call.path === `/v4/aliases/${qaAlias("qa1")}` && f.reads(call.path) === 2) {
      f.identity.host = "ep-uid-fixture.other.aws.neon.tech";
    }
  };
  await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0);
});

test("an older deployment SHA is compared to its recorded SHA rather than the current lease head", async () => {
  const f = new Fixture();
  f.remotes[0].gitSource.sha = otherSha; f.remotes[0].meta.githubCommitSha = otherSha;
  for (const entry of f.records) {
    const record = entry.payload as QaLeaseRecord;
    const old = record.deployments.find(d => d.id === "dpl_provisioning"); if (old) old.sha = otherSha;
  }
  f.record.deployments[0].sha = otherSha; f.approve();
  await f.remove(); assert.equal(f.deletes().length, 1);
});

test("an approval that expires during the final alias read is denied before DELETE", async () => {
  const f = new Fixture(), capturedNow = Date.now(), original = Date.now;
  let clock = capturedNow;
  f.env.CAKE_QA_DELETE_APPROVALS = JSON.stringify([{ ...deletePlan(f.record), expiresAt: new Date(capturedNow + 1).toISOString() }]);
  f.before = call => { if (call.method === "GET" && call.path === `/v4/aliases/${qaAlias("qa1")}` && f.reads(call.path) === 2) clock = capturedNow + 1; };
  Date.now = () => clock;
  try { await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 0); }
  finally { Date.now = original; }
});

test("DELETE 404 remains an HTTP failure and cannot fall through to deployment deletion", async () => {
  const f = new Fixture(); f.deleteStatus = 404;
  await assert.rejects(() => runQaRequest(f.gateway(), { action: "release", pr: 42, leaseId }, { log: () => {} }), (error: unknown) => {
    assert.deepEqual(qaDiagnosticFields(error), { stage: "DELETE_ALIAS", provider: "VERCEL", method: "DELETE", status: 404, reason: "HTTP_ERROR" }); return true;
  });
  assert.equal(f.deletes().length, 1); assert.equal((f.records.at(-1)!.payload as QaLeaseRecord).state, "deleting");
  assert.equal(f.deletes().some(c => c.path.startsWith("/v13/deployments/") || c.path.startsWith("/projects/")), false);
});

test("an alias still present after DELETE keeps cleanup incomplete", async () => {
  const f = new Fixture(); f.afterDelete = () => { f.alias = { uid, alias: qaAlias("qa1"), projectId: QA_PROJECT_ID, deploymentId: "dpl_application" }; };
  await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 1);
});

test("a successful DELETE response with either the UID or hostname still present is incomplete", async () => {
  const f = new Fixture(); f.uidAlias = structuredClone(f.alias);
  await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 1);
});

test("hostname reassignment after DELETE is held even if the original UID is gone", async () => {
  const f = new Fixture();
  f.afterDelete = () => { f.alias = { uid: "alias_foreign", alias: qaAlias("qa1"), projectId: "prj_foreign", deploymentId: "dpl_foreign" }; f.uidAlias = null; };
  await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 1);
});

test("a DELETE response without the documented SUCCESS status is held without a retry", async () => {
  for (const data of [null, {}, { status: "ERROR" }, { status: "PRIVATE_PROVIDER_BODY" }]) {
    const f = new Fixture(); f.reply = call => call.method === "DELETE" ? { status: 200, data } : undefined;
    await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 1);
  }
});

test("an unknown DELETE response is held, and a later hostname GET 404 never repeats the DELETE", async () => {
  const f = new Fixture();
  f.reply = call => { if (call.method === "DELETE") { f.alias = null; throw new Error(`PRIVATE_PROVIDER_BODY ${database.host} ${f.env.VERCEL_TOKEN}`); } return undefined; };
  await assert.rejects(() => f.remove()); assert.equal(f.deletes().length, 1);
  f.reply = undefined; await f.remove(); assert.equal(f.deletes().length, 1);
});

test("GET and DELETE 403, malformed provider responses and transport errors never expose private values", async () => {
  const cases: ((f: Fixture) => void)[] = [
    f => { f.deleteStatus = 403; },
    f => { f.reply = call => call.method === "GET" && call.path === `/v4/aliases/${qaAlias("qa1")}` ? { status: 403, data: { message: "PRIVATE_PROVIDER_BODY", host: database.host } } : undefined; },
    f => { f.reply = call => call.method === "GET" && call.path === `/v4/aliases/${uid}` ? { status: 403, data: { message: "PRIVATE_PROVIDER_BODY" } } : undefined; },
    f => { f.reply = call => call.method === "GET" && call.path === `/v9/projects/${QA_PROJECT_ID}` ? { status: 403, data: { message: "PRIVATE_PROVIDER_BODY" } } : undefined; },
    f => { f.uidAlias = "PRIVATE_PROVIDER_BODY"; },
    f => { f.reply = call => { if (call.method === "GET" && call.path.includes("/aliases/")) throw new Error(`PRIVATE_PROVIDER_BODY ${database.host} ${f.env.VERCEL_TOKEN}`); return undefined; }; },
  ];
  for (const configure of cases) {
    const f = new Fixture(); configure(f);
    await assert.rejects(() => f.remove(), (error: unknown) => {
      const annotation = qaFailureAnnotation(error);
      for (const secret of ["PRIVATE_PROVIDER_BODY", database.host, f.env.VERCEL_TOKEN!, f.env.GITHUB_TOKEN!, f.env.NEON_API_KEY!]) {
        assert.equal(annotation.includes(secret), false);
        if (error instanceof Error) assert.equal(error.message.includes(secret), false);
      }
      return true;
    });
  }
});

test("a read-only gateway refuses alias cleanup before sending any request", async () => {
  const f = new Fixture();
  await assert.rejects(() => f.gateway("read").deleteAlias(f.record, deletePlan(f.record)), (error: unknown) => {
    assert.equal(qaDiagnosticFields(error).reason, "METHOD_NOT_ALLOWED"); return true;
  });
  assert.equal(f.calls.length, 0);
});

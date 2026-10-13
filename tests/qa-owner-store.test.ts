import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { HttpOwnerApprovalStore } from "../scripts/qa-owner-store";
import { makeOwnerPlan, parsePlan, QA_APPROVAL_TASK, QA_APPROVAL_WORKFLOW, type OwnerApprovalEvent } from "../lib/qa-owner-approval";
import { deletePlan, type DeletePlan } from "../lib/qa-pool-authorization";
import { QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK, claimRecord, nextRecord, replayDeployments,
  type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord } from "../lib/qa-pool";
import type { QaPullRequest } from "../lib/qa-pool-service";

const start = Date.parse("2026-10-13T10:00:00.000Z"), mainSha = "a".repeat(40), sha = "b".repeat(40), otherSha = "c".repeat(40);
const leaseId = "00000000-0000-4000-8000-000000000042", otherLease = "00000000-0000-4000-8000-000000000043";
const ownerId = 4242, prefix = `/repos/${QA_REPOSITORY}`;
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-owner-store", endpointId: "ep-owner-store",
  host: "ep-owner-store.example.aws.neon.tech" };
type Call = { path: string; method: string; body?: unknown };
type RawRun = ReturnType<typeof run>;
type CiRun = ReturnType<typeof ciRun>;
const ciPath = (page = 1) => `${prefix}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100&page=${page}`;
function ciRun(id: number, event: "push" | "pull_request") {
  return { id, event, head_sha: sha, head_branch: "codex/owner-store", head_repository: { full_name: QA_REPOSITORY }, repository: { full_name: QA_REPOSITORY },
    path: ".github/workflows/ci.yml", pull_requests: event === "pull_request" ? [{ number: 42 }] : [],
    status: "completed", conclusion: "success" as string | null };
}
function run(id: number, title: string) {
  return { id, run_attempt: 1, repository: { full_name: QA_REPOSITORY }, head_repository: { full_name: QA_REPOSITORY },
    path: QA_APPROVAL_WORKFLOW, referenced_workflows: [{ path: `${QA_REPOSITORY}/.github/workflows/qa-private-run.yml@${mainSha}`,
      ref: "refs/heads/main", sha: mainSha }], event: "workflow_dispatch", head_branch: "main", head_sha: mainSha,
    display_title: title, actor: { id: ownerId, type: "User" }, triggering_actor: { id: ownerId, type: "User" },
    status: "completed", conclusion: "success" as string | null };
}
function quiet(context: TestContext): string[] {
  const messages: string[] = [];
  context.mock.method(console, "log", (...values: unknown[]) => { messages.push(values.map(String).join(" ")); });
  return messages;
}
class StoreFixture {
  env: Record<string, string | undefined> = { QA_TRUSTED_MAIN_SHA: mainSha, CAKE_QA_PARENT_BRANCH_ID: "br-owner-parent",
    GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1" };
  pr: QaPullRequest = { number: 42, state: "open", branch: "codex/owner-store", sha, repository: QA_REPOSITORY, base: "main", approved: false };
  rawPr = { number: 42, state: "open", head: { ref: "codex/owner-store", sha, repo: { full_name: QA_REPOSITORY } }, base: { ref: "main" } };
  repository = { full_name: QA_REPOSITORY, owner: { login: "tyask", type: "User", id: ownerId } };
  main = { name: "main", commit: { sha: mainSha } };
  records: GithubDeployment[] = [];
  events: OwnerApprovalEvent[] = [];
  runs = new Map<number, RawRun>([[100, run(100, "Cake QA request-preview -")]]);
  calls: Call[] = [];
  faults = new Map<string, unknown>();
  pages?: Map<number, unknown[]>;
  ciRuns: CiRun[] = [ciRun(600, "push"), ciRun(601, "pull_request")];
  ciPages?: Map<number, CiRun[]>;
  time = start;
  ledgerReads = 0;
  api = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    this.calls.push({ path, method, body: structuredClone(body) });
    if (this.faults.has(path)) {
      const fault = this.faults.get(path);
      if (fault instanceof Error) throw fault;
      return structuredClone(fault);
    }
    if (method === "GET") {
      if (path === prefix) return structuredClone(this.repository);
      if (path === `${prefix}/branches/main`) return structuredClone(this.main);
      if (path === `${prefix}/pulls/42`) return structuredClone(this.rawPr);
      const ciPage = new RegExp(`^${prefix}/actions/workflows/ci\\.yml/runs\\?head_sha=${sha}&per_page=100&page=([1-9][0-9]*)$`).exec(path);
      if (ciPage) return { workflow_runs: structuredClone(this.ciPages?.get(Number(ciPage[1]))
        ?? this.ciRuns.slice((Number(ciPage[1]) - 1) * 100, Number(ciPage[1]) * 100)) };
      const page = new RegExp(`^${prefix}/deployments\\?task=${QA_APPROVAL_TASK}&per_page=100&page=([1-9][0-9]*)$`).exec(path);
      if (page) return structuredClone(this.pages?.get(Number(page[1])) ?? this.events.slice((Number(page[1]) - 1) * 100, Number(page[1]) * 100));
      const metadata = new RegExp(`^${prefix}/actions/runs/([1-9][0-9]*)/attempts/([1-9][0-9]*)$`).exec(path);
      if (metadata) {
        const value = this.runs.get(Number(metadata[1]));
        assert.ok(value, "metadata must be obtained for the recorded run ID");
        assert.equal(Number(metadata[2]), value.run_attempt, "metadata must be attempt-qualified");
        return structuredClone(value);
      }
    }
    if (method === "POST" && path === `${prefix}/deployments`) {
      const value = body as { ref: string; task: string; environment: string; payload: OwnerApprovalEvent["payload"] };
      const event: OwnerApprovalEvent = { id: 1001 + this.events.length, task: value.task, environment: value.environment, sha: value.ref,
        payload: structuredClone(value.payload), creator: { login: "github-actions[bot]", type: "Bot" } };
      this.events.push(event);
      return structuredClone(event);
    }
    assert.fail(`unexpected fake request ${method} ${path}`);
  };
  store = new HttpOwnerApprovalStore(this.env, this.api, async () => {
    this.ledgerReads++;
    return structuredClone(this.records);
  }, () => this.time, () => leaseId);
  posts() { return this.calls.filter((call) => call.method !== "GET"); }
  async issue(action: "preview" | "cleanup" = "preview") {
    this.runs.set(100, run(100, action === "cleanup" ? "Cake QA request-release -" : "Cake QA request-preview -"));
    await this.store.requestPlan(action, this.pr);
    const event = this.events.at(-1)!;
    return { id: event.id, plan: parsePlan(event.payload) };
  }
  async decide(planId: number, state: "approved" | "revoked" = "approved", runId = 200) {
    this.time++;
    this.env.GITHUB_RUN_ID = String(runId);
    this.runs.set(runId, { ...run(runId, `Cake QA ${state === "approved" ? "approve" : "revoke"} ${planId}`), status: "in_progress", conclusion: null });
    await this.store.decide(planId, state);
    return this.runs.get(runId)!;
  }
  complete(runId = 200, conclusion = "success") {
    const current = this.runs.get(runId)!;
    current.status = "completed"; current.conclusion = conclusion;
  }
  claim(changes: Partial<QaLeaseRecord> = {}) {
    const record = claimRecord(replayDeployments(this.records), { pr: 42, branch: this.pr.branch, sha: this.pr.sha,
      leaseId, slot: "qa1", now: new Date(this.time).toISOString() })!;
    this.add({ ...record, ...changes });
  }
  add(record: QaLeaseRecord) {
    this.records.push({ id: this.records.length + 10, task: QA_TASK, environment: QA_ENVIRONMENT, sha: record.headSha, payload: structuredClone(record) });
    replayDeployments(this.records);
  }
  advance(changes: Partial<QaLeaseRecord>) {
    const saved = replayDeployments(this.records).qa1!;
    this.add(nextRecord(saved, changes, new Date(this.time).toISOString()));
  }
  savedDatabase() {
    this.claim();
    this.advance({ database, deployments: [{ id: "dpl_baseline", sha, phase: "provisioning" }] });
  }
  deleting() {
    this.savedDatabase();
    this.advance({ state: "deleting" });
    return deletePlan(replayDeployments(this.records).qa1!.payload);
  }
  assertNoProviderWrites() {
    assert.ok(this.calls.every((call) => call.method === "GET" || call.path === `${prefix}/deployments` && call.method === "POST"));
    for (const call of this.posts()) {
      const body = call.body as Record<string, unknown>;
      assert.equal(body.task, QA_APPROVAL_TASK); assert.equal(body.production_environment, false);
      assert.equal(body.auto_merge, false); assert.deepEqual(body.required_contexts, []);
      assert.equal(JSON.stringify(body).includes(database.host), false, "public ledger must omit private DB host");
    }
  }
}

test("request-preview creates one hostless PENDING approval record and no resources or lease", async (t) => {
  const messages = quiet(t), f = new StoreFixture(), { id, plan } = await f.issue();
  assert.equal(plan.maximumNewDeployments, 2); assert.equal(plan.maximumNewDatabases, 1);
  assert.deepEqual(plan.resources.deploymentIds, []); assert.equal(plan.resources.database, null);
  assert.equal(plan.previousLeaseRecordId, null); assert.equal(plan.parentBranchId, "br-owner-parent");
  assert.equal((await f.store.states()).get(id)?.status, "PENDING");
  assert.deepEqual(await f.store.preview(f.pr), { known: true, authorization: null });
  assert.equal(f.posts().length, 1); assert.deepEqual(f.records, []);
  await f.store.requestPlan("preview", f.pr);
  assert.equal(f.posts().length, 1, "a current pending plan must be reused");
  assert.ok(messages.every((message) => !message.includes(database.host)));
  f.assertNoProviderWrites();
});

test("actual owner run title binds plan ID; incomplete receipt activates only after successful metadata GET", async (t) => {
  quiet(t); const f = new StoreFixture(), { id } = await f.issue();
  await f.decide(id);
  assert.equal((await f.store.states()).get(id)?.status, "PENDING");
  assert.equal((await f.store.preview(f.pr)).authorization, null);
  f.complete();
  assert.deepEqual(await f.store.preview(f.pr), { known: true, authorization: { slot: "qa1", leaseId } });
  assert.ok(f.calls.filter((call) => call.path === `${prefix}/actions/runs/200/attempts/1`).length >= 3,
    "in-progress metadata must be fetched again instead of cached");
  const decision = f.events.at(-1)!.payload as { actorId: number; planId: number };
  assert.equal(decision.actorId, ownerId); assert.equal(decision.planId, id); f.assertNoProviderWrites();
});

test("nonowner, bot, rerun actor, fork, wrong ref, wrong main SHA and wrong run title cannot append approval", async (t) => {
  quiet(t);
  const cases: [string, (raw: RawRun, id: number) => void][] = [
    ["nonowner actor", (raw) => { raw.actor.id = ownerId + 1; }],
    ["nonowner triggering actor", (raw) => { raw.triggering_actor.id = ownerId + 1; }],
    ["bot actor", (raw) => { raw.actor.type = "Bot"; }],
    ["bot triggering actor", (raw) => { raw.triggering_actor.type = "Bot"; }],
    ["fork", (raw) => { raw.head_repository.full_name = "other/Cake"; }],
    ["source repository", (raw) => { raw.repository.full_name = "other/Cake"; }],
    ["feature ref", (raw) => { raw.head_branch = "codex/owner-store"; }],
    ["workflow head mismatch", (raw) => { raw.head_sha = otherSha; }],
    ["untrusted reusable ref", (raw) => { raw.referenced_workflows[0].ref = "refs/heads/codex/owner-store"; }],
    ["wrong reusable path", (raw) => { raw.referenced_workflows[0].path = `${QA_REPOSITORY}/.github/workflows/qa-pool.yml@${mainSha}`; }],
    ["ambiguous reusable workflow", (raw) => { raw.referenced_workflows.push(structuredClone(raw.referenced_workflows[0])); }],
    ["wrong plan run title", (raw, id) => { raw.display_title = `Cake QA approve ${id + 1}`; }],
    ["opposite action run title", (raw, id) => { raw.display_title = `Cake QA revoke ${id}`; }],
    ["non-dispatch", (raw) => { raw.event = "schedule"; }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const f = new StoreFixture(), { id } = await f.issue();
    f.env.GITHUB_RUN_ID = "200";
    const raw = { ...run(200, `Cake QA approve ${id}`), status: "in_progress", conclusion: null };
    change(raw, id); f.runs.set(200, raw);
    await assert.rejects(() => f.store.decide(id, "approved"));
    assert.equal(f.posts().length, 1); assert.equal(f.events.length, 1); assert.deepEqual(f.records, []);
  });
});

test("approval requires the exact OPEN PR repository, feature ref and full head SHA", async (t) => {
  quiet(t);
  for (const field of ["closed", "head", "branch", "fork", "base", "number"]) await t.test(field, async () => {
    const f = new StoreFixture(), { id } = await f.issue();
    if (field === "closed") f.rawPr.state = "closed";
    if (field === "head") f.rawPr.head.sha = otherSha;
    if (field === "branch") f.rawPr.head.ref = "codex/other";
    if (field === "fork") f.rawPr.head.repo.full_name = "other/Cake";
    if (field === "base") f.rawPr.base.ref = "other";
    if (field === "number") f.rawPr.number++;
    await assert.rejects(() => f.decide(id)); assert.equal(f.posts().length, 1);
  });
});

test("PR opened, synchronize and reopened metadata can request a pending plan but cannot approve", async (t) => {
  quiet(t);
  for (const action of ["opened", "synchronize", "reopened"]) await t.test(action, async () => {
    const f = new StoreFixture(), raw = run(100, `Cake QA ${action} -`);
    raw.event = "pull_request_target"; raw.head_branch = f.pr.branch; raw.head_sha = sha;
    f.runs.set(100, raw);
    await f.store.requestPlan("preview", f.pr);
    const id = f.events[0].id;
    assert.equal((await f.store.states()).get(id)?.status, "PENDING");
    assert.equal((await f.store.preview(f.pr)).authorization, null);
    assert.equal(f.posts().length, 1); assert.deepEqual(f.records, []);
  });
});

test("a nonowner may request a safe pending plan; an owner-triggered rerun is not a fresh approval", async (t) => {
  quiet(t); const f = new StoreFixture(), request = f.runs.get(100)!;
  request.actor.id = ownerId + 1; request.triggering_actor.id = ownerId + 1;
  await f.store.requestPlan("preview", f.pr);
  const id = f.events[0].id;
  assert.equal((await f.store.states()).get(id)?.status, "PENDING");
  f.env.GITHUB_RUN_ID = "200"; f.env.GITHUB_RUN_ATTEMPT = "2";
  f.runs.set(200, { ...run(200, `Cake QA approve ${id}`), run_attempt: 2, status: "in_progress", conclusion: null });
  await assert.rejects(() => f.store.decide(id, "approved"));
  assert.equal(f.posts().length, 1); assert.equal((await f.store.preview(f.pr)).authorization, null);
});

test("a full pool retains all leases and emits no approval POST or resource request", async (t) => {
  const messages = quiet(t), f = new StoreFixture();
  for (const [index, slot] of (["qa1", "qa2", "qa3"] as const).entries()) {
    const record = claimRecord(replayDeployments(f.records), { pr: index + 100, branch: `codex/occupied-${index}`, sha,
      leaseId: `00000000-0000-4000-8000-00000000010${index}`, slot, now: new Date(start).toISOString() })!;
    f.add(record);
  }
  const before = structuredClone(f.records);
  await f.store.requestPlan("preview", f.pr);
  assert.deepEqual(f.records, before); assert.equal(f.posts().length, 0); assert.deepEqual(f.events, []);
  assert.ok(messages.some((message) => message.includes("空きQA枠")));
});

test("changed trusted main or reviewed Native parent holds an existing approval", async (t) => {
  quiet(t);
  for (const field of ["main", "parent"]) await t.test(field, async () => {
    const f = new StoreFixture(), { id } = await f.issue(); await f.decide(id); f.complete();
    if (field === "main") f.main.commit.sha = otherSha;
    else f.env.CAKE_QA_PARENT_BRANCH_ID = "br-other-parent";
    if (field === "main") await assert.rejects(() => f.store.preview(f.pr));
    else assert.equal((await f.store.preview(f.pr)).authorization, null);
    assert.equal(f.posts().length, 2);
  });
});

test("expiry is exact and no stale approval follows a new PR SHA", async (t) => {
  quiet(t); const f = new StoreFixture(), { id, plan } = await f.issue(); await f.decide(id); f.complete();
  assert.equal((await f.store.preview({ ...f.pr, sha: otherSha })).authorization, null);
  assert.equal((await f.store.preview({ ...f.pr, state: "closed" })).authorization, null);
  f.time = Date.parse(plan.expiresAt);
  assert.equal((await f.store.states()).get(id)?.status, "EXPIRED");
  assert.equal((await f.store.preview(f.pr)).authorization, null);
  await assert.rejects(() => f.decide(id, "approved", 300)); assert.equal(f.posts().length, 2);
});

test("a higher-ID revoke and even its unfinished receipt prevent fallback to older approval", async (t) => {
  quiet(t); const f = new StoreFixture(), { id } = await f.issue(); await f.decide(id); f.complete();
  assert.ok((await f.store.preview(f.pr)).authorization);
  await f.decide(id, "revoked", 300);
  assert.equal((await f.store.states()).get(id)?.status, "PENDING");
  assert.equal((await f.store.preview(f.pr)).authorization, null);
  f.complete(300);
  assert.equal((await f.store.states()).get(id)?.status, "REVOKED");
  assert.equal((await f.store.preview(f.pr)).authorization, null);
  const receipt = f.events.at(-1)!.payload as { previousDecisionId: number; sequence: number };
  assert.equal(receipt.previousDecisionId, f.events[1].id); assert.equal(receipt.sequence, 2);
});

test("failed approval metadata never authorizes, and a higher pending plan blocks the old approved plan", async (t) => {
  quiet(t); const f = new StoreFixture(), { id } = await f.issue(); await f.decide(id); f.complete(200, "failure");
  assert.equal((await f.store.preview(f.pr)).authorization, null);
  const fresh = new StoreFixture(), first = await fresh.issue(); await fresh.decide(first.id); fresh.complete();
  assert.ok((await fresh.store.preview(fresh.pr)).authorization);
  const newer = structuredClone(fresh.events[0]);
  newer.id = 1003; newer.payload = makeOwnerPlan({ action: "preview", projectId: QA_PROJECT_ID, pr: 42, branch: fresh.pr.branch,
    sha, slot: "qa1", leaseId: otherLease, previousLeaseRecordId: null, deploymentIds: [], alias: "cake-qa1-fumin.vercel.app",
    database: null, parentBranchId: "br-owner-parent", runId: 300, runAttempt: 1 }, mainSha, fresh.time);
  fresh.runs.set(300, run(300, "Cake QA request-preview -")); fresh.events.push(newer);
  assert.equal((await fresh.store.preview(fresh.pr)).authorization, null);
});

test("fresh two-deployment budget follows the same claim into verified DB application phase without a new plan", async (t) => {
  quiet(t); const f = new StoreFixture(), { id } = await f.issue(); await f.decide(id); f.complete();
  f.claim(); assert.ok((await f.store.preview(f.pr)).authorization);
  f.advance({ intent: { sha, phase: "provisioning", attemptId: otherLease, startedAt: new Date(f.time).toISOString() } });
  assert.ok((await f.store.preview(f.pr)).authorization);
  f.advance({ intent: undefined, database, deployments: [{ id: "dpl_first", sha, phase: "provisioning" }] });
  assert.ok((await f.store.preview(f.pr)).authorization);
  f.advance({ intent: { sha, phase: "application", attemptId: otherLease, startedAt: new Date(f.time).toISOString() } });
  assert.ok((await f.store.preview(f.pr)).authorization);
  f.advance({ intent: undefined, deployments: [{ id: "dpl_first", sha, phase: "provisioning" }, { id: "dpl_second", sha, phase: "application" }] });
  assert.ok((await f.store.preview(f.pr)).authorization);
  f.advance({ intent: { sha, phase: "application", attemptId: otherLease, startedAt: new Date(f.time).toISOString() } });
  assert.equal((await f.store.preview(f.pr)).authorization, null, "a third creation intent exceeds the reviewed budget");
  assert.equal(f.posts().length, 2); f.assertNoProviderWrites();
});

test("current lease, feature ref, intent SHA and new deployment SHA must match the reviewed plan", async (t) => {
  quiet(t);
  for (const field of ["lease", "branch", "intent", "deployment"]) await t.test(field, async () => {
    const f = new StoreFixture(), { id } = await f.issue(); await f.decide(id); f.complete();
    f.claim(field === "lease" ? { leaseId: otherLease } : field === "branch" ? { branch: "codex/other" } : {});
    if (field === "intent") f.advance({ intent: { sha: otherSha, phase: "provisioning", attemptId: otherLease, startedAt: new Date(f.time).toISOString() } });
    if (field === "deployment") f.advance({ deployments: [{ id: "dpl_other", sha: otherSha, phase: "provisioning" }] });
    assert.equal((await f.store.preview(f.pr)).authorization, null);
  });
});

test("existing DB plans preserve baseline resources and identity and permit only one additional deployment", async (t) => {
  const messages = quiet(t), f = new StoreFixture(); f.savedDatabase();
  const { id, plan } = await f.issue();
  assert.equal(plan.previousLeaseRecordId, 11); assert.equal(plan.maximumNewDeployments, 1); assert.equal(plan.maximumNewDatabases, 0);
  assert.deepEqual(plan.resources.deploymentIds, ["dpl_baseline"]);
  assert.deepEqual(plan.resources.database, { projectId: QA_NEON_PROJECT_ID, branchId: database.branchId, endpointId: database.endpointId });
  await f.decide(id); f.complete(); f.advance({ deployments: [...replayDeployments(f.records).qa1!.payload.deployments, { id: "dpl_update", sha, phase: "application" }] });
  assert.ok((await f.store.preview(f.pr)).authorization);
  f.advance({ intent: { sha, phase: "application", attemptId: otherLease, startedAt: new Date(f.time).toISOString() } });
  assert.equal((await f.store.preview(f.pr)).authorization, null);
  assert.ok(messages.every((message) => !message.includes(database.host))); f.assertNoProviderWrites();
});

test("missing baseline history, lost IDs and changed saved DB stop authorization", async (t) => {
  quiet(t);
  for (const field of ["baseline", "ids", "database", "host"]) await t.test(field, async () => {
    const f = new StoreFixture(); f.savedDatabase(); const { id } = await f.issue(); await f.decide(id); f.complete();
    if (field === "baseline") f.records.pop();
    else {
      const corrupt = structuredClone(replayDeployments(f.records).qa1!.payload);
      if (field === "ids") corrupt.deployments = [];
      if (field === "database") corrupt.database = { ...database, branchId: "br-other" };
      if (field === "host") corrupt.database = { ...database, host: "ep-owner-store.other.aws.neon.tech" };
      corrupt.sequence++; corrupt.previousRecordId = f.records.at(-1)!.id;
      f.records.push({ id: 12, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload: corrupt });
    }
    await assert.rejects(() => f.store.preview(f.pr)); assert.equal(f.posts().length, 2);
  });
});

test("cleanup reconstructs private host from the exact ledger and publishes only safe complete resource IDs", async (t) => {
  const messages = quiet(t), f = new StoreFixture(), cleanup = f.deleting();
  const { id, plan } = await f.issue("cleanup");
  assert.equal(plan.maximumNewDeployments, 0); assert.equal(plan.maximumNewDatabases, 0);
  assert.deepEqual(plan.resources.deploymentIds, cleanup.deploymentIds); assert.equal(plan.previousLeaseRecordId, 12);
  await f.decide(id); f.complete();
  assert.deepEqual(await f.store.cleanup(cleanup), { known: true, approved: true });
  assert.ok(messages.every((message) => !message.includes(database.host))); f.assertNoProviderWrites();
});

test("cleanup authorization requires every field of the caller's full DeletePlan, including the private host", async (t) => {
  quiet(t);
  const cases: [string, (plan: DeletePlan) => void][] = [
    ["deployment subset", (plan) => { plan.deploymentIds = []; }],
    ["extra deployment", (plan) => { plan.deploymentIds.push("dpl_unapproved"); }],
    ["alias", (plan) => { plan.alias = null; }],
    ["DB omitted", (plan) => { plan.database = null; }],
    ["DB branch", (plan) => { plan.database!.branchId = "br-other"; }],
    ["DB endpoint", (plan) => { plan.database!.endpointId = "ep-other"; }],
    ["private host", (plan) => { plan.database!.host = "ep-owner-store.other.aws.neon.tech"; }],
    ["slot", (plan) => { plan.slot = "qa2"; }],
    ["project", (plan) => { (plan as { projectId: string }).projectId = "other"; }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const f = new StoreFixture(), cleanup = f.deleting(), { id } = await f.issue("cleanup"); await f.decide(id); f.complete();
    const different = structuredClone(cleanup); change(different);
    assert.equal((await f.store.cleanup(different)).approved, false, "partial or altered cleanup manifest must not inherit approval");
    assert.equal(f.posts().length, 2);
  });
});

test("cleanup approval does not extend to resources added to the current deleting ledger", async (t) => {
  quiet(t); const f = new StoreFixture(), cleanup = f.deleting(), { id } = await f.issue("cleanup"); await f.decide(id); f.complete();
  f.advance({ deployments: [...replayDeployments(f.records).qa1!.payload.deployments, { id: "dpl_late", sha, phase: "application" }] });
  assert.equal((await f.store.cleanup(cleanup)).approved, false); assert.equal(f.posts().length, 2);
});

test("all approval pages are replayed and malformed later records cannot fall back to an older approval", async (t) => {
  quiet(t); const f = new StoreFixture(), { id } = await f.issue(); await f.decide(id); f.complete();
  // Other-task rows only fill the page; replay ignores them after authenticated creator validation.
  const fillers = Array.from({ length: 98 }, (_, index) => ({ ...f.events[0], id: 2000 + index, task: "unrelated-task" }));
  f.pages = new Map([[1, [...f.events, ...fillers]], [2, [{ ...f.events[0], id: 3000, payload: { kind: "unknown" } }]]]);
  await assert.rejects(() => f.store.preview(f.pr));
  assert.ok(f.calls.some((call) => call.path === `${prefix}/deployments?task=${QA_APPROVAL_TASK}&per_page=100&page=2`));
  assert.equal(f.posts().length, 2);
});

test("unknown HTTP metadata or ledger provenance holds state without another POST", async (t) => {
  quiet(t);
  const cases: [string, unknown][] = [
    [`${prefix}/branches/main`, new Error("transport unavailable")],
    [`${prefix}/actions/runs/200/attempts/1`, new Error("transport unavailable")],
    [prefix, { full_name: QA_REPOSITORY, owner: { login: "tyask", type: "Organization", id: ownerId } }],
    [`${prefix}/pulls/42`, { response: "unconfirmed" }],
  ];
  for (const [path, fault] of cases) await t.test(path, async () => {
    const f = new StoreFixture(), { id } = await f.issue(); f.faults.set(path, fault);
    const before = structuredClone(f.events); await assert.rejects(() => f.decide(id));
    assert.deepEqual(f.events, before); assert.equal(f.posts().length, 1); assert.deepEqual(f.records, []);
  });
  const f = new StoreFixture(); const { id } = await f.issue(); await f.decide(id); f.complete();
  f.events[1].creator.login = "not-actions" as "github-actions[bot]";
  await assert.rejects(() => f.store.preview(f.pr)); assert.equal(f.posts().length, 2);
});

test("unconfirmed GET during plan issuance or post-approval observation never creates another record", async (t) => {
  quiet(t);
  const initial = new StoreFixture();
  initial.faults.set(`${prefix}/actions/runs/100/attempts/1`, new Error("transport unavailable"));
  await assert.rejects(() => initial.store.requestPlan("preview", initial.pr));
  assert.equal(initial.posts().length, 0); assert.deepEqual(initial.events, []); assert.deepEqual(initial.records, []);
  const f = new StoreFixture(), { id } = await f.issue(); await f.decide(id); f.complete();
  f.faults.set(`${prefix}/actions/runs/200/attempts/1`, new Error("transport unavailable"));
  const before = structuredClone(f.events);
  await assert.rejects(() => f.store.preview(f.pr));
  assert.deepEqual(f.events, before); assert.equal(f.posts().length, 2);
});

test("malformed HTTP evidence containing private sentinels yields only the fixed diagnostic", async (t) => {
  const messages = quiet(t), f = new StoreFixture(), { id } = await f.issue();
  const privateSentinel = "owner-store-private-token";
  f.faults.set(`${prefix}/pulls/42`, { error: `${privateSentinel}:${database.host}` });
  await assert.rejects(() => f.decide(id), (error: unknown) => {
    const diagnostic = `${String(error)} ${JSON.stringify(error)}`;
    assert.equal(diagnostic.includes(privateSentinel), false); assert.equal(diagnostic.includes(database.host), false);
    assert.match(diagnostic, /QA承認の実行元・現在計画を確認できません/);
    return true;
  });
  assert.equal(f.posts().length, 1); assert.ok(messages.every((message) => !message.includes(privateSentinel) && !message.includes(database.host)));
});

test("official finite caller and reusable workflow suffixes accept independent exact main SHA and ref evidence", async (t) => {
  quiet(t);
  const callerRefs = [null, "main", "refs/heads/main", mainSha];
  const reusableRefs = ["main", "refs/heads/main", mainSha];
  for (const callerRef of callerRefs) for (const reusableRef of reusableRefs) await t.test(`${callerRef ?? "no suffix"} / ${reusableRef}`, async () => {
    const f = new StoreFixture(), request = f.runs.get(100)!;
    const caller = callerRef === null ? QA_APPROVAL_WORKFLOW : `${QA_APPROVAL_WORKFLOW}@${callerRef}`;
    const reusable = `${QA_REPOSITORY}/.github/workflows/qa-private-run.yml@${reusableRef}`;
    request.path = caller; request.referenced_workflows[0].path = reusable;
    await f.store.requestPlan("preview", f.pr);
    const id = f.events[0].id;
    f.env.GITHUB_RUN_ID = "200"; f.time++;
    const approval = { ...run(200, `Cake QA approve ${id}`), status: "in_progress", conclusion: null };
    approval.path = caller; approval.referenced_workflows[0].path = reusable;
    f.runs.set(200, approval); await f.store.decide(id, "approved"); f.complete();
    assert.ok((await f.store.preview(f.pr)).authorization); f.assertNoProviderWrites();
  });
});

test("arbitrary workflow suffixes, missing reusable suffix and independent ref or SHA mismatch reject before POST", async (t) => {
  quiet(t);
  const cases: [string, (raw: RawRun) => void][] = [
    ["caller feature suffix", (raw) => { raw.path = `${QA_APPROVAL_WORKFLOW}@codex/owner-store`; }],
    ["caller arbitrary refs suffix", (raw) => { raw.path = `${QA_APPROVAL_WORKFLOW}@refs/heads/other`; }],
    ["caller different SHA suffix", (raw) => { raw.path = `${QA_APPROVAL_WORKFLOW}@${otherSha}`; }],
    ["caller lookalike suffix", (raw) => { raw.path = `${QA_APPROVAL_WORKFLOW}@main/extra`; }],
    ["reusable feature suffix", (raw) => { raw.referenced_workflows[0].path = `${QA_REPOSITORY}/.github/workflows/qa-private-run.yml@codex/owner-store`; }],
    ["reusable different SHA suffix", (raw) => { raw.referenced_workflows[0].path = `${QA_REPOSITORY}/.github/workflows/qa-private-run.yml@${otherSha}`; }],
    ["reusable missing suffix", (raw) => { raw.referenced_workflows[0].path = `${QA_REPOSITORY}/.github/workflows/qa-private-run.yml`; }],
    ["accepted path with wrong independent ref", (raw) => { raw.referenced_workflows[0].path = `${QA_REPOSITORY}/.github/workflows/qa-private-run.yml@main`; raw.referenced_workflows[0].ref = "refs/heads/other"; }],
    ["accepted path with wrong independent SHA", (raw) => { raw.referenced_workflows[0].path = `${QA_REPOSITORY}/.github/workflows/qa-private-run.yml@main`; raw.referenced_workflows[0].sha = otherSha; }],
    ["accepted paths with wrong event head", (raw) => { raw.path = `${QA_APPROVAL_WORKFLOW}@main`; raw.referenced_workflows[0].path = `${QA_REPOSITORY}/.github/workflows/qa-private-run.yml@main`; raw.head_sha = otherSha; }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const f = new StoreFixture(); change(f.runs.get(100)!);
    await assert.rejects(() => f.store.requestPlan("preview", f.pr));
    assert.equal(f.posts().length, 0); assert.deepEqual(f.events, []); assert.deepEqual(f.records, []);
  });
});

test("safe plan issuance tolerates unproved CI, while both current-head CI events are mandatory for approval", async (t) => {
  quiet(t);
  const cases: [string, (runs: CiRun[], index: number) => void][] = [
    ["missing", (runs, index) => { runs.splice(index, 1); }],
    ["pending", (runs, index) => { runs[index].status = "in_progress"; runs[index].conclusion = null; }],
    ["failure", (runs, index) => { runs[index].conclusion = "failure"; }],
    ["wrong head", (runs, index) => { runs[index].head_sha = otherSha; }],
    ["wrong branch", (runs, index) => { runs[index].head_branch = "codex/other"; }],
    ["fork", (runs, index) => { runs[index].head_repository.full_name = "other/Cake"; }],
    ["forged source repository", (runs, index) => { runs[index].repository.full_name = "other/Cake"; }],
    ["wrong workflow", (runs, index) => { runs[index].path = ".github/workflows/other.yml"; }],
    ["wrong workflow suffix", (runs, index) => { runs[index].path = ".github/workflows/ci.yml@other"; }],
    ["invalid run ID", (runs, index) => { runs[index].id = 0; }],
    ["latest failure", (runs, index) => { runs.push({ ...structuredClone(runs[index]), id: 700, conclusion: "failure" }); }],
  ];
  for (const event of ["push", "pull_request"] as const) for (const [name, change] of cases) await t.test(`${event}: ${name}`, async () => {
    const f = new StoreFixture(); change(f.ciRuns, event === "push" ? 0 : 1);
    const { id } = await f.issue();
    assert.equal(f.calls.some((call) => call.path === ciPath()), false, "informational plan issuance must not claim CI proof");
    assert.equal((await f.store.states()).get(id)?.status, "PENDING");
    await assert.rejects(() => f.decide(id));
    assert.equal(f.posts().length, 1); assert.deepEqual(f.records, []);
    assert.equal(f.calls.find((call) => call.path === ciPath())?.method, "GET");
  });
  await t.test("pull_request not linked to reviewed PR", async () => {
    const f = new StoreFixture(); f.ciRuns[1].pull_requests = [{ number: 43 }];
    const { id } = await f.issue(); await assert.rejects(() => f.decide(id)); assert.equal(f.posts().length, 1);
  });
});

test("fresh CI observation is mandatory after approval; general PR reads and cleanup remain independent", async (t) => {
  quiet(t);
  for (const event of ["push", "pull_request"] as const) await t.test(event, async () => {
    const f = new StoreFixture(), { id } = await f.issue(); await f.decide(id); f.complete();
    assert.ok((await f.store.preview(f.pr)).authorization);
    f.ciRuns.push({ ...ciRun(700, event), status: "queued", conclusion: null });
    const before = structuredClone(f.events);
    await assert.rejects(() => f.store.preview(f.pr));
    assert.ok((await f.store.preview(f.pr, false)).authorization, "read-only PR discovery does not require creation CI");
    assert.deepEqual(f.events, before); assert.equal(f.posts().length, 2);
  });
  const f = new StoreFixture(), cleanup = f.deleting(), { id } = await f.issue("cleanup");
  f.faults.set(ciPath(), new Error("CI unavailable"));
  await f.decide(id); f.complete();
  assert.equal((await f.store.cleanup(cleanup)).approved, true);
  assert.equal(f.calls.some((call) => call.path === ciPath()), false, "cleanup authorization must not depend on CI availability");
});

test("CI pagination finds higher-ID failure on a later page and accepts only exact official CI paths", async (t) => {
  quiet(t);
  const f = new StoreFixture(), { id } = await f.issue();
  f.ciPages = new Map([[1, Array.from({ length: 100 }, (_, index) => ciRun(600 + index, index % 2 ? "push" : "pull_request"))],
    [2, [{ ...ciRun(900, "pull_request"), conclusion: "failure" }]]]);
  await assert.rejects(() => f.decide(id));
  assert.equal(f.calls.find((call) => call.path === ciPath(2))?.method, "GET"); assert.equal(f.posts().length, 1);
  for (const suffix of [null, sha, "codex/owner-store"]) await t.test(suffix ?? "no suffix", async () => {
    const accepted = new StoreFixture(), request = await accepted.issue();
    for (const item of accepted.ciRuns) item.path = suffix === null ? ".github/workflows/ci.yml" : `.github/workflows/ci.yml@${suffix}`;
    await accepted.decide(request.id); accepted.complete(); assert.ok((await accepted.store.preview(accepted.pr)).authorization);
  });
});

test("an active reviewed PR in another slot and lease rejects the empty reviewed slot", async (t) => {
  quiet(t); const f = new StoreFixture(), { id } = await f.issue(); await f.decide(id); f.complete();
  const other = claimRecord(replayDeployments(f.records), { pr: 42, branch: f.pr.branch, sha, leaseId: otherLease, slot: "qa2",
    now: new Date(f.time).toISOString() })!;
  f.add(other);
  assert.equal(replayDeployments(f.records).qa1, null);
  assert.equal((await f.store.preview(f.pr)).authorization, null);
  assert.equal(f.posts().length, 2); assert.equal(replayDeployments(f.records).qa2?.payload.leaseId, otherLease);
});

test("an unresolved creation intent is retained and cannot issue a new plan", async (t) => {
  quiet(t); const f = new StoreFixture(); f.claim();
  f.advance({ intent: { sha, phase: "provisioning", attemptId: otherLease, startedAt: new Date(f.time).toISOString() } });
  const before = structuredClone(f.records);
  await assert.rejects(() => f.store.requestPlan("preview", f.pr));
  assert.deepEqual(f.records, before); assert.equal(f.posts().length, 0); assert.deepEqual(f.events, []);
});

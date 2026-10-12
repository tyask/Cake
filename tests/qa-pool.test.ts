import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  claimRecord, nextRecord, parseLeaseRecord, replayDeployments, QA_ENVIRONMENT, QA_TASK, QA_NEON_PROJECT_ID,
  type QaLeaseRecord, type GithubDeployment, type SavedLease, type Pool,
} from "../lib/qa-pool";

const sha = "a".repeat(40);
const now = "2026-10-12T00:00:00Z";
const token = "00000000-0000-4000-8000-000000000001";
const pool = (): Pool => ({ qa1: null, qa2: null, qa3: null });
const lease = (): QaLeaseRecord => claimRecord(pool(), { pr: 34, branch: "codex/task", sha, leaseId: token, now })!;
const entry = (id: number, payload: QaLeaseRecord): GithubDeployment => ({ id, task: QA_TASK, environment: QA_ENVIRONMENT, sha: payload.headSha, payload });
const saved = (): SavedLease => ({ id: 1, payload: lease() });
const db = { projectId: QA_NEON_PROJECT_ID, branchId: "br-one", endpointId: "ep-one", host: "ep-one.ap-southeast-1.aws.neon.tech" } as const;

test("full pool leaves a fourth PR waiting; a held or deleting lease is never overwritten", () => {
  const p = pool();
  for (let i = 0; i < 3; i++) {
    const record = claimRecord(p, { pr: 34 + i, branch: `codex/task-${i}`, sha, leaseId: `00000000-0000-4000-8000-00000000000${i + 1}`, now })!;
    p[record.slot] = { id: i + 1, payload: record };
  }
  assert.equal(claimRecord(p, { pr: 99, branch: "codex/fourth", sha, leaseId: token, now }), null);
  assert.throws(() => claimRecord(p, { pr: 34, branch: "codex/task", sha, leaseId: token, now }), /既に/);
  p.qa1 = { id: 4, payload: nextRecord(p.qa1!, { state: "deleting" }, now) };
  assert.equal(claimRecord(p, { pr: 99, branch: "codex/fourth", sha, leaseId: token, now }), null);
});

test("same PR push advances full SHA and retains lease, slot, and database", () => {
  const first = saved();
  const withDb = { id: 2, payload: nextRecord(first, { database: db }, now) };
  const next = nextRecord(withDb, { headSha: "b".repeat(40) }, now);
  assert.equal(next.leaseId, token);
  assert.equal(next.slot, "qa1");
  assert.deepEqual(next.database, db);
  assert.throws(() => nextRecord(withDb, { database: { ...db, branchId: "br-other" } }, now), /識別子/);
  assert.throws(() => nextRecord(withDb, { leaseId: "00000000-0000-4000-8000-000000000002" }, now), /古いlease/);
});

test("API JSON key order and omitted undefined fields do not invalidate the same database or lease", () => {
  const first = { id: 2, payload: nextRecord(saved(), { database: db }, now) };
  const reordered = { host: db.host, endpointId: db.endpointId, branchId: db.branchId, projectId: db.projectId };
  const next = nextRecord(first, { database: reordered, intent: undefined, aliasSha: undefined }, now);
  assert.deepEqual(next.database, db);
  assert.equal(Object.hasOwn(next, "intent"), false);
  assert.deepEqual(parseLeaseRecord(JSON.parse(JSON.stringify(next))), next);
});

test("release requires deleting and preserves retired DB identity for the next lease", () => {
  const first = { id: 2, payload: nextRecord(saved(), { database: db }, now) };
  assert.throws(() => nextRecord(first, { state: "free", retiredDatabases: [db] }, now), /状態遷移/);
  const deleting = { id: 3, payload: nextRecord(first, { state: "deleting" }, now) };
  assert.throws(() => nextRecord(deleting, { state: "held" }, now), /状態遷移/);
  assert.throws(() => nextRecord(deleting, { state: "free" }, now), /識別情報/);
  const free = { id: 4, payload: nextRecord(deleting, { state: "free", retiredDatabases: [db] }, now) };
  const p = pool(); p.qa1 = free;
  const newRecord = claimRecord(p, { pr: 35, branch: "codex/new-task", sha, leaseId: "00000000-0000-4000-8000-000000000002", now })!;
  assert.throws(() => nextRecord({ id: 5, payload: newRecord }, { database: db }, now), /再利用/);
  assert.throws(() => claimRecord(p, { pr: 34, branch: "codex/task", sha, leaseId: "00000000-0000-4000-8000-000000000002", now }), /新しいPR枝/);
});

test("every snapshot is replayed by ID; statuses and ordinary Vercel deployment records cannot free leases", () => {
  const first = lease(), next = nextRecord({ id: 1, payload: first }, { headSha: "b".repeat(40) }, now);
  const ordinary = { id: 999, task: "deploy", environment: "Preview", sha, payload: {} };
  const p = replayDeployments([{ ...entry(2, next), statuses: [{ state: "inactive" }] } as GithubDeployment, ordinary, entry(1, first)]);
  assert.equal(p.qa1!.payload.state, "held");
  assert.equal(p.qa1!.payload.headSha, "b".repeat(40));
  assert.throws(() => replayDeployments([entry(1, first), entry(3, { ...next, previousRecordId: 88 })]), /系列/);
  assert.throws(() => replayDeployments([entry(1, first), entry(3, { ...next, leaseId: "00000000-0000-4000-8000-000000000002" })]), /古いlease/);
  assert.throws(() => replayDeployments([entry(1, first), entry(1, first)]), /記録/);
  assert.throws(() => replayDeployments([{ ...entry(1, first), sha: "b".repeat(40) }]), /SHA/);
});

test("malformed IDs, payloads, shortened SHAs and unrecorded READY deployments fail closed", () => {
  for (const change of [
    { protocol: "cake-qa/v2" }, { slot: "qa4" }, { headSha: "a123" }, { leaseId: "legacy" },
    { branch: "qa1" }, { pr: 0 }, { state: "inactive" }, { database: { ...db, projectId: "production" } },
    { readyDeploymentId: "dpl_unrecorded" }, { aliasSha: sha }, { credentials: "forbidden" },
  ]) assert.throws(() => parseLeaseRecord({ ...lease(), ...change }));
});

test("all failed and successful deployment IDs survive snapshots for complete cleanup", () => {
  const first = saved();
  const deployments = [{ id: "dpl_failed", sha, phase: "provisioning" as const }, { id: "dpl_ready", sha, phase: "application" as const }];
  const withIds = { id: 2, payload: nextRecord(first, { database: db, deployments }, now) };
  assert.throws(() => nextRecord(withIds, { deployments: deployments.slice(1) }, now), /削除対象/);
  assert.equal(nextRecord(withIds, { state: "deleting" }, now).deployments.length, 2);
});

test("lease tokens and deployment IDs have a single owner across the entire history", () => {
  const first = lease();
  const second = { ...lease(), slot: "qa2" as const, pr: 35, branch: "codex/second" };
  assert.throws(() => replayDeployments([entry(1, first), entry(2, second)]), /token/);
  second.leaseId = "00000000-0000-4000-8000-000000000002";
  const attached = nextRecord({ id: 1, payload: first }, { deployments: [{ id: "dpl_shared", sha, phase: "provisioning" }] }, now);
  const attached2 = nextRecord({ id: 2, payload: second }, { deployments: [{ id: "dpl_shared", sha, phase: "provisioning" }] }, now);
  assert.throws(() => replayDeployments([entry(1, first), entry(2, second), entry(3, attached), entry(4, attached2)]), /共有/);
});

test("auto Git deployment only permits main and denies slash-containing feature branches", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.git.deploymentEnabled, { "**": false, main: true });
  const workflow = readFileSync(new URL("../.github/workflows/qa-pool.yml", import.meta.url), "utf8");
  assert.match(workflow, /queue: max/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /ref: refs\/heads\/main/);
  assert.match(workflow, /CAKE_QA_POOL_ENABLED/);
});

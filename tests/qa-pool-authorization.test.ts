import test from "node:test";
import assert from "node:assert/strict";
import {
  deletePlan, deletionApproval, probeApproval,
  type DeleteApproval, type DeletePlan, type ProbeApproval,
} from "../lib/qa-pool-authorization";
import {
  nextRecord, parseLeaseRecord, qaAlias, QA_NEON_PROJECT_ID, QA_PROJECT_ID,
  type DatabaseIdentity, type QaLeaseRecord,
} from "../lib/qa-pool";

const sha = "a".repeat(40), otherSha = "b".repeat(40);
const now = Date.parse("2026-10-12T01:00:00.000Z");
const expiresAt = "2026-10-12T02:00:00.000Z";
const leaseId = "00000000-0000-4000-8000-000000000042";
const database: DatabaseIdentity = {
  projectId: QA_NEON_PROJECT_ID, branchId: "br-native", endpointId: "ep-native",
  host: "ep-native.ap-southeast-1.aws.neon.tech",
};
const json = (value: unknown) => JSON.stringify(value);
function probe(): ProbeApproval {
  return { projectId: QA_PROJECT_ID, pr: 42, sha, slot: "qa2", expiresAt };
}
function lease(): QaLeaseRecord {
  return {
    protocol: "cake-qa/v1", slot: "qa2", leaseId, pr: 42, branch: "codex/task-42", headSha: sha,
    state: "held", createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z",
    sequence: 1, previousRecordId: null, retiredDatabases: [], database: structuredClone(database),
    deployments: [
      { id: "dpl_provisioning", sha, phase: "provisioning" },
      { id: "dpl_application", sha, phase: "application" },
    ],
  };
}
function plan(): DeletePlan { return deletePlan(lease()); }
function approval(target = plan()): DeleteApproval {
  return { ...structuredClone(target), expiresAt };
}

test("限定probeは承認済みPR・完全SHA・固定slotを返し、同じ承認で再試行できる", () => {
  const approved = probe(), settings = json([approved]);
  assert.deepEqual(probeApproval(settings, 42, sha, now), approved);
  assert.deepEqual(probeApproval(settings, 42, sha, now + 1), approved);
  assert.equal(probeApproval(settings, 43, sha, now), null);
  assert.equal(probeApproval(settings, 42, otherSha, now), null);
});

test("probeの未設定・空配列・期限切れ・期限と同時刻は生成を許可しない", () => {
  for (const settings of [undefined, "", "  ", "[]"]) {
    assert.equal(probeApproval(settings, 42, sha, now), null);
  }
  for (const deadline of ["2026-10-12T00:59:59.999Z", new Date(now).toISOString()]) {
    assert.equal(probeApproval(json([{ ...probe(), expiresAt: deadline }]), 42, sha, now), null);
  }
  assert.equal(probeApproval(json([probe()]), 42, sha, Number.NaN), null);
});

test("JSON配列以外の設定や包括booleanではprobeも削除も承認されない", () => {
  for (const settings of ["true", "false", "null", "{}", "{", json(probe())]) {
    assert.throws(() => probeApproval(settings, 42, sha, now), /JSON配列/);
    assert.throws(() => deletionApproval(settings, plan(), now), /JSON配列/);
  }
  assert.throws(() => probeApproval("[true]", 42, sha, now), /probe承認/);
  assert.equal(deletionApproval("[true]", plan(), now), false);
  assert.equal(deletionApproval(json([{ enabled: true, deleteApproved: true }]), plan(), now), false);
});

test("probeは必須情報欠落・別project・短いSHA・不正slot・未知keyを拒否する", () => {
  const invalid: unknown[] = [
    null, [], { ...probe(), projectId: "prj_other" }, { ...probe(), pr: 0 },
    { ...probe(), pr: 42.5 }, { ...probe(), sha: sha.slice(0, 7) }, { ...probe(), sha: sha.toUpperCase() },
    { ...probe(), slot: "qa4" }, { ...probe(), slot: "*" }, { ...probe(), expiresAt: "not-a-time" },
    { ...probe(), broad: true },
  ];
  for (const field of ["projectId", "pr", "sha", "slot", "expiresAt"] as const) {
    const partial: Record<string, unknown> = { ...probe() };
    delete partial[field];
    invalid.push(partial);
  }
  for (const value of invalid) {
    assert.throws(() => probeApproval(json([value]), 42, sha, now), /probe承認/, json(value));
  }
  // An unrelated malformed approval must not disappear behind the matching entry.
  assert.throws(() => probeApproval(json([probe(), { ...probe(), pr: 43, broad: true }]), 42, sha, now), /probe承認/);
});

test("同じPR・SHAへの有効probe承認が複数slotにある場合は曖昧な生成を拒否する", () => {
  assert.throws(() => probeApproval(json([probe(), { ...probe(), slot: "qa1" }]), 42, sha, now), /重複/);
  assert.throws(() => probeApproval(json([probe(), probe()]), 42, sha, now), /重複/);
  assert.deepEqual(probeApproval(json([
    { ...probe(), expiresAt: new Date(now).toISOString() }, probe(), { ...probe(), pr: 43 },
  ]), 42, sha, now), probe());
});

test("削除manifestは全記録deploymentを昇順に保持し、通常leaseだけ固定aliasを含む", () => {
  const record = lease(), before = structuredClone(record);
  const expected: DeletePlan = {
    projectId: QA_PROJECT_ID, pr: 42, slot: "qa2", leaseId, headSha: sha,
    deploymentIds: ["dpl_application", "dpl_provisioning"], alias: qaAlias("qa2"), database,
  };
  assert.deepEqual(deletePlan(record), expected);
  assert.deepEqual(record, before);
  assert.deepEqual(deletePlan({ ...record, purpose: "probe" }), { ...expected, alias: null });
  assert.deepEqual(deletePlan({ ...record, deployments: [], database: undefined }), {
    ...expected, deploymentIds: [], database: null,
  });
});

test("削除承認はmanifest全体に一致し、再試行と配列順・JSON key順の違いを許容する", () => {
  const target = plan();
  const reordered = {
    expiresAt, database: {
      host: database.host, endpointId: database.endpointId, branchId: database.branchId, projectId: database.projectId,
    },
    alias: target.alias, deploymentIds: [...target.deploymentIds].reverse(), headSha: sha,
    leaseId, slot: "qa2", pr: 42, projectId: QA_PROJECT_ID,
  };
  const settings = json([reordered]);
  assert.equal(deletionApproval(settings, target, now), true);
  assert.equal(deletionApproval(settings, target, now + 1), true);
  assert.deepEqual(target.deploymentIds, ["dpl_application", "dpl_provisioning"]);
});

test("削除承認のproject・PR・slot・lease・完全HEAD・aliasの変更は対象を広げない", () => {
  const target = plan();
  for (const change of [
    { projectId: "prj_other" }, { pr: 43 }, { slot: "qa1" },
    { leaseId: "00000000-0000-4000-8000-000000000043" }, { headSha: otherSha },
    { headSha: sha.slice(0, 7) }, { alias: qaAlias("qa1") }, { alias: null }, { alias: "*" },
  ]) {
    assert.equal(deletionApproval(json([{ ...approval(target), ...change }]), target, now), false, json(change));
  }
});

test("削除承認はdeployment IDの部分集合・上位集合・重複・wildcardを拒否する", () => {
  const target = plan();
  for (const ids of [
    [], ["dpl_application"], [...target.deploymentIds, "dpl_extra"],
    [...target.deploymentIds, "dpl_application"], ["*"], ["dpl_*"], [42],
  ]) {
    assert.equal(deletionApproval(json([{ ...approval(target), deploymentIds: ids }]), target, now), false, json(ids));
  }
  assert.equal(deletionApproval(json([approval(target)]), { ...target, deploymentIds: [...target.deploymentIds, "dpl_new"] }, now), false);
});

test("削除承認の期限切れ・期限欠落・部分情報・未知keyは削除を許可しない", () => {
  const target = plan();
  for (const deadline of ["not-a-time", new Date(now).toISOString(), "2026-10-12T00:59:59.999Z"]) {
    assert.equal(deletionApproval(json([{ ...approval(target), expiresAt: deadline }]), target, now), false);
  }
  for (const field of Object.keys(approval(target))) {
    const partial: Record<string, unknown> = { ...approval(target) };
    delete partial[field];
    assert.equal(deletionApproval(json([partial]), target, now), false, field);
  }
  assert.equal(deletionApproval(json([{ ...approval(target), deleteAll: true }]), target, now), false);
  assert.equal(deletionApproval(undefined, target, now), false);
  assert.equal(deletionApproval(json([approval(target)]), target, Number.NaN), false);
});

test("削除承認はDBのproject・branch・endpoint・host全てを照合する", () => {
  const target = plan();
  const invalid: unknown[] = [
    null, {}, [], { ...database, projectId: "other-neon-project" },
    { ...database, branchId: "br-other" }, { ...database, endpointId: "ep-other" },
    { ...database, host: "ep-other.ap-southeast-1.aws.neon.tech" },
    { ...database, extra: "unreviewed" },
  ];
  for (const field of Object.keys(database)) {
    const partial: Record<string, unknown> = { ...database };
    delete partial[field];
    invalid.push(partial);
  }
  for (const value of invalid) {
    assert.equal(deletionApproval(json([{ ...approval(target), database: value }]), target, now), false, json(value));
  }
});

test("probe削除のalias nullと未生成leaseのDB nullは明示一致が必要", () => {
  const probeTarget = deletePlan({ ...lease(), purpose: "probe" });
  assert.equal(deletionApproval(json([approval(probeTarget)]), probeTarget, now), true);
  assert.equal(deletionApproval(json([{ ...approval(probeTarget), alias: qaAlias("qa2") }]), probeTarget, now), false);
  const empty = deletePlan({ ...lease(), deployments: [], database: undefined, purpose: "probe" });
  assert.equal(deletionApproval(json([approval(empty)]), empty, now), true);
  assert.equal(deletionApproval(json([{ ...approval(empty), database }]), empty, now), false);
  assert.equal(deletionApproval(json([approval(empty)]), { ...empty, deploymentIds: ["dpl_new"] }, now), false);
});

test("型を迂回した不正manifestも削除承認の境界で拒否する", () => {
  const target = plan();
  const invalid: unknown[] = [
    { ...target, projectId: "prj_other" }, { ...target, pr: 0 }, { ...target, pr: 42.5 },
    { ...target, slot: "qa4" }, { ...target, leaseId: "*" }, { ...target, headSha: sha.slice(0, 7) },
    { ...target, deploymentIds: ["dpl_application", "dpl_application"] },
    { ...target, deploymentIds: ["*"] }, { ...target, alias: qaAlias("qa1") },
    { ...target, database: null }, { ...target, database: {} },
    { ...target, database: { ...database, projectId: "other-neon-project" } },
    { ...target, database: { ...database, host: "ep-other.ap-southeast-1.aws.neon.tech" } },
    { ...target, database: { ...database, extra: true } },
  ];
  for (const value of invalid) {
    const malformed = value as DeletePlan;
    assert.equal(deletionApproval(json([{ ...malformed, expiresAt }]), malformed, now), false, json(value));
  }
});

test("probe用途は同じleaseで変更できず、alias SHAを記録できない", () => {
  const record = parseLeaseRecord({ ...lease(), purpose: "probe" });
  const saved = { id: 1, payload: record };
  assert.throws(() => nextRecord(saved, { purpose: undefined }, new Date(now).toISOString()), /用途/);
  assert.throws(() => nextRecord({ id: 1, payload: lease() }, { purpose: "probe" }, new Date(now).toISOString()), /用途/);
  assert.throws(() => parseLeaseRecord({
    ...record, readyDeploymentId: "dpl_application", aliasSha: sha,
  }), /alias記録/);
  const updated = nextRecord(saved, { headSha: otherSha }, new Date(now).toISOString());
  assert.equal(updated.purpose, "probe");
  assert.deepEqual(updated.database, database);
  assert.equal(updated.leaseId, leaseId);
});

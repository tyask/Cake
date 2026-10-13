import test from "node:test";
import assert from "node:assert/strict";
import {
  deletionApproval, diagnoseDeletionApproval,
  type DeleteApproval, type DeletePlan, type DeletionApprovalDiagnosis,
} from "../lib/qa-pool-authorization";
import { QA_NEON_PROJECT_ID, QA_PROJECT_ID, qaAlias } from "../lib/qa-pool";

const now = Date.parse("2026-10-13T07:00:00.000Z");
const future = "2026-10-13T08:00:00.000Z", past = "2026-10-13T06:00:00.000Z";
const sha = "a".repeat(40), leaseId = "00000000-0000-4000-8000-000000000042";
function plan(): DeletePlan {
  return { projectId: QA_PROJECT_ID, pr: 42, slot: "qa1", leaseId, headSha: sha,
    deploymentIds: ["dpl_application", "dpl_provisioning"], alias: qaAlias("qa1"),
    database: { projectId: QA_NEON_PROJECT_ID, branchId: "br-diagnostic", endpointId: "ep-diagnostic",
      host: "ep-diagnostic.mock.aws.neon.tech" } };
}
function approval(target = plan(), expiresAt = future): DeleteApproval { return { ...structuredClone(target), expiresAt }; }
const json = (value: unknown) => JSON.stringify(value);
const denied = (expiry: "NO_MATCH" | "EXPIRED" | "INVALID", reason: DeletionApprovalDiagnosis["reason"], matches: boolean): DeletionApprovalDiagnosis => ({
  valid: true, matches, expiry, decision: "DENIED", reason,
});
const allowed: DeletionApprovalDiagnosis = { valid: true, matches: true, expiry: "ACTIVE", decision: "ALLOWED", reason: "ACTIVE_APPROVAL" };

test("unset, empty and whitespace settings are valid empty arrays with no target match", () => {
  for (const text of [undefined, "", " \n\t ", "[]"]) {
    assert.deepEqual(diagnoseDeletionApproval(text, plan(), now), denied("NO_MATCH", "NO_TARGET_MATCH", false));
    assert.equal(deletionApproval(text, plan(), now), false);
  }
});

test("malformed JSON and non-array values report validation errors without changing the validator's throw", () => {
  for (const text of ["{", "[", "```json\n[]\n```", "[trailing,]"]) {
    assert.deepEqual(diagnoseDeletionApproval(text, plan(), now), {
      valid: false, matches: null, expiry: "UNCONFIRMED", decision: "VALIDATION_ERROR", reason: "INVALID_JSON",
    });
    assert.throws(() => deletionApproval(text, plan(), now), /JSON配列/);
  }
  for (const text of ["null", "true", "42", "{}", json(approval()), json(json([approval()]))]) {
    assert.deepEqual(diagnoseDeletionApproval(text, plan(), now), {
      valid: false, matches: null, expiry: "UNCONFIRMED", decision: "VALIDATION_ERROR", reason: "NOT_ARRAY",
    });
    assert.throws(() => deletionApproval(text, plan(), now), /JSON配列/);
  }
});

test("a missing or partial private plan cannot fabricate a target or an allowed decision", () => {
  for (const text of [undefined, "[]", json([approval()])]) {
    assert.deepEqual(diagnoseDeletionApproval(text, undefined, now), {
      valid: true, matches: null, expiry: "UNCONFIRMED", decision: "UNCONFIRMED", reason: "PLAN_UNCONFIRMED",
    });
  }
  const publicDatabase = { projectId: QA_NEON_PROJECT_ID, branchId: "br-diagnostic", endpointId: "ep-diagnostic" };
  for (const target of [null, {}, { ...plan(), database: publicDatabase }, { ...plan(), deploymentIds: ["dpl_application", "dpl_application"] }]) {
    assert.deepEqual(diagnoseDeletionApproval(json([approval()]), target as DeletePlan, now), {
      valid: true, matches: null, expiry: "UNCONFIRMED", decision: "UNCONFIRMED", reason: "PLAN_INVALID",
    });
  }
});

test("only one captured finite clock is used, including the exact expiry boundary", () => {
  for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(diagnoseDeletionApproval(json([approval()]), plan(), clock), {
      valid: true, matches: null, expiry: "UNCONFIRMED", decision: "UNCONFIRMED", reason: "CLOCK_UNCONFIRMED",
    });
  }
  const original = Date.now;
  let reads = 0;
  Date.now = () => now + reads++;
  try {
    assert.deepEqual(diagnoseDeletionApproval(json([approval(plan(), new Date(now + 1).toISOString())]), plan()), allowed);
    assert.equal(reads, 1);
  } finally { Date.now = original; }
  assert.deepEqual(diagnoseDeletionApproval(json([approval(plan(), new Date(now).toISOString())]), plan(), now), denied("EXPIRED", "EXPIRED_APPROVAL", true));
});

test("future, expired, invalid and missing expiry are distinguished from target mismatch", () => {
  assert.deepEqual(diagnoseDeletionApproval(json([approval()]), plan(), now), allowed);
  assert.deepEqual(diagnoseDeletionApproval(json([approval(plan(), past)]), plan(), now), denied("EXPIRED", "EXPIRED_APPROVAL", true));
  for (const expiresAt of ["not-a-time", "", null, 42]) {
    const text = json([{ ...approval(), expiresAt }]);
    assert.deepEqual(diagnoseDeletionApproval(text, plan(), now), denied("INVALID", "INVALID_EXPIRY", true));
    assert.equal(deletionApproval(text, plan(), now), false);
  }
  const missing: Record<string, unknown> = { ...approval() }; delete missing.expiresAt;
  assert.deepEqual(diagnoseDeletionApproval(json([missing]), plan(), now), denied("INVALID", "INVALID_EXPIRY", true));
});

test("all target fields, the complete deployment set and exact private DB identity must match", () => {
  const target = plan(), valid = approval(target);
  const differences = [
    { projectId: "prj_other" }, { pr: 43 }, { slot: "qa2" }, { leaseId: "00000000-0000-4000-8000-000000000043" },
    { headSha: "b".repeat(40) }, { deploymentIds: ["dpl_application"] },
    { deploymentIds: [...target.deploymentIds, "dpl_unrecorded"] }, { deploymentIds: ["dpl_application", "dpl_application"] },
    { alias: null }, { alias: qaAlias("qa2") }, { database: null },
    { database: { ...target.database, projectId: "other-project" } },
    { database: { ...target.database, branchId: "br-other" } },
    { database: { ...target.database, endpointId: "ep-other", host: "ep-other.mock.aws.neon.tech" } },
    { database: { ...target.database, host: "ep-diagnostic.other.aws.neon.tech" } },
    { database: { ...target.database, host: "[redacted]" } }, { unknown: true },
  ];
  for (const [index, difference] of differences.entries()) {
    const text = json([{ ...valid, ...difference }]);
    assert.deepEqual(diagnoseDeletionApproval(text, target, now), denied("NO_MATCH", "NO_TARGET_MATCH", false), `difference ${index}`);
    assert.equal(deletionApproval(text, target, now), false, `difference ${index}`);
  }
  for (const field of Object.keys(target)) {
    const partial: Record<string, unknown> = { ...valid }; delete partial[field];
    assert.deepEqual(diagnoseDeletionApproval(json([partial]), target, now), denied("NO_MATCH", "NO_TARGET_MATCH", false), field);
  }
});

test("matching tolerates object key and deployment array order without changing inputs", () => {
  const target = plan(), before = structuredClone(target);
  Object.freeze(target.deploymentIds); Object.freeze(target.database); Object.freeze(target);
  const reordered = { expiresAt: future, database: { host: before.database!.host, endpointId: before.database!.endpointId,
    branchId: before.database!.branchId, projectId: before.database!.projectId }, alias: before.alias,
    deploymentIds: [...before.deploymentIds].reverse(), headSha: sha, leaseId, slot: "qa1", pr: 42, projectId: QA_PROJECT_ID };
  assert.deepEqual(diagnoseDeletionApproval(json([reordered]), target, now), allowed);
  assert.equal(deletionApproval(json([reordered]), target, now), true);
  assert.deepEqual(target, before);
});

test("mixed malformed or unrelated entries preserve existing some acceptance in either order", () => {
  const valid = approval();
  for (const other of [null, [], true, 42, {}, { ...valid, pr: 43 }, { ...valid, unknown: true }, { ...valid, database: {} }]) {
    for (const values of [[other, valid], [valid, other]]) {
      const text = json(values);
      assert.deepEqual(diagnoseDeletionApproval(text, plan(), now), allowed);
      assert.equal(deletionApproval(text, plan(), now), true);
    }
  }
  assert.deepEqual(diagnoseDeletionApproval(json([null, [], true, {}]), plan(), now), denied("NO_MATCH", "NO_TARGET_MATCH", false));
});

test("duplicate exact approvals remain allowed and all matching expiries are considered", () => {
  const valid = approval(), expired = approval(plan(), past), invalid = { ...approval(), expiresAt: "invalid" };
  for (const values of [[valid, valid], [expired, valid], [valid, expired], [invalid, valid], [valid, invalid], [expired, invalid, valid]]) {
    const text = json(values);
    assert.deepEqual(diagnoseDeletionApproval(text, plan(), now), allowed);
    assert.equal(deletionApproval(text, plan(), now), true);
  }
  assert.deepEqual(diagnoseDeletionApproval(json([expired, expired]), plan(), now), denied("EXPIRED", "EXPIRED_APPROVAL", true));
  assert.deepEqual(diagnoseDeletionApproval(json([expired, invalid]), plan(), now), denied("INVALID", "INVALID_EXPIRY", true));
  assert.deepEqual(diagnoseDeletionApproval(json([invalid, expired]), plan(), now), denied("INVALID", "INVALID_EXPIRY", true));
});

test("unrelated active approvals do not override the exact target's expiry", () => {
  const expired = approval(plan(), past), unrelated = { ...approval(), pr: 43 };
  assert.deepEqual(diagnoseDeletionApproval(json([unrelated, expired]), plan(), now), denied("EXPIRED", "EXPIRED_APPROVAL", true));
  assert.deepEqual(diagnoseDeletionApproval(json([{ ...approval(), pr: 43 }]), plan(), now), denied("NO_MATCH", "NO_TARGET_MATCH", false));
});

test("an empty no-DB private manifest preserves the existing validator decision", () => {
  const target: DeletePlan = { ...plan(), deploymentIds: [], alias: null, database: null };
  assert.deepEqual(diagnoseDeletionApproval(json([approval(target)]), target, now), allowed);
  assert.equal(deletionApproval(json([approval(target)]), target, now), true);
});

test("diagnostic outputs contain only fixed enums and booleans, never input text, hosts, IDs or credentials", () => {
  const target = plan(), credential = "synthetic-private-credential";
  const inputs = [json([approval(target)]), json([{ ...approval(target), expiresAt: credential }]),
    `${target.database!.host} ${credential} postgresql://private/private`, json([{ ...approval(target), extra: credential }])];
  for (const text of inputs) {
    const report = diagnoseDeletionApproval(text, target, now), output = JSON.stringify(report);
    assert.deepEqual(Object.keys(report).sort(), ["decision", "expiry", "matches", "reason", "valid"]);
    for (const privateValue of [target.database!.host, credential, target.leaseId, target.headSha, ...target.deploymentIds]) {
      assert.equal(output.includes(privateValue), false, "private values must be omitted");
    }
    assert.equal(output.includes("postgresql://"), false);
  }
});

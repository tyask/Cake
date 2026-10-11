import assert from "node:assert/strict";
import test from "node:test";
import { recurringFormConfig, recurringFormDefaults, recurringFormPreview } from "../lib/recurring-payment-form";
import type { RecurringPayment } from "../lib/recurring-payment-types";
import type { WorkspaceMetadata } from "../lib/types";

const selected: WorkspaceMetadata = { workspace: { id: "w", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
  members: [{ id: "a", email: "a@test", name: "A", imageUrl: null, role: "OWNER", weight: 1 },
    { id: "b", email: "b@test", name: "B", imageUrl: null, role: "MEMBER", weight: 1 }], rules: [] };
const config = { dayOfMonth: 27, merchant: "家賃", method: "振込", amountYen: 100000, actorUserId: "a", expenseClass: "SHARED" as const, splitWeights: { a: 1, b: 1 }, memo: "" };
const payment: RecurringPayment = { id: "r", workspaceId: "w", state: "ACTIVE", revision: 2, authorizedById: "a",
  currentConfig: config,
  nextScheduledOn: "2026-10-27", blockedReason: null };

test("editing starts with the current saved amount and day and copies split weights", () => {
  const draft = recurringFormConfig(selected, "a", ["a", "b"], "2026-10-10", payment);
  assert.equal(draft.amountYen, 100000);
  assert.equal(draft.dayOfMonth, 27);
  draft.splitWeights.a = 9;
  assert.equal(payment.currentConfig.splitWeights.a, 1);
});

test("new recurring payment selects an eligible actor and fixes a personal workspace split", () => {
  assert.equal(recurringFormConfig(selected, "a", ["b"], "2026-10-10").actorUserId, "b");
  const personal = { ...selected, workspace: { ...selected.workspace, type: "PERSONAL" as const } };
  assert.deepEqual(recurringFormDefaults(personal, "", "b"), { expenseClass: "PERSONAL", splitWeights: { a: 0, b: 1 } });
});

test("preview chooses this month before the configured day at JST 09:00 and next month at the boundary", () => {
  const before = new Date("2026-10-09T08:59:59.999+09:00");
  const boundary = new Date("2026-10-09T09:00:00.000+09:00");
  assert.deepEqual(recurringFormPreview({ ...config, dayOfMonth: 9 }, before), { firstOn: "2026-10-09" });
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 9 }, boundary).firstOn, "2026-11-09");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 10 }, before).firstOn, "2026-10-10");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 10 }, boundary).firstOn, "2026-10-10");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 1 }, before).firstOn, "2026-11-01");
});

test("editing previews the selected day solely from the server time", () => {
  const now = new Date("2026-10-10T10:00:00+09:00");
  assert.deepEqual(recurringFormPreview({ ...config, dayOfMonth: 31 }, now), { firstOn: "2026-10-31" });
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 10 }, now).firstOn, "2026-11-10");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 1 }, now).firstOn, "2026-11-01");
});

test("preview clamps the configured day to month end and applies the same JST 09:00 boundary", () => {
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 31 }, new Date("2027-02-10T10:00:00+09:00")).firstOn, "2027-02-28");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 31 }, new Date("2027-02-28T08:59:59.999+09:00")).firstOn, "2027-02-28");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 31 }, new Date("2027-02-28T09:00:00+09:00")).firstOn, "2027-03-31");
});

test("new members get zero without silently deleting an unknown saved participant", () => {
  const draft = recurringFormConfig(selected, "a", ["a", "b"], "2026-10-10", { ...payment,
    currentConfig: { ...config, splitWeights: { a: 1, former: 2 } } });
  assert.deepEqual(draft.splitWeights, { a: 1, former: 2, b: 0 });
});

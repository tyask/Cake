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
  nextScheduledOn: "2026-10-27", blockedReason: null, lastGeneratedMonth: "2026-09-01" };

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

test("new payment preview keeps this month's future date and clamps month end", () => {
  const now = new Date("2026-10-10T09:00:00+09:00");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 1 }, now).firstOn, "2026-11-01");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 27 }, now).firstOn, "2026-10-27");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 31 }, new Date("2027-02-10T09:00:00+09:00")).firstOn, "2027-02-28");
});

test("new and edited previews advance today's date at exactly JST 09:00", () => {
  const todayConfig = { ...config, dayOfMonth: 9 };
  for (const existing of [undefined, payment]) {
    assert.equal(recurringFormPreview(todayConfig, new Date("2026-10-09T08:59:59.999+09:00"), existing).firstOn, "2026-10-09");
    assert.equal(recurringFormPreview(todayConfig, new Date("2026-10-09T09:00:00+09:00"), existing).firstOn, "2026-11-09");
    assert.equal(recurringFormPreview(todayConfig, new Date("2026-10-09T23:59:59.999+09:00"), existing).firstOn, "2026-11-09");
    assert.equal(recurringFormPreview({ ...config, dayOfMonth: 10 }, new Date("2026-10-09T09:00:00+09:00"), existing).firstOn, "2026-10-10");
  }
});

test("editing previews the current month immediately but preserves the generated-month guard", () => {
  const now = new Date("2026-10-10T08:59:59+09:00");
  assert.deepEqual(recurringFormPreview({ ...config, dayOfMonth: 31 }, now, payment), { firstOn: "2026-10-31" });
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 10 }, now, payment).firstOn, "2026-10-10");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 1 }, now, payment).firstOn, "2026-11-01");
  const generated = { ...payment, lastGeneratedMonth: "2026-10-01" };
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 31 }, now, generated).firstOn, "2026-11-30");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 10 }, now, generated).firstOn, "2026-11-10");
});

test("new members get zero without silently deleting an unknown saved participant", () => {
  const draft = recurringFormConfig(selected, "a", ["a", "b"], "2026-10-10", { ...payment,
    currentConfig: { ...config, splitWeights: { a: 1, former: 2 } } });
  assert.deepEqual(draft.splitWeights, { a: 1, former: 2, b: 0 });
});

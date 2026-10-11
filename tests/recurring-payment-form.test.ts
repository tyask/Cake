import assert from "node:assert/strict";
import test from "node:test";
import { recurringFormConfig, recurringFormDefaults, recurringFormPreview } from "../lib/recurring-payment-form";
import type { RecurringPayment } from "../lib/recurring-payment-types";
import type { WorkspaceMetadata } from "../lib/types";

const selected: WorkspaceMetadata = { workspace: { id: "w", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
  members: [{ id: "a", email: "a@test", name: "A", imageUrl: null, role: "OWNER", weight: 1 },
    { id: "b", email: "b@test", name: "B", imageUrl: null, role: "MEMBER", weight: 1 }], rules: [] };
const config = { dayOfMonth: 27, merchant: "家賃", method: "振込", amountYen: 100000, actorUserId: "a", expenseClass: "SHARED" as const, splitWeights: { a: 1, b: 1 }, memo: "" };
const payment: RecurringPayment = { id: "r", workspaceId: "w", state: "ACTIVE", startOn: "2026-09-01", activeFromMonth: "2026-09-01", revision: 2, authorizedById: "a",
  currentConfig: config, pendingConfig: { ...config, dayOfMonth: 10, amountYen: 110000 }, pendingEffectiveMonth: "2026-11-01",
  nextScheduledOn: "2026-10-27", blockedReason: null, lastGeneratedMonth: "2026-09-01" };

test("editing a future change starts with the saved future amount and day", () => {
  const draft = recurringFormConfig(selected, "a", ["a", "b"], "2026-10-10", payment);
  assert.equal(draft.amountYen, 110000);
  assert.equal(draft.dayOfMonth, 10);
  draft.splitWeights.a = 9;
  assert.equal(payment.pendingConfig!.splitWeights.a, 1);
});

test("new recurring payment selects an eligible actor and fixes a personal workspace split", () => {
  assert.equal(recurringFormConfig(selected, "a", ["b"], "2026-10-10").actorUserId, "b");
  const personal = { ...selected, workspace: { ...selected.workspace, type: "PERSONAL" as const } };
  assert.deepEqual(recurringFormDefaults(personal, "", "b"), { expenseClass: "PERSONAL", splitWeights: { a: 0, b: 1 } });
});

test("new payment preview uses today and the next matching monthly date", () => {
  assert.deepEqual(recurringFormPreview({ ...config, dayOfMonth: 10 }, "2026-10-10"), { effectiveMonth: "2026-10-01", firstOn: "2026-10-10" });
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 1 }, "2026-10-10").firstOn, "2026-11-01");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 27 }, "2026-10-10").firstOn, "2026-10-27");
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 31 }, "2027-02-10").firstOn, "2027-02-28");
});

test("editing retains legacy internal start metadata without accepting a start date input", () => {
  const future = { ...payment, startOn: "2026-12-28", activeFromMonth: "2026-12-01", lastGeneratedMonth: null };
  assert.deepEqual(recurringFormPreview({ ...config, dayOfMonth: 31 }, "2026-10-10", future), { effectiveMonth: "2026-12-01", firstOn: "2026-12-31" });
  assert.equal(recurringFormPreview({ ...config, dayOfMonth: 10 }, "2026-10-10", future).firstOn, "2027-01-10");
});

test("new members get zero without silently deleting an unknown saved participant", () => {
  const draft = recurringFormConfig(selected, "a", ["a", "b"], "2026-10-10", { ...payment,
    pendingConfig: null, currentConfig: { ...config, splitWeights: { a: 1, former: 2 } } });
  assert.deepEqual(draft.splitWeights, { a: 1, former: 2, b: 0 });
});

import { defaultSplitWeights, matchingDefaultRule, personalSplitWeights, transactionDefaults } from "./expense-splits";
import { nextScheduledOn } from "./recurring-payment-calendar";
import type { RecurringPayment, RecurringPaymentConfig } from "./recurring-payment-types";
import type { WorkspaceMetadata } from "./types";

export function recurringFormConfig(selected: WorkspaceMetadata, currentUserId: string, eligibleActorUserIds: readonly string[], today: string, payment?: RecurringPayment): RecurringPaymentConfig {
  if (payment) {
    const config = payment.currentConfig;
    // A newly joined member contributes zero; preserve unknown saved IDs so
    // invalid membership is reported instead of silently changing the split.
    const splitWeights = { ...config.splitWeights };
    for (const member of selected.members) if (!(member.id in splitWeights)) splitWeights[member.id] = 0;
    return { ...config, splitWeights };
  }
  const eligible = selected.members.filter(member => eligibleActorUserIds.includes(member.id));
  const actorUserId = eligible.find(member => member.id === currentUserId)?.id ?? eligible[0]?.id ?? "";
  return { dayOfMonth: Number(today.slice(8)), merchant: "", method: "現金", amountYen: 0, actorUserId,
    expenseClass: selected.workspace.type === "PERSONAL" ? "PERSONAL" : "SHARED",
    splitWeights: selected.workspace.type === "PERSONAL" && actorUserId
      ? personalSplitWeights(selected.members, actorUserId) : defaultSplitWeights(selected.members), memo: "" };
}

export function recurringFormDefaults(selected: WorkspaceMetadata, merchant: string, actorUserId: string) {
  if (selected.workspace.type === "PERSONAL") return { expenseClass: "PERSONAL" as const, splitWeights: personalSplitWeights(selected.members, actorUserId) };
  return matchingDefaultRule(merchant, selected.rules)
    ? transactionDefaults(merchant, selected.rules, selected.members, actorUserId)
    : { expenseClass: "SHARED" as const, splitWeights: defaultSplitWeights(selected.members) };
}

export function recurringFormPreview(config: RecurringPaymentConfig, now: Date, payment?: RecurringPayment) {
  const firstOn = nextScheduledOn({ state: "ACTIVE", currentConfig: config,
    lastGeneratedMonth: payment?.lastGeneratedMonth ?? null }, now);
  return { firstOn };
}

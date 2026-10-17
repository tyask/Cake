import { defaultSplitWeights, personalSplitWeights, transactionDefaults, validateSplitWeights } from "../expense-splits";
import type { ExpenseClass, SplitWeights } from "../types";
import type { AppStore } from "../app-store";

export function resolveTransactionSplit(
  input: { merchant: string; actorUserId: string; expenseClass?: ExpenseClass; splitWeights?: SplitWeights },
  context: Awaited<ReturnType<AppStore["splitContext"]>>,
  fallbackExpenseClass: ExpenseClass = "PERSONAL",
) {
  if (!context.members.some((member) => member.id === input.actorUserId)) throw new Error("取引担当者がワークスペースに参加していません。");
  const defaults = transactionDefaults(input.merchant, context.rules, context.members, input.actorUserId, fallbackExpenseClass);
  const expenseClass = input.expenseClass ?? defaults.expenseClass;
  const splitWeights = input.splitWeights === undefined
    ? expenseClass === "PERSONAL"
      ? personalSplitWeights(context.members, input.actorUserId)
      : defaults.expenseClass === "SHARED" ? defaults.splitWeights : defaultSplitWeights(context.members)
    : validateSplitWeights(input.splitWeights, context.members, expenseClass, input.actorUserId);
  return { expenseClass, splitWeights };
}

export function resolveRuleSplit(expenseClass: ExpenseClass, splitWeights: SplitWeights | null | undefined, members: { id: string }[]) {
  if (expenseClass === "PERSONAL") {
    if (splitWeights != null) throw new Error("個人費ルールの割合は、取引担当者が1、ほかの参加者が0です。");
    return null;
  }
  return splitWeights == null ? null : validateSplitWeights(splitWeights, members);
}


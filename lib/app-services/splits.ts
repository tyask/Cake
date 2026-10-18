import { defaultSplitWeights, personalSplitWeights, transactionDefaults, validateSplitWeights } from "../expense-splits";
import type { DefaultRule, ExpenseClass, SplitWeights, WorkspaceMember } from "../types";

type TransactionSplitInput = { merchant: string; actorUserId: string; expenseClass?: ExpenseClass; splitWeights?: SplitWeights };
type SplitContext = { members: readonly Pick<WorkspaceMember, "id" | "weight" | "name">[]; rules: readonly DefaultRule[] };

/** Apply this after inheriting any saved classification and ratio. */
export function transactionNeedsRules(input: Pick<TransactionSplitInput, "expenseClass" | "splitWeights">) {
  return input.expenseClass === undefined || (input.expenseClass === "SHARED" && input.splitWeights === undefined);
}

export function resolveTransactionSplit(
  input: TransactionSplitInput,
  context: SplitContext,
  fallbackExpenseClass: ExpenseClass = "PERSONAL",
) {
  if (!context.members.some((member) => member.id === input.actorUserId)) throw new Error("取引担当者がワークスペースに参加していません。");
  const defaults = transactionNeedsRules(input)
    ? transactionDefaults(input.merchant, context.rules, context.members, input.actorUserId, fallbackExpenseClass) : null;
  const expenseClass = input.expenseClass ?? defaults?.expenseClass ?? fallbackExpenseClass;
  const splitWeights = input.splitWeights === undefined
    ? expenseClass === "PERSONAL"
      ? personalSplitWeights(context.members, input.actorUserId)
      : defaults?.expenseClass === "SHARED" ? defaults.splitWeights : defaultSplitWeights(context.members)
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


import { defaultSplitWeights, personalSplitWeights, transactionDefaults, validateSplitWeights, type DefaultRuleMatcher } from "../../shared/expense-splits";
import type { ExpenseClass, SplitWeights, TransactionType, WorkspaceMember } from "../../shared/types";

type TransactionSplitInput = { merchant: string; actorUserId: string; type?: TransactionType; expenseClass?: ExpenseClass; splitWeights?: SplitWeights };
type SplitContext = { members: readonly Pick<WorkspaceMember, "id" | "weight" | "name">[]; matchRule: DefaultRuleMatcher };

/** Apply this after inheriting any saved classification and ratio. */
export function transactionNeedsRules(input: Pick<TransactionSplitInput, "type" | "expenseClass" | "splitWeights">) {
  return input.type !== "RECEIPT" && (input.expenseClass === undefined || (input.expenseClass === "SHARED" && input.splitWeights === undefined));
}

export function resolveTransactionSplit(
  input: TransactionSplitInput,
  context: SplitContext,
  fallbackExpenseClass: ExpenseClass = "PERSONAL",
) {
  if (!context.members.some((member) => member.id === input.actorUserId)) throw new Error("取引担当者がワークスペースに参加していません。");
  const defaults = transactionNeedsRules(input)
    ? transactionDefaults(input.merchant, context.matchRule, context.members, input.actorUserId, fallbackExpenseClass) : null;
  const expenseClass = input.expenseClass ?? defaults?.expenseClass ?? (input.type === "RECEIPT" ? "PERSONAL" : fallbackExpenseClass);
  const splitWeights = input.splitWeights === undefined
    ? expenseClass === "PERSONAL"
      ? personalSplitWeights(context.members, input.actorUserId)
      : defaults?.expenseClass === "SHARED" ? defaults.splitWeights : defaultSplitWeights(context.members)
    : validateSplitWeights(input.splitWeights, context.members, expenseClass, input.actorUserId);
  return { expenseClass, splitWeights };
}

export function resolveRuleSplit(expenseClass: ExpenseClass, splitWeights: SplitWeights | null | undefined, members: { id: string }[]) {
  if (expenseClass === "PERSONAL") {
    if (splitWeights != null) throw new Error("個人ルールの割合は、取引担当者が1、ほかの参加者が0です。");
    return null;
  }
  return splitWeights == null ? null : validateSplitWeights(splitWeights, members);
}


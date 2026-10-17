import { randomUUID } from "node:crypto";
import { calculateSettlement } from "../settlement";
import type { AppStore } from "../app-store";
import type { AppUser } from "../types";
import type { Action } from "./types";

export async function settlementService(store: AppStore, user: AppUser, input: Action<"completeSettlement">) {
  const context = await store.settlementContext(input.workspaceId, user.id);
  const result = context.workspaceType === "SHARED" ? calculateSettlement(context.members, context.transactions) : null;
  if (!result || result.transactionIds.length === 0) throw new Error("清算対象の明細がありません。");
  const settlementId = randomUUID();
  const targetIds = new Set(result.transactionIds);
  const expectedTransactions = context.transactions
    .filter((transaction) => targetIds.has(transaction.id))
    .sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
    .map((transaction) => ({
      id: transaction.id, actorUserId: transaction.actorUserId, type: transaction.type,
      amountYen: transaction.amountYen, expenseClass: transaction.expenseClass, splitWeights: transaction.splitWeights,
    }));
  const calculationSnapshot = {
    ...result,
    transactions: expectedTransactions,
  };
  await store.completeSettlement(input, user, settlementId, result, expectedTransactions, calculationSnapshot);
  return { ok: true };
}

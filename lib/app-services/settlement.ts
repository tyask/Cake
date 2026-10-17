import { randomUUID } from "node:crypto";
import type { AppStore } from "../app-store";
import type { AppUser } from "../types";
import type { Action } from "./types";

export async function settlementService(store: AppStore, user: AppUser, input: Action<"completeSettlement">) {
  await store.requireWorkspaceMember(input.workspaceId, user.id);
  const latest = await store.bootstrap(user, input.workspaceId);
  const result = latest.selected?.settlement;
  if (!result || result.transactionIds.length === 0) throw new Error("清算対象の明細がありません。");
  const settlementId = randomUUID();
  const expectedTransactions = latest.selected!.transactions
    .filter((transaction) => result.transactionIds.includes(transaction.id))
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

import { randomUUID } from "node:crypto";
import { transactionRecord } from "../transaction-record";
import { resolveTransactionSplit, transactionNeedsRules } from "./splits";
import type { ExpenseClass, SplitWeights } from "../types";
import type { AppStore } from "../app-store";
import type { AppUser } from "../types";
import type { Action } from "./types";

export async function transactionsService(store: AppStore, user: AppUser, input: Action<"saveTransactionMemo" | "saveTransaction" | "deleteTransaction" | "deleteTransactions" | "applyTransactionRules">) {
  if (input.action === "saveTransactionMemo") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    const saved = await store.saveTransactionMemo(input, user);
    if (!saved) throw new Error("明細が存在しません。");
    return { ok: true, transactionId: String(saved.id), memo: String(saved.memo) };
  }

  if (input.action === "saveTransaction") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    const previous = input.transactionId && input.splitWeights === undefined
      ? await store.previousTransaction(input)
      : null;
    const splitInput = {
      ...input,
      expenseClass: input.expenseClass ?? (previous ? String(previous.expense_class) as ExpenseClass : undefined),
      splitWeights: previous && (input.expenseClass === undefined || input.expenseClass === previous.expense_class)
        && (previous.expense_class === "SHARED" || input.actorUserId === previous.actor_user_id)
        ? previous.split_weights as SplitWeights : input.splitWeights,
    };
    const [members, rules] = await Promise.all([
      store.splitMembers(input.workspaceId),
      transactionNeedsRules(splitInput) ? store.splitRules(input.workspaceId) : Promise.resolve([]),
    ]);
    const split = resolveTransactionSplit(splitInput, { members, rules });
    let saved: Record<string, unknown>;
    if (input.transactionId) {
      const updated = await store.updateTransaction(input, user, split);
      if (!updated) throw new Error("清算済み、または存在しない明細は編集できません。");
      saved = updated;
    } else {
      const id = randomUUID();
      saved = await store.insertTransaction(input, user, split, id);
    }
    return { ok: true, transaction: transactionRecord(saved, members.find(member => member.id === input.actorUserId)!.name) };
  }

  if (input.action === "deleteTransaction") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    const deleted = await store.deleteTransaction(input);
    if (!deleted) throw new Error("清算済み、または存在しない明細は削除できません。");
    return { ok: true };
  }

  if (input.action === "deleteTransactions" || input.action === "applyTransactionRules") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    const rows = await store.bulkTransactions(input, user);
    const result = rows[0].result as { affected: number; transactions?: Array<Record<string, unknown> & { occurredAt: string }> };
    return (input.action === "deleteTransactions"
      ? { ok: true, deleted: Number(result.affected) }
      : {
        ok: true, applied: Number(result.affected),
        appliedTransactions: (result.transactions ?? []).map((transaction) => ({
          ...transaction, occurredAt: new Date(transaction.occurredAt).toISOString(),
        })),
      });
  }

  const unhandled: never = input;
  throw new Error(`未対応の操作です: ${unhandled}`);
}

import { resolveTransactionSplit, transactionNeedsRules } from "./splits";
import { prepareDefaultRuleMatcher } from "../../shared/expense-splits";
import type { AppStore } from "../stores/app-store";
import type { AppUser } from "../../shared/types";
import type { Action } from "./types";

export async function importsService(store: AppStore, user: AppUser, input: Action<"bulkImport">) {
  await store.requireWorkspaceMember(input.workspaceId, user.id);
  const [members, rules] = await Promise.all([store.splitMembers(input.workspaceId), store.splitRules(input.workspaceId)]);
  const matchRule = input.items.some(transactionNeedsRules) ? prepareDefaultRuleMatcher(rules) : () => undefined;
  const context = { members, matchRule };
  const items = input.items.map((item) => ({ ...item, ...resolveTransactionSplit(item, context, "SHARED") }));
  if (items.some(item => item.expenseClass === "PERSONAL" && item.actorUserId !== user.id)) {
    throw new Error("個人費は本人の明細だけ登録・変更できます。");
  }
  const result = await store.persistPayPayImport({ ...input, items, userId: user.id });
  return { ok: true, ...result };
}

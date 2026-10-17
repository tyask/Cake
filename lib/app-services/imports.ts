import { resolveTransactionSplit } from "./splits";
import type { AppStore } from "../app-store";
import type { AppUser } from "../types";
import type { Action } from "./types";

export async function importsService(store: AppStore, user: AppUser, input: Action<"bulkImport">) {
  await store.requireWorkspaceMember(input.workspaceId, user.id);
  const [members, rules] = await Promise.all([store.splitMembers(input.workspaceId), store.splitRules(input.workspaceId)]);
  const context = { members, rules };
  const items = input.items.map((item) => ({ ...item, ...resolveTransactionSplit(item, context, "SHARED") }));
  const result = await store.persistPayPayImport({ ...input, items, userId: user.id });
  return { ok: true, ...result };
}

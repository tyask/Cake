import { resolveRuleSplit } from "./splits";
import type { AppStore } from "../app-store";
import type { AppUser } from "../types";
import type { Action } from "./types";

export async function rulesService(store: AppStore, user: AppUser, input: Action<"createRule" | "updateRule" | "reorderRules" | "deleteRule" | "deleteRules">) {
  if (input.action === "createRule") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    const members = await store.splitMembers(input.workspaceId);
    const splitWeights = resolveRuleSplit(input.expenseClass, input.splitWeights, members);
    await store.createRule(input, user, splitWeights);
    return { ok: true };
  }

  if (input.action === "updateRule") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    const [members, previous] = await Promise.all([
      store.splitMembers(input.workspaceId), store.ruleForUpdate(input.workspaceId, input.ruleId),
    ]);
    if (!previous) throw new Error("このワークスペースにルールがありません。");
    const splitWeights = resolveRuleSplit(input.expenseClass, input.splitWeights === undefined && input.expenseClass === previous.expenseClass ? previous.splitWeights : input.splitWeights, members);
    const updated = await store.updateRule(input, splitWeights, previous);
    if (!updated) throw new Error("このワークスペースにルールがありません。");
    return { ok: true };
  }

  if (input.action === "reorderRules") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    await store.reorderRules(input, user);
    return { ok: true };
  }

  if (input.action === "deleteRule" || input.action === "deleteRules") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    const requireAll = input.action === "deleteRules";
    const ids = input.action === "deleteRule" ? [input.ruleId] : input.ruleIds;
    const deleted = await store.deleteRules(input.workspaceId, user.id, ids, requireAll);
    return requireAll ? { ok: true, deleted } : { ok: true };
  }

  const unhandled: never = input;
  throw new Error(`未対応の操作です: ${unhandled}`);
}

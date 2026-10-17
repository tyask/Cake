import { resolveRuleSplit } from "./splits";
import type { AppStore } from "../app-store";
import type { AppUser } from "../types";
import type { Action } from "./types";

export async function rulesService(store: AppStore, user: AppUser, input: Action<"createRule" | "updateRule" | "reorderRules" | "deleteRule" | "deleteRules">) {
  if (input.action === "createRule") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    const context = await store.splitContext(input.workspaceId);
    const splitWeights = resolveRuleSplit(input.expenseClass, input.splitWeights, context.members);
    await store.createRule(input, user, splitWeights);
    return { ok: true };
  }

  if (input.action === "updateRule") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    const context = await store.splitContext(input.workspaceId);
    const previous = context.rules.find((rule) => rule.id === input.ruleId);
    if (!previous) throw new Error("このワークスペースにルールがありません。");
    const splitWeights = resolveRuleSplit(input.expenseClass, input.splitWeights === undefined && input.expenseClass === previous.expenseClass ? previous.splitWeights : input.splitWeights, context.members);
    const updated = await store.updateRule(input, splitWeights, previous);
    if (!updated) throw new Error("このワークスペースにルールがありません。");
    return { ok: true };
  }

  if (input.action === "reorderRules") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    await store.reorderRules(input, user);
    return { ok: true };
  }

  if (input.action === "deleteRule") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    await store.deleteRule(input);
    return { ok: true };
  }

  if (input.action === "deleteRules") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    const requestedIds = JSON.stringify(input.ruleIds);
    const targets = await store.ruleTargets(input, requestedIds);
    if (targets.length !== input.ruleIds.length) {
      throw new Error("選択したルールが見つかりません。画面を更新して選び直してください。");
    }
    const deleted = await store.deleteRules(input, requestedIds);
    return { ok: true, deleted };
  }

  const unhandled: never = input;
  throw new Error(`未対応の操作です: ${unhandled}`);
}

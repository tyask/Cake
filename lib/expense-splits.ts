import type { DefaultRule, ExpenseClass, SplitWeights, WorkspaceMember } from "./types";

type MemberWeight = Pick<WorkspaceMember, "id" | "weight">;
type MemberIdentity = { id: string } | string;

/** Return a copy so changing a form or the defaults never changes a saved ratio. */
export function validateSplitWeights(
  input: unknown,
  members: readonly MemberIdentity[],
  expenseClass?: ExpenseClass,
  actorUserId?: string,
): SplitWeights {
  const ids = members.map((member) => typeof member === "string" ? member : member.id);
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("割合の参加者が不正です。");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("負担割合を設定してください。");
  }
  const values = input as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.length !== ids.length || keys.some((key) => !ids.includes(key))) {
    throw new Error("負担割合の参加者が一致しません。");
  }
  const entries = ids.map((id) => {
    const weight = values[id];
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 0 || weight > 2_147_483_647) {
      throw new Error("割合は0から2147483647までの整数で設定してください。");
    }
    return [id, weight] as const;
  });
  if (entries.every(([, weight]) => weight === 0)) {
    throw new Error("割合は少なくとも一人を1以上にしてください。");
  }
  if (expenseClass === "PERSONAL") {
    if (!actorUserId || !ids.includes(actorUserId)) {
      throw new Error("個人費の担当者が参加者に含まれていません。");
    }
    if (entries.some(([id, weight]) => weight !== (id === actorUserId ? 1 : 0))) {
      throw new Error("個人費の割合は担当者が1、ほかの参加者が0です。");
    }
  }
  return Object.fromEntries(entries);
}

export function defaultSplitWeights(members: readonly MemberWeight[]): SplitWeights {
  if (members.length === 0) return {};
  return validateSplitWeights(Object.fromEntries(members.map((member) => [member.id, member.weight])), members);
}

export function personalSplitWeights(members: readonly { id: string }[], actorUserId: string): SplitWeights {
  if (members.length === 0) return {};
  return validateSplitWeights(
    Object.fromEntries(members.map((member) => [member.id, member.id === actorUserId ? 1 : 0])),
    members,
    "PERSONAL",
    actorUserId,
  );
}

export function matchingDefaultRule(merchant: string, rules: readonly DefaultRule[]): DefaultRule | undefined {
  return [...rules]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .find((rule) => rule.enabled && merchant.includes(rule.merchantContains));
}

export function transactionDefaults(
  merchant: string,
  rules: readonly DefaultRule[],
  members: readonly MemberWeight[],
  actorUserId: string,
): { expenseClass: ExpenseClass; splitWeights: SplitWeights } {
  const rule = matchingDefaultRule(merchant, rules);
  const expenseClass = rule?.expenseClass ?? "PERSONAL";
  if (expenseClass === "PERSONAL") {
    return { expenseClass, splitWeights: personalSplitWeights(members, actorUserId) };
  }
  const splitWeights = rule?.splitWeights == null
    ? defaultSplitWeights(members)
    : members.length === 0
      ? {}
      : validateSplitWeights(Object.fromEntries(members.map((member) => [member.id, rule.splitWeights?.[member.id] ?? 0])), members);
  return { expenseClass, splitWeights };
}

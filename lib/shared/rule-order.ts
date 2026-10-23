import type { DefaultRule } from "./types";

/** Keep live records in the optimistic order, then append externally added rules. */
export function orderedWorkspaceRules(rules: readonly DefaultRule[], orderOverride: readonly string[] | null): DefaultRule[] {
  const byId = new Map<string, DefaultRule>();
  for (const rule of rules) if (!byId.has(rule.id)) byId.set(rule.id, rule);
  const ordered: DefaultRule[] = [];
  const includedIds = new Set<string>();
  for (const id of orderOverride ?? []) {
    const rule = byId.get(id);
    if (!rule || includedIds.has(id)) continue;
    ordered.push(rule);
    includedIds.add(id);
  }
  for (const [id, rule] of byId) if (!includedIds.has(id)) ordered.push(rule);
  return ordered;
}

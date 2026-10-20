import type { Category } from "./types";

export type CategoryMovePosition = "before" | "inside" | "after";
export type CategoryMoveTarget = { categoryId: string | null; position: CategoryMovePosition };
export type CategoryMoveDestination = {
  parentId: string | null;
  beforeCategoryId: string | null;
  label: string;
  error: string | null;
  unchanged: boolean;
};

/** Prepare shared lookups once for all drop targets in the current tree. */
export function prepareCategoryMove(categories: readonly Category[], sourceId: string | null) {
  const byId = new Map(categories.map(category => [category.id, category]));
  const children = new Map<string | null, Category[]>();
  for (const category of categories) {
    const siblings = children.get(category.parentId) ?? [];
    siblings.push(category);
    children.set(category.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const nextSibling = new Map<string, string | null>();
  for (const siblings of children.values()) {
    let nextId: string | null = null;
    for (let index = siblings.length - 1; index >= 0; index--) {
      nextSibling.set(siblings[index].id, nextId);
      if (siblings[index].id !== sourceId && !siblings[index].archivedAt) nextId = siblings[index].id;
    }
  }
  const source = sourceId ? byId.get(sourceId) : undefined;
  const descendants = new Set<string>();
  const stack = source ? [source] : [];
  while (stack.length) {
    const category = stack.pop()!;
    if (descendants.has(category.id)) continue;
    descendants.add(category.id);
    for (const child of children.get(category.id) ?? []) stack.push(child);
  }
  const duplicateParents = new Set(categories.filter(category => !category.archivedAt && category.id !== sourceId && category.name === source?.name).map(category => category.parentId));
  const oldNextId = source ? nextSibling.get(source.id) ?? null : null;

  function destination(target: CategoryMoveTarget): CategoryMoveDestination {
    const relative = target.categoryId ? byId.get(target.categoryId) : undefined;
    const parentId = relative ? target.position === "inside" ? relative.id : relative.parentId : null;
    let beforeCategoryId: string | null = null;
    if (relative && target.position === "before") beforeCategoryId = relative.id;
    if (relative && target.position === "after") beforeCategoryId = nextSibling.get(relative.id) ?? null;
    const label = relative ? `「${relative.name}」${target.position === "before" ? "の前" : target.position === "after" ? "の後" : "の子カテゴリ（末尾）"}へ移動` : "最上位の末尾へ移動";
    let error: string | null = null;
    if (!source || source.archivedAt) error = "移動するカテゴリは使用停止・削除されています。";
    else if (target.categoryId && (!relative || relative.archivedAt)) error = "使用停止・削除されたカテゴリには移動できません。";
    else if (relative?.id === source.id || (parentId && descendants.has(parentId))) error = "自分自身や子孫のカテゴリには移動できません。";
    else if (parentId && (!byId.has(parentId) || byId.get(parentId)?.archivedAt)) error = "移動先の親カテゴリは使用停止・削除されています。";
    else if (duplicateParents.has(parentId)) error = "移動先の階層に同じ名前のカテゴリがあります。";
    return { parentId, beforeCategoryId, label, error, unchanged: !error && source?.parentId === parentId && beforeCategoryId === oldNextId };
  }

  return { source, descendants, destination };
}

import type { BootstrapData, Category } from "./types";

type CategoryUpdate = { category: Category } | { archivedCategories: Category[] };

/** Adopt acknowledged metadata without a GET that another save could invalidate. */
export function applyCategoryUpdate(data: BootstrapData, workspaceId: string, update: CategoryUpdate): BootstrapData {
  const selected = data.selected;
  if (!selected || selected.workspace.id !== workspaceId) return data;
  const categories = new Map(selected.categories.map(category => [category.id, category]));
  for (const category of "category" in update ? [update.category] : update.archivedCategories) {
    const current = categories.get(category.id);
    if (!current || current.revision < category.revision) categories.set(category.id, category);
  }
  return { ...data, selected: { ...selected, categories: [...categories.values()] } };
}

import type { BootstrapData, Category } from "./types";

type CategoryUpdate = { category: Category } | { archivedCategoryIds: string[]; archivedAt: string };

/** Adopt acknowledged metadata without a GET that another save could invalidate. */
export function applyCategoryUpdate(data: BootstrapData, workspaceId: string, update: CategoryUpdate): BootstrapData {
  const selected = data.selected;
  if (!selected || selected.workspace.id !== workspaceId) return data;
  const current = selected.categories;
  let categories: Category[];
  if ("category" in update) {
    categories = current.some(category => category.id === update.category.id)
      ? current.map(category => category.id === update.category.id ? update.category : category)
      : [...current, update.category];
  } else {
    const archived = new Set(update.archivedCategoryIds);
    categories = current.map(category => archived.has(category.id) ? { ...category, archivedAt: update.archivedAt } : category);
  }
  return { ...data, selected: { ...selected, categories } };
}

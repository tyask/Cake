import type { BootstrapData, Category } from "./types";

type CategoryUpdate = { category: Category } | { archivedCategoryRevisions: { id: string; revision: number }[]; archivedAt: string };

/** Adopt acknowledged metadata without a GET that another save could invalidate. */
export function applyCategoryUpdate(data: BootstrapData, workspaceId: string, update: CategoryUpdate): BootstrapData {
  const selected = data.selected;
  if (!selected || selected.workspace.id !== workspaceId) return data;
  const current = selected.categories;
  let categories: Category[];
  if ("category" in update) {
    categories = current.some(category => category.id === update.category.id)
      ? current.map(category => category.id === update.category.id && category.revision < update.category.revision ? update.category : category)
      : [...current, update.category];
  } else {
    const archived = new Map(update.archivedCategoryRevisions.map(category => [category.id, category.revision]));
    categories = current.map(category => {
      const revision = archived.get(category.id);
      return revision !== undefined && category.revision < revision ? { ...category, archivedAt: update.archivedAt, revision } : category;
    });
  }
  return { ...data, selected: { ...selected, categories } };
}

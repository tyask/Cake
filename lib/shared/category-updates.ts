import { isWorkspaceData, type BootstrapMetadata, type Category } from "./types";

export type CategoryDeletion = {
  deletedCategoryIds: string[];
  detachedTransactions: { transactionId: string; categoryId: null; categoryConfirmed: false; categoryRevision: number }[];
};

type CategoryUpdate = ({ category: Category } | { archivedCategories: Category[] } | { movedCategories: Category[] } | CategoryDeletion)
  & { ancestorCategories?: Category[] };

/** Adopt acknowledged metadata without a GET that another save could invalidate. */
export function applyCategoryUpdate<T extends BootstrapMetadata>(data: T, workspaceId: string, update: CategoryUpdate): T {
  const selected = data.selected;
  if (!selected || selected.workspace.id !== workspaceId) return data;
  if ("deletedCategoryIds" in update) {
    const deleted = new Set(update.deletedCategoryIds);
    const detached = new Map(update.detachedTransactions.map(transaction => [transaction.transactionId, transaction]));
    return { ...data, selected: { ...selected,
      categories: selected.categories.filter(category => !deleted.has(category.id)),
      ...(isWorkspaceData(selected) ? { transactions: selected.transactions.map(transaction => {
        const acknowledged = detached.get(transaction.id);
        return acknowledged && acknowledged.categoryRevision > transaction.categoryRevision
          ? { ...transaction, categoryId: null, categoryConfirmed: false, categoryRevision: acknowledged.categoryRevision }
          : transaction;
      }) } : {}),
    } };
  }
  const categories = new Map(selected.categories.map(category => [category.id, category]));
  const acknowledged = "category" in update ? [update.category]
    : "archivedCategories" in update ? update.archivedCategories : update.movedCategories;
  for (const category of [...acknowledged, ...(update.ancestorCategories ?? [])]) {
    const current = categories.get(category.id);
    if (!current || current.revision < category.revision) categories.set(category.id, category);
  }
  return { ...data, selected: { ...selected, categories: [...categories.values()] } };
}

import { calculateSettlement } from "../shared/settlement";
import { isWorkspaceData, type BootstrapMetadata, type TransactionRecord } from "../shared/types";

type TransactionUpdate = { transaction: TransactionRecord } | { transactionId: string; memo: string }
  | { transactionId: string; categoryId: string | null; categoryConfirmed: boolean; categoryRevision: number };

/** Apply confirmed server values to the current workspace without a full reload. */
export function applyTransactionUpdate<T extends BootstrapMetadata>(data: T, workspaceId: string, update: TransactionUpdate): T {
  const selected = data.selected;
  if (!isWorkspaceData(selected) || selected.workspace.id !== workspaceId) return data;
  if ("transaction" in update) {
    const exists = selected.transactions.some(item => item.id === update.transaction.id);
    const transactions = (exists
      ? selected.transactions.map(item => {
        if (item.id !== update.transaction.id) return item;
        const category = update.transaction.categoryRevision > item.categoryRevision ? update.transaction : item;
        return { ...update.transaction, memo: item.memo, categoryId: category.categoryId,
          categoryConfirmed: category.categoryConfirmed, categoryRevision: category.categoryRevision };
      })
      : [update.transaction, ...selected.transactions])
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    return { ...data, selected: { ...selected, transactions,
      settlement: selected.workspace.type === "SHARED" ? calculateSettlement(selected.members, transactions) : null } };
  }
  return { ...data, selected: { ...selected, transactions: selected.transactions.map(item =>
    item.id !== update.transactionId ? item : "memo" in update
      ? { ...item, memo: update.memo }
      : update.categoryRevision > item.categoryRevision
        ? { ...item, categoryId: update.categoryId, categoryConfirmed: update.categoryConfirmed, categoryRevision: update.categoryRevision }
        : item) } };
}

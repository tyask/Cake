import { calculateSettlement } from "../shared/settlement";
import { isWorkspaceData, type BootstrapMetadata, type TransactionRecord } from "../shared/types";

export type TransactionUpdate = { transaction: TransactionRecord } | { transactionId: string; memo: string }
  | { transactionId: string; categoryId: string | null; categoryConfirmed: boolean; categoryRevision: number };

/** Memo/category saves can finish while a normal field save is still in flight. */
export function updateTransactionRecords(records: readonly TransactionRecord[], update: TransactionUpdate): TransactionRecord[] {
  if ("transaction" in update) {
    const exists = records.some(item => item.id === update.transaction.id);
    return (exists
      ? records.map(item => {
        if (item.id !== update.transaction.id) return item;
        const category = update.transaction.categoryRevision > item.categoryRevision ? update.transaction : item;
        return { ...update.transaction, memo: item.memo, categoryId: category.categoryId,
          categoryConfirmed: category.categoryConfirmed, categoryRevision: category.categoryRevision };
      })
      : [update.transaction, ...records])
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  }
  return records.map(item =>
    item.id !== update.transactionId ? item : "memo" in update
      ? { ...item, memo: update.memo }
      : update.categoryRevision > item.categoryRevision
        ? { ...item, categoryId: update.categoryId, categoryConfirmed: update.categoryConfirmed, categoryRevision: update.categoryRevision }
        : item);
}

/** Apply confirmed server values to the current workspace without a full reload. */
export function applyTransactionUpdate<T extends BootstrapMetadata>(data: T, workspaceId: string, update: TransactionUpdate): T {
  const selected = data.selected;
  if (!isWorkspaceData(selected) || selected.workspace.id !== workspaceId) return data;
  const transactions = updateTransactionRecords(selected.transactions, update);
  return { ...data, selected: { ...selected, transactions,
    settlement: "transaction" in update && selected.workspace.type === "SHARED" ? calculateSettlement(selected.members, transactions) : selected.settlement } };
}

import { calculateSettlement } from "./settlement";
import type { BootstrapData, TransactionRecord } from "./types";

type TransactionUpdate = { transaction: TransactionRecord } | { transactionId: string; memo: string };

/** Apply confirmed server values to the current workspace without a full reload. */
export function applyTransactionUpdate(data: BootstrapData, workspaceId: string, update: TransactionUpdate): BootstrapData {
  const selected = data.selected;
  if (!selected || selected.workspace.id !== workspaceId) return data;
  if ("transaction" in update) {
    const exists = selected.transactions.some(item => item.id === update.transaction.id);
    const transactions = (exists
      ? selected.transactions.map(item => item.id === update.transaction.id ? update.transaction : item)
      : [update.transaction, ...selected.transactions])
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    return { ...data, selected: { ...selected, transactions,
      settlement: selected.workspace.type === "SHARED" ? calculateSettlement(selected.members, transactions) : null } };
  }
  return { ...data, selected: { ...selected, transactions: selected.transactions.map(item =>
    item.id === update.transactionId ? { ...item, memo: update.memo } : item) } };
}

import { homeMonth } from "../shared/home-summary";
import { transactionViewSelectionSchema, type TransactionViewSelection } from "../shared/transaction-view";

export function transactionViewStorageKey(userId: string, workspaceId: string): string {
  return `cake:transaction-view:v1:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;
}

export function defaultTransactionViewSelection(now = new Date()): TransactionViewSelection {
  return { mode: "month", month: homeMonth(now) };
}

export function parseStoredTransactionView(raw: string | null, now = new Date()): TransactionViewSelection {
  try {
    const parsed = transactionViewSelectionSchema.safeParse(raw === null ? null : JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Corrupt browser data must not prevent viewing transactions.
  }
  return defaultTransactionViewSelection(now);
}

export function readStoredTransactionView(storage: Pick<Storage, "getItem">, key: string, now = new Date()): TransactionViewSelection {
  try {
    return parseStoredTransactionView(storage.getItem(key), now);
  } catch {
    return defaultTransactionViewSelection(now);
  }
}

export function writeStoredTransactionView(storage: Pick<Storage, "setItem">, key: string, selection: TransactionViewSelection): void {
  const parsed = transactionViewSelectionSchema.safeParse(selection);
  if (!parsed.success) return;
  try {
    storage.setItem(key, JSON.stringify(parsed.data));
  } catch {
    // The mounted view still remembers its selection when storage is unavailable.
  }
}

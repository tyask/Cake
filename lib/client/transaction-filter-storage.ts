import { transactionColumns, type TransactionFilters } from "../shared/transaction-filters";

export function transactionFiltersStorageKey(userId: string, workspaceId: string): string {
  return `cake:transaction-filters:v1:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;
}

export function parseStoredTransactionFilters(raw: string | null): TransactionFilters {
  if (raw === null) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

    const stored = parsed as Record<string, unknown>;
    const filters: TransactionFilters = {};
    for (const { id } of transactionColumns) {
      const value = stored[id];
      if (Array.isArray(value) && value.every(item => typeof item === "string")) {
        // v1 stored an unsigned amount matching both types. Preserve that meaning.
        filters[id] = id === "amountYen"
          ? [...new Set(value.flatMap(item => /^\d+$/.test(item) ? [`PAYMENT:${item}`, `RECEIPT:${item}`] : [item]))]
          : value;
      }
    }
    return filters;
  } catch {
    return {};
  }
}

export function readStoredTransactionFilters(storage: Pick<Storage, "getItem">, key: string): TransactionFilters {
  try {
    return parseStoredTransactionFilters(storage.getItem(key));
  } catch {
    return {};
  }
}

export function writeStoredTransactionFilters(storage: Pick<Storage, "setItem" | "removeItem">, key: string, filters: TransactionFilters): void {
  try {
    if (Object.keys(filters).length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(filters));
    }
  } catch {
    // Filters still work for the current page when browser storage is unavailable.
  }
}

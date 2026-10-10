"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { TransactionFilters } from "@/lib/transaction-filters";
import { readStoredTransactionFilters, transactionFiltersStorageKey, writeStoredTransactionFilters } from "@/lib/transaction-filter-storage";

const emptyFilters: TransactionFilters = {};
const serverSnapshot = () => emptyFilters;
type FilterUpdate = TransactionFilters | ((current: TransactionFilters) => TransactionFilters);

function createTransactionFilterStore(key: string) {
  const listeners = new Set<() => void>();
  let snapshot: TransactionFilters | undefined;

  function getSnapshot(): TransactionFilters {
    if (snapshot === undefined) {
      try { snapshot = readStoredTransactionFilters(window.localStorage, key); }
      catch { snapshot = {}; }
    }
    return snapshot;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    function onStorage(event: StorageEvent) {
      if (event.key !== key && event.key !== null) return;
      try { if (event.storageArea !== window.localStorage) return; }
      catch { return; }
      snapshot = undefined;
      listener();
    }
    window.addEventListener("storage", onStorage);
    // Recheck changes made between rendering and subscribing, including in another tab.
    snapshot = undefined;
    listener();
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  function setFilters(update: FilterUpdate) {
    snapshot = typeof update === "function" ? update(getSnapshot()) : update;
    try { writeStoredTransactionFilters(window.localStorage, key, snapshot); }
    catch { /* Filtering still works when browser storage is unavailable. */ }
    listeners.forEach(listener => listener());
  }

  return { getSnapshot, subscribe, setFilters };
}

export function useTransactionFilters(userId: string, workspaceId: string) {
  const store = useMemo(() => createTransactionFilterStore(transactionFiltersStorageKey(userId, workspaceId)), [userId, workspaceId]);

  const filters = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);
  return [filters, store.setFilters] as const;
}

"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  defaultTransactionViewSelection, readStoredTransactionView, transactionViewStorageKey, writeStoredTransactionView,
} from "@/lib/client/transaction-view-storage";
import { transactionViewSelectionSchema, type TransactionViewSelection } from "@/lib/shared/transaction-view";

const serverSnapshot = () => null;

function createSelectionStore(key: string) {
  const listeners = new Set<() => void>();
  const fallback = defaultTransactionViewSelection();
  let snapshot: TransactionViewSelection | undefined;

  function getSnapshot(): TransactionViewSelection {
    if (snapshot === undefined) {
      try { snapshot = readStoredTransactionView(window.localStorage, key); }
      catch { snapshot = fallback; }
    }
    return snapshot;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function setSelection(next: TransactionViewSelection) {
    const parsed = transactionViewSelectionSchema.safeParse(next);
    if (!parsed.success) return;
    snapshot = parsed.data;
    try { writeStoredTransactionView(window.localStorage, key, snapshot); }
    catch { /* Selection continues to work when accessing localStorage is denied. */ }
    listeners.forEach(listener => listener());
  }

  return { fallback, getSnapshot, subscribe, setSelection };
}

/** Hydrate before fetching; another tab must not switch away from unsaved edits. */
export function useTransactionViewSelection(userId: string, workspaceId: string) {
  const store = useMemo(() => createSelectionStore(transactionViewStorageKey(userId, workspaceId)), [userId, workspaceId]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);
  return { selection: snapshot ?? store.fallback, hydrated: snapshot !== null, setSelection: store.setSelection };
}

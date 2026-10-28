"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  analyticsFiltersStorageKey, defaultAnalyticsFilters, readStoredAnalyticsFilters, writeStoredAnalyticsFilters,
  type AnalyticsFilterState,
} from "@/lib/client/analytics-filter-storage";

const serverSnapshot = () => null;
type FilterUpdate = AnalyticsFilterState | ((current: AnalyticsFilterState) => AnalyticsFilterState);

function createAnalyticsFilterStore(key: string, workspaceId: string) {
  const listeners = new Set<() => void>();
  let snapshot: AnalyticsFilterState | undefined;

  function getSnapshot(): AnalyticsFilterState {
    if (snapshot === undefined) {
      try { snapshot = readStoredAnalyticsFilters(window.localStorage, key, workspaceId); }
      catch { snapshot = defaultAnalyticsFilters; }
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
    // Catch changes made between rendering and subscribing, including another tab.
    snapshot = undefined;
    listener();
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  function setFilters(update: FilterUpdate) {
    snapshot = typeof update === "function" ? update(getSnapshot()) : update;
    try { writeStoredAnalyticsFilters(window.localStorage, key, snapshot); }
    catch { /* Keep filtering when access to localStorage itself is unavailable. */ }
    listeners.forEach(listener => listener());
  }

  return { getSnapshot, subscribe, setFilters };
}

export function useAnalyticsFilters(userId: string, workspaceId: string) {
  const store = useMemo(() => createAnalyticsFilterStore(analyticsFiltersStorageKey(userId, workspaceId), workspaceId), [userId, workspaceId]);
  const snapshot = useSyncExternalStore<AnalyticsFilterState | null>(store.subscribe, store.getSnapshot, serverSnapshot);
  return [snapshot ?? defaultAnalyticsFilters, store.setFilters, snapshot !== null] as const;
}

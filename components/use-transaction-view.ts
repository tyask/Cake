"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { homeMonth } from "@/lib/shared/home-summary";
import { transactionMatchesView, type TransactionViewDataset, type TransactionViewSelection } from "@/lib/shared/transaction-view";
import type { CategoryDeletion } from "@/lib/shared/category-updates";
import type { TransactionRecord } from "@/lib/shared/types";
import { updateTransactionRecords, type TransactionUpdate } from "@/lib/client/transaction-updates";
import { useTransactionViewSelection } from "./use-transaction-view-selection";

type Result = { key: string; data: TransactionViewDataset | null; loading: boolean; error: string | null };
type Snapshot = { userId: string; workspaceId: string; selection: TransactionViewSelection; active: boolean; generation: number };
const MAX_CACHED_VIEWS = 24;
const unchangedRecords = (_workspaceId: string, records: TransactionRecord[]) => records;

function viewKey(userId: string, workspaceId: string, selection: TransactionViewSelection) {
  return JSON.stringify([userId, workspaceId, selection.mode, selection.mode === "month" ? selection.month : null]);
}

/** The mounted dashboard owns the cache; no records are saved to localStorage. */
export function useTransactionView(userId: string, workspaceId: string, active: boolean,
  reconcile: (workspaceId: string, records: TransactionRecord[]) => TransactionRecord[] = unchangedRecords) {
  const preferences = useTransactionViewSelection(userId, workspaceId);
  const selection = preferences.selection;
  const key = viewKey(userId, workspaceId, selection);
  const current = useRef<Snapshot>({ userId, workspaceId, selection, active, generation: 0 });
  const cache = useRef(new Map<string, TransactionViewDataset>());
  const revisions = useRef(new Map<string, number>());
  const requestId = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const inFlight = useRef<{ key: string; revision: number; generation: number; id: number; controller: AbortController; promise: Promise<boolean> } | null>(null);
  const resultRef = useRef<Result | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [reload, setReload] = useState(0);
  const changing = useRef(false);
  const reconcileRecords = useRef(reconcile);
  useLayoutEffect(() => { reconcileRecords.current = reconcile; }, [reconcile]);

  const publish = useCallback((next: Result | null) => { resultRef.current = next; setResult(next); }, []);
  const clearWorkspace = useCallback((target: string) => {
    revisions.current.set(target, (revisions.current.get(target) ?? 0) + 1);
    for (const [cacheKey, dataset] of cache.current) if (dataset.workspaceId === target) cache.current.delete(cacheKey);
  }, []);

  useLayoutEffect(() => {
    const previous = current.current;
    const changed = previous.userId !== userId || previous.workspaceId !== workspaceId || previous.active !== active
      || viewKey(userId, workspaceId, previous.selection) !== key;
    if (changed) {
      pending.current?.abort();
      requestId.current += 1;
    }
    if (previous.userId !== userId) cache.current.clear();
    current.current = { userId, workspaceId, selection, active, generation: previous.generation + Number(changed) };
  }, [userId, workspaceId, selection, key, active]);

  const load = useCallback(async (next: TransactionViewSelection, force: boolean): Promise<boolean> => {
    const origin = current.current;
    if (!origin.active || !origin.workspaceId) return false;
    if (force) clearWorkspace(origin.workspaceId);
    const nextKey = viewKey(origin.userId, origin.workspaceId, next);
    const revision = revisions.current.get(origin.workspaceId) ?? 0;
    const existing = inFlight.current;
    if (!force && existing?.key === nextKey && existing.revision === revision && existing.generation === origin.generation
      && existing.id === requestId.current && !existing.controller.signal.aborted) return existing.promise;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const id = ++requestId.current;
    const isCurrent = () => id === requestId.current && !controller.signal.aborted
      && current.current.generation === origin.generation && current.current.active
      && (revisions.current.get(origin.workspaceId) ?? 0) === revision;
    const cached = cache.current.get(nextKey);
    if (cached) {
      cache.current.delete(nextKey);
      cache.current.set(nextKey, cached);
      publish({ key: nextKey, data: cached, loading: false, error: null });
      return true;
    }
    const previous = resultRef.current;
    const visibleKey = viewKey(origin.userId, origin.workspaceId, origin.selection);
    publish({ key: visibleKey, data: previous?.key === visibleKey ? previous.data : null, loading: true, error: null });
    const task = (async () => {
      try {
        const query = new URLSearchParams({ workspaceId: origin.workspaceId, mode: next.mode });
        if (next.mode === "month") query.set("month", next.month);
        const response = await fetch(`/api/transactions?${query}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json() as TransactionViewDataset & { error?: string };
        if (!isCurrent()) return false;
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            clearWorkspace(origin.workspaceId);
            publish({ key: visibleKey, data: null, loading: false, error: body.error ?? "取引明細を取得できませんでした。" });
            return false;
          }
          throw new Error(body.error ?? "取引明細を取得できませんでした。");
        }
        if (body.workspaceId !== origin.workspaceId || body.mode !== next.mode || body.month !== (next.mode === "month" ? next.month : null)
          || !Array.isArray(body.transactions)) throw new Error("取引明細の対象が一致しません。再度お試しください。");
        const dataset = { ...body, transactions: reconcileRecords.current(origin.workspaceId, body.transactions) };
        cache.current.set(nextKey, dataset);
        if (cache.current.size > MAX_CACHED_VIEWS) {
          const oldest = cache.current.keys().next().value;
          if (oldest !== undefined) cache.current.delete(oldest);
        }
        publish({ key: nextKey, data: dataset, loading: false, error: null });
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        publish({ key: visibleKey, data: previous?.key === visibleKey ? previous.data : null, loading: false,
          error: error instanceof Error ? error.message : "取引明細を取得できませんでした。" });
        return false;
      }
    })();
    inFlight.current = { key: nextKey, revision, generation: origin.generation, id, controller, promise: task };
    void task.then(() => { if (inFlight.current?.id === id) inFlight.current = null; });
    return task;
  }, [clearWorkspace, publish]);

  useEffect(() => {
    if (!active || !preferences.hydrated || !workspaceId) return;
    void load(selection, false);
  }, [key, active, preferences.hydrated, workspaceId, reload, load, selection]);

  useLayoutEffect(() => () => { current.current.active = false; pending.current?.abort(); requestId.current += 1; }, []);

  const invalidate = useCallback((target: string) => {
    clearWorkspace(target);
    if (current.current.workspaceId === target) {
      pending.current?.abort();
      requestId.current += 1;
      const visible = resultRef.current;
      if (visible?.data?.workspaceId === target) publish({ ...visible, loading: current.current.active, error: null });
      setReload(value => value + 1);
    }
  }, [clearWorkspace, publish]);

  const applyUpdate = useCallback((target: string, update: TransactionUpdate) => {
    revisions.current.set(target, (revisions.current.get(target) ?? 0) + 1);
    const visible = resultRef.current;
    let confirmed: TransactionRecord | undefined;
    if ("transaction" in update) {
      const incoming = update.transaction;
      let known: TransactionRecord | undefined;
      function remember(records: readonly TransactionRecord[]) {
        const candidate = records.find(item => item.id === incoming.id);
        if (!candidate) return;
        const category = known && known.categoryRevision > candidate.categoryRevision ? known : candidate;
        known = { ...candidate, categoryId: category.categoryId, categoryConfirmed: category.categoryConfirmed,
          categoryRevision: category.categoryRevision };
      }
      // Resolve independent memo/category acknowledgements before moving the row
      // out of its old month. The destination cache may not contain the row yet.
      for (const dataset of cache.current.values()) if (dataset.workspaceId === target) remember(dataset.transactions);
      if (visible?.data?.workspaceId === target) remember(visible.data.transactions);
      confirmed = reconcileRecords.current(target, updateTransactionRecords(known ? [known] : [], update))[0];
    }
    const apply = (records: readonly TransactionRecord[]) => confirmed
      ? [...records.filter(item => item.id !== confirmed.id), confirmed].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      : updateTransactionRecords(records, update);
    for (const [cacheKey, dataset] of cache.current) {
      if (dataset.workspaceId !== target) continue;
      const view: TransactionViewSelection = { mode: dataset.mode, month: dataset.month ?? homeMonth() };
      cache.current.set(cacheKey, { ...dataset, transactions: reconcileRecords.current(target, apply(dataset.transactions)).filter(item => transactionMatchesView(item, view)) });
    }
    if (current.current.workspaceId === target && visible?.data?.workspaceId === target) {
      pending.current?.abort();
      requestId.current += 1;
      // A row that moved to another month remains available to the editor's pin
      // until its draft/save finishes. Revisited cached months are strictly scoped.
      publish({ ...visible, data: { ...visible.data, transactions: reconcileRecords.current(target, apply(visible.data.transactions)) }, loading: false });
    } else if (current.current.workspaceId === target && current.current.active) {
      pending.current?.abort();
      requestId.current += 1;
      setReload(value => value + 1);
    }
  }, [publish]);

  const applyCategoryDeletion = useCallback((target: string, deletion: CategoryDeletion) => {
    if (!deletion.deletedCategoryIds.length && !deletion.detachedTransactions.length) return;
    const visible = resultRef.current;
    if (current.current.workspaceId === target && visible?.data?.workspaceId === target) {
      publish({ ...visible, data: { ...visible.data, transactions: reconcileRecords.current(target, visible.data.transactions) } });
    }
    invalidate(target);
  }, [publish, invalidate]);

  const refresh = useCallback(async () => load(current.current.selection, true), [load]);
  const onChange = useCallback(async (next: TransactionViewSelection, prepare: () => Promise<void>): Promise<boolean> => {
    if (changing.current || !current.current.active) return false;
    changing.current = true;
    const origin = current.current;
    try {
      await prepare();
      if (current.current.generation !== origin.generation || !current.current.active) return false;
      const changedMode = origin.selection.mode !== next.mode;
      if (!await load(next, changedMode)) return false;
      if (current.current.generation !== origin.generation || !current.current.active) return false;
      preferences.setSelection(next);
      return true;
    } catch (error) {
      const previous = resultRef.current;
      if (current.current.generation === origin.generation && previous) publish({ ...previous, loading: false,
        error: error instanceof Error ? error.message : "入力を保存できませんでした。" });
      return false;
    } finally { changing.current = false; }
  }, [load, preferences, publish]);

  const visible = result?.key === key ? result : null;
  return { selection, data: visible?.data ?? null, loading: active && (!preferences.hydrated || !visible || visible.loading),
    error: visible?.error ?? null, onChange, refresh, invalidate, applyUpdate, applyCategoryDeletion };
}

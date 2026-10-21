"use client";

import { useEffect, useRef, useState } from "react";
import type { AppActionInput } from "@/lib/app-input";
import { postAction } from "@/lib/app-client";
import { applyTransactionUpdate } from "@/lib/transaction-updates";
import { applyCategoryUpdate, type CategoryDeletion } from "@/lib/category-updates";
import { bootstrapScopeForTab, mergeBootstrapMetadata, type DashboardTab as Tab } from "@/lib/bootstrap";
import { canApplyBootstrapResponse, isDashboardViewCurrent, isWorkspaceViewCurrent } from "@/lib/dashboard-requests";
import type { BootstrapData, BootstrapMetadata, BootstrapScope, Category } from "@/lib/types";

const NOTICE_DURATION_MS = 2_000;
type CategoryDeletionState = CategoryDeletion & { categorySnapshotIds?: ReadonlySet<string> };

export function useDashboardController(initialData: BootstrapData, initialTab: Tab = "home") {
  const [data, setData] = useState(initialData);
  const currentData = useRef(initialData);
  const [tab, setTab] = useState<Tab>(initialTab);
  const currentTab = useRef<Tab>(initialTab);
  const tabGeneration = useRef(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [noticeState, setNoticeState] = useState<{ message: string } | null>(null);
  const notice = noticeState?.message ?? null;
  const selected = data.selected;
  const workspaceView = useRef({ workspaceId: initialData.selected?.workspace.id, generation: 0 });
  const pendingRequests = useRef(0);
  const dataRevision = useRef(0);
  const refreshRequest = useRef(0);
  const manualRefreshPending = useRef(false);
  // Deleted UUIDs cannot become live again. Keep acknowledgements across tab,
  // GET and workspace changes, including responses for not-yet-visible rows.
  const categoryDeletions = useRef(new Map<string, CategoryDeletionState>());

  function setNotice(message: string | null) {
    setNoticeState(message ? { message } : null);
  }

  useEffect(() => {
    if (!noticeState) return;
    const timer = window.setTimeout(() => {
      setNoticeState(current => current === noticeState ? null : current);
    }, NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [noticeState]);

  function startLoading() { pendingRequests.current += 1; setLoading(true); }
  function finishLoading() { pendingRequests.current -= 1; setLoading(pendingRequests.current > 0); }

  function updateData(update: BootstrapData | ((current: BootstrapData) => BootstrapData)) {
    let next = typeof update === "function" ? update(currentData.current) : update;
    const workspaceId = next.selected?.workspace.id;
    const deletion = workspaceId ? categoryDeletions.current.get(workspaceId) : undefined;
    if (workspaceId && deletion) next = applyCategoryUpdate(next, workspaceId, deletion);
    currentData.current = next;
    setData(next);
  }

  function rememberCategoryDeletion(workspaceId: string, deletion: CategoryDeletion, categorySnapshotIds?: ReadonlySet<string>) {
    const previous = categoryDeletions.current.get(workspaceId);
    const transactions = new Map(previous?.detachedTransactions.map(transaction => [transaction.transactionId, transaction]));
    for (const transaction of deletion.detachedTransactions) {
      const current = transactions.get(transaction.transactionId);
      if (!current || transaction.categoryRevision > current.categoryRevision) transactions.set(transaction.transactionId, transaction);
    }
    categoryDeletions.current.set(workspaceId, {
      deletedCategoryIds: [...new Set([...(previous?.deletedCategoryIds ?? []), ...deletion.deletedCategoryIds])],
      detachedTransactions: [...transactions.values()],
      categorySnapshotIds: categorySnapshotIds ?? previous?.categorySnapshotIds,
    });
  }

  async function refresh(workspaceId = workspaceView.current.workspaceId, generation = workspaceView.current.generation, scope: BootstrapScope = bootstrapScopeForTab(currentTab.current)): Promise<boolean> {
    const requestId = ++refreshRequest.current;
    const revision = dataRevision.current;
    const desiredWorkspaceId = workspaceView.current.workspaceId;
    const params = new URLSearchParams();
    if (workspaceId) params.set("workspaceId", workspaceId);
    if (scope === "metadata") params.set("scope", scope);
    const query = params.toString();
    const response = await fetch(`/api/app${query ? `?${query}` : ""}`, { cache: "no-store" });
    const next = await response.json();
    if (!response.ok) throw new Error(next.error ?? "更新に失敗しました。");
    // An autosave for a previous workspace must not replace the newly selected view.
    if (!canApplyBootstrapResponse(
      { workspaceId: desiredWorkspaceId, generation, revision, requestId },
      { ...workspaceView.current, revision: dataRevision.current, requestId: refreshRequest.current },
    )) return false;
    const nextData = scope === "metadata" ? mergeBootstrapMetadata(currentData.current, next as BootstrapMetadata) : next as BootstrapData;
    // A new or externally deleted workspace needs its own transaction data.
    if (!nextData) return refresh(next.selected?.workspace.id, generation, "full");
    if (scope === "metadata" && nextData.selected) {
      const categoryIds = new Set(nextData.selected.categories.map(category => category.id));
      // A different browser may have deleted categories and detached retained
      // or not-yet-visible transactions. Fetch real revisions before adoption.
      const previous = currentData.current.selected;
      const categoryDisappeared = previous?.workspace.id === nextData.selected.workspace.id
        && previous.categories.some(category => !categoryIds.has(category.id));
      if (categoryDisappeared || nextData.selected.transactions.some(transaction => transaction.categoryId && !categoryIds.has(transaction.categoryId))) {
        return refresh(nextData.selected.workspace.id, generation, "full");
      }
    }
    if (nextData.selected) {
      const categoryIds = new Set(nextData.selected.categories.map(category => category.id));
      const previous = currentData.current.selected;
      const deletedCategoryIds = previous?.workspace.id === nextData.selected.workspace.id
        ? previous.categories.filter(category => !categoryIds.has(category.id)).map(category => category.id) : [];
      if (deletedCategoryIds.length || (scope === "full" && categoryDeletions.current.has(nextData.selected.workspace.id))) {
        // Complete metadata establishes absent category UUIDs. A full snapshot
        // also acknowledges real null revisions, including unseen transactions.
        rememberCategoryDeletion(nextData.selected.workspace.id, {
          deletedCategoryIds,
          detachedTransactions: scope === "full" ? nextData.selected.transactions.filter(transaction => transaction.categoryId === null)
            .map(transaction => ({ transactionId: transaction.id, categoryId: null, categoryConfirmed: false, categoryRevision: transaction.categoryRevision })) : [],
        }, scope === "full" ? categoryIds : undefined);
      }
    }
    workspaceView.current.workspaceId = nextData.selected?.workspace.id;
    updateData(nextData);
    return true;
  }

  async function refreshCurrentView(prepare?: () => Promise<void>) {
    if (manualRefreshPending.current) return;
    manualRefreshPending.current = true;
    const { workspaceId, generation } = workspaceView.current;
    const originTabGeneration = tabGeneration.current;
    const isCurrentView = () => isDashboardViewCurrent(
      { workspaceId, generation, tabGeneration: originTabGeneration },
      { ...workspaceView.current, tabGeneration: tabGeneration.current },
    );
    setRefreshing(true);
    startLoading();
    setNotice(null);
    try {
      await prepare?.();
      if (!isCurrentView()) return;
      const applied = await refresh(workspaceId, generation, "full");
      if (applied && isCurrentView()) setNotice("最新状態に更新しました。");
    } catch (error) {
      if (isCurrentView()) setNotice(error instanceof Error ? error.message : "更新に失敗しました。もう一度お試しください。");
    } finally {
      manualRefreshPending.current = false;
      setRefreshing(false);
      finishLoading();
    }
  }

  async function run(payload: AppActionInput, success: string, workspaceId?: string) {
    const originWorkspaceId = "workspaceId" in payload ? payload.workspaceId : selected?.workspace.id;
    const generation = workspaceView.current.generation;
    const originTabGeneration = tabGeneration.current;
    const isCurrentView = () => isWorkspaceViewCurrent(
      { workspaceId: originWorkspaceId, generation }, workspaceView.current,
    );
    const shouldNotify = () => isCurrentView() && originTabGeneration === tabGeneration.current && !manualRefreshPending.current;
    async function synchronizeCategoryMetadata(categoryIds: string[]) {
      try {
        const applied = await refresh(originWorkspaceId, generation, "full");
        const deletion = originWorkspaceId ? categoryDeletions.current.get(originWorkspaceId) : undefined;
        if (applied && isCurrentView() && originWorkspaceId && deletion?.categorySnapshotIds) {
          // The successful write preceded this full snapshot. Missing IDs are
          // deleted, while survivors already have their latest parent/revision.
          rememberCategoryDeletion(originWorkspaceId, {
            deletedCategoryIds: categoryIds.filter(id => !deletion.categorySnapshotIds!.has(id)), detachedTransactions: [],
          }, deletion.categorySnapshotIds);
        }
        if (shouldNotify()) setNotice(applied ? success : "変更は保存されました。画面を更新して最新の状態を確認してください。");
      } catch {
        // The write already succeeded. Do not invite a duplicate CREATE retry.
        if (shouldNotify()) setNotice("変更は保存されました。最新の状態を取得できないため、画面を更新してください。");
      }
    }
    startLoading();
    if (isCurrentView()) dataRevision.current += 1;
    if (shouldNotify()) setNotice(null);
    try {
      const result = await postAction(payload);
      if (payload.action === "deleteCategory" && result.deletedCategoryIds && result.detachedTransactions && originWorkspaceId) {
        rememberCategoryDeletion(originWorkspaceId, result);
      }
      if (isCurrentView()) {
        dataRevision.current += 1;
        const metadataUpdate = (payload.action === "createCategory" || payload.action === "updateCategory") && result.category
          ? { category: result.category, ancestorCategories: result.ancestorCategories }
          : payload.action === "archiveCategory" && result.archivedCategories
            ? { archivedCategories: result.archivedCategories, ancestorCategories: result.ancestorCategories }
            : payload.action === "moveCategory" && result.movedCategories ? { movedCategories: result.movedCategories } : null;
        if (metadataUpdate && originWorkspaceId) {
          const changed: Category[] = "category" in metadataUpdate ? [metadataUpdate.category]
            : "archivedCategories" in metadataUpdate ? metadataUpdate.archivedCategories : metadataUpdate.movedCategories;
          const acknowledged = [...changed, ...("ancestorCategories" in metadataUpdate ? metadataUpdate.ancestorCategories ?? [] : [])] as Category[];
          const deletion = categoryDeletions.current.get(originWorkspaceId);
          const deletedIds = new Set(deletion?.deletedCategoryIds);
          const current = new Map(currentData.current.selected?.categories.map(category => [category.id, category]));
          const needsSnapshot = deletion && acknowledged.some(category => {
            const saved = current.get(category.id);
            if (deletedIds.has(category.id) || (saved && saved.revision >= category.revision)) return false;
            return (!saved && deletion.categorySnapshotIds && !deletion.categorySnapshotIds.has(category.id))
              || (category.parentId !== null && deletedIds.has(category.parentId));
          });
          if (needsSnapshot) await synchronizeCategoryMetadata(acknowledged.map(category => category.id));
          else {
            updateData(current => isCurrentView() ? applyCategoryUpdate(current, originWorkspaceId, metadataUpdate) : current);
            if (shouldNotify()) setNotice(success);
          }
        } else if (payload.action === "deleteCategory" && result.deletedCategoryIds && result.detachedTransactions && originWorkspaceId) {
          const deletion = categoryDeletions.current.get(originWorkspaceId)!;
          const candidate = applyCategoryUpdate(currentData.current, originWorkspaceId, deletion);
          const deletedIds = new Set(deletion.deletedCategoryIds);
          if (candidate.selected?.categories.some(category => category.parentId && deletedIds.has(category.parentId))) {
            await synchronizeCategoryMetadata([]);
          } else {
            updateData(candidate);
            if (shouldNotify()) setNotice(success);
          }
        } else if (payload.action === "saveTransaction" && result.transaction && originWorkspaceId) {
          updateData(current => isCurrentView() ? applyTransactionUpdate(current, originWorkspaceId, { transaction: result.transaction }) : current);
          if (shouldNotify()) setNotice(success);
        } else if (payload.action === "saveTransactionMemo" && result.transactionId && typeof result.memo === "string" && originWorkspaceId) {
          updateData(current => isCurrentView() ? applyTransactionUpdate(current, originWorkspaceId, { transactionId: result.transactionId, memo: result.memo }) : current);
          if (shouldNotify()) setNotice(success);
        } else if (payload.action === "saveTransactionCategory" && result.transactionId && originWorkspaceId) {
          updateData(current => isCurrentView() ? applyTransactionUpdate(current, originWorkspaceId, {
            transactionId: result.transactionId, categoryId: result.categoryId, categoryConfirmed: result.categoryConfirmed, categoryRevision: result.categoryRevision,
          }) : current);
          if (shouldNotify()) setNotice(success);
        } else {
          const applied = await refresh(workspaceId ?? result.workspaceId ?? originWorkspaceId, generation);
          if (applied && shouldNotify()) {
            setNotice(payload.action === "bulkImport" ? `${result.imported}件を取り込みました。` : success);
          }
        }
      }
      return result;
    } catch (error) {
      if (shouldNotify()) setNotice(error instanceof Error ? error.message : "処理に失敗しました。");
      throw error;
    } finally { finishLoading(); }
  }

  async function switchWorkspace(workspaceId: string) {
    const generation = workspaceView.current.generation + 1;
    workspaceView.current = { workspaceId, generation };
    startLoading(); setNotice(null);
    try { await refresh(workspaceId, generation, "full"); }
    catch (error) {
      if (generation === workspaceView.current.generation) {
        workspaceView.current = { workspaceId: selected?.workspace.id, generation: generation + 1 };
        setNotice(error instanceof Error ? error.message : "読込に失敗しました。");
      }
    } finally { finishLoading(); }
  }

  function openTab(next: Tab) {
    if (next === tab) return;
    const originTabGeneration = ++tabGeneration.current;
    currentTab.current = next;
    setTab(next);
    startLoading();
    const generation = workspaceView.current.generation;
    void refresh().catch(error => {
      if (generation === workspaceView.current.generation && originTabGeneration === tabGeneration.current) setNotice(error instanceof Error ? error.message : "読込に失敗しました。");
    }).finally(finishLoading);
  }

  return { data, selected, tab, loading, refreshing, notice, setNotice, refresh, refreshCurrentView, run, switchWorkspace, openTab };
}

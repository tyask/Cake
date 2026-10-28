"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppActionInput } from "@/lib/shared/schemas/app-input";
import { postAction } from "@/lib/client/app-client";
import { applyTransactionUpdate } from "@/lib/client/transaction-updates";
import { applyCategoryUpdate, type CategoryDeletion } from "@/lib/shared/category-updates";
import { bootstrapScopeForTab, mergeBootstrapMetadata } from "@/lib/client/bootstrap";
import type { DashboardTab as Tab } from "@/lib/shared/types";
import { canApplyBootstrapResponse, isDashboardViewCurrent, isWorkspaceViewCurrent } from "@/lib/client/dashboard-requests";
import { isWorkspaceData, type BootstrapData, type BootstrapMetadata, type BootstrapScope, type Category } from "@/lib/shared/types";

const NOTICE_DURATION_MS = 2_000;
type CategorySnapshot = { ids: ReadonlySet<string>; generation: number };
type CategoryDeletionState = CategoryDeletion & { categorySnapshot?: CategorySnapshot };

export function useDashboardController(initialData: BootstrapMetadata, initialTab: Tab = "home") {
  const [data, setData] = useState<BootstrapMetadata>(initialData);
  const currentData = useRef<BootstrapMetadata>(initialData);
  const [transactionsReady, setTransactionsReady] = useState(initialTab === "transactions" && isWorkspaceData(initialData.selected));
  const homeRefresh = useRef<(() => Promise<void>) | null>(null);
  const registerHomeRefresh = useCallback((refresh: (() => Promise<void>) | null) => { homeRefresh.current = refresh; }, []);
  const [tab, setTab] = useState<Tab>(initialTab);
  const currentTab = useRef<Tab>(initialTab);
  const tabGeneration = useRef(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const [analyticsRevision, setAnalyticsRevision] = useState(0);
  const [importHistoryRevisions, setImportHistoryRevisions] = useState<Record<string, number>>({});
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

  function updateData(update: BootstrapMetadata | ((current: BootstrapMetadata) => BootstrapMetadata)) {
    let next = typeof update === "function" ? update(currentData.current) : update;
    const workspaceId = next.selected?.workspace.id;
    const deletion = workspaceId ? categoryDeletions.current.get(workspaceId) : undefined;
    if (workspaceId && deletion && (deletion.deletedCategoryIds.length || deletion.detachedTransactions.length)) {
      next = applyCategoryUpdate(next, workspaceId, deletion);
    }
    currentData.current = next;
    setData(next);
  }

  function rememberCategoryDeletion(workspaceId: string, deletion: CategoryDeletion, categorySnapshot?: CategorySnapshot) {
    const previous = categoryDeletions.current.get(workspaceId);
    const transactions = new Map(previous?.detachedTransactions.map(transaction => [transaction.transactionId, transaction]));
    for (const transaction of deletion.detachedTransactions) {
      const current = transactions.get(transaction.transactionId);
      if (!current || transaction.categoryRevision > current.categoryRevision) transactions.set(transaction.transactionId, transaction);
    }
    categoryDeletions.current.set(workspaceId, {
      deletedCategoryIds: [...new Set([...(previous?.deletedCategoryIds ?? []), ...deletion.deletedCategoryIds])],
      detachedTransactions: [...transactions.values()],
      categorySnapshot: categorySnapshot ?? previous?.categorySnapshot,
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
    try {
      const response = await fetch(`/api/app${query ? `?${query}` : ""}`, { cache: "no-store" });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error ?? "更新に失敗しました。");
      // An autosave for a previous workspace must not replace the newly selected view.
      if (!canApplyBootstrapResponse(
        { workspaceId: desiredWorkspaceId, generation, revision, requestId },
        { ...workspaceView.current, revision: dataRevision.current, requestId: refreshRequest.current },
      )) return false;
      let nextData: BootstrapMetadata = scope === "metadata"
        ? mergeBootstrapMetadata(currentData.current, next as BootstrapMetadata) ?? next as BootstrapMetadata
        : next as BootstrapData;
      if (scope === "metadata" && nextData.selected) {
        const categoryIds = new Set(nextData.selected.categories.map(category => category.id));
        // A category snapshot cannot acknowledge transaction revisions. Drop the
        // retained list; its next visit loads real revisions without a home full GET.
        const previous = currentData.current.selected;
        const categoryDisappeared = previous?.workspace.id === nextData.selected.workspace.id
          && previous.categories.some(category => !categoryIds.has(category.id));
        if (categoryDisappeared || (isWorkspaceData(nextData.selected) && nextData.selected.transactions.some(transaction => transaction.categoryId && !categoryIds.has(transaction.categoryId)))) {
          if (currentTab.current === "transactions") {
            setTransactionsReady(false);
            return refresh(nextData.selected.workspace.id, generation, "full");
          }
          const { workspace, members, rules, categories } = nextData.selected;
          nextData = { ...nextData, selected: { workspace, members, rules, categories } };
        }
      }
      if (nextData.selected) {
        const categoryIds = new Set(nextData.selected.categories.map(category => category.id));
        const previous = currentData.current.selected;
        const deletedCategoryIds = previous?.workspace.id === nextData.selected.workspace.id
          ? previous.categories.filter(category => !categoryIds.has(category.id)).map(category => category.id) : [];
        const deletionKnown = deletedCategoryIds.length > 0 || (categoryDeletions.current.get(nextData.selected.workspace.id)?.deletedCategoryIds.length ?? 0) > 0;
        // Both scopes return all categories. Every adopted response advances the
        // snapshot, including unchanged/empty lists without a known deletion.
        // Only a full response can acknowledge real transaction null revisions.
        rememberCategoryDeletion(nextData.selected.workspace.id, {
          deletedCategoryIds,
          detachedTransactions: scope === "full" && deletionKnown && isWorkspaceData(nextData.selected) ? nextData.selected.transactions.filter(transaction => transaction.categoryId === null)
            .map(transaction => ({ transactionId: transaction.id, categoryId: null, categoryConfirmed: false, categoryRevision: transaction.categoryRevision })) : [],
        }, { ids: categoryIds,
          generation: (categoryDeletions.current.get(nextData.selected.workspace.id)?.categorySnapshot?.generation ?? 0) + 1,
        });
      }
      workspaceView.current.workspaceId = nextData.selected?.workspace.id;
      updateData(nextData);
      setTransactionsReady(scope === "full" && currentTab.current === "transactions" && isWorkspaceData(nextData.selected));
      setWorkspaceSwitching(false);
      return true;
    } catch (error) {
      // A superseded workspace request cannot end a newer pending switch.
      if (requestId === refreshRequest.current && generation === workspaceView.current.generation) {
        const previousWorkspaceId = currentData.current.selected?.workspace.id;
        if (workspaceView.current.workspaceId !== previousWorkspaceId) {
          workspaceView.current = { workspaceId: previousWorkspaceId, generation: generation + 1 };
          setTransactionsReady(currentTab.current === "transactions" && isWorkspaceData(currentData.current.selected));
          setNotice(error instanceof Error ? error.message : "読込に失敗しました。");
        }
        setWorkspaceSwitching(false);
      }
      throw error;
    }
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
      const applied = await refresh(workspaceId, generation);
      const refreshHome = currentTab.current === "home" ? homeRefresh.current : null;
      if (applied && isCurrentView()) await refreshHome?.();
      if (applied && isCurrentView() && (!refreshHome || homeRefresh.current === refreshHome)) setNotice("最新状態に更新しました。");
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
    const categorySnapshotGeneration = originWorkspaceId
      ? categoryDeletions.current.get(originWorkspaceId)?.categorySnapshot?.generation ?? 0 : 0;
    const generation = workspaceView.current.generation;
    const originTabGeneration = tabGeneration.current;
    const isCurrentView = () => isWorkspaceViewCurrent(
      { workspaceId: originWorkspaceId, generation }, workspaceView.current,
    );
    const shouldNotify = () => isCurrentView() && originTabGeneration === tabGeneration.current && !manualRefreshPending.current;
    async function synchronizeCategoryMetadata(categoryIds: string[]) {
      try {
        const applied = await refresh(originWorkspaceId, generation);
        const deletion = originWorkspaceId ? categoryDeletions.current.get(originWorkspaceId) : undefined;
        const snapshot = deletion?.categorySnapshot;
        if (applied && isCurrentView() && originWorkspaceId && snapshot) {
          // The successful write preceded this full snapshot. Missing IDs are
          // deleted, while survivors already have their latest parent/revision.
          const deletedCategoryIds = categoryIds.filter(id => !snapshot.ids.has(id));
          rememberCategoryDeletion(originWorkspaceId, {
            deletedCategoryIds,
            detachedTransactions: deletedCategoryIds.length && isWorkspaceData(currentData.current.selected) ? currentData.current.selected.transactions.filter(transaction => transaction.categoryId === null)
              .map(transaction => ({ transactionId: transaction.id, categoryId: null, categoryConfirmed: false, categoryRevision: transaction.categoryRevision })) : [],
          }, snapshot);
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
    let savedResult: Awaited<ReturnType<typeof postAction>> | undefined;
    try {
      const result = await postAction(payload);
      savedResult = result;
      if (payload.action === "bulkImport" && originWorkspaceId) {
        // The import is committed even if the view changed while POST was in
        // flight, or fetching fresh workspace metadata fails afterwards.
        setImportHistoryRevisions(current => ({ ...current, [originWorkspaceId]: (current[originWorkspaceId] ?? 0) + 1 }));
      }
      if (payload.action === "deleteCategory" && result.deletedCategoryIds && result.detachedTransactions && originWorkspaceId) {
        rememberCategoryDeletion(originWorkspaceId, result);
      }
      if (isCurrentView()) {
        dataRevision.current += 1;
        setAnalyticsRevision(revision => revision + 1);
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
          const snapshot = deletion?.categorySnapshot;
          const snapshotNeedsRecheck = snapshot && (deletedIds.size > 0 || snapshot.generation > categorySnapshotGeneration);
          const current = new Map(currentData.current.selected?.categories.map(category => [category.id, category]));
          const needsSnapshot = deletion && acknowledged.some(category => {
            const saved = current.get(category.id);
            if (deletedIds.has(category.id) || (saved && saved.revision >= category.revision)) return false;
            return (!saved && snapshot && snapshotNeedsRecheck && !snapshot.ids.has(category.id))
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
        } else if (payload.action === "bulkImport") {
          try {
            const applied = await refresh(originWorkspaceId, generation);
            if (shouldNotify()) setNotice(applied ? `${result.imported}件を取り込みました。`
              : "取込は保存されました。画面を更新して最新の状態を確認してください。");
          } catch {
            // Do not turn a successful import into a failed-save retry.
            if (shouldNotify()) setNotice(`${result.imported}件を取り込みました。家計の最新状態を取得できないため、画面を更新してください。`);
          }
        } else {
          const applied = await refresh(workspaceId ?? result.workspaceId ?? originWorkspaceId, generation);
          if (applied && shouldNotify()) {
            setNotice(success);
          }
        }
      }
      return result;
    } catch (error) {
      if (savedResult) {
        if (shouldNotify()) setNotice("変更は保存されました。最新の状態を取得できないため、画面を更新してください。");
        return savedResult;
      }
      if (shouldNotify()) setNotice(error instanceof Error ? error.message : "処理に失敗しました。");
      throw error;
    } finally { finishLoading(); }
  }

  async function switchWorkspace(workspaceId: string) {
    const generation = workspaceView.current.generation + 1;
    workspaceView.current = { workspaceId, generation };
    setWorkspaceSwitching(true);
    setTransactionsReady(false);
    startLoading(); setNotice(null);
    const pending = refresh(workspaceId, generation);
    const requestId = refreshRequest.current;
    try { await pending; }
    catch (error) {
      if (generation === workspaceView.current.generation && requestId === refreshRequest.current) {
        setNotice(error instanceof Error ? error.message : "読込に失敗しました。");
      }
    } finally { finishLoading(); }
  }

  function openTab(next: Tab) {
    if (next === tab) return;
    const originTabGeneration = ++tabGeneration.current;
    currentTab.current = next;
    setTab(next);
    setTransactionsReady(false);
    startLoading();
    const generation = workspaceView.current.generation;
    void refresh().catch(error => {
      if (generation === workspaceView.current.generation && originTabGeneration === tabGeneration.current) setNotice(error instanceof Error ? error.message : "読込に失敗しました。");
    }).finally(finishLoading);
  }

  const selectedTransactions = tab === "transactions" && transactionsReady && isWorkspaceData(selected) ? selected : null;
  const importHistoryRevision = selected ? importHistoryRevisions[selected.workspace.id] ?? 0 : 0;
  return { data, selected, selectedTransactions, registerHomeRefresh, tab, loading, refreshing, workspaceSwitching, analyticsRevision, importHistoryRevision, notice, setNotice, refresh, refreshCurrentView, run, switchWorkspace, openTab };
}

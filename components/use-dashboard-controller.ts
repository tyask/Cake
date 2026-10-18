"use client";

import { useEffect, useRef, useState } from "react";
import type { AppActionInput } from "@/lib/app-input";
import { postAction } from "@/lib/app-client";
import { applyTransactionUpdate } from "@/lib/transaction-updates";
import { bootstrapScopeForTab, mergeBootstrapMetadata, type DashboardTab as Tab } from "@/lib/bootstrap";
import { canApplyBootstrapResponse, isDashboardViewCurrent, isWorkspaceViewCurrent } from "@/lib/dashboard-requests";
import type { BootstrapData, BootstrapMetadata, BootstrapScope } from "@/lib/types";

const NOTICE_DURATION_MS = 2_000;

export function useDashboardController(initialData: BootstrapData) {
  const [data, setData] = useState(initialData);
  const currentData = useRef(initialData);
  const [tab, setTab] = useState<Tab>("home");
  const currentTab = useRef<Tab>("home");
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
    const next = typeof update === "function" ? update(currentData.current) : update;
    currentData.current = next;
    setData(next);
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
    startLoading();
    if (isCurrentView()) dataRevision.current += 1;
    if (shouldNotify()) setNotice(null);
    try {
      const result = await postAction(payload);
      if (isCurrentView()) {
        dataRevision.current += 1;
        if (payload.action === "saveTransaction" && result.transaction && originWorkspaceId) {
          updateData(current => isCurrentView() ? applyTransactionUpdate(current, originWorkspaceId, { transaction: result.transaction }) : current);
          if (shouldNotify()) setNotice(success);
        } else if (payload.action === "saveTransactionMemo" && result.transactionId && typeof result.memo === "string" && originWorkspaceId) {
          updateData(current => isCurrentView() ? applyTransactionUpdate(current, originWorkspaceId, { transactionId: result.transactionId, memo: result.memo }) : current);
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

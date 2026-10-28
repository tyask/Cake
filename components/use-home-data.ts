"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HomeData } from "@/lib/shared/home-data";

type HomeResult = {
  key: string;
  revision: number;
  data: HomeData | null;
  loading: boolean;
  error: string | null;
};

/** Only the selected workspace/month and the latest confirmed revision can be shown. */
export function useHomeData(workspaceId: string, month: string, revision = 0, active = true) {
  const key = new URLSearchParams({ workspaceId, month }).toString();
  const currentView = useRef({ key, revision, active });
  const acknowledged = useRef({ workspaceId, revision });
  const [result, setResult] = useState<HomeResult | null>(null);
  const latestRequest = useRef(0);
  const pending = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    currentView.current = { key, revision, active };
    if (acknowledged.current.workspaceId !== workspaceId) acknowledged.current = { workspaceId, revision };
  }, [key, workspaceId, revision, active]);

  const refresh = useCallback(async () => {
    if (!active || currentView.current.key !== key || currentView.current.revision !== revision || !currentView.current.active) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const request = ++latestRequest.current;
    const isCurrent = () => request === latestRequest.current && !controller.signal.aborted
      && currentView.current.key === key && currentView.current.revision === revision && currentView.current.active;
    setResult({ key, revision, data: null, loading: true, error: null });
    try {
      const response = await fetch(`/api/home?${key}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json() as HomeData & { error?: string };
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(body.error ?? "ホームの集計を取得できませんでした。");
      if (body.workspaceId !== workspaceId || body.month !== month) throw new Error("集計の対象が一致しません。再度お試しください。");
      acknowledged.current = { workspaceId, revision };
      setResult({ key, revision, data: body, loading: false, error: null });
    } catch (error) {
      if (!isCurrent()) return;
      const saved = acknowledged.current.workspaceId === workspaceId && acknowledged.current.revision !== revision;
      const message = saved ? "変更は保存されました。ホームの最新状態を取得できませんでした。更新して再度お試しください。"
        : error instanceof Error ? error.message : "ホームの集計を取得できませんでした。再度お試しください。";
      setResult({ key, revision, data: null, loading: false, error: message });
      throw new Error(message);
    }
  }, [key, workspaceId, month, revision, active]);

  useEffect(() => {
    if (!active) return;
    // The render already derives the pending state for a new target/revision.
    // Start the external request after effects finish setting up this view.
    void Promise.resolve().then(refresh).catch(() => {});
    return () => {
      latestRequest.current += 1;
      pending.current?.abort();
    };
  }, [refresh, active]);

  const current = active && result?.key === key && result.revision === revision ? result : null;
  return {
    data: current?.data ?? null,
    loading: active && (!current || current.loading),
    error: current?.error ?? null,
    refresh,
  };
}

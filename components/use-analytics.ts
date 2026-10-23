"use client";

import { useEffect, useRef, useState } from "react";
import type { AnalyticsDataset, AnalyticsQuery } from "@/lib/shared/analytics";

type AnalyticsResult = {
  key: string;
  revision: number;
  data: AnalyticsDataset | null;
  loading: boolean;
  error: string | null;
};

/** Display filters deliberately never enter this request key or this hook. */
export function useAnalytics(query: AnalyticsQuery, revision: number, active: boolean) {
  const parameters = new URLSearchParams(query);
  const key = parameters.toString();
  const workspaceId = query.workspaceId;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<AnalyticsResult | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const request = ++latestRequest.current;
    const isCurrent = () => request === latestRequest.current && !controller.signal.aborted;
    async function load() {
      setResult(previous => ({ key, revision,
        data: previous?.data?.workspaceId === workspaceId ? previous.data : null, loading: true, error: null }));
      try {
        const response = await fetch(`/api/analytics?${key}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json() as AnalyticsDataset & { error?: string };
        if (!isCurrent()) return;
        if (!response.ok) throw new Error(body.error ?? "集計を取得できませんでした。再度お試しください。");
        if (body.workspaceId !== workspaceId) {
          throw new Error("集計の対象が一致しません。再度お試しください。");
        }
        setResult({ key, revision, data: body, loading: false, error: null });
      } catch (error) {
        if (isCurrent()) setResult(previous => ({ key, revision,
          data: previous?.data?.workspaceId === workspaceId ? previous.data : null, loading: false,
          error: error instanceof Error ? error.message : "集計を取得できませんでした。再度お試しください。" }));
      }
    }
    void load();
    return () => { controller.abort(); };
  }, [key, workspaceId, revision, active, attempt]);

  const current = active && result?.key === key && result.revision === revision ? result : null;
  return {
    data: active && result?.data?.workspaceId === workspaceId ? result.data : null,
    loading: active && (!current || current.loading),
    error: current?.error ?? null,
    refresh: () => setAttempt(value => value + 1),
  };
}

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
type MonthlySnapshot = Pick<HomeData, "monthly" | "members">;
type SharedSnapshot = Pick<HomeData, "unsettled" | "settlement" | "settlementHistory"> & { membersSignature: string };

const MAX_CACHED_MONTHS = 12;
const memberSignature = (members: HomeData["members"]) => JSON.stringify(members.map(member => [member.id, member.name]));

/** Only the selected workspace/month and the latest confirmed revision can be shown. */
export function useHomeData(workspaceId: string, month: string, revision = 0, active = true) {
  const key = new URLSearchParams({ workspaceId, month }).toString();
  const currentView = useRef({ key, workspaceId, revision, active });
  const acknowledged = useRef({ workspaceId, revision });
  const [result, setResult] = useState<HomeResult | null>(null);
  const [previousActive, setPreviousActive] = useState(active);
  if (previousActive !== active) {
    setPreviousActive(active);
    setResult(null);
  }
  const latestRequest = useRef(0);
  const pending = useRef<AbortController | null>(null);
  // These snapshots belong only to this mounted home view and confirmed revision.
  const months = useRef(new Map<string, MonthlySnapshot>());
  const shared = useRef<SharedSnapshot | null>(null);

  useLayoutEffect(() => {
    const previous = currentView.current;
    if (previous.workspaceId !== workspaceId || previous.revision !== revision || !active) {
      months.current.clear();
      shared.current = null;
      latestRequest.current += 1;
      pending.current?.abort();
    }
    currentView.current = { key, workspaceId, revision, active };
    if (acknowledged.current.workspaceId !== workspaceId) acknowledged.current = { workspaceId, revision };
  }, [key, workspaceId, revision, active]);

  const load = useCallback(async (force: boolean) => {
    if (!active || currentView.current.key !== key || currentView.current.revision !== revision || !currentView.current.active) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const request = ++latestRequest.current;
    const isCurrent = () => request === latestRequest.current && !controller.signal.aborted
      && currentView.current.key === key && currentView.current.revision === revision && currentView.current.active;
    if (force) {
      months.current.clear();
      shared.current = null;
    }
    const cached = months.current.get(key);
    const context = shared.current;
    if (!force && cached && context) {
      months.current.delete(key);
      months.current.set(key, cached);
      setResult({ key, revision, data: { workspaceId, month, ...cached,
        unsettled: context.unsettled, settlement: context.settlement, settlementHistory: context.settlementHistory },
      loading: false, error: null });
      return;
    }
    setResult({ key, revision, data: null, loading: true, error: null });
    try {
      const response = await fetch(`/api/home?${key}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json() as HomeData & { error?: string };
      if (!isCurrent()) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          months.current.clear();
          shared.current = null;
        }
        throw new Error(body.error ?? "ホームの集計を取得できませんでした。");
      }
      if (body.workspaceId !== workspaceId || body.month !== month) throw new Error("集計の対象が一致しません。再度お試しください。");
      const signature = memberSignature(body.members);
      if (shared.current && shared.current.membersSignature !== signature) months.current.clear();
      shared.current = { membersSignature: signature, unsettled: body.unsettled,
        settlement: body.settlement, settlementHistory: body.settlementHistory };
      months.current.delete(key);
      months.current.set(key, { members: body.members, monthly: body.monthly });
      if (months.current.size > MAX_CACHED_MONTHS) {
        const oldest = months.current.keys().next().value;
        if (oldest !== undefined) months.current.delete(oldest);
      }
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

  // Explicit refresh/retry always discards every month before fetching fresh data.
  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    if (!active) return;
    // The render already derives the pending state for a new target/revision.
    // Start the external request after effects finish setting up this view.
    void Promise.resolve().then(() => load(false)).catch(() => {});
    return () => {
      latestRequest.current += 1;
      pending.current?.abort();
    };
  }, [load, active]);

  useLayoutEffect(() => () => {
    currentView.current.active = false;
    latestRequest.current += 1;
    pending.current?.abort();
    months.current.clear();
    shared.current = null;
  }, []);

  const current = active && result?.key === key && result.revision === revision ? result : null;
  return {
    data: current?.data ?? null,
    loading: active && (!current || current.loading),
    error: current?.error ?? null,
    refresh,
  };
}

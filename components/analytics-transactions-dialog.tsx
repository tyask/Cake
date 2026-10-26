"use client";

import { useEffect, useState } from "react";
import type { AnalyticsDataset, AnalyticsRow } from "@/lib/shared/analytics";
import type { PreparedAnalyticsDataset } from "@/lib/shared/analytics-view";
import type { AnalyticsTransactionsDataset } from "@/lib/shared/analytics-transactions";
import { selectAnalyticsTransactions, type AnalyticsTransactionSelection } from "@/lib/shared/analytics-transaction-view";
import { formatYen } from "@/lib/shared/display-formatters";
import { TransactionListDialog, type TransactionListDialogState } from "./transaction-list-dialog";

export function AnalyticsTransactionsDialog({ data, prepared, row, selection, close }: {
  data: AnalyticsDataset;
  prepared: PreparedAnalyticsDataset;
  row: AnalyticsRow;
  selection: AnalyticsTransactionSelection;
  close: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; state: TransactionListDialogState; totalYen?: bigint } | null>(null);
  const parameters = new URLSearchParams({ workspaceId: data.workspaceId, period: "range",
    from: data.periods.current.from, to: data.periods.current.to }).toString();
  const state: TransactionListDialogState = result?.attempt === attempt ? result.state : { status: "loading" };

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/analytics/transactions?${parameters}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json() as AnalyticsTransactionsDataset & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "明細を取得できませんでした。");
        if (controller.signal.aborted) return;
        if (body.workspaceId !== data.workspaceId || body.period.from !== data.periods.current.from || body.period.to !== data.periods.current.to) {
          throw new Error("明細の対象が一致しません。再度お試しください。");
        }
        const selected = selectAnalyticsTransactions(body.transactions, body.members, body.period, prepared, selection);
        setResult({ attempt, state: { status: "success", transactions: selected.transactions, categories: body.categories }, totalYen: selected.totalYen });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ attempt, state: { status: "error",
          message: error instanceof Error ? error.message : "明細を取得できませんでした。" } });
      }
    }
    void load();
    return () => controller.abort();
  }, [parameters, data, prepared, selection, attempt]);

  return <TransactionListDialog title={`${row.label}の明細`} state={state} onRetry={() => setAttempt(value => value + 1)} onClose={close}
    emptyMessage="この期間・表示条件に該当する明細はありません。"
    description={<>
      <p>対象期間 {data.periods.current.from.replaceAll("-", "/")} ～ {data.periods.current.to.replaceAll("-", "/")}</p>
      <p>{selection.viewMode === "self" ? "自分の支出" : "共有費全体"}：{formatYen(row.currentYen)}
        {state.status === "success" && result?.totalYen !== row.currentYen && `（現在の明細による集計額：${formatYen(result?.totalYen ?? BigInt(0))}）`}</p>
      <p>明細の金額は取引全額です。{selection.viewMode === "self" && "集計額は自分の配分です。"}清算済みを含みます。</p>
      <p>明細は現在の保存内容で表示します。更新や削除により、取得済みの集計と異なる場合があります。</p>
    </>} />;
}

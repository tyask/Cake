"use client";

import { useEffect, useState } from "react";
import { DateTimePrecision, formatJstDateTime } from "@/lib/shared/display-formatters";
import type { ImportFormat, ImportHistoryEntry, ImportTransactionsResponse } from "@/lib/shared/import-history";
import { TransactionListDialog, type TransactionListDialogState } from "./transaction-list-dialog";
import styles from "./import-history-panel.module.css";

export function ImportTransactionsDialog({ workspaceId, format, entry, close }: {
  workspaceId: string;
  format: ImportFormat;
  entry: ImportHistoryEntry;
  close: () => void;
}) {
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; state: TransactionListDialogState } | null>(null);
  const requestKey = `${workspaceId}:${format}:${entry.id}:${retry}`;
  const state: TransactionListDialogState = result?.key === requestKey ? result.state : { status: "loading" };

  useEffect(() => {
    const controller = new AbortController();
    async function loadTransactions() {
      try {
        const query = new URLSearchParams({ workspaceId, format, batchId: entry.id });
        const response = await fetch(`/api/import/transactions?${query}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json() as ImportTransactionsResponse & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "明細を取得できませんでした。");
        if (!controller.signal.aborted) setResult({ key: requestKey, state: { status: "success", transactions: data.transactions, categories: data.categories } });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key: requestKey, state: { status: "error",
          message: error instanceof Error ? error.message : "明細を取得できませんでした。" } });
      }
    }
    void loadTransactions();
    return () => controller.abort();
  }, [workspaceId, format, entry.id, requestKey]);

  return <TransactionListDialog title="取り込んだ明細" state={state} onRetry={() => setRetry(value => value + 1)} onClose={close}
    emptyMessage={entry.importedRows > 0 ? "この取込で登録した明細は現在残っていません。" : "この取込で登録された明細はありません。"}
    description={<div className={styles.details}>
      <dl><dt>ファイル名</dt><dd>{entry.fileName}</dd>
        <dt>取込日時</dt><dd>{formatJstDateTime(entry.createdAt, DateTimePrecision.Minute)}</dd>
        <dt>取込者</dt><dd>{entry.importedByName}</dd></dl>
      <p className={styles.detailCount}>取込時{entry.importedRows}件{state.status === "success" && `・現在${state.transactions.length}件`}</p>
      <p>明細は現在の内容で表示しています。{state.status === "success" && state.transactions.length !== entry.importedRows && "削除などにより、取込時の登録件数と現在の明細数が異なる場合があります。"}</p>
    </div>} />;
}

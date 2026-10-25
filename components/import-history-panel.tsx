"use client";

import { useEffect, useId, useState } from "react";
import { DateTimePrecision, formatJstDateTime, formatJstShortDateTime } from "@/lib/shared/display-formatters";
import { IMPORT_FORMATS, IMPORT_HISTORY_PER_USER_LIMIT, type ImportFormat, type ImportHistoryEntry, type ImportHistoryResponse } from "@/lib/shared/import-history";
import { ImportTransactionsDialog } from "./import-transactions-dialog";
import styles from "./import-history-panel.module.css";

type HistoryResult = { key: string } & (
  { status: "success"; history: ImportHistoryEntry[] } | { status: "error"; message: string }
);

export function ImportHistoryPanel({ workspaceId, format, refreshKey }: { workspaceId: string; format: ImportFormat; refreshKey: number }) {
  const titleId = useId();
  const [result, setResult] = useState<HistoryResult | null>(null);
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<{ workspaceId: string; format: ImportFormat; entry: ImportHistoryEntry } | null>(null);
  const activeDetail = detail?.workspaceId === workspaceId && detail.format === format ? detail : null;
  const requestKey = `${workspaceId}:${format}:${refreshKey}:${retry}`;
  const current = result?.key === requestKey ? result : null;
  const formatLabel = IMPORT_FORMATS[format].label;

  useEffect(() => {
    const controller = new AbortController();
    async function loadHistory() {
      try {
        const query = new URLSearchParams({ workspaceId, format });
        const response = await fetch(`/api/import/history?${query}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json() as ImportHistoryResponse & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "取込履歴を取得できませんでした。");
        if (!controller.signal.aborted) setResult({ key: requestKey, status: "success", history: data.history });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key: requestKey, status: "error",
          message: error instanceof Error ? error.message : "取込履歴を取得できませんでした。" });
      }
    }
    void loadHistory();
    return () => controller.abort();
  }, [workspaceId, format, requestKey]);

  return <section className={`panel ${styles.panel}`} aria-labelledby={titleId} aria-busy={current === null}>
    <header className={styles.header}>
      <div><h2 id={titleId}>最近の取込履歴</h2><p>取込者ごとに最新{IMPORT_HISTORY_PER_USER_LIMIT}件 · 新しい順</p></div>
      <span className={styles.format}>{formatLabel}</span>
    </header>
    {current === null ? <p className={styles.message} role="status">取込履歴を読み込んでいます…</p>
      : current.status === "error" ? <div className={styles.message}>
        <p className="form-error" role="alert">{current.message}</p>
        <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>再試行</button>
      </div>
      : current.history.length === 0 ? <p className={styles.message}>{formatLabel}の取込履歴はまだありません。</p>
      : <>
        <table className={styles.table} aria-label={`${formatLabel}の取込履歴`}>
          <thead><tr><th scope="col">日時</th><th scope="col">ファイル名</th><th scope="col">取込者</th><th scope="col">登録</th></tr></thead>
          <tbody>{current.history.map(entry => {
            const fullDateTime = formatJstDateTime(entry.createdAt, DateTimePrecision.Minute);
            return <tr key={entry.id}>
              <td><time dateTime={entry.createdAt} title={fullDateTime} aria-label={fullDateTime}>
                <span className={styles.fullDate}>{fullDateTime}</span><span className={styles.shortDate} aria-hidden="true">{formatJstShortDateTime(entry.createdAt)}</span>
              </time></td>
              <td><button type="button" className={styles.fileName} title={entry.fileName} aria-label={`${entry.fileName}の取込詳細を開く`} onClick={() => setDetail({ workspaceId, format, entry })}>{entry.fileName}</button></td>
              <td><span className={styles.truncated} title={entry.importedByName}>{entry.importedByName}</span></td>
              <td className={styles.registered}><span className={styles.truncated} title={`${entry.importedRows}件`}>{entry.importedRows}</span></td>
            </tr>;
          })}</tbody>
        </table>
        <p className={styles.note}>登録の単位は件。ファイル名を押すと、取り込んだ明細の現在の内容を確認できます。</p>
      </>}
    {activeDetail !== null && <ImportTransactionsDialog key={`${workspaceId}:${format}:${activeDetail.entry.id}`} workspaceId={workspaceId} format={format} entry={activeDetail.entry} close={() => setDetail(null)} />}
  </section>;
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DateTimePrecision, formatJstDateTime, formatJstShortDateTime } from "@/lib/shared/display-formatters";
import { IMPORT_FORMATS, IMPORT_HISTORY_PER_USER_LIMIT, type ImportFormat, type ImportHistoryEntry, type ImportHistoryResponse } from "@/lib/shared/import-history";
import styles from "./import-history-panel.module.css";

type HistoryResult = { key: string } & (
  { status: "success"; history: ImportHistoryEntry[] } | { status: "error"; message: string }
);

function ImportHistoryDialog({ entry, close }: { entry: ImportHistoryEntry; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={close}>
    <h2 id={titleId}>取込の詳細</h2>
    <dl>
      <dt>ファイル名</dt><dd>{entry.fileName}</dd>
      <dt>取込日時</dt><dd>{formatJstDateTime(entry.createdAt, DateTimePrecision.Minute)}</dd>
      <dt>取込者</dt><dd>{entry.importedByName}</dd>
      <dt>登録</dt><dd>{entry.importedRows}件</dd>
      <dt>スキップ</dt><dd>{entry.skippedRows}件</dd>
    </dl>
    <footer><button type="button" className="secondary" onClick={() => dialog.current?.close()}>閉じる</button></footer>
  </dialog>;
}

export function ImportHistoryPanel({ workspaceId, format, refreshKey }: { workspaceId: string; format: ImportFormat; refreshKey: number }) {
  const titleId = useId();
  const [result, setResult] = useState<HistoryResult | null>(null);
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<ImportHistoryEntry | null>(null);
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
          <thead><tr><th scope="col">日時</th><th scope="col">ファイル名</th><th scope="col">取込者</th><th scope="col">登録</th><th scope="col">スキップ</th></tr></thead>
          <tbody>{current.history.map(entry => {
            const fullDateTime = formatJstDateTime(entry.createdAt, DateTimePrecision.Minute);
            return <tr key={entry.id}>
              <td><time dateTime={entry.createdAt} title={fullDateTime} aria-label={fullDateTime}>
                <span className={styles.fullDate}>{fullDateTime}</span><span className={styles.shortDate} aria-hidden="true">{formatJstShortDateTime(entry.createdAt)}</span>
              </time></td>
              <td><button type="button" className={styles.fileName} title={entry.fileName} aria-label={`${entry.fileName}の取込詳細を開く`} onClick={() => setDetail(entry)}>{entry.fileName}</button></td>
              <td><span className={styles.truncated} title={entry.importedByName}>{entry.importedByName}</span></td>
              <td className={styles.registered}><span className={styles.truncated} title={`${entry.importedRows}件`}>{entry.importedRows}</span></td>
              <td className={styles.skipped}><span className={styles.truncated} title={`${entry.skippedRows}件`}>{entry.skippedRows}</span></td>
            </tr>;
          })}</tbody>
        </table>
        <p className={styles.note}>登録・スキップの単位は件。ファイル名を押すと詳細を確認できます。<br />スキップには重複や取込対象から外した明細などが含まれます。</p>
      </>}
    {detail !== null && <ImportHistoryDialog entry={detail} close={() => setDetail(null)} />}
  </section>;
}

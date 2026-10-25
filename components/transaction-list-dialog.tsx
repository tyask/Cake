"use client";

import { useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import { flattenCategories } from "@/lib/shared/categories";
import { DateTimePrecision, formatJstDateTime, formatTransactionAmount } from "@/lib/shared/display-formatters";
import { expenseClassLabels, transactionActorLabels, transactionTypeLabels } from "@/lib/shared/domain-values";
import type { Category, TransactionRecord } from "@/lib/shared/types";
import styles from "./transaction-list-dialog.module.css";

export type TransactionListDialogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; transactions: TransactionRecord[]; categories: Category[] };

type Props = {
  title: string;
  description?: ReactNode;
  state: TransactionListDialogState;
  onRetry?: () => void;
  onClose: () => void;
  emptyMessage?: string;
};

export function TransactionListDialog({ title, description, state, onRetry, onClose, emptyMessage = "表示する明細はありません。" }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId(), descriptionId = useId();
  const categories = state.status === "success" ? state.categories : null;
  const categoryLabels = useMemo(() => new Map((categories ? flattenCategories(categories) : [])
    .map(({ category, path }) => [category.id, path + (category.archivedAt ? "（使用停止）" : "")])), [categories]);

  useEffect(() => {
    const element = dialog.current;
    if (returnFocus.current === null && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, []);

  const categoryLabel = (item: TransactionRecord) => item.categoryId
    ? categoryLabels.get(item.categoryId) ?? "利用できないカテゴリ" : "未分類";
  const settlementLabel = (item: TransactionRecord) => item.expenseClass === "PERSONAL" ? "対象外" : item.settledAt ? "清算済み" : "未清算";
  const amount = (item: TransactionRecord) => <span className={item.amountYen === 0 ? undefined : item.type === "PAYMENT" ? "negative" : "positive"}>
    {formatTransactionAmount(item.type, item.amountYen)}
  </span>;

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}
    aria-describedby={description == null ? undefined : descriptionId}
    onClose={() => { if (!dialog.current?.open) onClose(); }}>
    <header className={styles.header}>
      <h2 id={titleId}>{title}</h2>
      <button type="button" className={styles.closeIcon} aria-label="明細一覧を閉じる" onClick={() => dialog.current?.close()}>×</button>
    </header>
    <div className={styles.body}>
      {description != null && <div id={descriptionId} className={styles.description}>{description}</div>}
      {state.status === "loading" && <p className={styles.message} role="status">明細を読み込んでいます…</p>}
      {state.status === "error" && <div className={styles.message} role="alert"><p>{state.message}</p>
        {onRetry && <button type="button" className="secondary" onClick={onRetry}>再読み込み</button>}
      </div>}
      {state.status === "success" && (state.transactions.length === 0
        ? <p className={styles.message}>{emptyMessage}</p>
        : <>
          <p className={styles.count}>{state.transactions.length}件の明細</p>
          <table className={styles.table} aria-label={title}>
            <colgroup>{["date", "merchant", "method", "type", "amount", "actor", "expense", "category", "settlement", "memo"].map(name => <col key={name} className={styles[name]} />)}</colgroup>
            <thead><tr><th scope="col">取引日時</th><th scope="col">取引先</th><th scope="col">方法</th><th scope="col">種別</th>
              <th scope="col">金額（円）</th><th scope="col">支払者 / 受取者</th><th scope="col">区分</th><th scope="col">カテゴリ</th><th scope="col">清算</th><th scope="col">メモ</th></tr></thead>
            <tbody>{state.transactions.map(item => <tr key={item.id} data-transaction-id={item.id}>
              <td><time dateTime={item.occurredAt}>{formatJstDateTime(item.occurredAt)}</time></td>
              <td><b>{item.merchant}</b></td><td>{item.method}</td><td>{transactionTypeLabels[item.type]}</td>
              <td className={styles.amountCell}>{amount(item)}</td><td>{item.actorName}</td><td>{expenseClassLabels[item.expenseClass]}</td>
              <td>{categoryLabel(item)}</td><td>{settlementLabel(item)}</td><td className={styles.memoCell}>{item.memo || "—"}</td>
            </tr>)}</tbody>
          </table>
          <div className={styles.mobileList} aria-label={title}>{state.transactions.map(item => <details key={item.id} className={styles.mobileItem} data-transaction-id={item.id}>
            <summary className={styles.summary}>
              <span className={styles.summaryText}><b>{item.merchant}</b>
                <small>{formatJstDateTime(item.occurredAt, DateTimePrecision.Minute)} · {item.actorName}</small>
                <small className={styles.summaryCategory}>{categoryLabel(item)}</small>
              </span>
              <span className={styles.summaryAmount}>{amount(item)}<small>{expenseClassLabels[item.expenseClass]}</small></span>
              <span className={styles.chevron} aria-hidden="true">⌄</span>
            </summary>
            <dl className={styles.detailFields}>
              <div><dt>取引日時</dt><dd><time dateTime={item.occurredAt}>{formatJstDateTime(item.occurredAt)}</time></dd></div>
              <div><dt>取引先</dt><dd>{item.merchant}</dd></div>
              <div><dt>{transactionActorLabels[item.type]}</dt><dd>{item.actorName}</dd></div>
              <div><dt>金額（円）</dt><dd>{amount(item)}</dd></div>
              <div><dt>方法</dt><dd>{item.method}</dd></div>
              <div><dt>種別</dt><dd>{transactionTypeLabels[item.type]}</dd></div>
              <div><dt>区分</dt><dd>{expenseClassLabels[item.expenseClass]}</dd></div>
              <div><dt>カテゴリ</dt><dd>{categoryLabel(item)}</dd></div>
              <div><dt>清算</dt><dd>{settlementLabel(item)}</dd></div>
              <div><dt>メモ</dt><dd className={styles.memoCell}>{item.memo || "—"}</dd></div>
            </dl>
          </details>)}</div>
        </>)}
    </div>
    <footer className={styles.footer}><button type="button" className="secondary" onClick={() => dialog.current?.close()}>閉じる</button></footer>
  </dialog>;
}

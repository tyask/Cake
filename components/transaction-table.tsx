"use client";

import type { ReactNode } from "react";
import type { TransactionColumn } from "@/lib/transaction-filters";
import type { TransactionRecord, WorkspaceMember } from "@/lib/types";
import styles from "./transactions-panel.module.css";

export type TransactionTableColumn = "selection" | TransactionColumn | "status" | "updateStatus";
export type TransactionTableColumnDefinition = { id: TransactionTableColumn; label: string };

const columnWidths: Record<TransactionTableColumn, string> = {
  selection: styles.selectionColumn,
  occurredAt: styles.dateColumn,
  merchant: styles.merchantColumn,
  method: styles.methodColumn,
  amountYen: styles.amountColumn,
  actorUserId: styles.actorColumn,
  expenseClass: styles.classColumn,
  splitWeights: styles.ratioColumn,
  memo: styles.memoColumn,
  settlement: styles.settlementColumn,
  status: styles.settlementColumn,
  updateStatus: styles.updateStatusColumn,
};

const money = (value: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(value);
const summaryDate = (value: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

export const transactionSplitLabel = (members: Pick<WorkspaceMember, "name">[]) => `支払い割合（${members.map(member => member.name).join(", ")}）`;

export function TransactionTable({ columns, header, children, label }: {
  columns: readonly TransactionTableColumnDefinition[];
  header: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return <div className={styles.tableWrap}><table className={styles.table} aria-label={label}>
    <colgroup>{columns.map(column => <col key={column.id} className={columnWidths[column.id]} />)}</colgroup>
    <thead>{header}</thead>
    <tbody>{children}</tbody>
  </table></div>;
}

export function MobileTransactionSummary({ item, expanded, onToggle, checked, disabled, onSelect, status, selectionLabel, columnCount, dateLabel, amountLabel, indicator }: {
  item: Pick<TransactionRecord, "merchant" | "occurredAt" | "actorName" | "amountYen" | "expenseClass">;
  expanded: boolean;
  onToggle: () => void;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  status?: ReactNode;
  selectionLabel?: string;
  columnCount: number;
  dateLabel?: string;
  amountLabel?: string;
  indicator?: ReactNode;
}) {
  return <td className={styles.mobileSummary} colSpan={columnCount} data-selection>
    <input className={styles.checkbox} type="checkbox" aria-label={selectionLabel ?? item.merchant + "の明細を選択"} checked={checked} disabled={disabled} onChange={onSelect} />
    <button type="button" className={styles.summaryButton} aria-expanded={expanded} aria-label={item.merchant + "の詳細を" + (expanded ? "閉じる" : "開く")} onClick={onToggle}>
      <span className={styles.summaryName}><b>{item.merchant}</b><small>{dateLabel ?? summaryDate(item.occurredAt)} · {item.actorName}</small></span>
      <span className={styles.summaryAmount}><strong>{amountLabel ?? money(item.amountYen)}</strong><small>{status ?? (item.expenseClass === "PERSONAL" ? "個人費" : "共有費")}</small></span>
      <span className={styles.summaryChevron} aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
    </button>
    {indicator && <span className={styles.summaryUpdateStatus}>{indicator}</span>}
  </td>;
}

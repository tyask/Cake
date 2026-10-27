"use client";

import { formatTransactionAmount, formatJstDateTime, DateTimePrecision } from "@/lib/shared/display-formatters";

import { expenseClassLabels } from "@/lib/shared/domain-values";

import type { ReactNode } from "react";
import type { TransactionColumn } from "@/lib/shared/transaction-filters";
import type { TransactionRecord, WorkspaceMember } from "@/lib/shared/types";
import { SwipeDelete } from "./swipe-delete";
import styles from "./transactions-panel.module.css";

export type TransactionTableColumn = "selection" | TransactionColumn | "status" | "updateStatus";
export type TransactionTableColumnDefinition = { id: TransactionTableColumn; label: string };

const columnWidths: Record<TransactionTableColumn, string> = {
  selection: styles.selectionColumn,
  occurredAt: styles.dateColumn,
  merchant: styles.merchantColumn,
  method: styles.methodColumn,
  type: styles.typeColumn,
  amountYen: styles.amountColumn,
  actorUserId: styles.actorColumn,
  expenseClass: styles.classColumn,
  splitWeights: styles.ratioColumn,
  memo: styles.memoColumn,
  category: styles.categoryColumn,
  settlement: styles.settlementColumn,
  status: styles.settlementColumn,
  updateStatus: styles.updateStatusColumn,
};

export const transactionSplitLabel = (members: Pick<WorkspaceMember, "name">[]) => `配分割合（${members.map(member => member.name).join(", ")}）`;

export function TransactionTable({ columns, header, children, label, wrap = false }: {
  columns: readonly TransactionTableColumnDefinition[];
  header: ReactNode;
  children: ReactNode;
  label: string;
  wrap?: boolean;
}) {
  return <div className={styles.tableWrap + (wrap ? " " + styles.wrappingTableWrap : "")}><table className={styles.table + (wrap ? " " + styles.wrappingTable : "")} aria-label={label}>
    <colgroup>{columns.map(column => <col key={column.id} className={columnWidths[column.id]} />)}</colgroup>
    <thead>{header}</thead>
    <tbody>{children}</tbody>
  </table></div>;
}

export function MobileTransactionSummary({ item, expanded, onToggle, checked, disabled, onSelect, status, selectionLabel, columnCount, dateLabel, amountLabel, categoryLabel, indicator, onDelete, deleteDisabled }: {
  item: Pick<TransactionRecord, "merchant" | "occurredAt" | "actorName" | "amountYen" | "expenseClass"> & Partial<Pick<TransactionRecord, "source" | "type">>;
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
  categoryLabel?: string;
  indicator?: ReactNode;
  onDelete?: () => void;
  deleteDisabled?: boolean;
}) {
  const content = <>
    <input className={styles.checkbox} type="checkbox" aria-label={selectionLabel ?? item.merchant + "の明細を選択"} checked={checked} disabled={disabled} onChange={onSelect} />
    <button type="button" className={styles.summaryButton} aria-expanded={expanded} aria-label={item.merchant + "の詳細を" + (expanded ? "閉じる" : "開く")} onClick={onToggle}>
      <span className={styles.summaryName}><b>{item.merchant}</b><small>{dateLabel ?? formatJstDateTime(item.occurredAt, DateTimePrecision.Minute)} · {item.actorName}{item.source === "RECURRING" && <span className={styles.sourceTag}>定期</span>}</small>{categoryLabel && <small className={styles.summaryCategory}>{categoryLabel}</small>}</span>
      <span className={styles.summaryAmount}><strong className={item.amountYen === 0 ? "" : item.type === "RECEIPT" ? "positive" : "negative"}>{amountLabel ?? formatTransactionAmount(item.type ?? "PAYMENT", item.amountYen)}</strong><small>{status ?? (expenseClassLabels[item.expenseClass])}</small></span>
      <span className={styles.summaryChevron} aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
    </button>
    {indicator && <span className={styles.summaryUpdateStatus}>{indicator}</span>}
  </>;
  return <td className={styles.mobileSummary} colSpan={columnCount} data-selection>
    {onDelete ? <SwipeDelete label={item.merchant || "明細"} disabled={deleteDisabled} onDelete={onDelete}>{content}</SwipeDelete> : content}
  </td>;
}

"use client";

import { useState } from "react";
import type { PayPayPreviewRow } from "@/lib/paypay";
import type { ExpenseClass, SplitWeights, WorkspaceMember } from "@/lib/types";
import { SelectionCheckbox } from "./selection-checkbox";
import { SplitEditor } from "./split-editor";
import { MobileTransactionSummary, TransactionTable, transactionSplitLabel } from "./transaction-table";
import styles from "./transactions-panel.module.css";

const money = (value: number) => Number.isFinite(value)
  ? new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(value) : "—";

export function ImportPreviewTable({ rows, members, actorId, saving, onSelect, onSelectAll, onChangeClass, onChangeSplit }: {
  rows: PayPayPreviewRow[];
  members: WorkspaceMember[];
  actorId: string;
  saving: boolean;
  onSelect: (key: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  onChangeClass: (key: string, expenseClass: ExpenseClass) => void;
  onChangeSplit: (key: string, splitWeights: SplitWeights) => void;
}) {
  const eligible = rows.filter(row => !row.error && !row.duplicate);
  const count = eligible.filter(row => row.selected).length;
  const allSelected = eligible.length > 0 && count === eligible.length;
  const columns = [
    { id: "selection", label: "選択" }, { id: "occurredAt", label: "取引日時" },
    { id: "merchant", label: "取引先" }, { id: "method", label: "方法" },
    { id: "amountYen", label: "金額（円）" }, { id: "actorUserId", label: "支払者" },
    { id: "expenseClass", label: "費用区分" }, { id: "splitWeights", label: transactionSplitLabel(members) },
    { id: "status", label: "状態" },
  ] as const;
  return <TransactionTable columns={columns} label="取り込み明細" header={<tr>
    {columns.map(column => <th key={column.id} className={column.id === "selection" ? styles.selectionCell : undefined}>
      {column.id === "selection" ? <SelectionCheckbox label="取込対象をすべて選択" checked={allSelected} partial={count > 0 && !allSelected} disabled={saving || eligible.length === 0} onChange={() => onSelectAll(!allSelected)} /> : column.label}
    </th>)}
  </tr>}>
    {rows.map(row => <ImportPreviewRow key={row.key} row={row} members={members} actorId={actorId} saving={saving}
      onSelect={onSelect} onChangeClass={onChangeClass} onChangeSplit={onChangeSplit} columnCount={columns.length} />)}
  </TransactionTable>;
}

function ImportPreviewRow({ row, members, actorId, saving, onSelect, onChangeClass, onChangeSplit, columnCount }: {
  row: PayPayPreviewRow;
  members: WorkspaceMember[];
  actorId: string;
  saving: boolean;
  onSelect: (key: string, selected: boolean) => void;
  onChangeClass: (key: string, expenseClass: ExpenseClass) => void;
  onChangeSplit: (key: string, splitWeights: SplitWeights) => void;
  columnCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const actorName = members.find(member => member.id === actorId)?.name ?? "";
  const invalid = !!row.error || row.duplicate;
  const disabled = saving || invalid;
  const status = row.error ?? (row.duplicate ? "登録済み" : "登録可能");
  const selectionLabel = `${row.merchant || "取引先未設定"}を取り込む`;
  return <tr className={styles.transactionRow} data-expanded={expanded} data-import-key={row.key}>
    <MobileTransactionSummary item={{ ...row, actorName }} expanded={expanded} onToggle={() => setExpanded(value => !value)}
      checked={row.selected} disabled={disabled} onSelect={() => onSelect(row.key, !row.selected)}
      status={<span className={invalid ? styles.error : undefined}>{status}</span>}
      selectionLabel={selectionLabel} columnCount={columnCount}
      dateLabel={row.occurredAt.replace(/:\d{2}$/, "") || "日時未設定"} amountLabel={money(row.amountYen)} />
    <td data-label="選択" className={styles.selectionCell} data-selection>
      <input className={styles.checkbox} type="checkbox" aria-label={selectionLabel} checked={row.selected} disabled={disabled} onChange={event => onSelect(row.key, event.target.checked)} />
    </td>
    <td data-label="取引日時" className={styles.fullCell + " " + styles.dateCell}>{row.occurredAt || "—"}</td>
    <td data-label="取引先"><b>{row.merchant || "—"}</b></td>
    <td data-label="方法">{row.method}</td>
    <td data-label="金額（円）">{money(row.amountYen)}</td>
    <td data-label="支払者">{actorName}</td>
    <td data-label="費用区分"><select aria-label={`${row.merchant}の費用区分`} disabled={disabled} value={row.expenseClass} onChange={event => onChangeClass(row.key, event.target.value as ExpenseClass)}>
      <option value="PERSONAL">個人費</option><option value="SHARED">共有費</option>
    </select></td>
    <td data-label={transactionSplitLabel(members)} className={styles.splitCell + " " + styles.fullCell}>
      <SplitEditor compact inline label="支払い割合" members={members} value={row.splitWeights} amountYen={row.amountYen}
        disabled={disabled || row.expenseClass === "PERSONAL"} onChange={value => onChangeSplit(row.key, value)} />
    </td>
    <td data-label="状態"><span className={invalid ? styles.error : styles.muted}>{status}</span></td>
  </tr>;
}

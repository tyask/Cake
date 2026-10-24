"use client";

import { cashflowClass, formatTransactionAmount } from "@/lib/shared/display-formatters";

import { expenseClassLabels, expenseClasses } from "@/lib/shared/domain-values";

import { useState, type CSSProperties } from "react";
import { isPayPayRowImportable, type PayPayPreviewRow } from "@/lib/shared/paypay";
import type { ExpenseClass, SplitWeights, WorkspaceMember } from "@/lib/shared/types";
import { SelectionCheckbox } from "./selection-checkbox";
import { SplitEditor } from "./split-editor";
import { CategorySelect, type CategoryChoices } from "./category-select";
import { MobileTransactionSummary, TransactionTable, transactionSplitLabel } from "./transaction-table";
import styles from "./transactions-panel.module.css";

const money = (value: number) => Number.isFinite(value)
  ? formatTransactionAmount("PAYMENT", value) : "—";

export function ImportPreviewTable({ rows, members, actorId, saving, categoryChoices, onSelect, onSelectAll, onChangeClass, onChangeSplit, onChangeCategory, onDelete }: {
  rows: PayPayPreviewRow[];
  members: WorkspaceMember[];
  actorId: string;
  saving: boolean;
  categoryChoices: CategoryChoices;
  onSelect: (key: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  onChangeClass: (key: string, expenseClass: ExpenseClass) => void;
  onChangeSplit: (key: string, splitWeights: SplitWeights) => void;
  onChangeCategory: (key: string, categoryId: string | null) => void;
  onDelete: (key: string) => void;
}) {
  const eligible = rows.filter(isPayPayRowImportable);
  const count = eligible.filter(row => row.selected).length;
  const allSelected = eligible.length > 0 && count === eligible.length;
  const columns = [
    { id: "selection", label: "選択" }, { id: "occurredAt", label: "取引日時" },
    { id: "merchant", label: "取引先" }, { id: "method", label: "方法" },
    { id: "amountYen", label: "金額（円）" }, { id: "actorUserId", label: "支払者" },
    { id: "expenseClass", label: "区分" }, { id: "splitWeights", label: transactionSplitLabel(members) },
    { id: "category", label: "カテゴリ" }, { id: "status", label: "状態" },
  ] as const;
  return <TransactionTable columns={columns} label="取り込み明細" header={<tr>
    {columns.map(column => <th key={column.id} className={column.id === "selection" ? styles.selectionCell : undefined}>
      {column.id === "selection" ? <SelectionCheckbox label="登録可能な明細をすべて選択" mobileLabel={allSelected ? "全解除" : "全選択"} checked={allSelected} partial={count > 0 && !allSelected} disabled={saving || eligible.length === 0} onChange={() => onSelectAll(!allSelected)} /> : column.label}
    </th>)}
  </tr>}>
    {rows.map(row => <ImportPreviewRow key={row.key} row={row} members={members} actorId={actorId} saving={saving} categoryChoices={categoryChoices}
      onSelect={onSelect} onChangeClass={onChangeClass} onChangeSplit={onChangeSplit} onChangeCategory={onChangeCategory} onDelete={onDelete} columnCount={columns.length} />)}
  </TransactionTable>;
}

function ImportPreviewRow({ row, members, actorId, saving, categoryChoices, onSelect, onChangeClass, onChangeSplit, onChangeCategory, onDelete, columnCount }: {
  row: PayPayPreviewRow;
  members: WorkspaceMember[];
  actorId: string;
  saving: boolean;
  categoryChoices: CategoryChoices;
  onSelect: (key: string, selected: boolean) => void;
  onChangeClass: (key: string, expenseClass: ExpenseClass) => void;
  onChangeSplit: (key: string, splitWeights: SplitWeights) => void;
  onChangeCategory: (key: string, categoryId: string | null) => void;
  onDelete: (key: string) => void;
  columnCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const actorName = members.find(member => member.id === actorId)?.name ?? "";
  const invalid = !!row.error || row.duplicate;
  const disabled = saving || invalid;
  const status = row.error ?? (row.duplicate ? "登録済み" : "登録可能");
  const selectionLabel = `${row.merchant || "取引先未設定"}を選択`;
  const category = categoryChoices.byId.get(row.categoryId ?? "");
  const rowStyle = category ? { "--transaction-category-color": category.colorHex } as CSSProperties : undefined;
  return <tr className={`${styles.transactionRow}${row.duplicate ? ` ${styles.importDuplicate}` : ""}`} style={rowStyle} data-expanded={expanded} data-import-key={row.key}>
    <MobileTransactionSummary item={{ ...row, actorName }} expanded={expanded} onToggle={() => setExpanded(value => !value)}
      checked={row.selected} disabled={disabled} onSelect={() => onSelect(row.key, !row.selected)}
      status={<span className={row.error ? styles.error : undefined}>{status}</span>}
      selectionLabel={selectionLabel} columnCount={columnCount} onDelete={() => onDelete(row.key)} deleteDisabled={saving}
      categoryLabel={category ? category.label + (category.archived ? "（使用停止）" : "") : row.categoryId ? "利用できないカテゴリ" : "未分類"}
      dateLabel={row.occurredAt.replace(/:\d{2}$/, "") || "日時未設定"} amountLabel={money(row.amountYen)} />
    <td data-label="選択" className={styles.selectionCell} data-selection>
      <input className={styles.checkbox} type="checkbox" aria-label={selectionLabel} checked={row.selected} disabled={disabled} onChange={event => onSelect(row.key, event.target.checked)} />
    </td>
    <td data-label="取引日時" className={styles.fullCell + " " + styles.dateCell}>{row.occurredAt || "—"}</td>
    <td data-label="取引先"><b>{row.merchant || "—"}</b></td>
    <td data-label="方法">{row.method}</td>
    <td data-label="金額（円）" className={Number.isFinite(row.amountYen) ? cashflowClass(-row.amountYen) : undefined}>{money(row.amountYen)}</td>
    <td data-label="支払者">{actorName}</td>
    <td data-label="区分"><select aria-label={`${row.merchant}の区分`} disabled={disabled} value={row.expenseClass} onChange={event => onChangeClass(row.key, event.target.value as ExpenseClass)}>
      {expenseClasses.map(value => <option key={value} value={value}>{expenseClassLabels[value]}</option>)}
    </select></td>
    <td data-label={transactionSplitLabel(members)} className={styles.splitCell + " " + styles.fullCell}>
      <SplitEditor compact inline label="配分割合" members={members} value={row.splitWeights} amountYen={row.amountYen}
        disabled={disabled || row.expenseClass === "PERSONAL"} onChange={value => onChangeSplit(row.key, value)} />
    </td>
    <td data-label="カテゴリ" className={styles.categoryCell + " " + styles.fullCell}>
      <CategorySelect choices={categoryChoices} value={row.categoryId} disabled={disabled} onChange={categoryId => onChangeCategory(row.key, categoryId)} />
    </td>
    <td data-label="状態"><span className={row.error ? styles.error : styles.muted}>{status}</span></td>
  </tr>;
}

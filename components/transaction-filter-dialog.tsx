"use client";

import { useEffect, useId, useRef, useState } from "react";
import { transactionColumns, type FilterOption, type TransactionColumn } from "@/lib/shared/transaction-filters";
import type { TransactionSort } from "@/lib/shared/transaction-sort";
import styles from "./transactions-panel.module.css";
import { SelectionCheckbox } from "./selection-checkbox";

type SortDirection = TransactionSort["direction"] | "none";

export function TransactionFilterDialog({ column, options, selected, sortDirection, onColumnChange, onApply, onClear, onClose }: {
  column: TransactionColumn;
  options: FilterOption[];
  selected?: string[];
  sortDirection: SortDirection;
  onColumnChange: (column: TransactionColumn) => void;
  onApply: (values: string[] | undefined, direction: SortDirection) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState(sortDirection);
  // A save can replace the options while open; sorting alone must preserve the live filter.
  const [changedSelection, setChangedSelection] = useState<Set<string>>();
  const checked = changedSelection ?? new Set(selected ?? options.map(option => option.value));
  const matching = options.filter(option => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const checkedCount = matching.filter(option => checked.has(option.value)).length;
  const allChecked = matching.length > 0 && checkedCount === matching.length;
  useEffect(() => { dialog.current?.showModal(); }, []);
  const label = transactionColumns.find(item => item.id === column)!.label;

  return <dialog ref={dialog} className={styles.filterDialog} aria-labelledby={titleId} onClose={onClose}
    onClick={event => { if (event.target === event.currentTarget) {
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    } }}>
    <div className={styles.filterTitle}><h2 id={titleId}>{label}で絞り込み</h2><button type="button" aria-label="フィルターを閉じる" onClick={onClose}>×</button></div>
    <label className={styles.filterColumn}>列<select value={column} onChange={event => onColumnChange(event.target.value as TransactionColumn)}>
      {transactionColumns.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    <label className={styles.filterColumn}>ソート順<select value={direction} onChange={event => setDirection(event.target.value as SortDirection)}>
      <option value="none">ソートなし</option><option value="asc">昇順</option><option value="desc">降順</option>
    </select></label>
    <input className={styles.filterSearch} aria-label="候補の値を検索" placeholder="候補の値を検索" value={query} onChange={event => setQuery(event.target.value)} />
    <label className={styles.filterChoices}>
      <SelectionCheckbox label={query ? "検索結果の値をすべて選択" : "候補の値をすべて選択"} checked={allChecked}
        partial={checkedCount > 0 && !allChecked} disabled={matching.length === 0}
        onChange={() => setChangedSelection(current => {
          const next = new Set(current ?? checked);
          for (const option of matching) {
            if (allChecked) next.delete(option.value); else next.add(option.value);
          }
          return next;
        })} />
      <span>{query ? "検索結果をすべて選択" : "すべて選択"}</span>
    </label>
    {column === "category" && <p className={styles.filterCountNote}>親カテゴリと下位カテゴリは別々に選択します。</p>}
    <p className={styles.filterCountNote}>件数は現在表示中の明細をもとに表示しています。</p>
    <div className={styles.filterOptions}>
      {matching.map(option => <label key={option.value}>
        <input type="checkbox" checked={checked.has(option.value)} onChange={event => {
          const next = new Set(checked);
          if (event.target.checked) next.add(option.value); else next.delete(option.value);
          setChangedSelection(next);
        }} /><span>{option.label || "（空白）"}</span><small>{option.count}件</small>
      </label>)}
      {matching.length === 0 && <p>候補がありません。</p>}
    </div>
    <div className={styles.filterActions}>
      <button type="button" onClick={onClear}>この列の絞り込みを解除</button>
      <button type="button" className="primary" onClick={() => onApply(changedSelection === undefined ? selected
        : options.every(option => checked.has(option.value)) ? undefined : [...checked], direction)}>適用</button>
    </div>
  </dialog>;
}

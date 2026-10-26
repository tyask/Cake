"use client";

import { useMemo } from "react";
import { ANALYTICS_UNCLASSIFIED_ID, type PreparedAnalyticsDataset } from "@/lib/shared/analytics-view";
import { SelectionCheckbox } from "./selection-checkbox";
import styles from "./analytics-panel.module.css";

export function AnalyticsCategoryFilter({ prepared, selectedIds, onChange, open, onOpenChange }: {
  prepared: PreparedAnalyticsDataset;
  selectedIds: readonly string[] | null;
  onChange: (ids: string[] | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const options = useMemo(() => {
    const branches = new Map<string, string[]>();
    for (const item of prepared.categories.values()) {
      for (const ancestor of item.ancestors) {
        const branch = branches.get(ancestor) ?? [];
        branch.push(item.category.id);
        branches.set(ancestor, branch);
      }
    }
    return [...prepared.categories.values()].map(item => ({
      id: item.category.id,
      label: `${item.path}${item.category.archivedAt ? "（使用停止）" : ""}`,
      branchIds: branches.get(item.category.id)!,
    })).concat({ id: ANALYTICS_UNCLASSIFIED_ID, label: "未分類", branchIds: [ANALYTICS_UNCLASSIFIED_ID] });
  }, [prepared]);
  const allIds = options.map(option => option.id);
  const selected = new Set(selectedIds ?? allIds);
  const selectedCount = allIds.filter(id => selected.has(id)).length;
  const summary = selectedCount === 0 ? "未選択" : selectedCount === allIds.length ? "すべて選択中" : `${selectedCount} / ${allIds.length}件選択`;

  function toggle(ids: string[], checked: boolean) {
    const next = new Set(selected);
    for (const id of ids) if (checked) next.add(id); else next.delete(id);
    onChange(allIds.filter(id => next.has(id)));
  }

  return <details className={styles.categoryFilter} open={open} onToggle={event => onOpenChange(event.currentTarget.open)}>
    <summary><span>集計に含めるカテゴリ</span><span className={styles.categorySelection}>{summary}</span></summary>
    <fieldset className={styles.categoryOptions}><legend>集計に含めるカテゴリ</legend>
      <div className={styles.categoryActions}>
        <button type="button" onClick={() => onChange(null)}>すべて選択</button>
        <button type="button" onClick={() => onChange([])}>すべて解除</button>
      </div>
      <p className={styles.categoryHint}>親カテゴリのチェックは、子カテゴリもまとめて切り替えます。自分の収支では、収入・支出の両方に適用します。</p>
      {options.map(option => {
        const count = option.branchIds.filter(id => selected.has(id)).length;
        const checked = count === option.branchIds.length;
        return <label key={option.id}>
          <SelectionCheckbox label={option.label} checked={checked} partial={count > 0 && !checked} onChange={() => toggle(option.branchIds, !checked)} />
          <span>{option.label}</span>
        </label>;
      })}
    </fieldset>
  </details>;
}

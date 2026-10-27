"use client";

import { useMemo } from "react";
import { ANALYTICS_UNCLASSIFIED_ID, type PreparedAnalyticsDataset } from "@/lib/shared/analytics-view";
import { SelectionCheckbox } from "./selection-checkbox";
import styles from "./analytics-panel.module.css";

type CategoryOption = { id: string; label: string; name: string; branchIds: string[]; children: CategoryOption[] };

export function AnalyticsCategoryFilter({ prepared, selectedIds, onChange, open, onOpenChange }: {
  prepared: PreparedAnalyticsDataset;
  selectedIds: readonly string[] | null;
  onChange: (ids: string[] | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { options, roots } = useMemo(() => {
    const branches = new Map<string, string[]>();
    for (const item of prepared.categories.values()) {
      for (const ancestor of item.ancestors) {
        const branch = branches.get(ancestor) ?? [];
        branch.push(item.category.id);
        branches.set(ancestor, branch);
      }
    }
    const options: CategoryOption[] = [...prepared.categories.values()].map(item => ({
      id: item.category.id,
      label: `${item.path}${item.category.archivedAt ? "（使用停止）" : ""}`,
      name: `${item.category.name}${item.category.archivedAt ? "（使用停止）" : ""}`,
      branchIds: branches.get(item.category.id)!,
      children: [],
    }));
    const byId = new Map(options.map(option => [option.id, option]));
    const roots: CategoryOption[] = [];
    for (const item of prepared.categories.values()) {
      const option = byId.get(item.category.id)!;
      const parentId = item.ancestors.at(-2);
      const parent = parentId ? byId.get(parentId) : undefined;
      if (parent) parent.children.push(option); else roots.push(option);
    }
    const unclassified = { id: ANALYTICS_UNCLASSIFIED_ID, label: "未分類", name: "未分類", branchIds: [ANALYTICS_UNCLASSIFIED_ID], children: [] };
    options.push(unclassified); roots.push(unclassified);
    return { options, roots };
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

  function renderNodes(nodes: readonly CategoryOption[]) {
    return nodes.map(option => {
      const count = option.branchIds.filter(id => selected.has(id)).length;
      const checked = count === option.branchIds.length;
      return <li key={option.id}>
        <label>
          <SelectionCheckbox label={option.label} checked={checked} partial={count > 0 && !checked} onChange={() => toggle(option.branchIds, !checked)} />
          <span>{option.name}</span>
        </label>
        {option.children.length > 0 && <ul>{renderNodes(option.children)}</ul>}
      </li>;
    });
  }

  return <details className={styles.categoryFilter} open={open} onToggle={event => onOpenChange(event.currentTarget.open)}>
    <summary><span>集計に含めるカテゴリ</span><span className={styles.categorySelection}>{summary}</span></summary>
    <fieldset className={styles.categoryOptions}><legend>集計に含めるカテゴリ</legend>
      <div className={styles.categoryActions}>
        <button type="button" onClick={() => onChange(null)}>すべて選択</button>
        <button type="button" onClick={() => onChange([])}>すべて解除</button>
      </div>
      <p className={styles.categoryHint}>親カテゴリのチェックは、子カテゴリもまとめて切り替えます。選択したユーザーの収入・支出に適用します。</p>
      <ul className={styles.categoryTree} aria-label="カテゴリ階層">{renderNodes(roots)}</ul>
    </fieldset>
  </details>;
}

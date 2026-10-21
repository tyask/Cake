"use client";

import { flattenCategories } from "@/lib/categories";
import type { Category } from "@/lib/types";
import styles from "./category-select.module.css";

type CategoryChoice = { id: string; label: string; rootLabel: string; colorHex: string; archived: boolean };
export type CategoryChoices = { options: CategoryChoice[]; byId: ReadonlyMap<string, CategoryChoice> };

/** Prepare the hierarchy once for all category selectors in a list. */
export function prepareCategoryChoices(categories: Category[]): CategoryChoices {
  let rootLabel = "";
  const options = flattenCategories(categories).map(({ category, depth, path }) => {
    if (depth === 0) rootLabel = category.name;
    return { id: category.id, label: path, rootLabel, colorHex: category.colorHex, archived: category.archivedAt !== null };
  });
  return { options: options.filter(option => !option.archived), byId: new Map(options.map(option => [option.id, option])) };
}

export function CategorySelect({ choices, value, onChange, disabled = false, label = "カテゴリ", display = "full" }: {
  choices: CategoryChoices;
  value: string | null;
  onChange: (categoryId: string | null) => void;
  disabled?: boolean;
  label?: string;
  display?: "root" | "full";
}) {
  const current = value === null ? undefined : choices.byId.get(value);
  const name = current ? (display === "root" ? current.rootLabel : current.label) : value ? "利用できないカテゴリ" : "未分類";
  const suffix = current?.archived ? "（使用停止）" : "";
  return <div className={styles.control} data-disabled={disabled} title={(current?.label ?? name) + suffix}>
    <span className={styles.current} aria-hidden="true"><span className={styles.swatch} style={{ backgroundColor: current?.colorHex ?? "#94a3b8" }} /><span className={styles.name}>{name}{suffix}</span><span className={styles.chevron}>▾</span></span>
    <select className={styles.select} aria-label={label} value={value ?? ""} disabled={disabled} onChange={event => onChange(event.target.value || null)}>
      <option value="">未分類</option>
      {current?.archived && <option value={current.id} disabled>{current.label}（使用停止）</option>}
      {value && !current && <option value={value} disabled>利用できないカテゴリ</option>}
      {choices.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  </div>;
}

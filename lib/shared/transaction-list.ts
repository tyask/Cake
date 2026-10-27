import type { TransactionRecord } from "./types";

/** Share each filter result between visibility, selection counts and row rendering. */
export function transactionListView(
  items: readonly TransactionRecord[],
  matches: (item: TransactionRecord) => boolean,
  pinnedIds: ReadonlySet<string>,
  memoPinnedIds: ReadonlySet<string>,
  selectedIds: ReadonlySet<string>,
  canEdit: (item: TransactionRecord) => boolean = () => true,
) {
  const visible: TransactionRecord[] = [];
  const visibleEditable: TransactionRecord[] = [];
  const outsideFilterIds = new Set<string>();
  const visibleIds = new Set<string>();
  const editableIds = new Set<string>();
  let checkedVisibleCount = 0;
  for (const item of items) {
    const matched = matches(item);
    const editable = !item.settledAt && canEdit(item);
    if (editable) editableIds.add(item.id);
    if (!matched && !pinnedIds.has(item.id) && !memoPinnedIds.has(item.id)) continue;
    visible.push(item);
    visibleIds.add(item.id);
    if (!matched) outsideFilterIds.add(item.id);
    if (editable) {
      visibleEditable.push(item);
      if (selectedIds.has(item.id)) checkedVisibleCount += 1;
    }
  }
  const checkedIds = [...selectedIds].filter(id => editableIds.has(id));
  const hiddenCheckedCount = checkedIds.filter(id => !visibleIds.has(id)).length;
  const allVisibleChecked = visibleEditable.length > 0 && checkedVisibleCount === visibleEditable.length;
  const selectionChecked = allVisibleChecked || (visibleEditable.length === 0 && checkedIds.length > 0);
  return { visible, visibleEditable, outsideFilterIds, checkedIds, hiddenCheckedCount, selectionChecked };
}

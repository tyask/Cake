import { splitAmounts } from "./split-allocations";
import { transactionDateInput } from "./transaction-editing";
import type { TransactionRecord, WorkspaceMember } from "./types";

export const transactionColumns = [
  { id: "occurredAt", label: "取引日時" },
  { id: "merchant", label: "取引先" },
  { id: "method", label: "方法" },
  { id: "amountYen", label: "金額（円）" },
  { id: "actorUserId", label: "支払者" },
  { id: "expenseClass", label: "費用区分" },
  { id: "splitWeights", label: "支払い割合" },
  { id: "settlement", label: "清算" },
] as const;

export type TransactionColumn = typeof transactionColumns[number]["id"];
export type TransactionFilters = Partial<Record<TransactionColumn, string[]>>;
export type FilterOption = { value: string; label: string; count: number };

export function transactionFilterValue(item: TransactionRecord, column: TransactionColumn, members: WorkspaceMember[]): { value: string; label: string } {
  switch (column) {
    case "occurredAt": {
      const value = transactionDateInput(item.occurredAt).replace("T", " ");
      return { value, label: value };
    }
    case "merchant": return { value: item.merchant, label: item.merchant };
    case "method": return { value: item.method, label: item.method };
    case "amountYen": return { value: String(item.amountYen), label: item.amountYen.toLocaleString("ja-JP") + "円" };
    case "actorUserId": return { value: item.actorUserId, label: members.find(member => member.id === item.actorUserId)?.name ?? item.actorName };
    case "expenseClass": return { value: item.expenseClass, label: item.expenseClass === "PERSONAL" ? "個人費" : "共有費" };
    case "settlement": {
      const value = item.settledAt ? "SETTLED" : item.expenseClass === "PERSONAL" ? "EXCLUDED" : "PENDING";
      return { value, label: value === "SETTLED" ? "清算済み" : value === "EXCLUDED" ? "対象外" : "未清算" };
    }
    case "splitWeights": {
      const shares = splitAmounts(1000, item.splitWeights, members);
      const value = JSON.stringify(members.map(member => shares[member.id]));
      return { value, label: members.map(member => shares[member.id] / 10 + "%").join(" / ") };
    }
  }
}

export function transactionFilterOptions(items: TransactionRecord[], column: TransactionColumn, members: WorkspaceMember[], visibleItems: TransactionRecord[] = items): FilterOption[] {
  const counts = new Map<string, number>();
  for (const item of visibleItems) {
    const { value } = transactionFilterValue(item, column, members);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const options = new Map<string, FilterOption>();
  for (const item of items) {
    const { value, label } = transactionFilterValue(item, column, members);
    options.set(value, { value, label, count: counts.get(value) ?? 0 });
  }
  return [...options.values()].sort((a, b) => column === "amountYen"
    ? Number(a.value) - Number(b.value)
    : a.label.localeCompare(b.label, "ja", { numeric: true }));
}

export function matchesTransactionFilters(item: TransactionRecord, filters: TransactionFilters, members: WorkspaceMember[]): boolean {
  return transactionColumns.every(({ id }) => {
    const values = filters[id];
    return values === undefined || values.includes(transactionFilterValue(item, id, members).value);
  });
}

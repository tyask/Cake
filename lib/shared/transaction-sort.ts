import { splitAmounts } from "./split-allocations";
import { transactionFilterValue, type TransactionColumn } from "./transaction-filters";
import type { TransactionRecord, WorkspaceMember } from "./types";

export type TransactionSort = { column: TransactionColumn; direction: "asc" | "desc" };
type CategoryLabels = ReadonlyMap<string, { label: string; archived: boolean }>;
type SortKey = readonly (number | string)[];

const collator = new Intl.Collator("ja", { numeric: true });

/** Sort confirmed records for display without changing their source order or values. */
export function sortTransactions(
  items: readonly TransactionRecord[],
  sort: TransactionSort,
  members: WorkspaceMember[],
  categories?: CategoryLabels,
): TransactionRecord[] {
  const memberNames = new Map(members.map(member => [member.id, member.name]));
  const prepareKey = (item: TransactionRecord): SortKey => {
    switch (sort.column) {
      case "occurredAt": return [Date.parse(item.occurredAt)];
      case "amountYen": return [item.type === "PAYMENT" ? -item.amountYen : item.amountYen];
      case "actorUserId": return [memberNames.get(item.actorUserId) ?? item.actorName];
      case "splitWeights": {
        const shares = splitAmounts(1000, item.splitWeights, members);
        return members.map(member => shares[member.id]);
      }
      default: return [transactionFilterValue(item, sort.column, members, categories).label];
    }
  };
  // Date parsing, labels and ratio allocation are prepared once per record, not per comparison.
  const entries = items.map((item, index) => ({ item, index, key: prepareKey(item) }));
  const direction = sort.direction === "asc" ? 1 : -1;
  entries.sort((a, b) => {
    for (let index = 0; index < a.key.length; index++) {
      const left = a.key[index], right = b.key[index];
      const compared = typeof left === "number" && typeof right === "number"
        ? left - right : collator.compare(String(left), String(right));
      if (compared !== 0) return compared * direction;
    }
    return a.index - b.index;
  });
  return entries.map(entry => entry.item);
}

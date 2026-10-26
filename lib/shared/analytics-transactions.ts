import type { AnalyticsRange } from "./analytics";
import type { Category, TransactionRecord } from "./types";

export type AnalyticsTransactionsDataset = {
  workspaceId: string;
  snapshotAt: string;
  period: AnalyticsRange;
  members: { id: string; name: string }[];
  categories: Category[];
  transactions: TransactionRecord[];
};

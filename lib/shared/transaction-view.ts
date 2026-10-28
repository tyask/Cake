import { z } from "zod";
import { homeMonth, isHomeMonth } from "./home-summary";
import { workspaceIdSchema } from "./schemas/domain-schemas";
import type { TransactionRecord } from "./types";

export const transactionViewModes = ["month", "unsettled"] as const;
export const transactionViewMonthSchema = z.string().refine(isHomeMonth, "対象年月が不正です。");

/** Keep the last selected month while displaying unsettled transactions. */
export const transactionViewSelectionSchema = z.object({
  mode: z.enum(transactionViewModes),
  month: transactionViewMonthSchema,
}).strict();

export type TransactionViewSelection = z.infer<typeof transactionViewSelectionSchema>;

export const transactionViewQuerySchema = z.discriminatedUnion("mode", [
  z.object({ workspaceId: workspaceIdSchema, mode: z.literal("month"), month: transactionViewMonthSchema }).strict(),
  // The month does not restrict unsettled rows; clients may retain their last month.
  z.object({ workspaceId: workspaceIdSchema, mode: z.literal("unsettled"), month: z.string().optional() }).strict(),
]);

export type TransactionViewQuery = z.infer<typeof transactionViewQuerySchema>;

export type TransactionViewDataset = {
  workspaceId: string;
  mode: TransactionViewSelection["mode"];
  month: string | null;
  transactions: TransactionRecord[];
};

export function transactionMatchesView(
  item: Pick<TransactionRecord, "expenseClass" | "settledAt" | "occurredAt">, selection: TransactionViewSelection,
): boolean {
  return selection.mode === "unsettled" ? item.expenseClass === "SHARED" && !item.settledAt
    : homeMonth(new Date(item.occurredAt)) === selection.month;
}

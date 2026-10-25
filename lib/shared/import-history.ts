import { z } from "zod";
import { workspaceIdSchema } from "./schemas/domain-schemas";
import type { Category, TransactionRecord } from "./types";

export const IMPORT_HISTORY_PER_USER_LIMIT = 5;
export const IMPORT_FORMATS = { PAYPAY: { label: "PayPay" } } as const;
export type ImportFormat = keyof typeof IMPORT_FORMATS;

export const importHistoryQuerySchema = z.object({
  workspaceId: workspaceIdSchema,
  format: z.enum(Object.keys(IMPORT_FORMATS) as [ImportFormat, ...ImportFormat[]]),
});

export const importTransactionsQuerySchema = importHistoryQuerySchema.extend({
  batchId: z.string().uuid(),
});

export interface ImportHistoryEntry {
  id: string;
  format: ImportFormat;
  importedBy: string;
  importedByName: string;
  fileName: string;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  createdAt: string;
}

export interface ImportHistoryResponse {
  history: ImportHistoryEntry[];
}

export interface ImportTransactionsResponse {
  transactions: TransactionRecord[];
  categories: Category[];
}

import { z } from "zod";
import { MAX_PAYPAY_EXTERNAL_ID_LENGTH } from "./paypay-id";
import type { PayPayPreviewRow } from "./paypay";

export const MAX_DUPLICATE_CHECK_IDS = 2000;

export const importDuplicateCheckSchema = z.object({
  workspaceId: z.string().uuid(),
  externalIds: z.array(z.string().trim().min(1).max(MAX_PAYPAY_EXTERNAL_ID_LENGTH)).min(1).max(MAX_DUPLICATE_CHECK_IDS),
});

export interface ExistingPayPayTransaction {
  externalId: string;
  merchant: string;
  amountYen: number;
  source: string;
}

export const PAYPAY_KEY_CONFLICT_ERROR = "同じ取引IDの明細と金額または取引先が異なります";

export function applyPayPayDuplicateChecks(rows: PayPayPreviewRow[], existing: ExistingPayPayTransaction[] = []) {
  const byId = new Map(existing.map(item => [item.externalId, item]));
  const firstRows = new Map<string, PayPayPreviewRow>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    if (row.error) continue;
    const previous = firstRows.get(row.externalId);
    const saved = byId.get(row.externalId);
    if ((previous && (previous.merchant !== row.merchant || previous.amountYen !== row.amountYen))
      || (saved && (saved.source !== "PAYPAY" || saved.merchant !== row.merchant || saved.amountYen !== row.amountYen))) {
      conflicts.add(row.externalId);
    }
    firstRows.set(row.externalId, previous ?? row);
  }
  const seen = new Set<string>();
  return rows.map(row => {
    if (conflicts.has(row.externalId)) return { ...row, selected: false, duplicate: false, error: PAYPAY_KEY_CONFLICT_ERROR };
    if (row.error) return row;
    const repeated = seen.has(row.externalId);
    seen.add(row.externalId);
    const duplicate = row.duplicate || byId.has(row.externalId) || repeated;
    return { ...row, duplicate, selected: !duplicate, error: repeated ? "CSV内で重複しています" : null };
  });
}

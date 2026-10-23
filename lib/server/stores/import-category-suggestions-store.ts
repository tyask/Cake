import { CATEGORY_SUGGESTION_HISTORY_LIMIT, type ImportCategorySuggestionsResponse } from "../../shared/import-category-suggestions";
import { db } from "../database/db";
import { requireWorkspaceMember } from "./repository";

export async function findImportCategorySuggestions(
  workspaceId: string, userId: string, requestedMerchants: readonly string[],
): Promise<ImportCategorySuggestionsResponse> {
  await requireWorkspaceMember(workspaceId, userId);
  const sql = db();
  const merchants = [...new Set(requestedMerchants)];
  const rows = await sql`
    WITH requested AS MATERIALIZED (
      SELECT merchant, cake_normalize_merchant(merchant) COLLATE "C" AS merchant_normalized, ordinal
      FROM jsonb_array_elements_text(${JSON.stringify(merchants)}::jsonb) WITH ORDINALITY AS input(merchant, ordinal)
    ), normalized AS (
      SELECT DISTINCT merchant_normalized FROM requested
    ), suggestions AS MATERIALIZED (
      SELECT normalized.merchant_normalized, winner.category_id
      FROM normalized
      LEFT JOIN LATERAL (
        SELECT ranked.category_id
        FROM (
          SELECT recent.category_id,
            row_number() OVER (ORDER BY recent.occurred_at DESC, recent.created_at DESC, recent.id DESC) AS recency
          FROM (
            SELECT t.category_id, t.occurred_at, t.created_at, t.id
            FROM transactions t
            JOIN categories c ON c.workspace_id = t.workspace_id AND c.id = t.category_id
              AND c.archived_at IS NULL
            WHERE t.workspace_id = ${workspaceId}::uuid
              AND t.merchant_normalized = normalized.merchant_normalized
              AND t.type = 'PAYMENT' AND t.category_confirmed AND t.category_id IS NOT NULL
            ORDER BY t.occurred_at DESC, t.created_at DESC, t.id DESC
            LIMIT ${CATEGORY_SUGGESTION_HISTORY_LIMIT}
          ) recent
        ) ranked
        GROUP BY ranked.category_id
        ORDER BY count(*) DESC, min(ranked.recency) ASC
        LIMIT 1
      ) winner ON true
    )
    SELECT requested.merchant, suggestions.category_id
    FROM requested JOIN suggestions USING (merchant_normalized)
    ORDER BY requested.ordinal
  `;
  return {
    suggestions: rows.map(row => ({
      merchant: String(row.merchant), categoryId: row.category_id == null ? null : String(row.category_id),
    })),
  };
}

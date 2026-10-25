import { IMPORT_HISTORY_PER_USER_LIMIT, type ImportFormat, type ImportHistoryResponse } from "../../shared/import-history";
import { db } from "../database/db";
import { requireWorkspaceMember } from "./repository";

export async function findImportHistory(
  workspaceId: string, userId: string, format: ImportFormat,
): Promise<ImportHistoryResponse> {
  await requireWorkspaceMember(workspaceId, userId);
  const sql = db();
  const rows = await sql`
    WITH ranked AS (
      SELECT id, format, imported_by, file_name, total_rows, imported_rows, skipped_rows, created_at,
        row_number() OVER (PARTITION BY imported_by ORDER BY created_at DESC, id DESC) AS recency
      FROM import_batches
      WHERE workspace_id = ${workspaceId}::uuid AND format = ${format}
        AND EXISTS (
          SELECT 1 FROM workspace_members
          WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}
        )
    )
    SELECT r.id, r.format, r.imported_by, u.name AS imported_by_name,
      r.file_name, r.total_rows, r.imported_rows, r.skipped_rows,
      to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    FROM ranked r JOIN app_users u ON u.id = r.imported_by
    WHERE r.recency <= ${IMPORT_HISTORY_PER_USER_LIMIT}
    ORDER BY r.created_at DESC, r.id DESC
  `;
  return {
    history: rows.map(row => ({
      id: String(row.id), format: String(row.format) as ImportFormat,
      importedBy: String(row.imported_by), importedByName: String(row.imported_by_name),
      fileName: String(row.file_name), totalRows: Number(row.total_rows),
      importedRows: Number(row.imported_rows), skippedRows: Number(row.skipped_rows),
      // SQL serializes UTC with all six fractional digits; display formatting
      // belongs to the browser and must not truncate the API's precision.
      createdAt: String(row.created_at),
    })),
  };
}

import type { Category } from "./types";

export function categoryRecord(row: Record<string, unknown>): Category {
  return {
    id: String(row.id), parentId: row.parent_id == null ? null : String(row.parent_id),
    name: String(row.name), colorHex: String(row.color_hex), sortOrder: Number(row.sort_order),
    archivedAt: row.archived_at == null ? null
      : (row.archived_at instanceof Date ? row.archived_at : new Date(String(row.archived_at))).toISOString(),
  };
}

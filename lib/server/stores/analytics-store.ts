import type { AnalyticsDataset, AnalyticsRange, AnalyticsScope } from "../../shared/analytics";
import { categoryRecord } from "../../shared/category-record";
import { MAX_SPLIT_WEIGHT } from "../../shared/domain-values";
import { db } from "../database/db";
import { UserAccessError } from "../errors";

type Row = Record<string, unknown>;

/** Read one authorized snapshot, allocating each distinct transaction before scope joins. */
export async function findAnalytics(
  workspaceId: string, userId: string, periods: Record<AnalyticsScope, AnalyticsRange>,
): Promise<AnalyticsDataset> {
  const ranges = Object.entries(periods).map(([scope, range]) => ({ scope, ...range }));
  const [row] = await db()`
    WITH enabled_user AS MATERIALIZED (
      SELECT id FROM app_users WHERE id = ${userId} AND is_enabled
    ), authorized AS MATERIALIZED (
      SELECT w.id FROM workspaces w
      JOIN workspace_members mine ON mine.workspace_id = w.id
      JOIN enabled_user u ON u.id = mine.user_id
      WHERE w.id = ${workspaceId}::uuid
    ), members AS MATERIALIZED (
      SELECT m.user_id, m.joined_at, u.name
      FROM workspace_members m JOIN authorized a ON a.id = m.workspace_id
      JOIN app_users u ON u.id = m.user_id
    ), periods AS MATERIALIZED (
      SELECT scope, "from"::timestamp AT TIME ZONE 'Asia/Tokyo' AS start_at,
        ("to" + 1)::timestamp AT TIME ZONE 'Asia/Tokyo' AS end_at
      FROM jsonb_to_recordset(${JSON.stringify(ranges)}::jsonb) AS p(scope text, "from" date, "to" date)
    ), entries AS MATERIALIZED (
      SELECT t.id, t.type, t.occurred_at, t.amount_yen, t.actor_user_id, t.expense_class,
        t.category_id, t.split_weights
      FROM transactions t JOIN authorized a ON a.id = t.workspace_id
      WHERE t.type IN ('PAYMENT', 'RECEIPT')
        AND (t.expense_class = 'SHARED' OR t.actor_user_id = ${userId})
        AND t.occurred_at >= (SELECT min(start_at) FROM periods)
        AND t.occurred_at < (SELECT max(end_at) FROM periods)
        AND EXISTS (SELECT 1 FROM periods p WHERE t.occurred_at >= p.start_at AND t.occurred_at < p.end_at)
    ), weights AS MATERIALIZED (
      SELECT t.id, entry.key AS user_id, m.joined_at,
        CASE WHEN jsonb_typeof(entry.value) = 'number' THEN
          CASE WHEN entry.value::text::numeric BETWEEN 0 AND ${MAX_SPLIT_WEIGHT}
            AND trunc(entry.value::text::numeric) = entry.value::text::numeric
            THEN entry.value::text::numeric END
        END AS weight,
        m.user_id IS NOT NULL AS known_member
      FROM entries t CROSS JOIN LATERAL jsonb_each(t.split_weights) entry
      LEFT JOIN members m ON m.user_id = entry.key
    ), validated AS MATERIALIZED (
      SELECT t.id, COALESCE(
        count(w.user_id) = (SELECT count(*) FROM members)
        AND bool_and(w.known_member AND w.weight IS NOT NULL)
        AND sum(w.weight) > 0
        AND bool_or(w.user_id = t.actor_user_id AND w.known_member)
        AND (t.expense_class <> 'PERSONAL' OR bool_and(
          w.weight = CASE WHEN w.user_id = t.actor_user_id THEN 1 ELSE 0 END
        )), false) AS valid,
        sum(w.weight) AS total_weight
      FROM entries t LEFT JOIN weights w ON w.id = t.id
      GROUP BY t.id, t.actor_user_id, t.expense_class
    ), quotas AS (
      SELECT t.id, t.type, t.occurred_at, t.amount_yen, t.expense_class, t.category_id,
        w.user_id, w.joined_at,
        div(t.amount_yen::numeric * w.weight, v.total_weight) AS whole_yen,
        mod(t.amount_yen::numeric * w.weight, v.total_weight) AS remainder
      FROM entries t JOIN validated v ON v.id = t.id AND v.valid
      JOIN weights w ON w.id = t.id
    ), ranked AS (
      SELECT *, amount_yen::numeric - sum(whole_yen) OVER (PARTITION BY id) AS leftover,
        row_number() OVER (PARTITION BY id ORDER BY remainder DESC, joined_at, user_id) AS priority
      FROM quotas
    ), allocations AS MATERIALIZED (
      SELECT type, occurred_at, expense_class, category_id, user_id,
        whole_yen + CASE WHEN priority <= leftover THEN 1 ELSE 0 END AS burden_yen
      FROM ranked
    ), buckets AS (
      SELECT a.type, p.scope, to_char(a.occurred_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS month,
        a.user_id, a.expense_class, a.category_id, sum(a.burden_yen)::text AS burden_yen
      FROM allocations a JOIN periods p ON a.occurred_at >= p.start_at AND a.occurred_at < p.end_at
      GROUP BY a.type, p.scope, month, a.user_id, a.expense_class, a.category_id
      HAVING sum(a.burden_yen) <> 0
    )
    SELECT EXISTS(SELECT 1 FROM enabled_user) AS enabled,
      EXISTS(SELECT 1 FROM authorized) AS authorized,
      EXISTS(SELECT 1 FROM validated WHERE NOT valid) AS invalid_data,
      to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS snapshot_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', user_id, 'name', name)
        ORDER BY joined_at, user_id) FROM members), '[]'::jsonb) AS members,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'parent_id', c.parent_id, 'name', c.name, 'color_hex', c.color_hex,
        'sort_order', c.sort_order, 'archived_at', c.archived_at, 'revision', c.revision
      ) ORDER BY c.sort_order, c.created_at, c.id)
        FROM categories c JOIN authorized a ON a.id = c.workspace_id), '[]'::jsonb) AS categories,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'scope', scope, 'month', month, 'memberId', user_id, 'expenseClass', expense_class,
        'categoryId', category_id, 'burdenYen', burden_yen
      ) ORDER BY scope, month, user_id, expense_class, category_id) FROM buckets WHERE type = 'PAYMENT'), '[]'::jsonb) AS buckets,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'scope', scope, 'month', month, 'memberId', user_id, 'expenseClass', expense_class,
        'categoryId', category_id, 'burdenYen', burden_yen
      ) ORDER BY scope, month, user_id, expense_class, category_id) FROM buckets WHERE type = 'RECEIPT'), '[]'::jsonb) AS receipt_buckets
  `;
  if (!row || row.enabled !== true) throw new UserAccessError("ログインが必要です。", 401);
  if (row.authorized !== true) throw new UserAccessError("このワークスペースを操作する権限がありません。", 403);
  if (row.invalid_data === true) throw new Error("集計対象の保存済み負担割合が不正です。");
  return {
    workspaceId, snapshotAt: String(row.snapshot_at), timeZone: "Asia/Tokyo", periods,
    members: (row.members as Row[]).map(member => ({ id: String(member.id), name: String(member.name) })),
    categories: (row.categories as Row[]).map(categoryRecord),
    buckets: row.buckets as AnalyticsDataset["buckets"],
    receiptBuckets: row.receipt_buckets as AnalyticsDataset["receiptBuckets"],
  };
}

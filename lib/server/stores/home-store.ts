import { homeQuerySchema, type HomeData } from "../../shared/home-data";
import { MAX_SPLIT_WEIGHT } from "../../shared/domain-values";
import { calculateSettlement, type SettlementMember, type SettlementTransaction } from "../../shared/settlement";
import type { SettlementHistory } from "../../shared/types";
import { db } from "../database/db";
import { UserAccessError } from "../errors";

/** Monthly totals, settlement inputs, and history share one authorized SQL snapshot. */
export async function findHome(workspaceId: string, userId: string, month: string): Promise<HomeData> {
  homeQuerySchema.parse({ workspaceId, month });
  const [row] = await db()`
    WITH enabled_user AS MATERIALIZED (
      SELECT id FROM app_users WHERE id = ${userId} AND is_enabled
    ), authorized AS MATERIALIZED (
      SELECT w.id, w.type FROM workspaces w
      JOIN workspace_members mine ON mine.workspace_id = w.id
      JOIN enabled_user u ON u.id = mine.user_id
      WHERE w.id = ${workspaceId}::uuid
    ), members AS MATERIALIZED (
      SELECT m.user_id, m.joined_at, m.weight, u.name
      FROM workspace_members m JOIN authorized a ON a.id = m.workspace_id
      JOIN app_users u ON u.id = m.user_id
    ), month_bounds AS MATERIALIZED (
      -- Match homeMonth's fixed Japanese UTC+09:00 calendar, including years before 1888.
      SELECT ${`${month}-01`}::date::timestamp AT TIME ZONE INTERVAL '+09:00' AS start_at,
        (${`${month}-01`}::date + INTERVAL '1 month') AT TIME ZONE INTERVAL '+09:00' AS end_at
    ), entries AS MATERIALIZED (
      SELECT t.id, t.type, t.amount_yen, t.actor_user_id, t.expense_class, t.split_weights
      FROM transactions t JOIN authorized a ON a.id = t.workspace_id
      WHERE t.occurred_at >= (SELECT start_at FROM month_bounds)
        AND t.occurred_at < (SELECT end_at FROM month_bounds)
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
      WHERE t.expense_class = 'SHARED'
    ), validated AS MATERIALIZED (
      SELECT t.id, COALESCE(
        count(w.user_id) = (SELECT count(*) FROM members)
        AND bool_and(w.known_member AND w.weight IS NOT NULL)
        AND sum(w.weight) > 0, false) AS valid,
        sum(w.weight) AS total_weight
      FROM entries t LEFT JOIN weights w ON w.id = t.id
      WHERE t.expense_class = 'SHARED'
      GROUP BY t.id
    ), quotas AS (
      SELECT t.id, t.type, t.amount_yen, w.user_id, w.joined_at,
        div(t.amount_yen::numeric * w.weight, v.total_weight) AS whole_yen,
        mod(t.amount_yen::numeric * w.weight, v.total_weight) AS remainder
      FROM entries t JOIN validated v ON v.id = t.id AND v.valid
      JOIN weights w ON w.id = t.id
    ), ranked AS (
      SELECT *, amount_yen::numeric - sum(whole_yen) OVER (PARTITION BY id) AS leftover,
        row_number() OVER (PARTITION BY id ORDER BY remainder DESC, joined_at, user_id) AS priority
      FROM quotas
    ), allocations AS MATERIALIZED (
      SELECT type, user_id, whole_yen + CASE WHEN priority <= leftover THEN 1 ELSE 0 END AS burden_yen
      FROM ranked
      UNION ALL
      SELECT t.type, t.actor_user_id, t.amount_yen::numeric
      FROM entries t WHERE t.expense_class = 'PERSONAL'
    ), monthly AS MATERIALIZED (
      SELECT m.user_id, m.joined_at,
        COALESCE(sum(a.burden_yen) FILTER (WHERE a.type = 'PAYMENT'), 0) AS payment_total,
        COALESCE(sum(a.burden_yen) FILTER (WHERE a.type = 'RECEIPT'), 0) AS receipt_total
      FROM members m LEFT JOIN allocations a ON a.user_id = m.user_id
      GROUP BY m.user_id, m.joined_at
    ), unsettled AS MATERIALIZED (
      SELECT t.id, t.actor_user_id, t.type, t.amount_yen, t.split_weights
      FROM transactions t JOIN authorized a ON a.id = t.workspace_id
      WHERE t.expense_class = 'SHARED' AND t.settled_at IS NULL
    )
    SELECT EXISTS(SELECT 1 FROM enabled_user) AS enabled,
      EXISTS(SELECT 1 FROM authorized) AS authorized,
      (SELECT type FROM authorized) AS workspace_type,
      EXISTS(SELECT 1 FROM validated WHERE NOT valid) AS invalid_data,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', user_id, 'name', name, 'weight', weight)
        ORDER BY joined_at, user_id) FROM members), '[]'::jsonb) AS members,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'userId', user_id, 'paymentTotal', payment_total::text, 'receiptTotal', receipt_total::text,
        'balanceYen', (receipt_total - payment_total)::text
      ) ORDER BY joined_at, user_id) FROM monthly), '[]'::jsonb) AS monthly_people,
      (SELECT jsonb_build_object(
        'paymentTotal', COALESCE(sum(payment_total), 0)::text,
        'receiptTotal', COALESCE(sum(receipt_total), 0)::text,
        'balanceYen', (COALESCE(sum(receipt_total), 0) - COALESCE(sum(payment_total), 0))::text
      ) FROM monthly) AS monthly_total,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'actorUserId', actor_user_id, 'type', type, 'amountYen', amount_yen, 'splitWeights', split_weights
      ) ORDER BY id) FROM unsettled), '[]'::jsonb) AS unsettled_entries,
      (SELECT jsonb_build_object(
        'count', count(*),
        'paymentTotal', COALESCE(sum(amount_yen) FILTER (WHERE type = 'PAYMENT'), 0)::text,
        'receiptTotal', COALESCE(sum(amount_yen) FILTER (WHERE type = 'RECEIPT'), 0)::text,
        'balanceYen', (COALESCE(sum(amount_yen) FILTER (WHERE type = 'RECEIPT'), 0)
          - COALESCE(sum(amount_yen) FILTER (WHERE type = 'PAYMENT'), 0))::text
      ) FROM unsettled) AS unsettled_totals,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', h.id, 'payerName', h.payer_name, 'payeeName', h.payee_name,
        'amountYen', h.amount_yen, 'completedAt', h.completed_at
      ) ORDER BY h.completed_at DESC, h.id DESC) FROM (
        SELECT s.id, payer.name AS payer_name, payee.name AS payee_name, s.amount_yen, s.completed_at
        FROM settlements s JOIN authorized a ON a.id = s.workspace_id
        LEFT JOIN app_users payer ON payer.id = s.payer_user_id
        LEFT JOIN app_users payee ON payee.id = s.payee_user_id
        ORDER BY s.completed_at DESC, s.id DESC LIMIT 20
      ) h), '[]'::jsonb) AS settlement_history
  `;
  if (!row || row.enabled !== true) throw new UserAccessError("ログインが必要です。", 401);
  if (row.authorized !== true) throw new UserAccessError("このワークスペースを操作する権限がありません。", 403);
  if (row.invalid_data === true) throw new Error("集計対象の保存済み負担割合が不正です。");
  const members = row.members as SettlementMember[];
  const unsettled = (row.unsettled_entries as Omit<SettlementTransaction, "expenseClass" | "settledAt">[])
    .map(entry => ({ ...entry, expenseClass: "SHARED" as const, settledAt: null }));
  const calculation = row.workspace_type === "SHARED" ? calculateSettlement(members, unsettled) : null;
  // IDs are required only while calculating and committing settlement on the server.
  const settlement = calculation ? {
    paymentTotal: calculation.paymentTotal, receiptTotal: calculation.receiptTotal, netTotal: calculation.netTotal,
    people: calculation.people, payerUserId: calculation.payerUserId, payerName: calculation.payerName,
    payeeUserId: calculation.payeeUserId, payeeName: calculation.payeeName, amountYen: calculation.amountYen,
  } : null;
  return {
    workspaceId, month, members: members.map(({ id, name }) => ({ id, name })),
    monthly: { people: row.monthly_people as HomeData["monthly"]["people"], total: row.monthly_total as HomeData["monthly"]["total"] },
    unsettled: row.unsettled_totals as HomeData["unsettled"], settlement,
    settlementHistory: (row.settlement_history as SettlementHistory[]).map(history => ({
      ...history, completedAt: new Date(history.completedAt).toISOString(),
    })),
  };
}

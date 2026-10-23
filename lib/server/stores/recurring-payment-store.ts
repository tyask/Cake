import { db } from "../database/db";
import { recurringPaymentConfigSchema } from "../../shared/schemas/recurring-payment-schemas";
import { jstToday, monthOf } from "../../shared/recurring-payment-calendar";
import type { RecurringPaymentStore } from "../services/recurring-payments";

type Row = Record<string, unknown>;
type SavedMutation = Awaited<ReturnType<RecurringPaymentStore["mutate"]>>;
type GenerationResult = Awaited<ReturnType<RecurringPaymentStore["generate"]>>;

export const recurringPaymentStore: RecurringPaymentStore = {
  async list(workspaceId, userId, testMode) {
    const rows = await db()`
      WITH authorized AS (
        SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
        WHERE w.id = ${workspaceId}::uuid AND m.user_id = ${userId} AND cake_recurring_user_allowed(${userId},${testMode})
      )
      SELECT EXISTS(SELECT 1 FROM authorized) AS authorized,
        COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at,p.id) FROM recurring_payments p
          JOIN authorized a ON a.id = p.workspace_id WHERE p.state <> 'ARCHIVED'),'[]'::jsonb) AS payments,
        COALESCE((SELECT jsonb_agg(m.user_id ORDER BY m.user_id) FROM workspace_members m JOIN authorized a ON a.id = m.workspace_id
          WHERE cake_recurring_user_allowed(m.user_id,${testMode})),'[]'::jsonb) AS eligible_actor_user_ids
    `;
    const row = rows[0];
    if (!row) throw new Error("Unavailable result");
    return { authorized: row.authorized === true, payments: row.payments as Row[], eligibleActorUserIds: row.eligible_actor_user_ids as string[] };
  },
  async mutate(userId, input, testMode, now) {
    const config = input.action === "create" || input.action === "update"
      ? recurringPaymentConfigSchema.parse(Object.fromEntries(Object.keys(recurringPaymentConfigSchema.shape).map(key => [key, input[key as keyof typeof input]]))) : null;
    const rows = await db()`SELECT cake_mutate_recurring_payment(
      ${input.workspaceId}::uuid,${userId},${input.action},${"paymentId" in input ? input.paymentId : null}::uuid,
      ${"expectedRevision" in input ? input.expectedRevision : null}::integer,${null}::date,
      ${config ? JSON.stringify(config) : null}::jsonb,${testMode},${now.toISOString()}::timestamptz
    ) AS result`;
    if (!rows[0]?.result) throw new Error("Unavailable result");
    return rows[0].result as SavedMutation;
  },
  async candidates(workspaceId, testMode, now) {
    const today = jstToday(now);
    const thisMonth = monthOf(today);
    const rows = await db()`SELECT id,workspace_id FROM recurring_payments p
      WHERE state = 'ACTIVE' AND (${workspaceId ?? null}::uuid IS NULL OR workspace_id = ${workspaceId ?? null}::uuid)
        AND next_scheduled_on <= ${today}::date
        AND cake_recurring_scheduled_on(${thisMonth}::date,day_of_month) = ${today}::date
        AND (${today}::date + TIME '09:00') AT TIME ZONE 'Asia/Tokyo' <= ${now.toISOString()}::timestamptz
        AND cake_recurring_identity_matches(authorized_by,${testMode})
      ORDER BY workspace_id,id`;
    return rows.map(row => ({ id: String(row.id), workspaceId: String(row.workspace_id) }));
  },
  async generate(candidate, testMode, now) {
    const rows = await db()`SELECT cake_generate_recurring_payment(${candidate.workspaceId}::uuid,${candidate.id}::uuid,
      ${testMode},${now.toISOString()}::timestamptz) AS result`;
    if (!rows[0]?.result) throw new Error("Unavailable result");
    return rows[0].result as GenerationResult;
  },
};

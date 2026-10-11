import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { transactionDateInput } from "../lib/transaction-editing";

// Run only against the task's isolated database, after db:setup. This script
// never loads .env files or falls back to DATABASE_URL, and never alters seed
// identities. Its clock overrides are direct SQL calls, not public API inputs.
type Row = Record<string, unknown>;
type Config = {
  dayOfMonth: number; merchant: string; method: string; amountYen: number;
  actorUserId: string; expenseClass: "PERSONAL" | "SHARED";
  splitWeights: Record<string, number>; memo: string;
};

let stage = "専用テストDBの確認";
let cleanupFailed = false;

async function main() {
  const connection = process.env.CAKE_TEST_DATABASE_URL?.trim();
  if (!connection || connection === "[SENSITIVE]" || process.env.VERCEL_ENV === "production") {
    throw new Error("CAKE_TEST_DATABASE_URL が必要です。Productionでは実行できません。");
  }
  const parsed = new URL(connection);
  if (!(["postgres:", "postgresql:"] as string[]).includes(parsed.protocol)) {
    throw new Error("専用テストDBの接続形式が不正です。");
  }
  const sql = neon(connection);
  const fixture = `verify-recurring-${randomUUID()}`;
  const userA = `${fixture}-a`;
  const userB = `${fixture}-b`;
  const outsider = `${fixture}-outsider`;
  const users = [userA, userB, outsider];
  const workspaces: string[] = [];
  const now = (day: string) => `${day}T09:00:00+09:00`;

  async function workspace(withSecondMember = true) {
    const id = randomUUID();
    workspaces.push(id);
    await sql.transaction([
      sql`INSERT INTO workspaces (id, name, type, owner_user_id)
        VALUES (${id}::uuid, ${fixture}, 'SHARED', ${userA})`,
      sql`INSERT INTO workspace_members (workspace_id, user_id, role, weight)
        VALUES (${id}::uuid, ${userA}, 'OWNER', 1)`,
      ...(withSecondMember ? [sql`INSERT INTO workspace_members (workspace_id, user_id, role, weight)
        VALUES (${id}::uuid, ${userB}, 'MEMBER', 0)`] : []),
    ]);
    return id;
  }

  const baseConfig = (changes: Partial<Config> = {}): Config => ({
    dayOfMonth: 27, merchant: "DB回帰 家賃", method: "銀行振込", amountYen: 100_000,
    actorUserId: userA, expenseClass: "SHARED", splitWeights: { [userA]: 1, [userB]: 0 },
    memo: "定期登録の回帰確認", ...changes,
  });

  async function mutate(workspaceId: string, operation: string, payment: Row | null = null,
    config: Config | null = null, day = "2026-10-10", start: string | null = null,
    actor = userA, revision = payment ? Number(payment.revision) : null, testMode = false, runAt = now(day)) {
    const rows = await sql`SELECT cake_mutate_recurring_payment(
      ${workspaceId}::uuid, ${actor}, ${operation}, ${payment?.id ?? null}::uuid,
      ${revision}::integer, ${operation === "create" ? start : null}::date,
      ${config ? JSON.stringify(config) : null}::jsonb, ${testMode}, ${runAt}::timestamptz
    ) AS result`;
    return rows[0].result as { payment: Row; effectiveMonth?: string };
  }

  const generateQuery = (workspaceId: string, payment: Row, day: string, testMode = false, runAt = now(day)) =>
    sql`SELECT cake_generate_recurring_payment(${workspaceId}::uuid, ${payment.id}::uuid,
      ${testMode}, ${runAt}::timestamptz) AS result`;
  async function generate(workspaceId: string, payment: Row, day: string, testMode = false, runAt = now(day)) {
    const rows = await generateQuery(workspaceId, payment, day, testMode, runAt);
    return rows[0].result as { status: string; errorCode?: string; transactionId?: string };
  }
  async function saved(payment: Row) {
    const rows = await sql`SELECT * FROM recurring_payments WHERE id = ${payment.id}::uuid`;
    assert.equal(rows.length, 1);
    return rows[0] as Row;
  }
  async function count(workspaceId: string, payment: Row) {
    const prefix = `recurring_${payment.id}_`;
    const rows = await sql`SELECT count(*)::integer AS count FROM transactions
      WHERE workspace_id = ${workspaceId}::uuid AND starts_with(external_id, ${prefix})`;
    return Number(rows[0].count);
  }
  async function rejectsCode(action: () => Promise<unknown>, code: string) {
    let rejected = false;
    try { await action(); } catch (error) {
      rejected = true;
      assert.equal((error as { message?: string }).message, code);
    }
    assert.equal(rejected, true, `Expected rejection: ${code}`);
  }

  try {
    stage = "マイグレーションと有効ユーザー枠の確認";
    const schema = await sql`SELECT EXISTS (SELECT 1 FROM schema_migrations
      WHERE name = '011_recurring_payment_next_scheduled_on.sql') AS ready`;
    assert.equal(schema[0].ready, true, "011 migration must be applied first");
    const columns = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'recurring_payments' AND column_name = 'start_on'`;
    assert.equal(columns.length, 0, "start_on must be removed from the table");
    const capacity = await sql`SELECT count(*)::integer AS count FROM app_users WHERE is_enabled
      AND NOT ((id = 'test-user-a' AND email = 'test-a@cake.local')
        OR (id = 'test-user-b' AND email = 'test-b@cake.local'))`;
    assert.ok(Number(capacity[0].count) < 2, "No isolated normal-user slot is available");

    stage = "新規テスト利用者の作成";
    await sql.transaction(users.map((id, index) => sql`INSERT INTO app_users
      (id, email, name, is_admin, is_enabled)
      VALUES (${id}, ${`${id}@example.invalid`}, 'DB回帰利用者', false, ${index === 0})`));
    const workspaceId = await workspace();
    const otherWorkspace = await workspace();

    stage = "認可・revision・状態遷移";
    let payment = (await mutate(workspaceId, "create", null, baseConfig())).payment;
    assert.equal(payment.state, "ACTIVE");
    assert.equal(Number(payment.revision), 1);
    assert.equal(Object.hasOwn(payment, "start_on"), false);
    assert.equal(String(payment.active_from_month), "0001-01-01");
    assert.equal(payment.pending_config, null);
    assert.equal(payment.pending_effective_month, null);
    assert.equal(String(payment.next_scheduled_on), "2026-10-27");
    await rejectsCode(() => sql`UPDATE recurring_payments SET workspace_id = ${otherWorkspace}::uuid
      WHERE id = ${payment.id}::uuid`, "INPUT_INVALID");
    stage = "開始日削除後の月初制約保持";
    await assert.rejects(sql`UPDATE recurring_payments SET active_from_month = DATE '2026-10-02'
      WHERE id = ${payment.id}::uuid`, { code: "23514", constraint: "recurring_payments_active_from_month_month_start_check" });
    await assert.rejects(sql`UPDATE recurring_payments SET pending_config = ${JSON.stringify(baseConfig())}::jsonb,
      pending_effective_month = DATE '2026-11-02' WHERE id = ${payment.id}::uuid`,
    { code: "23514", constraint: "recurring_payments_pending_effective_month_month_start_check" });
    await assert.rejects(sql`UPDATE recurring_payments SET last_generated_month = DATE '2026-10-02'
      WHERE id = ${payment.id}::uuid`, { code: "23514", constraint: "recurring_payments_last_generated_month_month_start_check" });
    assert.equal((await saved(payment)).last_generated_month, null);
    stage = "認可・revision・状態遷移";
    await rejectsCode(() => mutate(workspaceId, "update", payment, baseConfig(),
      "2026-10-11", "2026-10-10", userA, 999), "CONFLICT");
    await rejectsCode(() => mutate(otherWorkspace, "pause", payment), "NOT_FOUND");
    await rejectsCode(() => mutate(workspaceId, "pause", payment, null,
      "2026-10-11", "2026-10-10", outsider), "FORBIDDEN");
    await rejectsCode(() => mutate(workspaceId, "create", null, baseConfig(),
      "2026-10-11", "2026-10-11", userA, null, true), "FORBIDDEN");
    await rejectsCode(() => mutate(workspaceId, "create", null,
      baseConfig({ splitWeights: { [userA]: 1, [userB]: 1 } })), "SPLIT_USER_UNAVAILABLE");
    await rejectsCode(() => mutate(workspaceId, "create", null,
      baseConfig({ actorUserId: userB })), "ACTOR_UNAVAILABLE");
    await rejectsCode(() => mutate(workspaceId, "create", null,
      baseConfig({ splitWeights: { [userA]: 1, [userB]: 0, [outsider]: 1 } })), "SPLIT_MEMBERS_INVALID");

    stage = "設定日の09:00境界・月末・履歴非参照";
    const cutoffConfig = baseConfig({ dayOfMonth: 10 });
    const beforeCutoff = (await mutate(workspaceId, "create", null, cutoffConfig,
      "2026-10-10", null, userA, null, false, "2026-10-10T08:59:59.999+09:00")).payment;
    assert.equal(String(beforeCutoff.next_scheduled_on), "2026-10-10");
    const atCutoff = (await mutate(workspaceId, "create", null, cutoffConfig,
      "2026-10-10", null, userA, null, false, "2026-10-10T09:00:00+09:00")).payment;
    assert.equal(String(atCutoff.next_scheduled_on), "2026-11-10");
    assert.equal((await generate(workspaceId, beforeCutoff, "2026-10-10", false,
      "2026-10-10T08:59:59.999+09:00")).status, "skipped");
    assert.equal((await generate(workspaceId, beforeCutoff, "2026-10-10")).status, "created");
    assert.equal((await generate(workspaceId, beforeCutoff, "2026-10-10")).status, "skipped");
    assert.equal((await generate(workspaceId, atCutoff, "2026-10-10")).status, "skipped");
    const dateCases = [
      ["2026-10-09T23:59:59+09:00", 10, "2026-10-10"],
      ["2026-10-10T08:59:59+09:00", 9, "2026-11-09"],
      ["2026-02-28T08:59:59+09:00", 31, "2026-02-28"],
      ["2026-02-28T09:00:00+09:00", 31, "2026-03-31"],
      ["2026-12-31T09:00:00+09:00", 31, "2027-01-31"],
    ] as const;
    for (const [at, day, expected] of dateCases) {
      const result = await sql`SELECT cake_recurring_next_scheduled_on(${day}, ${at}::timestamptz) AS next`;
      assert.equal(String(result[0].next), expected);
    }
    // Legacy markers are retained solely for compatibility and cannot prevent
    // a setting from running or change when its next date is saved.
    await sql`UPDATE recurring_payments SET last_generated_month = DATE '2199-01-01'
      WHERE id = ${payment.id}::uuid`;

    stage = "同時登録・固定スナップショット・実行日時";
    await sql`UPDATE workspace_members SET weight = 7 WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userA}`;
    const executedAt = "2026-10-27T09:23:45.678+09:00";
    const concurrent = await Promise.all([generate(workspaceId, payment, "2026-10-27", false, executedAt),
      generate(workspaceId, payment, "2026-10-27", false, executedAt)]);
    assert.deepEqual(concurrent.map(item => item.status).sort(), ["created", "skipped"]);
    assert.equal(await count(workspaceId, payment), 1);
    const entry = (await sql`SELECT * FROM transactions WHERE workspace_id = ${workspaceId}::uuid
      AND id = ${concurrent.find(item => item.status === "created")?.transactionId}::uuid`)[0];
    assert.equal(entry.external_id, `recurring_${payment.id}_20261027_${entry.id}`);
    const occurredAt = new Date(String(entry.occurred_at)).toISOString();
    assert.equal(occurredAt, "2026-10-27T00:23:45.678Z");
    assert.equal(transactionDateInput(occurredAt), "2026-10-27T09:23:45.678");
    assert.equal(entry.source, "RECURRING");
    assert.equal(entry.type, "PAYMENT");
    assert.equal(Number(entry.amount_yen), 100_000);
    assert.equal(entry.created_by, userA);
    assert.equal(entry.memo, baseConfig().memo);
    assert.deepEqual(entry.split_weights, baseConfig().splitWeights);

    stage = "明細削除後の再生成防止";
    await sql`SELECT cake_bulk_transactions(${workspaceId}::uuid, ${userA}, ARRAY[${entry.id}::uuid], 'DELETE')`;
    assert.equal((await generate(workspaceId, payment, "2026-10-27")).status, "skipped");
    assert.equal(await count(workspaceId, payment), 0);
    assert.equal(String((await saved(payment)).last_generated_month), "2199-01-01");
    assert.equal(String((await saved(payment)).next_scheduled_on), "2026-11-27");

    stage = "編集の即時反映・履歴marker非参照";
    let next = baseConfig({ dayOfMonth: 10, amountYen: 110_000 });
    payment = (await mutate(workspaceId, "update", await saved(payment), next, "2026-10-28")).payment;
    assert.equal(Number(payment.amount_yen), 110_000);
    assert.equal(Number(payment.day_of_month), 10);
    assert.equal(String(payment.last_generated_month), "2199-01-01");
    assert.equal(String(payment.next_scheduled_on), "2026-11-10");
    next = { ...next, memo: "即時反映した金額を保持してメモ変更" };
    payment = (await mutate(workspaceId, "update", payment, next, "2026-10-29")).payment;
    assert.equal(payment.memo, next.memo);
    assert.equal(payment.pending_config, null);
    assert.equal(payment.pending_effective_month, null);
    const beforeGenerateRevision = Number(payment.revision);
    assert.equal((await generate(workspaceId, payment, "2026-11-10")).status, "created");
    payment = await saved(payment);
    assert.equal(Number(payment.amount_yen), 110_000);
    assert.equal(payment.pending_config, null);
    assert.equal(Number(payment.revision), beforeGenerateRevision);

    stage = "当月の日付変更による追加登録・生成済み明細保持";
    let immediatelyEdited = (await mutate(workspaceId, "create", null, baseConfig())).payment;
    immediatelyEdited = (await mutate(workspaceId, "update", immediatelyEdited,
      baseConfig({ dayOfMonth: 11, amountYen: 444 }), "2026-10-10")).payment;
    const firstEditedResult = await generate(workspaceId, immediatelyEdited, "2026-10-11");
    assert.equal(firstEditedResult.status, "created");
    const editedEntry = (await sql`SELECT amount_yen, merchant FROM transactions
      WHERE id = ${firstEditedResult.transactionId}::uuid`)[0];
    assert.equal(Number(editedEntry.amount_yen), 444);
    immediatelyEdited = (await mutate(workspaceId, "update", await saved(immediatelyEdited),
      baseConfig({ dayOfMonth: 12, amountYen: 555, merchant: "変更後の支払先" }), "2026-10-11")).payment;
    assert.equal(String(immediatelyEdited.next_scheduled_on), "2026-10-12");
    assert.equal((await generate(workspaceId, immediatelyEdited, "2026-10-12")).status, "created");
    assert.equal((await generate(workspaceId, immediatelyEdited, "2026-10-12")).status, "skipped");
    assert.equal(await count(workspaceId, immediatelyEdited), 2);
    const unchangedEntry = (await sql`SELECT amount_yen, merchant FROM transactions
      WHERE id = ${firstEditedResult.transactionId}::uuid`)[0];
    assert.equal(Number(unchangedEntry.amount_yen), 444);
    assert.equal(unchangedEntry.merchant, baseConfig().merchant);
    assert.equal(Number(immediatelyEdited.amount_yen), 555);
    assert.equal(immediatelyEdited.merchant, "変更後の支払先");

    stage = "停止・即時再開・年跨ぎ・archive";
    payment = (await mutate(workspaceId, "pause", payment, null, "2026-11-11")).payment;
    await rejectsCode(() => mutate(workspaceId, "pause", payment, null, "2026-11-11"), "CONFLICT");
    assert.equal((await generate(workspaceId, payment, "2026-12-10")).status, "skipped");
    payment = (await mutate(workspaceId, "resume", payment, null, "2026-12-09")).payment;
    assert.equal(String(payment.active_from_month), "0001-01-01");
    assert.equal((await generate(workspaceId, payment, "2026-12-10")).status, "created");
    assert.equal((await generate(workspaceId, payment, "2027-01-10")).status, "created");
    payment = (await mutate(workspaceId, "archive", await saved(payment), null, "2027-01-11")).payment;
    await rejectsCode(() => mutate(workspaceId, "resume", payment, null, "2027-01-12"), "CONFLICT");
    await rejectsCode(() => mutate(workspaceId, "update", payment, next, "2027-01-12"), "CONFLICT");
    assert.equal(String(payment.last_generated_month), "2199-01-01");
    assert.equal(await count(workspaceId, payment), 3);

    stage = "途中失敗の全ロールバック・翌日補完なし";
    let failed = (await mutate(workspaceId, "create", null, baseConfig())).payment;
    failed = (await mutate(workspaceId, "update", failed, next, "2026-10-28")).payment;
    await assert.rejects(sql.transaction([
      generateQuery(workspaceId, failed, "2026-11-10"),
      sql`SELECT 1 / 0 AS forced_failure`,
    ]));
    const afterFailure = await saved(failed);
    assert.equal(afterFailure.last_generated_month, null);
    assert.equal(String(afterFailure.next_scheduled_on), "2026-11-10");
    assert.equal(afterFailure.pending_config, null);
    assert.equal(Number(afterFailure.amount_yen), 110_000);
    assert.equal(await count(workspaceId, failed), 0);
    assert.equal((await generate(workspaceId, failed, "2026-11-11")).status, "skipped");
    assert.equal(await count(workspaceId, failed), 0);
    assert.equal((await generate(workspaceId, failed, "2026-12-10")).status, "created");
    assert.equal(String((await saved(failed)).next_scheduled_on), "2027-01-10");

    stage = "未実行予定の翌日・開始日管理なし・月末丸め";
    const missed = (await mutate(workspaceId, "create", null, baseConfig())).payment;
    assert.equal((await generate(workspaceId, missed, "2026-10-28")).status, "skipped");
    assert.equal(await count(workspaceId, missed), 0);
    const legacyStart = (await mutate(workspaceId, "create", null, baseConfig({ dayOfMonth: 31 }),
      "2026-10-10", "2026-12-28")).payment;
    assert.equal(Object.hasOwn(legacyStart, "start_on"), false);
    assert.equal(String(legacyStart.active_from_month), "0001-01-01");
    assert.equal((await generate(workspaceId, legacyStart, "2026-11-30")).status, "created");
    assert.equal((await generate(workspaceId, legacyStart, "2026-12-31")).status, "created");

    stage = "旧月単位external_idが存在しても新明細を追加できる";
    const collision = (await mutate(workspaceId, "create", null, baseConfig())).payment;
    await sql`INSERT INTO transactions (workspace_id, occurred_at, merchant, method, type,
      amount_yen, actor_user_id, expense_class, split_weights, external_id, source, created_by, updated_by)
      VALUES (${workspaceId}::uuid, ${now("2026-10-27")}::timestamptz, '衝突検証の既存明細', '現金', 'PAYMENT',
        123, ${userA}, 'PERSONAL', ${JSON.stringify({ [userA]: 1, [userB]: 0 })}::jsonb,
        ${`recurring_${collision.id}_202610`}, 'MANUAL', ${userA}, ${userA})`;
    assert.equal((await generate(workspaceId, collision, "2026-10-27")).status, "created");
    assert.equal((await saved(collision)).last_generated_month, null);
    const original = (await sql`SELECT amount_yen, source FROM transactions WHERE workspace_id = ${workspaceId}::uuid
      AND external_id = ${`recurring_${collision.id}_202610`}`)[0];
    assert.equal(Number(original.amount_yen), 123);
    assert.equal(original.source, "MANUAL");

    stage = "生成による清算スナップショット差分";
    const settlementWorkspace = await workspace();
    await sql`INSERT INTO transactions (workspace_id, occurred_at, merchant, method, type,
      amount_yen, actor_user_id, expense_class, split_weights, external_id, source, created_by, updated_by)
      VALUES (${settlementWorkspace}::uuid, ${now("2026-10-26")}::timestamptz, '清算確認の既存明細', '現金', 'PAYMENT',
        400, ${userA}, 'SHARED', ${JSON.stringify({ [userA]: 1, [userB]: 0 })}::jsonb,
        ${`manual_${randomUUID()}`}, 'MANUAL', ${userA}, ${userA})`;
    const snapshot = async () => (await sql`SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'actorUserId', actor_user_id, 'type', type, 'amountYen', amount_yen,
      'expenseClass', expense_class, 'splitWeights', split_weights) ORDER BY id) AS entries
      FROM transactions WHERE workspace_id = ${settlementWorkspace}::uuid AND expense_class = 'SHARED'
        AND settled_at IS NULL`)[0].entries;
    const beforeGeneration = await snapshot();
    const settlementPayment = (await mutate(settlementWorkspace, "create", null, baseConfig())).payment;
    assert.equal((await generate(settlementWorkspace, settlementPayment, "2026-10-27")).status, "created");
    await assert.rejects(sql`SELECT cake_assert_settlement_snapshot(${settlementWorkspace}::uuid,
      ${userA}, ${JSON.stringify(beforeGeneration)}::jsonb)`);
    await sql`SELECT cake_assert_settlement_snapshot(${settlementWorkspace}::uuid,
      ${userA}, ${JSON.stringify(await snapshot())}::jsonb)`;

    stage = "メンバー追加の0補完・testモード分離";
    const singleWorkspace = await workspace(false);
    const single = (await mutate(singleWorkspace, "create", null,
      baseConfig({ splitWeights: { [userA]: 2 } }))).payment;
    await sql`INSERT INTO workspace_members (workspace_id, user_id, role, weight)
      VALUES (${singleWorkspace}::uuid, ${userB}, 'MEMBER', 9)`;
    const eligibility = (await sql`SELECT cake_recurring_user_allowed(${userA}, true) AS in_test,
      cake_recurring_user_allowed(${userA}, false) AS in_normal`)[0];
    assert.equal(eligibility.in_test, false);
    assert.equal(eligibility.in_normal, true);
    assert.equal((await generate(singleWorkspace, single, "2026-10-27", true)).status, "skipped");
    assert.equal((await saved(single)).state, "ACTIVE");
    assert.equal(await count(singleWorkspace, single), 0);
    assert.equal((await generate(singleWorkspace, single, "2026-10-27")).status, "created");
    const extended = (await sql`SELECT split_weights FROM transactions WHERE workspace_id = ${singleWorkspace}::uuid`)[0];
    assert.deepEqual(extended.split_weights, { [userA]: 2, [userB]: 0 });
    assert.deepEqual((await saved(single)).split_weights, { [userA]: 2 });

    stage = "負担参加者失効のBLOCKED・割合保持";
    const unavailableShare = (await mutate(workspaceId, "create", null, baseConfig())).payment;
    // Model a previously enabled participant becoming unavailable, without
    // enabling or altering any existing account in the isolated database.
    await sql`UPDATE recurring_payments SET split_weights = ${JSON.stringify({ [userA]: 1, [userB]: 1 })}::jsonb
      WHERE id = ${unavailableShare.id}::uuid`;
    const shareResult = await generate(workspaceId, unavailableShare, "2026-10-27");
    assert.equal(shareResult.status, "blocked");
    assert.equal(shareResult.errorCode, "SPLIT_USER_UNAVAILABLE");
    const shareSaved = await saved(unavailableShare);
    assert.deepEqual(shareSaved.split_weights, { [userA]: 1, [userB]: 1 });
    assert.equal(shareSaved.last_generated_month, null);
    assert.equal(await count(workspaceId, unavailableShare), 0);

    stage = "利用失効のBLOCKEDと再開確認";
    const disabled = (await mutate(workspaceId, "create", null, baseConfig())).payment;
    await sql`UPDATE app_users SET is_enabled = false WHERE id = ${userA}`;
    assert.equal((await generate(workspaceId, disabled, "2026-10-27")).status, "blocked");
    assert.equal((await saved(disabled)).state, "BLOCKED");
    assert.equal(await count(workspaceId, disabled), 0);
    await sql`UPDATE app_users SET is_enabled = true WHERE id = ${userA}`;
    const resumed = (await mutate(workspaceId, "resume", await saved(disabled), null, "2026-10-27")).payment;
    assert.equal(resumed.state, "ACTIVE");
    assert.equal(String(resumed.next_scheduled_on), "2026-11-27");
    assert.equal((await generate(workspaceId, resumed, "2026-10-27")).status, "skipped");
    assert.equal((await generate(workspaceId, resumed, "2026-11-27")).status, "created");

    stage = "workspace削除のCASCADE";
    await sql`DELETE FROM workspaces WHERE id = ${singleWorkspace}::uuid`;
    const children = await sql`SELECT
      (SELECT count(*) FROM recurring_payments WHERE workspace_id = ${singleWorkspace}::uuid)::integer AS payments,
      (SELECT count(*) FROM transactions WHERE workspace_id = ${singleWorkspace}::uuid)::integer AS entries`;
    assert.equal(Number(children[0].payments), 0);
    assert.equal(Number(children[0].entries), 0);

    console.log("定期支払いの実DB回帰: 認可、競合、原子性、日付、状態遷移、失効、CASCADE を確認しました。");
  } finally {
    try {
      // IDs were generated for this invocation; existing seed data is untouched.
      for (const id of workspaces) await sql`DELETE FROM workspaces WHERE id = ${id}::uuid AND name = ${fixture}`;
      for (const id of users) await sql`DELETE FROM app_users WHERE id = ${id} AND email = ${`${id}@example.invalid`}`;
      console.log("実DB回帰で作成した利用者・ワークスペースを削除しました。");
    } catch {
      cleanupFailed = true;
      console.error("実DB回帰の後片付けに失敗しました。対象はこの実行で作成した fixture のみです。");
    }
  }
}

void main().catch((error: unknown) => {
  // Database errors can embed connection details; never print the raw error.
  console.error(`定期支払いの実DB回帰に失敗しました（${stage}）。接続情報・DBエラー本文は表示しません。`);
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z0-9_]{3,48}$/.test(code)) console.error(`固定エラーコード: ${code}`);
  process.exitCode = 1;
}).finally(() => {
  if (cleanupFailed) process.exitCode = 1;
});

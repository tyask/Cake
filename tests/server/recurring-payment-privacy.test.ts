import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neonConfig } from "@neondatabase/serverless";
import { recurringPaymentStore } from "../../lib/server/stores/recurring-payment-store";
import { createRecurringPaymentService, RecurringPaymentError } from "../../lib/server/services/recurring-payments";
import type { RecurringPaymentConfig } from "../../lib/shared/recurring-payment-types";

// Exercise production SQL through the Neon adapter, without a remote database.
test("個人の定期支払いは支払者本人だけに一覧・編集・手動生成を許可する", async t => {
  const memory = new PGlite({ extensions: { pgcrypto } });
  t.after(() => memory.close());
  const migrations = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    await memory.exec(await readFile(new URL(name, migrations), "utf8"));
  }
  await memory.exec("UPDATE app_users SET is_enabled=false");
  await memory.exec(`INSERT INTO app_users(id,email,name,is_enabled) VALUES
    ('a','a@example.test','A',true),('b','b@example.test','B',true)`);
  const workspaceId = randomUUID();
  await memory.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES($1,'共有家計','SHARED','a')", [workspaceId]);
  await memory.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,'a','OWNER'),($1,'b','MEMBER')", [workspaceId]);
  const previous = { url: process.env.DATABASE_URL, fetch: neonConfig.fetchFunction, logging: process.env.DB_QUERY_LOG };
  process.env.DATABASE_URL = "postgresql://fixture:fixture@mock.neon.tech/recurring_privacy";
  process.env.DB_QUERY_LOG = "off";
  t.after(() => {
    neonConfig.fetchFunction = previous.fetch;
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
    if (previous.logging === undefined) delete process.env.DB_QUERY_LOG; else process.env.DB_QUERY_LOG = previous.logging;
  });
  neonConfig.fetchFunction = async (_url: RequestInfo | URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; params: string[] };
    try {
      const result = await memory.query<Record<string, unknown>>(body.query, body.params);
      return Response.json({ fields: result.fields, rows: result.rows.map(row => result.fields.map(field => {
        const value = row[field.name];
        return value == null ? null : field.dataTypeID === 16 ? value ? "t" : "f"
          : typeof value === "object" ? JSON.stringify(value) : String(value);
      })) });
    } catch (error) {
      return Response.json({ message: (error as Error).message, code: (error as { code: string }).code }, { status: 400 });
    }
  };
  const service = createRecurringPaymentService(recurringPaymentStore, { testMode: () => false });
  const savedAt = new Date("2026-10-10T08:59:00+09:00"), runAt = new Date("2026-10-10T09:00:00+09:00");
  const config = (actorUserId: string, expenseClass: "SHARED" | "PERSONAL", merchant: string): RecurringPaymentConfig => ({
    dayOfMonth: 10, merchant, method: "口座振替", amountYen: 1200, actorUserId, expenseClass,
    splitWeights: expenseClass === "SHARED" ? { a: 1, b: 1 } : { a: actorUserId === "a" ? 1 : 0, b: actorUserId === "b" ? 1 : 0 }, memo: `${merchant}の非公開メモ`,
  });
  const sharedA = (await service.mutateRecurringPayment("a", { action: "create", workspaceId, ...config("a", "SHARED", "共有A") }, savedAt)).payment;
  const sharedB = (await service.mutateRecurringPayment("a", { action: "create", workspaceId, ...config("b", "SHARED", "共有B") }, savedAt)).payment;
  const personalA = (await service.mutateRecurringPayment("a", { action: "create", workspaceId, ...config("a", "PERSONAL", "A専用") }, savedAt)).payment;
  const personalB = (await service.mutateRecurringPayment("b", { action: "create", workspaceId, ...config("b", "PERSONAL", "B専用") }, savedAt)).payment;
  // A historical setting can have a different creator/authorizer; ownership is still the actor.
  await memory.query("UPDATE recurring_payments SET authorized_by='a',created_by='a' WHERE id=$1", [personalB.id]);
  const snapshot = async () => (await memory.query(`SELECT jsonb_build_object(
    'workspace',(SELECT to_jsonb(w) FROM workspaces w WHERE id=$1),
    'settings',(SELECT jsonb_agg(p ORDER BY p.id) FROM recurring_payments p WHERE p.workspace_id=$1),
    'transactions',(SELECT jsonb_agg(tr ORDER BY tr.id) FROM transactions tr WHERE tr.workspace_id=$1)) AS data`, [workspaceId])).rows;
  const status = (expected: number) => (error: unknown) => error instanceof RecurringPaymentError && error.status === expected;

  await t.test("共有設定は双方に、個人設定は作成者ではなく支払者本人だけに返す", async () => {
    for (const [userId, own, hidden] of [["a", personalA, personalB], ["b", personalB, personalA]] as const) {
      const listed = await service.listRecurringPayments(workspaceId, userId, savedAt);
      assert.deepEqual(listed.payments.map(payment => payment.id).sort(), [sharedA.id, sharedB.id, own.id].sort());
      assert.doesNotMatch(JSON.stringify(listed), new RegExp(hidden.currentConfig.merchant));
    }
  });

  await t.test("相手の個人設定はrevision・状態・更新内容によらず不存在と同じ404で全体rollback", async () => {
    const before = await snapshot();
    for (const id of [personalB.id, randomUUID()]) {
      for (const action of ["pause", "resume", "archive", "update"] as const) {
        for (const expectedRevision of [1, 999]) {
          await assert.rejects(service.mutateRecurringPayment("a", {
            action, workspaceId, paymentId: id, expectedRevision,
            ...(action === "update" ? config("a", "SHARED", "書き換え") : {}),
          }, savedAt), status(404));
          assert.deepEqual(await snapshot(), before);
        }
      }
    }
  });

  await t.test("他人を担当者にした個人設定の作成・共有からの変更を拒否し、本人の更新は許可", async () => {
    const before = await snapshot();
    await assert.rejects(service.mutateRecurringPayment("a", { action: "create", workspaceId, ...config("b", "PERSONAL", "無断作成") }, savedAt), status(400));
    await assert.rejects(service.mutateRecurringPayment("a", {
      action: "update", workspaceId, paymentId: sharedB.id, expectedRevision: sharedB.revision, ...config("b", "PERSONAL", "無断変更"),
    }, savedAt), status(400));
    assert.deepEqual(await snapshot(), before);
    const updated = await service.mutateRecurringPayment("b", {
      action: "update", workspaceId, paymentId: personalB.id, expectedRevision: personalB.revision, ...config("b", "PERSONAL", "B専用更新"),
    }, savedAt);
    assert.equal(updated.payment.currentConfig.merchant, "B専用更新");
    assert.equal(updated.payment.authorizedById, "b");
  });

  await t.test("手動実行は相手の個人設定を候補件数にも含めず生成せず、Cronは残りを生成", async () => {
    const hiddenBefore = (await memory.query("SELECT to_jsonb(p) AS data FROM recurring_payments p WHERE id=$1", [personalB.id])).rows;
    const result = await service.runRecurringPayments({ workspaceId, authorizedUserId: "a", now: runAt, logger: () => {} });
    assert.deepEqual({ ...result, runId: "ignored" }, { runId: "ignored", candidates: 3, created: 3, skipped: 0, failed: 0, unprocessed: 0 });
    assert.deepEqual((await memory.query("SELECT to_jsonb(p) AS data FROM recurring_payments p WHERE id=$1", [personalB.id])).rows, hiddenBefore);
    assert.equal((await memory.query("SELECT id FROM transactions WHERE expense_class='PERSONAL' AND actor_user_id='b'")).rows.length, 0);
    const cron = await service.runRecurringPayments({ now: runAt, logger: () => {} });
    assert.equal(cron.candidates, 1);
    assert.equal(cron.created, 1);
    assert.equal((await memory.query("SELECT id FROM transactions WHERE expense_class='PERSONAL' AND actor_user_id='b'")).rows.length, 1);
  });

  await t.test("候補抽出後に相手個人へ変わった設定は生成直前のロック内で再判定する", async () => {
    const raced = (await service.mutateRecurringPayment("b", { action: "create", workspaceId, ...config("b", "SHARED", "競合設定") }, savedAt)).payment;
    const candidates = await recurringPaymentStore.candidates(workspaceId, false, runAt, "a");
    const candidate = candidates.find(item => item.id === raced.id)!;
    assert.ok(candidate);
    await service.mutateRecurringPayment("b", { action: "update", workspaceId, paymentId: raced.id, expectedRevision: raced.revision,
      ...config("b", "PERSONAL", "B非公開競合") }, savedAt);
    const before = await snapshot();
    assert.deepEqual(await recurringPaymentStore.generate(candidate, false, runAt, "a"), { status: "skipped" });
    assert.deepEqual(await snapshot(), before);
    assert.ok(!(await recurringPaymentStore.candidates(workspaceId, false, runAt, "a")).some(item => item.id === raced.id));
  });

  await t.test("候補抽出・生成は最新の所属と有効利用者を確認する", async () => {
    await memory.query("UPDATE app_users SET is_enabled=false WHERE id='a'");
    assert.deepEqual(await recurringPaymentStore.candidates(workspaceId, false, runAt, "a"), []);
    await assert.rejects(recurringPaymentStore.generate({ id: sharedA.id, workspaceId }, false, runAt, "a"), (error: unknown) => (error as { code: string }).code === "P0403");
    await memory.query("UPDATE app_users SET is_enabled=true WHERE id='a'");
    await memory.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='b'", [workspaceId]);
    assert.deepEqual(await recurringPaymentStore.candidates(workspaceId, false, runAt, "b"), []);
    await assert.rejects(service.mutateRecurringPayment("b", { action: "pause", workspaceId, paymentId: personalB.id, expectedRevision: 2 }, savedAt), status(403));
  });
});

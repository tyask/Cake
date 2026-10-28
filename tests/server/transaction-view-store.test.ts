import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neonConfig } from "@neondatabase/serverless";
import { findTransactionView } from "../../lib/server/stores/transaction-view-store";
import { UserAccessError } from "../../lib/server/errors";
import type { TransactionViewSelection } from "../../lib/shared/transaction-view";

test("明細SQLは月と全期間未精算の取得範囲・最新認可を1snapshotで保証する", async t => {
  const memory = new PGlite({ extensions: { pgcrypto } });
  t.after(() => memory.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
    await memory.exec(await readFile(new URL(name, directory), "utf8"));
  }
  await memory.exec("UPDATE app_users SET is_enabled=false");
  await memory.exec(`INSERT INTO app_users(id,email,name,is_enabled) VALUES
    ('a','a@example.test','A',true),('b','b@example.test','B',true),('outside','outside@example.test','外部',false)`);
  const workspaceId = randomUUID(), otherWorkspaceId = randomUUID();
  await memory.query(`INSERT INTO workspaces(id,name,type,owner_user_id)
    VALUES ($1,'対象家計','SHARED','a'),($2,'別家計','PERSONAL','outside')`, [workspaceId, otherWorkspaceId]);
  await memory.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES
    ($1,'a','OWNER'),($1,'b','MEMBER'),($2,'outside','OWNER')`, [workspaceId, otherWorkspaceId]);
  const insert = async (options: { id?: string; workspace?: string; actor?: string; occurredAt?: string;
    createdAt?: string; type?: string; expenseClass?: string; settled?: boolean } = {}) => {
    const id = options.id ?? randomUUID(), actor = options.actor ?? "a";
    const workspace = options.workspace ?? workspaceId, expenseClass = options.expenseClass ?? "SHARED";
    const weights = workspace === otherWorkspaceId ? { outside: 1 } : expenseClass === "PERSONAL"
      ? { a: actor === "a" ? 1 : 0, b: actor === "b" ? 1 : 0 } : { a: 1, b: 2 };
    await memory.query(`INSERT INTO transactions(id,workspace_id,occurred_at,created_at,merchant,
      method,type,amount_yen,actor_user_id,expense_class,split_weights,external_id,source,created_by,updated_by,memo,settled_at)
      VALUES ($1::uuid,$2,$3,$4,'対象取引先','現金',$5,1200,$6,$7,$8::jsonb,
        $1::text,'MANUAL',$6,$6,'明細メモ',$9)`,
    [id, workspace, options.occurredAt ?? "2026-10-12T00:00:00.123456Z",
      options.createdAt ?? "2026-10-12T00:00:00.123456Z", options.type ?? "PAYMENT", actor,
      expenseClass, JSON.stringify(weights), options.settled ? "2026-10-13T00:00:00.123Z" : null]);
    return id;
  };
  const monthIds = [await insert({ occurredAt: "2026-09-30T15:00:00Z" }),
    await insert({ occurredAt: "2026-10-31T14:59:59.999999Z" }),
    await insert({ type: "RECEIPT" }), await insert({ settled: true }),
    await insert({ expenseClass: "PERSONAL" }), await insert({ expenseClass: "PERSONAL", actor: "b" }),
    await insert({ occurredAt: "2026-10-30T00:00:00Z", type: "RECEIPT", settled: true })];
  const orderedIds = [await insert({ id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-10-12T00:00:00.123455Z" }),
    await insert({ id: "00000000-0000-4000-8000-000000000002" }),
    await insert({ id: "00000000-0000-4000-8000-000000000003" })];
  const outsideMonthIds = [await insert({ occurredAt: "2026-09-30T14:59:59.999999Z" }),
    await insert({ occurredAt: "2026-10-31T15:00:00Z", type: "RECEIPT" }),
    await insert({ occurredAt: "2025-01-01T00:00:00Z" }), await insert({ occurredAt: "2099-01-01T00:00:00Z" })];
  await insert({ workspace: otherWorkspaceId, actor: "outside" });
  const firstYearId = await insert({ occurredAt: "0001-01-01T00:00:00Z" });
  const historicBoundaryId = await insert({ occurredAt: "0001-01-31T15:00:00Z" });
  const historicPreviousId = await insert({ occurredAt: "0001-01-31T14:59:59.999999Z" });
  const lastYearId = await insert({ occurredAt: "9999-12-31T14:59:59.999999Z" });
  const afterLastYearId = await insert({ occurredAt: "9999-12-31T15:00:00Z" });

  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  process.env.DATABASE_URL = "postgresql://fixture:fixture@mock.neon.tech/transaction_view";
  process.env.DB_QUERY_LOG = "off";
  t.after(() => {
    neonConfig.fetchFunction = previous.fetch;
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
    if (previous.logging === undefined) delete process.env.DB_QUERY_LOG; else process.env.DB_QUERY_LOG = previous.logging;
  });
  const queries: { query: string; params: string[] }[] = [];
  neonConfig.fetchFunction = async (_url: RequestInfo | URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; params: string[] };
    queries.push(body);
    const result = await memory.query<Record<string, unknown>>(body.query, body.params);
    return Response.json({ fields: result.fields, rows: result.rows.map(row => result.fields.map(field => {
      const value = row[field.name];
      return value == null ? null : typeof value === "object" ? JSON.stringify(value) : String(value);
    })) });
  };
  const read = async (selection: TransactionViewSelection | { mode: "unsettled"; month?: string } = { mode: "month", month: "2026-10" }, user = "a", target = workspaceId) => {
    const start = queries.length;
    const result = await findTransactionView(target, user, selection);
    assert.equal(queries.length - start, 1, "認可と対象明細を固定1SQLで取得する");
    return result;
  };

  await t.test("月のJST境界と支払い・収入・個人・共有・清算済み・未来日付を含める", async () => {
    const result = await read();
    assert.equal(result.workspaceId, workspaceId);
    assert.equal(result.mode, "month");
    assert.equal(result.month, "2026-10");
    assert.deepEqual(new Set(result.transactions.map(item => item.id)), new Set([...monthIds, ...orderedIds]));
    assert.equal(result.transactions[0].id, monthIds[1]);
    assert.equal(result.transactions.at(-1)!.id, monthIds[0]);
    assert.deepEqual(result.transactions.filter(item => orderedIds.includes(item.id)).map(item => item.id), [...orderedIds].reverse());
    const personal = result.transactions.find(item => item.id === monthIds[5])!;
    assert.equal(personal.actorName, "B");
    assert.equal(personal.memo, "明細メモ");
    assert.deepEqual(personal.splitWeights, { a: 0, b: 1 });
    assert.equal(result.transactions.find(item => item.id === monthIds[3])!.settledAt, "2026-10-13T00:00:00.123Z");
    assert.deepEqual((await read(undefined, "b")).transactions, result.transactions, "他参加者の個人明細も同じ閲覧範囲");
  });

  await t.test("未精算は月制限を外し、個人と清算済みを除く共有の支払い・収入を取得する", async () => {
    const result = await read({ mode: "unsettled" });
    assert.equal(result.mode, "unsettled");
    assert.equal(result.month, null);
    assert.deepEqual(new Set(result.transactions.map(item => item.id)), new Set([
      monthIds[0], monthIds[1], monthIds[2], ...orderedIds, ...outsideMonthIds,
      firstYearId, historicBoundaryId, historicPreviousId, lastYearId, afterLastYearId,
    ]));
    assert.ok(result.transactions.every(item => item.expenseClass === "SHARED" && item.settledAt === null));
    assert.deepEqual((await read({ mode: "unsettled", month: "2026-10" })).transactions, result.transactions);
  });

  await t.test("0001年・9999年の端と歴史的日時もホームと同じ固定UTC+9で判定する", async () => {
    assert.deepEqual(new Set((await read({ mode: "month", month: "0001-01" })).transactions.map(item => item.id)),
      new Set([firstYearId, historicPreviousId]));
    assert.deepEqual((await read({ mode: "month", month: "0001-02" })).transactions.map(item => item.id), [historicBoundaryId]);
    assert.deepEqual((await read({ mode: "month", month: "9999-12" })).transactions.map(item => item.id), [lastYearId]);
  });

  await t.test("空月は空配列を返し、非所属・不在・利用停止は認可エラーにする", async () => {
    assert.deepEqual((await read({ mode: "month", month: "2026-08" })).transactions, []);
    for (const [user, target, status] of [["outside", workspaceId, 401], ["a", otherWorkspaceId, 403],
      ["a", randomUUID(), 403], ["missing", workspaceId, 401]] as const) {
      await assert.rejects(read(undefined, user, target), error => error instanceof UserAccessError && error.status === status);
    }
    await memory.exec("UPDATE app_users SET is_enabled=false WHERE id='b'");
    await assert.rejects(read(undefined, "b"), error => error instanceof UserAccessError && error.status === 401);
    await memory.exec("UPDATE app_users SET is_enabled=true WHERE id='b'");
    await memory.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='b'", [workspaceId]);
    await assert.rejects(read(undefined, "b"), error => error instanceof UserAccessError && error.status === 403);
  });

  await t.test("READ ONLYで動作し、明細・家計を更新しない", async () => {
    const snapshot = async () => (await memory.query(`SELECT jsonb_build_object(
      'transactions',(SELECT jsonb_agg(t ORDER BY id) FROM transactions t),
      'workspaces',(SELECT jsonb_agg(w ORDER BY id) FROM workspaces w)) AS data`)).rows;
    const before = await snapshot();
    await memory.exec("BEGIN READ ONLY");
    try { await read(); await read({ mode: "unsettled" }); } finally { await memory.exec("ROLLBACK"); }
    assert.deepEqual(await snapshot(), before);
  });
});

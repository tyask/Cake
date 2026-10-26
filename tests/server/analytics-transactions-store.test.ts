import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neonConfig } from "@neondatabase/serverless";
import { findAnalyticsTransactions } from "../../lib/server/stores/analytics-transactions-store";
import { UserAccessError } from "../../lib/server/errors";

test("集計明細SQLは日本時間の期間・本人の公開範囲・安定順・最新認可を一つのsnapshotで保証する", async t => {
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
  await memory.query(`INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES
    ($1,'b','MEMBER','2026-01-01T00:00Z'),($1,'a','OWNER','2026-01-01T00:00Z'),
    ($2,'outside','OWNER','2026-01-01T00:00Z')`, [workspaceId, otherWorkspaceId]);
  const parentId = randomUUID(), childId = randomUUID(), foreignCategoryId = randomUUID();
  await memory.query(`INSERT INTO categories(id,workspace_id,parent_id,name,color_hex,sort_order,created_by,updated_by)
    VALUES ($1,$4,NULL,'暮らし','#f97316',0,'a','a'),($2,$4,$1,'食品','#22c55e',1,'a','a'),
      ($3,$5,NULL,'別家計カテゴリ','#000000',0,'outside','outside')`,
  [parentId, childId, foreignCategoryId, workspaceId, otherWorkspaceId]);
  const insert = async (options: { id?: string; workspace?: string; actor?: string; occurredAt?: string;
    createdAt?: string; category?: string | null; type?: string; expenseClass?: string; settled?: boolean } = {}) => {
    const id = options.id ?? randomUUID(), actor = options.actor ?? "a";
    const workspace = options.workspace ?? workspaceId;
    const expenseClass = options.expenseClass ?? "SHARED";
    const weights = workspace === otherWorkspaceId ? { outside: 1 } : expenseClass === "PERSONAL"
      ? { a: actor === "a" ? 1 : 0, b: actor === "b" ? 1 : 0 } : { a: 1, b: 2 };
    await memory.query(`INSERT INTO transactions(id,workspace_id,occurred_at,created_at,merchant,
      method,type,amount_yen,actor_user_id,expense_class,split_weights,external_id,source,created_by,updated_by,category_id,memo,settled_at)
      VALUES ($1::uuid,$2,$3,$4,'対象取引先','現金',$5,1200,$6,$7,$8::jsonb,
        $1::text,'MANUAL',$6,$6,$9,'明細メモ',$10)`,
    [id, workspace, options.occurredAt ?? "2026-10-12T00:00:00.123456Z",
      options.createdAt ?? "2026-10-12T00:00:00.123456Z", options.type ?? "PAYMENT", actor,
      expenseClass, JSON.stringify(weights), options.category === undefined ? childId : options.category,
      options.settled ? "2026-10-13T00:00:00.123Z" : null]);
    return id;
  };
  const period = { from: "2026-10-01", to: "2026-10-23" };
  const startId = await insert({ occurredAt: "2026-09-30T15:00:00Z" });
  const orderedIds: string[] = [];
  orderedIds.push(await insert({ occurredAt: "2026-10-12T00:00:00.123455Z" }));
  orderedIds.push(await insert({ createdAt: "2026-10-12T00:00:00.123455Z" }));
  orderedIds.push(await insert({ id: "00000000-0000-4000-8000-000000000001" }));
  orderedIds.push(await insert({ id: "00000000-0000-4000-8000-000000000002", settled: true, actor: "b" }));
  const personalId = await insert({ expenseClass: "PERSONAL", category: null });
  const endId = await insert({ occurredAt: "2026-10-23T14:59:59.999999Z" });
  await insert({ occurredAt: "2026-09-30T14:59:59.999999Z" });
  await insert({ occurredAt: "2026-10-23T15:00:00Z" });
  const privateId = await insert({ actor: "b", expenseClass: "PERSONAL" });
  await insert({ type: "RECEIPT" });
  await insert({ workspace: otherWorkspaceId, actor: "outside", category: foreignCategoryId });
  await memory.query("UPDATE categories SET archived_at='2026-10-01T00:00:00.123Z' WHERE id=$1", [childId]);

  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  process.env.DATABASE_URL = "postgresql://fixture:fixture@mock.neon.tech/analytics_transactions";
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
  const read = async (user = "a", target = workspaceId, range = period) => {
    const start = queries.length;
    const result = await findAnalyticsTransactions(target, user, range);
    assert.equal(queries.length - start, 1, "認可・現在期間の明細・metadataを固定1SQLで取得");
    return result;
  };

  await t.test("JSTの両端と支払いだけを抽出し、清算済み・現在カテゴリ・保存割合を返す", async () => {
    const result = await read();
    assert.equal(result.workspaceId, workspaceId);
    assert.deepEqual(result.period, period);
    assert.match(result.snapshotAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    assert.deepEqual(new Set(result.transactions.map(item => item.id)), new Set([startId, ...orderedIds, personalId, endId]));
    assert.equal(result.transactions[0].id, endId);
    assert.equal(result.transactions.at(-1)!.id, startId);
    assert.deepEqual(result.transactions.filter(item => orderedIds.includes(item.id)).map(item => item.id), [...orderedIds].reverse());
    const settled = result.transactions.find(item => item.id === orderedIds.at(-1))!;
    assert.equal(settled.actorName, "B");
    assert.equal(settled.settledAt, "2026-10-13T00:00:00.123Z");
    assert.equal(settled.memo, "明細メモ");
    assert.deepEqual(settled.splitWeights, { a: 1, b: 2 });
    assert.deepEqual(result.members.map(item => item.id), ["a", "b"], "参加日時同率はID順");
    assert.deepEqual(result.categories.map(item => item.id), [parentId, childId]);
    assert.equal(result.categories[1].parentId, parentId);
    assert.equal(result.categories[1].archivedAt, "2026-10-01T00:00:00.123Z");
  });

  await t.test("本人個人費だけを公開し、相手へ切り替えると公開対象を入れ替える", async () => {
    const own = await read(), other = await read("b");
    assert.ok(own.transactions.some(item => item.id === personalId));
    assert.ok(own.transactions.every(item => item.id !== privateId));
    assert.ok(other.transactions.some(item => item.id === privateId));
    assert.ok(other.transactions.every(item => item.id !== personalId));
  });

  await t.test("有効な空期間はmetadataを保持し、非所属・不在・利用停止を明細なしと区別する", async () => {
    const empty = await read("a", workspaceId, { from: "2026-08-01", to: "2026-08-31" });
    assert.deepEqual(empty.transactions, []);
    assert.equal(empty.categories.length, 2);
    for (const [user, target, status] of [["outside", workspaceId, 401], ["a", otherWorkspaceId, 403],
      ["a", randomUUID(), 403], ["missing", workspaceId, 401]] as const) {
      await assert.rejects(read(user, target), error => error instanceof UserAccessError && error.status === status);
    }
    await memory.exec("UPDATE app_users SET is_enabled=false WHERE id='b'");
    await assert.rejects(read("b"), error => error instanceof UserAccessError && error.status === 401);
    await memory.exec("UPDATE app_users SET is_enabled=true WHERE id='b'");
    await memory.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='b'", [workspaceId]);
    await assert.rejects(read("b"), error => error instanceof UserAccessError && error.status === 403);
  });

  await t.test("READ ONLY transactionで動作し、現在値の照会で保存データを更新しない", async () => {
    const snapshot = async () => (await memory.query(`SELECT jsonb_build_object(
      'transactions',(SELECT jsonb_agg(t ORDER BY id) FROM transactions t),
      'categories',(SELECT jsonb_agg(c ORDER BY id) FROM categories c),
      'workspaces',(SELECT jsonb_agg(w ORDER BY id) FROM workspaces w)) AS data`)).rows;
    const before = await snapshot();
    await memory.exec("BEGIN READ ONLY");
    try { await read(); } finally { await memory.exec("ROLLBACK"); }
    assert.deepEqual(await snapshot(), before);
  });
});

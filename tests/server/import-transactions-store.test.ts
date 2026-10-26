import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neonConfig } from "@neondatabase/serverless";
import { findImportTransactions } from "../../lib/server/stores/import-transactions-store";

test("取込回の明細SQLは現在値・家計とbatch境界・空履歴・安定順・カテゴリ・所属を保証する", async t => {
  const memory = new PGlite({ extensions: { pgcrypto } });
  t.after(() => memory.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
    await memory.exec(await readFile(new URL(name, directory), "utf8"));
  }
  await memory.exec(`INSERT INTO app_users(id,email,name) VALUES
    ('a','a@example.test','A'),('b','b@example.test','B'),('outside','outside@example.test','外部利用者')`);
  const workspaceId = randomUUID(), otherWorkspaceId = randomUUID();
  await memory.query(`INSERT INTO workspaces(id,name,type,owner_user_id)
    VALUES ($1,'取込回の明細','SHARED','a'),($2,'別家計','PERSONAL','outside')`, [workspaceId, otherWorkspaceId]);
  await memory.query(`INSERT INTO workspace_members(workspace_id,user_id,role)
    VALUES ($1,'a','OWNER'),($1,'b','MEMBER'),($2,'outside','OWNER')`, [workspaceId, otherWorkspaceId]);
  const batchId = randomUUID(), sameFileBatchId = randomUUID(), emptyBatchId = randomUUID(), otherBatchId = randomUUID();
  for (const [id, workspace, user, imported] of [
    [batchId, workspaceId, "a", 6], [sameFileBatchId, workspaceId, "b", 1],
    [emptyBatchId, workspaceId, "a", 0], [otherBatchId, otherWorkspaceId, "outside", 1],
  ] as const) {
    await memory.query(`INSERT INTO import_batches(id,workspace_id,imported_by,file_name,total_rows,imported_rows,skipped_rows)
      VALUES ($1,$2,$3,'同名.csv',6,$4,6-$4)`, [id, workspace, user, imported]);
  }
  const parentId = randomUUID(), childId = randomUUID(), archivedId = randomUUID(), foreignCategoryId = randomUUID();
  await memory.query(`INSERT INTO categories(id,workspace_id,parent_id,name,color_hex,sort_order,created_by,updated_by)
    VALUES ($1,$5,NULL,'暮らし','#f97316',0,'a','a'),($2,$5,$1,'食品','#22c55e',1,'a','a'),
      ($3,$5,NULL,'未使用の旧カテゴリ','#888888',2,'a','a'),($4,$6,NULL,'別家計カテゴリ','#000000',0,'outside','outside')`,
  [parentId, childId, archivedId, foreignCategoryId, workspaceId, otherWorkspaceId]);
  await memory.query("UPDATE categories SET archived_at='2026-10-01T00:00:00.123Z' WHERE id=$1", [archivedId]);

  const insert = async (options: { id?: string; workspace?: string; batch?: string | null; actor?: string;
    occurredAt?: string; createdAt?: string; category?: string | null } = {}) => {
    const id = options.id ?? randomUUID(), actor = options.actor ?? "a";
    await memory.query(`INSERT INTO transactions(id,workspace_id,import_batch_id,occurred_at,created_at,merchant,
      method,type,amount_yen,actor_user_id,expense_class,split_weights,external_id,source,created_by,updated_by,category_id,memo)
      VALUES ($1::uuid,$2,$3,$4,$5,'取込先','PayPay残高','PAYMENT',1200,$6,'PERSONAL',jsonb_build_object($6::text,1),
        $1::text,'PAYPAY',$6,$6,$7,'取込時メモ')`,
    [id, options.workspace ?? workspaceId, options.batch === undefined ? batchId : options.batch,
      options.occurredAt ?? "2026-10-25T00:00:00.123456Z", options.createdAt ?? "2026-10-20T00:00:00.123456Z",
      actor, options.category === undefined ? childId : options.category]);
    return id;
  };
  const ids: string[] = [];
  ids.push(await insert({ occurredAt: "2026-10-25T00:00:00.123455Z" }));
  ids.push(await insert({ createdAt: "2026-10-20T00:00:00.123455Z" }));
  ids.push(await insert({ id: "00000000-0000-4000-8000-000000000001" }));
  ids.push(await insert({ id: "00000000-0000-4000-8000-000000000002" }));
  ids.push(await insert({ occurredAt: "2026-10-26T00:00:00.123Z" }));
  const sameFileId = await insert({ batch: sameFileBatchId, actor: "b" });
  await insert({ actor: "b" }); // 本人の取込回に旧版が保存した相手個人費も非公開。
  await insert({ batch: null });
  await insert({ workspace: otherWorkspaceId, batch: otherBatchId, actor: "outside", category: foreignCategoryId });
  // The existing FK references only the batch ID. Defend against legacy/corrupt
  // cross-workspace links as well as ordinary other-batch rows.
  await insert({ workspace: otherWorkspaceId, batch: batchId, actor: "outside", category: foreignCategoryId });

  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  process.env.DATABASE_URL = "postgresql://fixture:fixture@mock.neon.tech/import_transactions";
  process.env.DB_QUERY_LOG = "off";
  t.after(() => {
    neonConfig.fetchFunction = previous.fetch;
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
    if (previous.logging === undefined) delete process.env.DB_QUERY_LOG; else process.env.DB_QUERY_LOG = previous.logging;
  });
  const queries: { query: string; params: string[] }[] = [];
  let beforeDetails: (() => Promise<unknown>) | undefined;
  neonConfig.fetchFunction = async (_url: RequestInfo | URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; params: string[] };
    queries.push(body);
    if (body.query.includes("WITH selected_batch")) {
      const hook = beforeDetails; beforeDetails = undefined;
      await hook?.();
    }
    const result = await memory.query<Record<string, unknown>>(body.query, body.params);
    return Response.json({ fields: result.fields, rows: result.rows.map(row => result.fields.map(field => {
      const value = row[field.name];
      return value == null ? null : typeof value === "object" ? JSON.stringify(value) : String(value);
    })) });
  };
  const details = async (batch = batchId, user = "a", workspace = workspaceId) => {
    const before = queries.length;
    const result = await findImportTransactions(workspace, user, "PAYPAY", batch);
    assert.equal(queries.length - before, 2, "所属確認と明細・カテゴリ取得の固定2往復");
    return result;
  };

  await t.test("filenameではなくbatch IDで照会し、日時精度・UUIDまで使って安定順を決める", async () => {
    const result = (await details())!;
    assert.deepEqual(result.transactions.map(row => row.id), [...ids].reverse());
    assert.ok(result.transactions.every(row => row.actorUserId === "a" && row.actorName === "A"));
    assert.equal(result.transactions[0].occurredAt, "2026-10-26T00:00:00.123Z");
    assert.deepEqual(result.transactions[0].splitWeights, { a: 1, b: 0 });
    assert.equal(result.transactions[0].source, "PAYPAY");
    assert.equal(await details(sameFileBatchId), null, "相手の取込回をIDで指定しても取得できない");
    assert.deepEqual((await details(sameFileBatchId, "b"))!.transactions.map(row => row.id), [sameFileId]);
    assert.equal(await details(batchId, "b"), null, "本人以外には取込回の存在を公開しない");
    assert.deepEqual(result.categories.map(category => category.id), [parentId, childId, archivedId]);
    assert.equal(result.categories.find(category => category.id === archivedId)!.archivedAt, "2026-10-01T00:00:00.123Z");
    assert.ok(result.categories.every(category => category.id !== foreignCategoryId));
  });

  await t.test("編集後の金額・メモ・支払方法・清算状態・現在のカテゴリ情報を返す", async () => {
    const id = ids.at(-1)!;
    await memory.query(`UPDATE transactions SET amount_yen=3456,memo='編集後メモ',method='編集後の方法',
      merchant='編集後の取引先',settled_at='2026-10-27T03:04:05.678Z' WHERE id=$1`, [id]);
    await memory.query("UPDATE app_users SET name='現在のA' WHERE id='a'");
    await memory.query("UPDATE categories SET name='現在の食品',archived_at='2026-10-27T00:00:00Z' WHERE id=$1", [childId]);
    const result = (await details())!, current = result.transactions.find(row => row.id === id)!;
    assert.equal(current.amountYen, 3456);
    assert.equal(current.memo, "編集後メモ");
    assert.equal(current.method, "編集後の方法");
    assert.equal(current.merchant, "編集後の取引先");
    assert.equal(current.settledAt, "2026-10-27T03:04:05.678Z");
    assert.equal(current.actorName, "現在のA");
    assert.equal(current.categoryId, childId);
    assert.equal(current.categoryConfirmed, true);
    assert.equal(current.categoryRevision, 1);
    assert.equal(result.categories.find(category => category.id === childId)!.name, "現在の食品");
    assert.equal(result.categories.find(category => category.id === childId)!.parentId, parentId);
    assert.equal(result.categories.find(category => category.id === childId)!.archivedAt, "2026-10-27T00:00:00.000Z");
  });

  await t.test("有効な0件登録回や全明細削除済みは空配列、不在・別家計・別形式はnullにする", async () => {
    assert.deepEqual((await details(emptyBatchId))!.transactions, [], "他回で登録済みの重複明細を混ぜない");
    assert.equal(await details(randomUUID()), null);
    assert.equal(await details(otherBatchId), null);
    await memory.exec("ALTER TABLE import_batches DROP CONSTRAINT import_batches_format_check");
    const differentFormat = randomUUID();
    try {
      await memory.query(`INSERT INTO import_batches(id,workspace_id,imported_by,file_name,total_rows,imported_rows,skipped_rows,format)
        VALUES ($1,$2,'a','別形式.csv',0,0,0,'OTHER')`, [differentFormat, workspaceId]);
      assert.equal(await details(differentFormat), null);
    } finally {
      await memory.query("DELETE FROM import_batches WHERE id=$1", [differentFormat]);
      await memory.exec("ALTER TABLE import_batches ADD CONSTRAINT import_batches_format_check CHECK(format IN ('PAYPAY'))");
    }
    await memory.query("DELETE FROM transactions WHERE id=ANY($1::uuid[])", [ids]);
    assert.deepEqual((await details())!.transactions, []);
    assert.equal((await details())!.categories.length, 3, "0明細でも同じ家計のカテゴリを返す");
  });

  await t.test("非所属利用者を照会前に拒否し、認可後の脱退競合でも明細・カテゴリを返さない", async () => {
    for (const user of ["outside", "missing"]) {
      const before = queries.length;
      await assert.rejects(findImportTransactions(workspaceId, user, "PAYPAY", sameFileBatchId), /権限がありません/);
      assert.equal(queries.length - before, 1);
    }
    beforeDetails = () => memory.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='b'", [workspaceId]);
    assert.equal(await details(sameFileBatchId, "b"), null);
    const before = queries.length;
    await assert.rejects(findImportTransactions(otherWorkspaceId, "a", "PAYPAY", otherBatchId), /権限がありません/);
    assert.equal(queries.length - before, 1);
  });

  await t.test("明細照会は保存データを変更せず、batch索引を利用できる", async () => {
    const snapshot = async () => (await memory.query(`SELECT jsonb_build_object(
      'transactions',(SELECT jsonb_agg(t ORDER BY id) FROM transactions t),
      'batches',(SELECT jsonb_agg(b ORDER BY id) FROM import_batches b),
      'categories',(SELECT jsonb_agg(c ORDER BY id) FROM categories c),
      'workspaces',(SELECT jsonb_agg(w ORDER BY id) FROM workspaces w)) AS data`)).rows;
    const before = await snapshot();
    await details();
    assert.deepEqual(await snapshot(), before);
    const query = queries.at(-1)!;
    await memory.exec("SET enable_seqscan=off");
    try {
      const plan = await memory.query("EXPLAIN (FORMAT JSON) " + query.query, query.params);
      assert.match(JSON.stringify(plan.rows), /transactions_workspace_import_batch_date_idx/);
    } finally { await memory.exec("RESET enable_seqscan"); }
  });
});

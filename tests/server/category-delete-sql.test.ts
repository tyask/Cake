import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { CategoryDeletion } from "../../lib/shared/category-updates";
import type { Category } from "../../lib/shared/types";

test("カテゴリ削除SQLは子孫と全明細参照を原子的に解除し、清算履歴と他の業務値を維持する", async t => {
  const sql = new PGlite({ extensions: { pgcrypto } });
  t.after(() => sql.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith(".sql")).sort()) {
    await sql.exec(await readFile(new URL(file, directory), "utf8"));
  }
  await sql.exec("INSERT INTO app_users(id,email,name) VALUES ('a','a@example.test','A'),('b','b@example.test','B'),('outside','outside@example.test','Outside')");
  const workspace = randomUUID(), otherWorkspace = randomUUID();
  await sql.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1,'削除テスト','SHARED','a'),($2,'別workspace','PERSONAL','outside')", [workspace, otherWorkspace]);
  await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'a','OWNER'),($1,'b','MEMBER'),($2,'outside','OWNER')", [workspace, otherWorkspace]);
  async function create(name: string, parentId: string | null = null, target = workspace, actor = "a") {
    return (await sql.query<{ result: { category: Category } }>(
      "SELECT cake_mutate_category($1::uuid,$2,'CREATE',NULL,$3::uuid,$4,'#f97316') AS result", [target, actor, parentId, name],
    )).rows[0].result.category;
  }
  async function insert(categoryId: string | null, settled = false) {
    const id = randomUUID();
    await sql.query(`INSERT INTO transactions(id,workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,
      expense_class,split_weights,external_id,created_by,updated_by,memo,category_id,settled_at)
      VALUES ($1,$2,'2026-10-01T01:02:03.456Z','分類済み明細','現金','PAYMENT',1234,'a','SHARED',
        '{"a":1,"b":3}',$1::uuid::text,'a','a','元のメモ',$3,$4::timestamptz)`,
    [id, workspace, categoryId, settled ? "2026-10-02T01:02:03.456Z" : null]);
    return id;
  }
  const remove = async (categoryId: string, actor = "a", target = workspace) => (await sql.query<{ result: CategoryDeletion }>(
    "SELECT cake_delete_category($1::uuid,$2,$3::uuid) AS result", [target, actor, categoryId],
  )).rows[0].result;
  const snapshot = async () => (await sql.query<{ data: unknown }>(`SELECT jsonb_build_object(
    'workspaces',(SELECT jsonb_agg(w ORDER BY id) FROM workspaces w),
    'categories',(SELECT jsonb_agg(c ORDER BY id) FROM categories c),
    'transactions',(SELECT jsonb_agg(t ORDER BY id) FROM transactions t),
    'settlements',(SELECT jsonb_agg(s ORDER BY id) FROM settlements s),
    'links',(SELECT jsonb_agg(st ORDER BY transaction_id) FROM settlement_transactions st)) AS data`)).rows[0].data;
  const root = await create("親"), branch = await create("削除する枝", root.id), untouched = await create("保持する兄弟", root.id);
  const branchIds = [branch.id];
  let deepest = branch;
  for (let index = 0; index < 20; index++) {
    deepest = await create(`子${index}`, deepest.id);
    branchIds.push(deepest.id);
  }
  const archived = await create("過去の停止カテゴリ", branch.id);
  branchIds.push(archived.id);
  const assigned = await insert(branch.id), settled = await insert(deepest.id, true), archivedReference = await insert(archived.id);
  const otherTransaction = await insert(untouched.id), unclassified = await insert(null);
  await sql.query("SELECT cake_mutate_category($1::uuid,'a','ARCHIVE',$2::uuid)", [workspace, archived.id]);
  const foreign = await create("別のカテゴリ", null, otherWorkspace, "outside");
  const settlement = randomUUID();
  await sql.query(`INSERT INTO settlements(id,workspace_id,payer_user_id,payee_user_id,amount_yen,weight_snapshot,calculation_snapshot,completed_by)
    VALUES ($1,$2,'a','b',926,'{"a":1,"b":3}','{"original":true}','a')`, [settlement, workspace]);
  await sql.query("INSERT INTO settlement_transactions(settlement_id,transaction_id) VALUES ($1,$2)", [settlement, settled]);

  await t.test("最新所属・workspace境界・対象の存在を検証し、拒否時は全体を変更しない", async () => {
    await sql.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='b'", [workspace]);
    const before = await snapshot();
    for (const [operation, message] of [
      [() => remove(branch.id, "b"), /権限がありません/],
      [() => remove(branch.id, "outside"), /権限がありません/],
      [() => remove(branch.id, "a", randomUUID()), /権限がありません/],
      [() => remove(foreign.id), /カテゴリが存在しません/],
      [() => remove(randomUUID()), /カテゴリが存在しません/],
    ] as const) {
      await assert.rejects(operation(), message);
      assert.deepEqual(await snapshot(), before);
    }
    await assert.rejects(sql.query("UPDATE transactions SET workspace_id=$1 WHERE id=$2", [otherWorkspace, assigned]), /transactions_category_workspace_fk/);
    assert.deepEqual(await snapshot(), before);
    await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'b','MEMBER')", [workspace]);
  });

  await t.test("子の削除失敗は先行した明細解除・revision・workspace日時もrollbackする", async () => {
    await sql.exec(`CREATE FUNCTION fixture_delete_failure() RETURNS trigger AS $$ BEGIN
      IF OLD.name='子19' THEN RAISE EXCEPTION 'fixture_delete_failure'; END IF; RETURN OLD; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fixture_delete_failure BEFORE DELETE ON categories FOR EACH ROW EXECUTE FUNCTION fixture_delete_failure()`);
    const before = await snapshot();
    await assert.rejects(remove(branch.id), /fixture_delete_failure/);
    assert.deepEqual(await snapshot(), before);
    await sql.exec("DROP TRIGGER fixture_delete_failure ON categories; DROP FUNCTION fixture_delete_failure()");
  });

  await t.test("一般参加者も枝全体を削除でき、清算済み・過去の停止参照を含む明細が未分類になる", async () => {
    const before = (await sql.query<{ id: string; category_revision: number; data: Record<string, unknown> }>(
      "SELECT id,category_revision,to_jsonb(t) - ARRAY['category_id','category_confirmed','category_revision','updated_by','updated_at'] AS data FROM transactions t ORDER BY id",
    )).rows;
    const history = (await sql.query("SELECT * FROM settlements")).rows;
    const links = (await sql.query("SELECT * FROM settlement_transactions")).rows;
    const result = await remove(branch.id, "b");
    assert.deepEqual(new Set(result.deletedCategoryIds), new Set(branchIds));
    assert.deepEqual(new Set(result.detachedTransactions.map(transaction => transaction.transactionId)), new Set([assigned, settled, archivedReference]));
    for (const acknowledgement of result.detachedTransactions) {
      const previous = before.find(transaction => transaction.id === acknowledgement.transactionId)!;
      assert.deepEqual(acknowledgement, { transactionId: previous.id, categoryId: null, categoryConfirmed: false, categoryRevision: previous.category_revision + 1 });
      assert.deepEqual((await sql.query("SELECT category_id,category_confirmed,category_revision,updated_by FROM transactions WHERE id=$1", [previous.id])).rows[0],
        { category_id: null, category_confirmed: false, category_revision: previous.category_revision + 1, updated_by: "b" });
    }
    assert.deepEqual((await sql.query("SELECT id,to_jsonb(t) - ARRAY['category_id','category_confirmed','category_revision','updated_by','updated_at'] AS data FROM transactions t ORDER BY id")).rows,
      before.map(({ id, data }) => ({ id, data })));
    assert.deepEqual((await sql.query("SELECT * FROM settlements")).rows, history);
    assert.deepEqual((await sql.query("SELECT * FROM settlement_transactions")).rows, links);
    assert.deepEqual(new Set((await sql.query<{ id: string }>("SELECT id FROM categories")).rows.map(category => category.id)), new Set([root.id, untouched.id, foreign.id]));
    assert.deepEqual((await sql.query("SELECT id,category_id,category_revision FROM transactions WHERE id=ANY($1::uuid[]) ORDER BY id", [[otherTransaction, unclassified]])).rows,
      before.filter(transaction => transaction.id === otherTransaction || transaction.id === unclassified).map(transaction => ({ id: transaction.id,
        category_id: transaction.id === otherTransaction ? untouched.id : null, category_revision: transaction.category_revision })));
    const after = await snapshot();
    await assert.rejects(remove(branch.id), /カテゴリが存在しません/);
    await assert.rejects(create("遅い子追加", branch.id), /追加先のカテゴリ/);
    await assert.rejects(sql.query("SELECT cake_mutate_category($1::uuid,'a','ASSIGN',$2::uuid,NULL,NULL,NULL,$3::uuid)", [workspace, branch.id, assigned]), /カテゴリが存在しない/);
    await assert.rejects(sql.query("SELECT cake_move_category($1::uuid,'a',$2::uuid,NULL,NULL)", [workspace, branch.id]), /カテゴリが存在しない/);
    assert.deepEqual(await snapshot(), after);
  });

  await t.test("使用停止済みの枝自体も削除でき、参照なしなら空の明細応答を返す", async () => {
    const stopped = await create("停止済みを削除");
    await sql.query("SELECT cake_mutate_category($1::uuid,'a','ARCHIVE',$2::uuid)", [workspace, stopped.id]);
    assert.deepEqual(await remove(stopped.id), { deletedCategoryIds: [stopped.id], detachedTransactions: [] });
  });
});

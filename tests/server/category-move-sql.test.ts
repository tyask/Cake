import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { categoryPath, flattenCategories } from "../../lib/shared/categories";
import { applyCategoryUpdate } from "../../lib/shared/category-updates";
import type { BootstrapData, Category } from "../../lib/shared/types";

test("カテゴリ移動は兄弟順・任意階層・参照・revisionを同じTransactionで確定する", async t => {
  const sql = new PGlite({ extensions: { pgcrypto } });
  t.after(() => sql.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith(".sql")).sort()) {
    await sql.exec(await readFile(new URL(file, directory), "utf8"));
  }
  await sql.exec("INSERT INTO app_users(id,email,name) VALUES ('a','a@example.test','A'),('b','b@example.test','B'),('outside','outside@example.test','Outside')");
  const workspace = randomUUID(), otherWorkspace = randomUUID();
  await sql.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1,'カテゴリ移動','SHARED','a'),($2,'別workspace','PERSONAL','outside')", [workspace, otherWorkspace]);
  await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'a','OWNER'),($1,'b','MEMBER'),($2,'outside','OWNER')", [workspace, otherWorkspace]);
  async function create(name: string, parentId: string | null = null, workspaceId = workspace, actor = "a") {
    return (await sql.query<{ result: { category: Category } }>(
      "SELECT cake_mutate_category($1::uuid,$2,'CREATE',NULL,$3::uuid,$4,'#f59e0b') AS result",
      [workspaceId, actor, parentId, name],
    )).rows[0].result.category;
  }
  async function move(categoryId: string, parentId: string | null, beforeId: string | null = null, actor = "a", workspaceId = workspace) {
    return (await sql.query<{ result: { movedCategories: Category[] } }>(
      "SELECT cake_move_category($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid) AS result",
      [workspaceId, actor, categoryId, parentId, beforeId],
    )).rows[0].result.movedCategories;
  }
  async function archive(categoryId: string) {
    await sql.query("SELECT cake_mutate_category($1::uuid,'a','ARCHIVE',$2::uuid)", [workspace, categoryId]);
  }
  const siblings = async (parentId: string | null) => (await sql.query<{ id: string; sort_order: number; revision: number }>(
    "SELECT id,sort_order,revision FROM categories WHERE workspace_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid ORDER BY sort_order,id", [workspace, parentId])).rows;
  const snapshot = async () => (await sql.query<{ data: unknown }>(`SELECT jsonb_build_object(
    'workspaces',(SELECT jsonb_agg(w ORDER BY id) FROM workspaces w),
    'categories',COALESCE((SELECT jsonb_agg(c ORDER BY id) FROM categories c),'[]'::jsonb),
    'transactions',COALESCE((SELECT jsonb_agg(t ORDER BY id) FROM transactions t),'[]'::jsonb)
  ) AS data`)).rows[0].data;
  const source = await create("移動元"), destination = await create("移動先");
  const first = await create("先頭", source.id), moving = await create("移動する枝", source.id), last = await create("末尾", source.id);
  const stopped = await create("使用停止", source.id);
  await archive(stopped.id);
  const destinationFirst = await create("既存先頭", destination.id), destinationLast = await create("既存末尾", destination.id);
  const child = await create("子", moving.id);
  let deepest = child;
  for (let i = 0; i < 32; i++) deepest = await create(`深さ${i}`, deepest.id);
  const transactionId = randomUUID();
  await sql.query(`INSERT INTO transactions(id,workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,
    expense_class,split_weights,external_id,created_by,updated_by,category_id,settled_at)
    VALUES ($1,$2,'2026-10-01T00:00:00Z','分類済み明細','現金','PAYMENT',1234,'a','SHARED','{"a":1,"b":1}',$1::uuid::text,'a','a',$3,'2026-10-02T00:00:00Z')`,
  [transactionId, workspace, deepest.id]);
  const transactionBefore = (await sql.query("SELECT * FROM transactions WHERE id=$1", [transactionId])).rows[0];

  await t.test("同階層の前・末尾へ移動し、変更した兄弟だけrevisionを進める", async () => {
    const response = await move(moving.id, source.id, first.id, "b");
    assert.deepEqual((await siblings(source.id)).map(row => [row.id, row.sort_order, row.revision]), [
      [moving.id, 0, 2], [first.id, 1, 2], [last.id, 2, 1], [stopped.id, 3, 2],
    ]);
    assert.deepEqual(new Set(response.map(category => category.id)), new Set([source.id, first.id, moving.id, last.id, stopped.id]));
    assert.equal(response.find(category => category.id === stopped.id)!.archivedAt !== null, true);
    const before = await snapshot();
    await move(moving.id, source.id, first.id);
    assert.deepEqual(await snapshot(), before, "同じ位置への移動ではrevisionもworkspace日時も更新しない");
    await move(moving.id, source.id);
    assert.deepEqual((await siblings(source.id)).map(row => row.id), [first.id, last.id, stopped.id, moving.id]);
    assert.deepEqual((await siblings(source.id)).map(row => row.sort_order), [0, 1, 2, 3]);
    assert.equal((await siblings(source.id)).find(row => row.id === stopped.id)!.revision, 3, "使用停止済み兄弟の順序変更もrevisionを進める");
  });

  await t.test("別の親へ枝ごと移動し、元/先の全兄弟DTOと明細の安定した参照を保持する", async () => {
    const sourceBefore = await siblings(source.id), destinationBefore = await siblings(destination.id);
    const descendantBefore = (await sql.query("SELECT * FROM categories WHERE id=$1", [deepest.id])).rows[0];
    const response = await move(moving.id, destination.id, destinationLast.id);
    assert.deepEqual((await siblings(source.id)).map(row => row.id), [first.id, last.id, stopped.id]);
    assert.deepEqual((await siblings(destination.id)).map(row => row.id), [destinationFirst.id, moving.id, destinationLast.id]);
    assert.deepEqual((await siblings(destination.id)).map(row => row.sort_order), [0, 1, 2]);
    assert.deepEqual(new Set(response.map(category => category.id)), new Set([source, destination, ...sourceBefore, ...destinationBefore].map(category => category.id)));
    const acknowledged = response.find(category => category.id === moving.id)!;
    assert.equal(acknowledged.parentId, destination.id);
    assert.equal(acknowledged.revision, sourceBefore.find(category => category.id === moving.id)!.revision + 1);
    assert.equal(acknowledged.colorHex, moving.colorHex);
    assert.deepEqual((await sql.query("SELECT * FROM categories WHERE id=$1", [deepest.id])).rows[0], descendantBefore);
    assert.deepEqual((await sql.query("SELECT * FROM transactions WHERE id=$1", [transactionId])).rows[0], transactionBefore);
  });

  await t.test("深い階層への移動とルートへの昇格を許可し、旧APIの追加・編集も維持する", async () => {
    const separate = await create("別の枝");
    await move(separate.id, deepest.id);
    assert.equal((await sql.query<{ parent_id: string }>("SELECT parent_id FROM categories WHERE id=$1", [separate.id])).rows[0].parent_id, deepest.id);
    await move(separate.id, null, source.id);
    assert.deepEqual((await siblings(null)).map(row => row.id), [separate.id, source.id, destination.id]);
    const appended = await create("末尾に追加");
    assert.equal(appended.sortOrder, 3);
    const updated = (await sql.query<{ result: { category: Category } }>(
      "SELECT cake_mutate_category($1::uuid,'a','UPDATE',$2::uuid,NULL,'改名','#123456') AS result", [workspace, separate.id],
    )).rows[0].result.category;
    assert.equal(updated.parentId, null);
    assert.equal(updated.sortOrder, 0);
    assert.equal(updated.colorHex, "#123456");
  });

  await t.test("cycle・同名・使用停止・越境・不正な位置・最新の所属拒否は全体を変更しない", async () => {
    const foreign = await create("別workspaceの枝", null, otherWorkspace, "outside");
    const duplicateParent = await create("同名のある親");
    await create(moving.name, duplicateParent.id);
    const stoppedParent = await create("停止済みの親");
    await archive(stoppedParent.id);
    await sql.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='b'", [workspace]);
    const invalid = [
      [() => move(moving.id, moving.id), /自分自身または子孫/],
      [() => move(moving.id, deepest.id), /自分自身または子孫/],
      [() => move(moving.id, duplicateParent.id), /同じ階層に同じ名前/],
      [() => move(stopped.id, null), /使用停止/],
      [() => move(moving.id, stoppedParent.id), /使用停止/],
      [() => move(moving.id, foreign.id), /移動先のカテゴリ/],
      [() => move(foreign.id, null), /カテゴリが存在しない/],
      [() => move(moving.id, source.id, destinationFirst.id), /挿入位置/],
      [() => move(moving.id, source.id, stopped.id), /挿入位置/],
      [() => move(moving.id, destination.id, moving.id), /挿入位置/],
      [() => move(moving.id, source.id, foreign.id), /挿入位置/],
      [() => move(moving.id, source.id, randomUUID()), /挿入位置/],
      [() => move(moving.id, source.id, null, "b"), /権限がありません/],
      [() => move(moving.id, source.id, null, "outside"), /権限がありません/],
      [() => move(moving.id, source.id, null, "a", randomUUID()), /権限がありません/],
    ] as const;
    const before = await snapshot();
    for (const [run, message] of invalid) {
      await assert.rejects(run(), message);
      assert.deepEqual(await snapshot(), before);
    }
    await assert.rejects(sql.query("UPDATE categories SET parent_id=$1 WHERE id=$2", [deepest.id, moving.id]), /自分自身または子孫/);
    await assert.rejects(sql.query("UPDATE categories SET workspace_id=$1 WHERE id=$2", [otherWorkspace, moving.id]), /所属は変更できません/);
    assert.deepEqual(await snapshot(), before, "DB構造guardもcycleと所属変更を拒否する");
  });

  await t.test("移動先の兄弟更新が失敗した場合は親・全兄弟・revision・workspace日時をrollbackする", async () => {
    await sql.query("ALTER TABLE categories ADD CONSTRAINT fixture_move_failure CHECK (id <> '" + first.id + "'::uuid OR sort_order = 0)");
    const before = await snapshot();
    await assert.rejects(move(moving.id, source.id, first.id), /fixture_move_failure/);
    assert.deepEqual(await snapshot(), before);
    await sql.exec("ALTER TABLE categories DROP CONSTRAINT fixture_move_failure");
  });

  await t.test("別ブラウザが親子を逆転させた後の古い画面でも全metadata操作の応答で最新祖先を反映する", async () => {
    const sharedWorkspace = randomUUID();
    await sql.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1,'別ブラウザの移動','SHARED','a')", [sharedWorkspace]);
    await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'a','OWNER'),($1,'b','MEMBER')", [sharedWorkspace]);
    const p = await create("P", null, sharedWorkspace), x = await create("X", p.id, sharedWorkspace);
    const z = await create("Z", null, sharedWorkspace), y = await create("Y", z.id, sharedWorkspace);
    const stale = { selected: { workspace: { id: sharedWorkspace }, categories: [p, x, z, y] } } as BootstrapData;
    await move(y.id, null, null, "b", sharedWorkspace);
    await move(z.id, y.id, null, "b", sharedWorkspace);
    const movedCategories = await move(x.id, y.id, null, "a", sharedWorkspace);
    assert.ok(movedCategories.some(category => category.id === y.id && category.parentId === null), "移動先の親自身の最新DTOを返す");
    const moved = applyCategoryUpdate(stale, sharedWorkspace, { movedCategories });
    assert.equal(flattenCategories(moved.selected!.categories).length, 4);
    assert.deepEqual(categoryPath(moved.selected!.categories, x.id).map(category => category.name), ["Y", "X"]);
    assert.deepEqual(categoryPath(moved.selected!.categories, z.id).map(category => category.name), ["Y", "Z"]);

    async function metadataMutation(operation: string, categoryId: string | null, parentId: string | null, name: string | null) {
      return (await sql.query<{ result: { category: Category; archivedCategories: Category[]; ancestorCategories: Category[] } }>(
        "SELECT cake_mutate_category_with_ancestors($1::uuid,'a',$2,$3::uuid,$4::uuid,$5,'#f59e0b') AS result",
        [sharedWorkspace, operation, categoryId, parentId, name],
      )).rows[0].result;
    }
    const updated = await metadataMutation("UPDATE", z.id, null, "改名Z");
    const renamed = applyCategoryUpdate(stale, sharedWorkspace, updated);
    assert.equal(flattenCategories(renamed.selected!.categories).length, 4);
    assert.deepEqual(categoryPath(renamed.selected!.categories, z.id).map(category => category.name), ["Y", "改名Z"]);
    const created = await metadataMutation("CREATE", null, z.id, "追加した子");
    const added = applyCategoryUpdate(stale, sharedWorkspace, created);
    assert.equal(flattenCategories(added.selected!.categories).length, 5);
    assert.deepEqual(categoryPath(added.selected!.categories, created.category.id).map(category => category.name), ["Y", "改名Z", "追加した子"]);
    assert.deepEqual(new Set(created.ancestorCategories.map(category => category.id)), new Set([y.id, z.id]), "新しい子の祖先全体をrootまで返す");
    const archived = await metadataMutation("ARCHIVE", z.id, null, null);
    const stopped = applyCategoryUpdate(stale, sharedWorkspace, archived);
    assert.equal(flattenCategories(stopped.selected!.categories).length, 5);
    assert.ok(stopped.selected!.categories.find(category => category.id === z.id)!.archivedAt);
    assert.deepEqual(categoryPath(stopped.selected!.categories, created.category.id).map(category => category.name), ["Y", "改名Z", "追加した子"]);
    const repeatedArchive = applyCategoryUpdate(stopped, sharedWorkspace, created);
    assert.deepEqual(repeatedArchive.selected!.categories, stopped.selected!.categories, "古い作成の祖先DTOでも新しい停止状態を戻さない");
    const assigned = (await sql.query<{ result: Record<string, unknown> }>(
      "SELECT cake_mutate_category_with_ancestors($1::uuid,'a','ASSIGN',$2::uuid,NULL,NULL,NULL,$3::uuid) AS result",
      [workspace, child.id, transactionId],
    )).rows[0].result;
    assert.equal("ancestorCategories" in assigned, false, "明細のカテゴリ保存はmetadata取得を増やさない");
  });
});

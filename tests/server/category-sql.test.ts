import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("カテゴリの実SQLは階層・所属・履歴を保持し、失敗した操作を全体rollbackする", async t => {
  const sql = new PGlite({ extensions: { pgcrypto } });
  t.after(() => sql.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith(".sql") && file < "014").sort()) {
    await sql.exec(await readFile(new URL(file, directory), "utf8"));
  }
  await sql.exec("INSERT INTO app_users(id,email,name) VALUES ('a','a@example.test','A'),('b','b@example.test','B'),('outside','outside@example.test','Outside')");
  const workspace = randomUUID(), otherWorkspace = randomUUID();
  await sql.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1,'カテゴリテスト','SHARED','a'),($2,'別workspace','PERSONAL','outside')", [workspace, otherWorkspace]);
  await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'a','OWNER'),($1,'b','MEMBER'),($2,'outside','OWNER')", [workspace, otherWorkspace]);
  async function insert(categoryId: string | null = null, confirmed = false) {
    const id = randomUUID();
    await sql.query(`INSERT INTO transactions(id,workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,
      expense_class,split_weights,external_id,created_by,updated_by,memo${categoryId ? ",category_id,category_confirmed" : ""})
      VALUES ($1::uuid,$2::uuid,'2026-10-01T01:02:03.456Z','スーパー','現金','PAYMENT',1234,'a','SHARED','{"a":1,"b":3}',$1::uuid::text,'a','a','元のメモ'${categoryId ? ",$3,$4" : ""})`,
    categoryId ? [id, workspace, categoryId, confirmed] : [id, workspace]);
    return id;
  }
  // This historical row predates the new columns, just like production data.
  const historical = await insert();
  await sql.exec(await readFile(new URL("014_categories.sql", directory), "utf8"));
  type Category = { id: string; revision: number; parentId: string | null; name: string; colorHex: string; sortOrder: number; archivedAt: string | null };
  async function mutate(operation: string, options: { workspace?: string; actor?: string; categoryId?: string | null;
    parentId?: string | null; name?: string; color?: string; transactionId?: string } = {}) {
    return (await sql.query<{ result: { category: Category; archivedCategoryIds: string[]; archivedCategories: Category[]; categoryId: string | null; categoryConfirmed: boolean; categoryRevision: number } }>(
      "SELECT cake_mutate_category($1::uuid,$2,$3,$4::uuid,$5::uuid,$6,$7,$8::uuid) AS result",
      [options.workspace ?? workspace, options.actor ?? "a", operation, options.categoryId ?? null,
        options.parentId ?? null, options.name ?? null, options.color ?? "#f59e0b", options.transactionId ?? null],
    )).rows[0].result;
  }
  const create = async (name: string, parentId: string | null = null) => (await mutate("CREATE", { name, parentId })).category;
  const snapshot = async () => (await sql.query<{ data: unknown }>(`SELECT jsonb_build_object(
    'workspace',(SELECT to_jsonb(w) FROM workspaces w WHERE id=$1),
    'categories',COALESCE((SELECT jsonb_agg(c ORDER BY id) FROM categories c WHERE workspace_id=$1),'[]'::jsonb),
    'transactions',COALESCE((SELECT jsonb_agg(t ORDER BY id) FROM transactions t WHERE workspace_id=$1),'[]'::jsonb)
    ) AS data`, [workspace])).rows[0].data;
  const food = await create("食費"), daily = await create("日用品");
  const grocery = await create("食品", food.id), fresh = await create("生鮮食品", grocery.id), vegetable = await create("野菜", fresh.id);

  await t.test("既存明細は未分類のまま、任意階層・兄弟の順序・名前の一意性を保持する", async () => {
    assert.deepEqual((await sql.query("SELECT category_id,category_confirmed FROM transactions WHERE id=$1", [historical])).rows[0],
      { category_id: null, category_confirmed: false });
    assert.equal(vegetable.parentId, fresh.id);
    assert.equal(daily.sortOrder, food.sortOrder + 1);
    assert.equal((await create("外食", food.id)).sortOrder, grocery.sortOrder + 1);
    const before = await snapshot();
    await assert.rejects(create("食費"), /同じ階層に同じ名前/);
    await assert.rejects(create("食品", food.id), /同じ階層に同じ名前/);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await create("食品", daily.id)).name, "食品");
    const updated = (await mutate("UPDATE", { categoryId: food.id, name: "飲食費", color: "#ABCDEF" })).category;
    assert.equal(updated.colorHex, "#abcdef");
    assert.equal(updated.revision, food.revision + 1);
    assert.equal((await sql.query<{ color_hex: string }>("SELECT color_hex FROM categories WHERE id=$1", [vegetable.id])).rows[0].color_hex, "#f59e0b");
    await assert.rejects(mutate("UPDATE", { categoryId: daily.id, name: "飲食費" }), /同じ階層に同じ名前/);
  });

  await t.test("別workspace・脱退済みユーザー・不正な構造を拒否する", async () => {
    const foreign = (await mutate("CREATE", { workspace: otherWorkspace, actor: "outside", name: "別カテゴリ" })).category;
    const before = await snapshot();
    await assert.rejects(create("越境", foreign.id), /追加先のカテゴリ/);
    await assert.rejects(mutate("UPDATE", { categoryId: foreign.id, name: "越境" }), /カテゴリが存在しない/);
    await assert.rejects(mutate("ARCHIVE", { categoryId: foreign.id }), /カテゴリが存在しません/);
    await assert.rejects(mutate("ASSIGN", { categoryId: foreign.id, transactionId: historical }), /カテゴリが存在しない/);
    await assert.rejects(mutate("CREATE", { actor: "outside", name: "権限なし" }), /権限がありません/);
    await sql.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='b'", [workspace]);
    await assert.rejects(mutate("CREATE", { actor: "b", name: "脱退済み" }), /権限がありません/);
    await assert.rejects(sql.query("UPDATE categories SET parent_id=$1 WHERE id=$2", [vegetable.id, food.id]), /所属と親は変更できません/);
    await assert.rejects(sql.query("UPDATE categories SET workspace_id=$1 WHERE id=$2", [otherWorkspace, food.id]), /所属と親は変更できません/);
    assert.deepEqual(await snapshot(), before);
    // The composite FK protects the workspace even if an unrelated write path
    // attempted to move a categorized transaction without changing category_id.
    await mutate("ASSIGN", { categoryId: food.id, transactionId: historical });
    await assert.rejects(sql.query("UPDATE transactions SET workspace_id=$1 WHERE id=$2", [otherWorkspace, historical]), /transactions_category_workspace_fk/);
  });

  await t.test("精算済み明細のカテゴリだけを保存し、手動割当の確認状態をサーバーで確定する", async () => {
    await sql.query("UPDATE transactions SET settled_at='2026-10-02T00:00:00Z' WHERE id=$1", [historical]);
    const fields = "occurred_at,merchant,method,type,amount_yen,actor_user_id,expense_class,split_weights,memo,settled_at,external_id,source,created_by,created_at";
    const previous = (await sql.query(`SELECT ${fields} FROM transactions WHERE id=$1`, [historical])).rows[0];
    const previousRevision = (await sql.query<{ category_revision: number }>("SELECT category_revision FROM transactions WHERE id=$1", [historical])).rows[0].category_revision;
    const assigned = await mutate("ASSIGN", { categoryId: vegetable.id, transactionId: historical });
    assert.equal(assigned.categoryId, vegetable.id); assert.equal(assigned.categoryConfirmed, true);
    assert.equal(assigned.categoryRevision, previousRevision + 1);
    assert.deepEqual((await sql.query(`SELECT ${fields} FROM transactions WHERE id=$1`, [historical])).rows[0], previous);
    assert.deepEqual((await sql.query("SELECT category_id,category_confirmed FROM transactions WHERE id=$1", [historical])).rows[0],
      { category_id: vegetable.id, category_confirmed: true });
    const manual = await insert(vegetable.id, false);
    assert.equal((await sql.query<{ category_confirmed: boolean }>("SELECT category_confirmed FROM transactions WHERE id=$1", [manual])).rows[0].category_confirmed, true);
    assert.equal((await mutate("ASSIGN", { transactionId: historical })).categoryRevision, previousRevision + 2);
    assert.deepEqual((await sql.query("SELECT category_id,category_confirmed FROM transactions WHERE id=$1", [historical])).rows[0],
      { category_id: null, category_confirmed: false });
    const before = await snapshot();
    await assert.rejects(mutate("ASSIGN", { transactionId: randomUUID(), categoryId: vegetable.id }), /明細が存在しません/);
    assert.deepEqual(await snapshot(), before);
    await mutate("ASSIGN", { categoryId: vegetable.id, transactionId: historical });
  });

  await t.test("一部の更新失敗は子孫アーカイブ全体とworkspace更新をrollbackする", async () => {
    await sql.exec(`ALTER TABLE categories ADD CONSTRAINT fixture_archive_failure CHECK (name <> '野菜' OR archived_at IS NULL)`);
    const before = await snapshot();
    await assert.rejects(mutate("ARCHIVE", { categoryId: food.id }), /fixture_archive_failure/);
    assert.deepEqual(await snapshot(), before);
    await sql.exec("ALTER TABLE categories DROP CONSTRAINT fixture_archive_failure");
  });

  await t.test("子孫を一括停止しても過去の参照を維持し、新しい割当・子追加だけ拒否する", async () => {
    const archived = await mutate("ARCHIVE", { categoryId: food.id });
    assert.ok([food, grocery, fresh, vegetable].every(category => archived.archivedCategoryIds.includes(category.id)));
    const revisions = new Map(archived.archivedCategories.map(category => [category.id, category.revision]));
    assert.equal(revisions.get(food.id), 3);
    assert.equal(revisions.get(vegetable.id), 2);
    assert.equal((await sql.query<{ archived_at: string | null }>("SELECT archived_at FROM categories WHERE id=$1", [daily.id])).rows[0].archived_at, null);
    assert.equal((await sql.query<{ category_id: string | null }>("SELECT category_id FROM transactions WHERE id=$1", [historical])).rows[0].category_id, vegetable.id);
    await sql.query("UPDATE transactions SET merchant='スーパー編集',memo='メモ編集' WHERE id=$1", [historical]);
    await assert.rejects(mutate("ASSIGN", { categoryId: vegetable.id, transactionId: historical }), /使用停止/);
    await assert.rejects(insert(vegetable.id), /使用停止/);
    await assert.rejects(create("追加不可", food.id), /使用停止/);
    await assert.rejects(mutate("UPDATE", { categoryId: vegetable.id, name: "変更不可" }), /使用停止/);
    const repeated = await mutate("ARCHIVE", { categoryId: food.id });
    assert.deepEqual(repeated.archivedCategoryIds, []);
    assert.deepEqual(repeated.archivedCategories, archived.archivedCategories, "既に停止済みでも枝全体の確定状態を返す");
    assert.equal((await create("飲食費")).name, "飲食費");
    await mutate("ASSIGN", { transactionId: historical });
    assert.equal((await sql.query<{ category_id: string | null }>("SELECT category_id FROM transactions WHERE id=$1", [historical])).rows[0].category_id, null);
  });

  await t.test("workspace削除では階層と明細のカテゴリ参照を残さない", async () => {
    await sql.query("DELETE FROM workspaces WHERE id=$1", [workspace]);
    assert.deepEqual((await sql.query("SELECT id FROM categories WHERE workspace_id=$1", [workspace])).rows, []);
    assert.deepEqual((await sql.query("SELECT id FROM transactions WHERE workspace_id=$1", [workspace])).rows, []);
  });
});

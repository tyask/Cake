import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neonConfig } from "@neondatabase/serverless";
import { persistPayPayImport, type PayPayImportItem } from "../../lib/server/stores/paypay-import";
import { createAppStore } from "../../lib/server/stores/app-store";

test("CSVカテゴリの実SQLは互換性・集合検証・重複保持・全体rollbackを保証する", async t => {
  const memory = new PGlite({ extensions: { pgcrypto } });
  t.after(() => memory.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql") && name < "018").sort()) {
    await memory.exec(await readFile(new URL(name, directory), "utf8"));
  }
  await memory.exec("INSERT INTO app_users(id,email,name) VALUES ('a','a@example.test','A'),('b','b@example.test','B'),('outside','outside@example.test','Outside')");
  const workspaceId = randomUUID(), otherWorkspaceId = randomUUID();
  await memory.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1,'取込テスト','SHARED','a'),($2,'別workspace','PERSONAL','outside')", [workspaceId, otherWorkspaceId]);
  await memory.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'a','OWNER'),($1,'b','MEMBER'),($2,'outside','OWNER')", [workspaceId, otherWorkspaceId]);
  const categoryId = randomUUID(), childId = randomUUID(), archivedId = randomUUID(), foreignId = randomUUID();
  await memory.query(`INSERT INTO categories(id,workspace_id,parent_id,name,color_hex,sort_order,created_by,updated_by)
    VALUES ($1,$5,NULL,'食費','#f59e0b',0,'a','a'),($2,$5,$1,'食品','#f59e0b',0,'a','a'),
    ($3,$5,NULL,'旧カテゴリ','#000000',1,'a','a'),($4,$6,NULL,'別カテゴリ','#000000',0,'outside','outside')`,
  [categoryId, childId, archivedId, foreignId, workspaceId, otherWorkspaceId]);
  await memory.query("UPDATE categories SET archived_at=now() WHERE id=$1", [archivedId]);
  type CategoryAssignment = { id: string; category_id: string | null; category_confirmed: boolean; category_revision: number };
  const insertManual = (category: string | null, externalId: string, source = "MANUAL") => memory.query<CategoryAssignment>(`
    INSERT INTO transactions(workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,
      expense_class,split_weights,external_id,source,created_by,updated_by,category_id,category_confirmed)
    VALUES ($1,'2026-10-10T00:00:00.123Z','スーパー','現金','PAYMENT',1234,'a','SHARED','{"a":1,"b":1}',
      $2,$4,'a','a',$3,false) RETURNING id,category_id,category_confirmed,category_revision`,
  [workspaceId, externalId, category, source]);
  const beforeMigration = (await insertManual(categoryId, "manual-before")).rows[0];
  await memory.exec(await readFile(new URL("018_import_categories.sql", directory), "utf8"));
  await memory.exec(await readFile(new URL("022_import_history.sql", directory), "utf8"));
  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  const fixtureUrl = "postgresql://fixture:fixture@mock.neon.tech/import_category_test";
  process.env.DATABASE_URL = fixtureUrl;
  process.env.DB_QUERY_LOG = "off";
  t.after(() => {
    neonConfig.fetchFunction = previous.fetch;
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
    if (previous.logging === undefined) delete process.env.DB_QUERY_LOG; else process.env.DB_QUERY_LOG = previous.logging;
  });
  let beforeBatch: (() => Promise<void>) | undefined;
  const batches: { query: string; params: string[] }[][] = [];
  function encode(result: Awaited<ReturnType<typeof memory.query>>) {
    return {
      fields: result.fields, rows: result.rows.map(row => result.fields.map(field => {
        const value = (row as Record<string, unknown>)[field.name];
        if (value == null) return null;
        if (field.dataTypeID === 16) return value ? "t" : "f";
        if (field.dataTypeID === 3802 || field.dataTypeID === 114) return JSON.stringify(value);
        return value instanceof Date ? value.toISOString().replace("T", " ").replace("Z", "+00") : String(value);
      })),
    };
  }
  neonConfig.fetchFunction = async (_url: RequestInfo | URL, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("Neon-Connection-String"), fixtureUrl);
    const body = JSON.parse(String(init.body)) as { queries: { query: string; params: string[] }[] };
    batches.push(body.queries);
    try {
      const hook = beforeBatch;
      beforeBatch = undefined;
      await hook?.();
      const results = await memory.transaction(async tx => {
        const results = [];
        for (const query of body.queries) results.push(encode(await tx.query(query.query, query.params)));
        return results;
      });
      return new Response(JSON.stringify({ results }), { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ message: (error as Error).message, code: (error as { code: string }).code }), { status: 400 });
    }
  };
  let sequence = 0;
  const item = (category?: string | null): PayPayImportItem => ({
    occurredAt: "2026-10-10T00:00:00.123Z", merchant: "スーパー", method: "PayPay", amountYen: 1234,
    actorUserId: "a", expenseClass: "SHARED", splitWeights: { a: 1, b: 1 }, externalId: String(++sequence),
    ...(category === undefined ? {} : { categoryId: category }),
  });
  const run = (items: PayPayImportItem[], userId = "a") => persistPayPayImport({ workspaceId, userId, fileName: "categories.csv", totalRows: items.length, items });
  const snapshot = async () => (await memory.query<{ data: unknown }>(`SELECT jsonb_build_object(
    'workspace',(SELECT to_jsonb(w) FROM workspaces w WHERE id=$1),
    'categories',(SELECT jsonb_agg(c ORDER BY id) FROM categories c WHERE workspace_id=$1),
    'transactions',(SELECT jsonb_agg(tr ORDER BY id) FROM transactions tr WHERE workspace_id=$1),
    'batches',(SELECT jsonb_agg(b ORDER BY id) FROM import_batches b WHERE workspace_id=$1)
  ) AS data`, [workspaceId])).rows[0].data;

  await t.test("移行前の明細と通常手動INSERT/UPDATE・旧CSV・定期生成の未分類を維持する", async () => {
    const afterMigration = (await memory.query("SELECT id,category_id,category_confirmed,category_revision FROM transactions WHERE id=$1", [beforeMigration.id])).rows[0];
    assert.deepEqual(afterMigration, beforeMigration);
    const manual = (await insertManual(childId, "manual-after")).rows[0];
    assert.deepEqual({ category: manual.category_id, confirmed: manual.category_confirmed, revision: manual.category_revision },
      { category: childId, confirmed: true, revision: 1 });
    await memory.query("UPDATE transactions SET category_id=$1,category_confirmed=false WHERE id=$2", [categoryId, manual.id]);
    assert.deepEqual((await memory.query("SELECT category_id,category_confirmed,category_revision FROM transactions WHERE id=$1", [manual.id])).rows[0],
      { category_id: categoryId, category_confirmed: true, category_revision: 2 });
    await memory.query("UPDATE transactions SET category_id=NULL,category_confirmed=true WHERE id=$1", [manual.id]);
    assert.deepEqual((await memory.query("SELECT category_id,category_confirmed,category_revision FROM transactions WHERE id=$1", [manual.id])).rows[0],
      { category_id: null, category_confirmed: false, category_revision: 3 });
    await assert.rejects(insertManual(archivedId, "invalid-archived"), /カテゴリが存在しないか/);
    for (const invalid of [foreignId, randomUUID()]) {
      await assert.rejects(insertManual(invalid, `invalid-${invalid}`), /transactions_category_workspace_fk/);
    }
    const beforeRejectedStatement = await snapshot();
    await assert.rejects(memory.query(`INSERT INTO transactions(workspace_id,occurred_at,merchant,method,type,amount_yen,
      actor_user_id,expense_class,split_weights,external_id,created_by,updated_by,category_id)
      SELECT $1,'2026-10-10T00:00:00Z','一括SQL','現金','PAYMENT',100,'a','SHARED','{"a":1,"b":1}',
        'statement-' || category_id::text,'a','a',category_id FROM unnest($2::uuid[]) AS ids(category_id)`,
    [workspaceId, [categoryId, archivedId]]), /カテゴリが存在しないか/);
    assert.deepEqual(await snapshot(), beforeRejectedStatement, "statement triggerの一部失敗で全行とworkspace日時を戻す");
    await assert.rejects(createAppStore().insertTransaction({
      action: "saveTransaction", workspaceId, occurredAt: "2026-10-10T00:00:00.123Z", merchant: "手動", method: "現金",
      type: "PAYMENT", amountYen: 100, actorUserId: "a", categoryId: foreignId,
    }, { id: "a", email: "a@example.test", name: "A", imageUrl: null },
    { expenseClass: "SHARED", splitWeights: { a: 1, b: 1 } }, randomUUID()), /カテゴリが存在しないか/);
    assert.deepEqual(await snapshot(), beforeRejectedStatement, "現在の手動APIはFKに先行する業務検証を保持する");
    const uncategorized = (await insertManual(null, "recurring-after", "RECURRING")).rows[0];
    assert.equal(uncategorized.category_confirmed, false);
    assert.equal(uncategorized.category_revision, 0);
    const omitted = item(), cleared = item(null);
    assert.deepEqual(await run([omitted, cleared]), { imported: 2, skipped: 0 });
  });

  await t.test("親/末端/未分類を同じ集合INSERTで保存し、確認状態・revision・日時精度を確定する", async () => {
    const rows = [item(categoryId), item(childId), item(null), item()];
    assert.deepEqual(await run(rows), { imported: 4, skipped: 0 });
    const saved = (await memory.query<CategoryAssignment & { occurred_at: Date }>("SELECT category_id,category_confirmed,category_revision,occurred_at FROM transactions WHERE import_batch_id=(SELECT id FROM import_batches ORDER BY created_at DESC LIMIT 1) ORDER BY external_id")).rows;
    assert.deepEqual(saved.map(row => [row.category_id, row.category_confirmed, row.category_revision]),
      [[categoryId, true, 1], [childId, true, 1], [null, false, 0], [null, false, 0]]);
    assert.ok(saved.every(row => row.occurred_at.toISOString() === rows[0].occurredAt));
    assert.equal(batches.at(-1)!.length, 4);
  });

  await t.test("既存重複と入力内重複はカテゴリ・金額・監査情報を変更せず最初の登録を保持する", async () => {
    const first = item(categoryId);
    await run([first]);
    const before = (await memory.query("SELECT to_jsonb(tr) AS data FROM transactions tr WHERE external_id=$1", [`PayPay_20261010090000_${first.externalId}`])).rows;
    assert.deepEqual(await run([{ ...first, categoryId: childId }]), { imported: 0, skipped: 1 });
    assert.deepEqual((await memory.query("SELECT to_jsonb(tr) AS data FROM transactions tr WHERE external_id=$1", [`PayPay_20261010090000_${first.externalId}`])).rows, before);
    const repeated = item(categoryId);
    assert.deepEqual(await run([repeated, { ...repeated, categoryId: childId }]), { imported: 1, skipped: 1 });
  });

  await t.test("越境・停止・不在カテゴリは既存重複の入力でも拒否し全履歴・全明細をrollbackする", async () => {
    const existing = item(categoryId);
    await run([existing]);
    for (const invalid of [foreignId, archivedId, randomUUID()]) {
      const before = await snapshot();
      await assert.rejects(run([item(childId), { ...existing, categoryId: invalid }]), /カテゴリが存在しないか/);
      assert.deepEqual(await snapshot(), before);
    }
  });

  await t.test("DB衝突と途中のINSERT失敗も履歴・workspace更新を含め全体rollbackする", async () => {
    const existing = item(categoryId);
    await run([existing]);
    const before = await snapshot();
    await assert.rejects(run([item(childId), { ...existing, amountYen: 999 }]), /同じ取引日・取引番号/);
    assert.deepEqual(await snapshot(), before);
    await memory.exec("ALTER TABLE transactions ADD CONSTRAINT fixture_import_failure CHECK (merchant <> '取込失敗')");
    await assert.rejects(run([item(categoryId), { ...item(childId), merchant: "取込失敗" }]), /fixture_import_failure/);
    assert.deepEqual(await snapshot(), before);
    await memory.exec("ALTER TABLE transactions DROP CONSTRAINT fixture_import_failure");
  });

  await t.test("事前確認後の脱退・削除を保存Transactionで検出し、取込後のカテゴリ削除は全行を未分類にする", async () => {
    beforeBatch = async () => { await memory.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='b'", [workspaceId]); };
    await assert.rejects(run([item(childId)], "b"), /権限がありません/);
    const doomedId = randomUUID();
    await memory.query("INSERT INTO categories(id,workspace_id,name,color_hex,sort_order,created_by,updated_by) VALUES ($1,$2,'削除予定','#000000',2,'a','a')", [doomedId, workspaceId]);
    beforeBatch = async () => { await memory.query("SELECT cake_delete_category($1,'a',$2)", [workspaceId, doomedId]); };
    await assert.rejects(run([item(doomedId)]), /カテゴリが存在しないか/);
    const deletion = (await memory.query<{ result: { detachedTransactions: { transactionId: string }[] } }>("SELECT cake_delete_category($1,'a',$2) AS result", [workspaceId, categoryId])).rows[0].result;
    assert.ok(deletion.detachedTransactions.length > 0);
    assert.equal((await memory.query("SELECT id FROM transactions WHERE category_id IN ($1,$2)", [categoryId, childId])).rows.length, 0);
    assert.equal((await memory.query("SELECT id FROM transactions WHERE category_confirmed OR category_revision < 0")).rows.length, 0);
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neonConfig } from "@neondatabase/serverless";
import { getBootstrap } from "../../lib/server/stores/repository";
import { createAppStore } from "../../lib/server/stores/app-store";
import { createAppService } from "../../lib/server/services/app-service";
import { parseAppActionInput } from "../../lib/shared/schemas/app-input";

test("個人明細は担当者本人だけが参照・操作でき、共有明細は双方で操作できる", async t => {
  const memory = new PGlite({ extensions: { pgcrypto } });
  t.after(() => memory.close());
  const migrations = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    await memory.exec(await readFile(new URL(name, migrations), "utf8"));
  }
  await memory.exec("INSERT INTO app_users(id,email,name) VALUES ('a','a@example.test','A'),('b','b@example.test','B')");
  const workspaceId = randomUUID(), categoryId = randomUUID();
  await memory.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1,'権限テスト','SHARED','a')", [workspaceId]);
  await memory.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'a','OWNER'),($1,'b','MEMBER')", [workspaceId]);
  await memory.query("INSERT INTO categories(id,workspace_id,name,color_hex,sort_order,created_by,updated_by) VALUES ($1,$2,'共通カテゴリ','#f97316',0,'a','a')", [categoryId, workspaceId]);
  async function insert(actor: string, expenseClass: string, merchant: string) {
    const id = randomUUID();
    await memory.query(`INSERT INTO transactions(id,workspace_id,occurred_at,merchant,method,type,amount_yen,
      actor_user_id,expense_class,split_weights,external_id,created_by,updated_by,category_id)
      VALUES ($1::uuid,$2,'2026-10-01T00:00:00Z',$3,'現金','PAYMENT',1000,$4,$5,$6::jsonb,$1::text,$7,$7,$8)`,
    [id, workspaceId, merchant, actor, expenseClass, JSON.stringify(expenseClass === "SHARED" ? { a: 1, b: 1 } : { a: Number(actor === "a"), b: Number(actor === "b") }), actor === "a" ? "b" : "a", categoryId]);
    return id;
  }
  const sharedA = await insert("a", "SHARED", "共有A"), sharedB = await insert("b", "SHARED", "共有B");
  const personalA = await insert("a", "PERSONAL", "本人だけのA"), personalB = await insert("b", "PERSONAL", "本人だけのB");
  const users = {
    a: { id: "a", email: "a@example.test", name: "A", imageUrl: null },
    b: { id: "b", email: "b@example.test", name: "B", imageUrl: null },
  };
  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  process.env.DATABASE_URL = "postgresql://fixture:fixture@mock.neon.tech/transaction_privacy";
  process.env.DB_QUERY_LOG = "off";
  t.after(() => {
    neonConfig.fetchFunction = previous.fetch;
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
    if (previous.logging === undefined) delete process.env.DB_QUERY_LOG; else process.env.DB_QUERY_LOG = previous.logging;
  });
  function encode(result: Awaited<ReturnType<typeof memory.query>>) {
    return { fields: result.fields, rows: result.rows.map(row => result.fields.map(field => {
      const value = (row as Record<string, unknown>)[field.name];
      if (value == null) return null;
      if (field.dataTypeID === 16) return value ? "t" : "f";
      if (field.dataTypeID === 3802 || field.dataTypeID === 114) return JSON.stringify(value);
      return value instanceof Date ? value.toISOString().replace("T", " ").replace("Z", "+00") : String(value);
    })) };
  }
  let beforeBatch: (() => Promise<void>) | undefined;
  neonConfig.fetchFunction = async (_url: RequestInfo | URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; params: string[]; queries?: { query: string; params: string[] }[] };
    try {
      if (!body.queries) return new Response(JSON.stringify(encode(await memory.query(body.query, body.params))), { status: 200 });
      const hook = beforeBatch; beforeBatch = undefined; await hook?.();
      const results = await memory.transaction(async tx => {
        const results = [];
        for (const query of body.queries!) results.push(encode(await tx.query(query.query, query.params)));
        return results;
      });
      return new Response(JSON.stringify({ results }), { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ message: (error as Error).message, code: (error as { code: string }).code }), { status: 400 });
    }
  };
  const store = createAppStore(), service = createAppService(store);
  const run = (input: unknown, actor: "a" | "b" = "a") => service.execute(users[actor], parseAppActionInput(input));
  const save = { action: "saveTransaction", workspaceId, occurredAt: "2026-10-01T00:00:00Z", merchant: "保存", method: "現金", type: "PAYMENT", amountYen: 500, actorUserId: "a", expenseClass: "PERSONAL" } as const;
  const snapshot = async () => (await memory.query<{ data: unknown }>(`SELECT jsonb_build_object(
    'workspace',(SELECT to_jsonb(w) FROM workspaces w WHERE id=$1),
    'transactions',(SELECT jsonb_agg(t ORDER BY id) FROM transactions t WHERE workspace_id=$1)) AS data`, [workspaceId])).rows[0].data;

  await t.test("bootstrapは作成者やOWNER権限によらず本人個人費と双方の共有費だけを返す", async () => {
    for (const actor of ["a", "b"] as const) {
      const data = await getBootstrap(users[actor], workspaceId);
      assert.deepEqual(new Set(data.selected!.transactions.map(row => row.id)), new Set([sharedA, sharedB, actor === "a" ? personalA : personalB]));
      assert.doesNotMatch(JSON.stringify(data), new RegExp(actor === "a" ? "本人だけのB" : "本人だけのA"));
      assert.equal(data.selected!.settlement!.amountYen, 0);
    }
    assert.equal(await store.previousTransaction({ ...save, transactionId: personalB }, users.a), undefined);
  });
  await t.test("相手の個人IDを指定した更新・削除・メモ・カテゴリと混在一括操作は全体をrollbackする", async () => {
    const before = await snapshot();
    const actions = [
      { ...save, transactionId: personalB },
      { ...save, transactionId: personalB, expenseClass: "SHARED", splitWeights: { a: 1, b: 1 } },
      { action: "deleteTransaction", workspaceId, transactionId: personalB },
      { action: "saveTransactionMemo", workspaceId, transactionId: personalB, memo: "変更" },
      { action: "saveTransactionCategory", workspaceId, transactionId: personalB, categoryId: null },
      { action: "deleteTransactions", workspaceId, transactionIds: [sharedA, personalB] },
      { action: "applyTransactionRules", workspaceId, transactionIds: [sharedA, personalB] },
    ];
    for (const action of actions) {
      await assert.rejects(run(action), /明細が存在し|選択した明細が見つかりません/);
      assert.deepEqual(await snapshot(), before);
    }
  });
  await t.test("本人は個人費を編集でき、相手が支払った共有費のメモも編集できる", async () => {
    await run({ ...save, transactionId: personalA });
    await run({ action: "saveTransactionMemo", workspaceId, transactionId: personalA, memo: "本人メモ" });
    await run({ action: "saveTransactionCategory", workspaceId, transactionId: personalA, categoryId: null });
    await run({ action: "saveTransactionMemo", workspaceId, transactionId: sharedB, memo: "共有メモ" });
    assert.deepEqual((await memory.query("SELECT merchant,amount_yen,memo,category_id FROM transactions WHERE id=$1", [personalA])).rows[0],
      { merchant: "保存", amount_yen: 500, memo: "本人メモ", category_id: null });
    await run({ action: "saveTransactionMemo", workspaceId, transactionId: personalB, memo: "B本人" }, "b");
  });
  await t.test("相手の個人費の新規作成・共有からの変更をサービスとDB確定境界で拒否する", async () => {
    const before = await snapshot();
    for (const transactionId of [undefined, sharedB]) {
      await assert.rejects(run({ ...save, transactionId, actorUserId: "b" }), /個人費は本人/);
      assert.deepEqual(await snapshot(), before);
    }
    await assert.rejects(store.insertTransaction({ ...save, actorUserId: "b" }, users.a,
      { expenseClass: "PERSONAL", splitWeights: { a: 0, b: 1 } }, randomUUID()), /個人費は本人/);
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(run({ action: "applyTransactionRules", workspaceId, transactionIds: [sharedA, sharedB] }), /個人費は本人/);
    assert.deepEqual(await snapshot(), before);
  });
  await t.test("事前確認後の脱退も保存transactionで検出し、個人費を変更しない", async () => {
    beforeBatch = async () => { await memory.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='b'", [workspaceId]); };
    await assert.rejects(run({ action: "deleteTransaction", workspaceId, transactionId: personalB }, "b"), /権限がありません/);
    assert.equal((await memory.query<{ count: number }>("SELECT count(*)::int AS count FROM transactions WHERE id=$1", [personalB])).rows[0].count, 1);
    await memory.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'b','MEMBER')", [workspaceId]);
  });
  await t.test("共有カテゴリ削除は参照を全解除し、応答には相手個人費のIDや件数を含めない", async () => {
    const result = await run({ action: "deleteCategory", workspaceId, categoryId });
    assert.ok("detachedTransactions" in result && Array.isArray(result.detachedTransactions));
    assert.deepEqual(new Set(result.detachedTransactions.map(row => row.transactionId)), new Set([sharedA, sharedB]));
    assert.equal(JSON.stringify(result).includes(personalB), false);
    assert.equal((await memory.query<{ count: number }>("SELECT count(*)::int AS count FROM transactions WHERE category_id=$1", [categoryId])).rows[0].count, 0);
    await run({ action: "deleteTransaction", workspaceId, transactionId: personalA });
    await run({ action: "deleteTransactions", workspaceId, transactionIds: [personalB] }, "b");
  });
});

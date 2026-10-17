import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neonConfig } from "@neondatabase/serverless";
import { createAppService } from "../lib/app-service";
import { createAppStore } from "../lib/app-store";

// Exercise the real store statement in disposable PostgreSQL through Neon's HTTP decoding.
// No configured DB, provider credentials or external network are used.
test("清算済みworkspace削除は関連だけを一回のSQLで除去し、失敗時は全体をrollbackする", async (t) => {
  const sql = new PGlite({ extensions: { pgcrypto } });
  t.after(() => sql.close());
  const directory = new URL("../db/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) await sql.exec(await readFile(new URL(file, directory), "utf8"));
  await sql.exec("INSERT INTO app_users(id,email,name) VALUES ('a','a@example.test','A'),('b','b@example.test','B')");
  const user = { id: "a", email: "a@example.test", name: "A", imageUrl: null };
  async function createWorkspace(name: string) {
    const { rows: [workspace] } = await sql.query<{ id: string }>("INSERT INTO workspaces(name,type,owner_user_id) VALUES ($1,'SHARED','a') RETURNING id", [name]);
    const id = workspace.id;
    await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'a','OWNER'),($1,'b','MEMBER')", [id]);
    await sql.query("INSERT INTO invitations(workspace_id,email,token_hash,invited_by,expires_at) VALUES ($1,'b@example.test',$2,'a',now()+interval '7 days')", [id, id]);
    await sql.query("INSERT INTO default_rules(workspace_id,merchant_contains,expense_class,created_by) VALUES ($1,'QA','SHARED','a')", [id]);
    const { rows: [batch] } = await sql.query<{ id: string }>("INSERT INTO import_batches(workspace_id,imported_by,file_name,total_rows,imported_rows,skipped_rows) VALUES ($1,'a','qa.csv',1,1,0) RETURNING id", [id]);
    const { rows: [transaction] } = await sql.query<{ id: string }>(`INSERT INTO transactions(workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,expense_class,split_weights,external_id,created_by,updated_by,settled_at,import_batch_id)
      VALUES ($1,now(),'QA','QA','PAYMENT',100,'a','SHARED','{"a":1,"b":1}',$3,'a','a',now(),$2) RETURNING id`, [id, batch.id, id]);
    const { rows: [settlement] } = await sql.query<{ id: string }>("INSERT INTO settlements(id,workspace_id,amount_yen,weight_snapshot,calculation_snapshot,completed_by) VALUES (gen_random_uuid(),$1,50,'{}','{}','a') RETURNING id", [id]);
    await sql.query("INSERT INTO settlement_transactions(settlement_id,transaction_id) VALUES ($1,$2)", [settlement.id, transaction.id]);
    return { id, transactionId: transaction.id, settlementId: settlement.id };
  }
  const target = await createWorkspace("削除対象"), survivor = await createWorkspace("維持対象");
  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  process.env.DATABASE_URL = "postgresql://fixture:fixture@mock.neon.tech/workspace_delete";
  process.env.DB_QUERY_LOG = "off";
  t.after(() => {
    neonConfig.fetchFunction = previous.fetch;
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
    if (previous.logging === undefined) delete process.env.DB_QUERY_LOG; else process.env.DB_QUERY_LOG = previous.logging;
  });
  const requests: string[] = [];
  neonConfig.fetchFunction = async (_url: RequestInfo | URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; params: string[]; queries?: unknown[] };
    assert.equal(body.queries, undefined, "所属SELECTと削除の一回ずつを保つ");
    requests.push(body.query);
    try {
      const { rows, fields } = await sql.query(body.query, body.params);
      return new Response(JSON.stringify({ fields: fields.map(field => ({ name: field.name, dataTypeID: field.dataTypeID })), rows: rows.map(row => fields.map(field => (row as Record<string, unknown>)[field.name])) }), { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ message: (error as Error).message, code: (error as { code: string }).code }), { status: 400 });
    }
  };
  const service = createAppService(createAppStore());
  assert.deepEqual(await service.execute(user, { action: "deleteWorkspace", workspaceId: target.id, confirmationName: "削除対象" }), { ok: true });
  assert.equal(requests.length, 2);
  for (const table of ["workspaces", "workspace_members", "invitations", "default_rules", "import_batches", "transactions", "settlements"]) {
    const column = table === "workspaces" ? "id" : "workspace_id";
    assert.equal((await sql.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column}=$1`, [target.id])).rows[0].count, 0, table);
  }
  assert.deepEqual((await sql.query("SELECT settlement_id::text,transaction_id::text FROM settlement_transactions")).rows, [{ settlement_id: survivor.settlementId, transaction_id: survivor.transactionId }]);
  await sql.exec("CREATE TABLE fixture_delete_blocker(workspace_id uuid REFERENCES workspaces(id) ON DELETE RESTRICT)");
  await sql.query("INSERT INTO fixture_delete_blocker VALUES ($1)", [survivor.id]);
  requests.length = 0;
  await assert.rejects(service.execute(user, { action: "deleteWorkspace", workspaceId: survivor.id, confirmationName: "維持対象" }), /foreign key constraint/);
  assert.equal(requests.length, 2);
  assert.deepEqual((await sql.query("SELECT settlement_id::text,transaction_id::text FROM settlement_transactions")).rows, [{ settlement_id: survivor.settlementId, transaction_id: survivor.transactionId }]);
  assert.equal((await sql.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM workspaces WHERE id=$1", [survivor.id])).rows[0].count, 1);
});

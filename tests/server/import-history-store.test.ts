import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neonConfig } from "@neondatabase/serverless";
import { findImportHistory } from "../../lib/server/stores/import-history-store";

test("取込履歴の実SQLは形式・家計を限定し取込者ごとの最新5件と所属境界を保証する", async t => {
  const memory = new PGlite({ extensions: { pgcrypto } });
  t.after(() => memory.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql") && name < "022").sort()) {
    await memory.exec(await readFile(new URL(name, directory), "utf8"));
  }
  await memory.exec(`INSERT INTO app_users(id,email,name) VALUES
    ('a','a@example.test','同じ名前'),('b','b@example.test','同じ名前'),
    ('former','former@example.test','以前の取込者'),('outside','outside@example.test','別家計の利用者')`);
  const workspaceId = randomUUID(), otherWorkspaceId = randomUUID();
  await memory.query(`INSERT INTO workspaces(id,name,type,owner_user_id)
    VALUES ($1,'取込履歴','SHARED','a'),($2,'別家計','PERSONAL','outside')`, [workspaceId, otherWorkspaceId]);
  await memory.query(`INSERT INTO workspace_members(workspace_id,user_id,role)
    VALUES ($1,'a','OWNER'),($1,'former','MEMBER'),($2,'outside','OWNER')`, [workspaceId, otherWorkspaceId]);
  const legacyId = randomUUID();
  await memory.query(`INSERT INTO import_batches(id,workspace_id,imported_by,file_name,total_rows,imported_rows,skipped_rows,created_at)
    VALUES ($1,$2,'former','移行前.csv',4,0,4,'2026-10-01T00:00:00.123456Z')`, [legacyId, workspaceId]);
  await memory.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='former'", [workspaceId]);
  await memory.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'b','MEMBER')", [workspaceId]);
  await memory.exec(await readFile(new URL("022_import_history.sql", directory), "utf8"));

  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  process.env.DATABASE_URL = "postgresql://fixture:fixture@mock.neon.tech/import_history";
  process.env.DB_QUERY_LOG = "off";
  t.after(() => {
    neonConfig.fetchFunction = previous.fetch;
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
    if (previous.logging === undefined) delete process.env.DB_QUERY_LOG; else process.env.DB_QUERY_LOG = previous.logging;
  });
  const queries: { query: string; params: string[] }[] = [];
  let beforeHistory: (() => Promise<unknown>) | undefined;
  neonConfig.fetchFunction = async (_url: RequestInfo | URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; params: string[] };
    queries.push(body);
    if (body.query.includes("WITH ranked")) {
      const hook = beforeHistory; beforeHistory = undefined;
      await hook?.();
    }
    const result = await memory.query<Record<string, unknown>>(body.query, body.params);
    return Response.json({ fields: result.fields, rows: result.rows.map(row => result.fields.map(field => {
      const value = row[field.name];
      return value == null ? null : String(value);
    })) });
  };
  const history = async (user = "a", workspace = workspaceId) => {
    const before = queries.length;
    const result = await findImportHistory(workspace, user, "PAYPAY");
    assert.equal(queries.length - before, 2, "取込者数・履歴件数に関係なく所属と履歴の固定2往復");
    return result.history;
  };
  const insert = async (user: string, createdAt: string, options: { id?: string; workspace?: string; format?: string; imported?: number } = {}) => {
    const id = options.id ?? randomUUID(), imported = options.imported ?? 1;
    await memory.query(`INSERT INTO import_batches(id,workspace_id,imported_by,file_name,total_rows,imported_rows,skipped_rows,created_at,format)
      VALUES ($1,$2,$3,$4,4,$5,$6,$7,$8)`,
    [id, options.workspace ?? workspaceId, user, `${id}.csv`, imported, 4 - imported, createdAt, options.format ?? "PAYPAY"]);
    return id;
  };

  await t.test("移行前の履歴と旧INSERTをPayPayとして保持し、元取込者・0件登録・日時精度を返す", async () => {
    const saved = await history();
    assert.deepEqual(saved, [{
      id: legacyId, format: "PAYPAY", importedBy: "former", importedByName: "以前の取込者", fileName: "移行前.csv",
      totalRows: 4, importedRows: 0, skippedRows: 4, createdAt: "2026-10-01T00:00:00.123456Z",
    }]);
    const oldInsert = (await memory.query<{ format: string }>(`INSERT INTO import_batches(workspace_id,imported_by,file_name,total_rows,imported_rows,skipped_rows)
      VALUES ($1,'a','旧アプリ.csv',1,1,0) RETURNING format`, [workspaceId])).rows[0];
    assert.equal(oldInsert.format, "PAYPAY");
    await memory.query("DELETE FROM import_batches WHERE file_name='旧アプリ.csv'");
    await assert.rejects(insert("a", "2026-10-01T00:00:00Z", { format: "UNKNOWN" }), /import_batches_format_check/);
  });

  const aIds: string[] = [], bIds: string[] = [];
  await t.test("同名の取込者もID別に最新5件を選び、全体を日時・UUID降順に並べる", async () => {
    for (let index = 1; index <= 7; index++) {
      aIds.push(await insert("a", `2026-10-${String(index + 10).padStart(2, "0")}T00:00:00Z`, { imported: index === 7 ? 0 : 1 }));
      bIds.push(await insert("b", "2026-10-20T00:00:00.123456Z", { id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    }
    await insert("outside", "2026-10-30T00:00:00Z", { workspace: otherWorkspaceId });
    const saved = await history();
    assert.equal(saved.length, 11, "現在の取込者2人をそれぞれ5件＋元取込者1件");
    assert.deepEqual(saved.filter(row => row.importedBy === "a").map(row => row.id), aIds.slice(-5).reverse());
    assert.deepEqual(saved.filter(row => row.importedBy === "b").map(row => row.id), bIds.slice(-5).reverse());
    assert.deepEqual(saved.map(row => row.id), [...bIds.slice(-5).reverse(), ...aIds.slice(-5).reverse(), legacyId]);
    assert.equal(saved.find(row => row.id === aIds.at(-1))!.importedRows, 0);
    assert.equal(saved.find(row => row.id === aIds.at(-1))!.skippedRows, 4);
    assert.ok(saved.filter(row => ["a", "b"].includes(row.importedBy)).every(row => row.importedByName === "同じ名前"));
    assert.ok(saved.every(row => row.importedBy !== "outside"));
    assert.equal((await history("b")).length, 11, "ログインユーザー本人だけに絞らない");
  });

  await t.test("形式で絞ってから5件を選び、他形式の新しい履歴に枠を消費させない", async () => {
    // Simulate a later supported format without changing this deployment's API enum.
    await memory.exec("ALTER TABLE import_batches DROP CONSTRAINT import_batches_format_check");
    try {
      for (let index = 0; index < 6; index++) await insert("a", "2026-10-30T00:00:00Z", { format: "OTHER" });
      const saved = await history();
      assert.equal(saved.length, 11);
      assert.ok(saved.every(row => row.format === "PAYPAY"));
      assert.deepEqual(saved.filter(row => row.importedBy === "a").map(row => row.id), aIds.slice(-5).reverse());
    } finally {
      await memory.query("DELETE FROM import_batches WHERE format='OTHER'");
      await memory.exec("ALTER TABLE import_batches ADD CONSTRAINT import_batches_format_check CHECK(format IN ('PAYPAY'))");
    }
  });

  await t.test("非所属・脱退済み利用者は拒否し、所属確認後の解除でも履歴を公開しない", async () => {
    for (const user of ["outside", "former", "missing"]) {
      const before = queries.length;
      await assert.rejects(findImportHistory(workspaceId, user, "PAYPAY"), /権限がありません/);
      assert.equal(queries.length - before, 1);
    }
    beforeHistory = () => memory.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='b'", [workspaceId]);
    assert.deepEqual(await history("b"), []);
    const before = queries.length;
    await assert.rejects(findImportHistory(otherWorkspaceId, "a", "PAYPAY"), /権限がありません/);
    assert.equal(queries.length - before, 1);
  });

  await t.test("空履歴を返し、履歴照会は保存データを変更せず索引で範囲を絞れる", async () => {
    const emptyWorkspace = randomUUID();
    await memory.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1,'空履歴','PERSONAL','a')", [emptyWorkspace]);
    await memory.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'a','OWNER')", [emptyWorkspace]);
    const snapshot = async () => (await memory.query(`SELECT jsonb_build_object(
      'batches',(SELECT jsonb_agg(b ORDER BY id) FROM import_batches b),
      'workspaces',(SELECT jsonb_agg(w ORDER BY id) FROM workspaces w)) AS data`)).rows;
    const before = await snapshot();
    assert.deepEqual(await history("a", emptyWorkspace), []);
    await history();
    assert.deepEqual(await snapshot(), before);
    const query = queries.at(-1)!;
    await memory.exec("SET enable_seqscan=off");
    try {
      const plan = await memory.query("EXPLAIN (FORMAT JSON) " + query.query, query.params);
      assert.match(JSON.stringify(plan.rows), /import_batches_workspace_format_importer_history_idx/);
    } finally { await memory.exec("RESET enable_seqscan"); }
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neonConfig } from "@neondatabase/serverless";
import { findImportDuplicates } from "../../lib/server/stores/import-duplicates-store";
import { findImportCategorySuggestions } from "../../lib/server/stores/import-category-suggestions-store";

test("カテゴリ補完の実SQLは取引先別30件・最多と最新順・所属境界・一括照会を保証する", async t => {
  const memory = new PGlite({ extensions: { pgcrypto } });
  t.after(() => memory.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
    await memory.exec(await readFile(new URL(name, directory), "utf8"));
  }
  await memory.exec("INSERT INTO app_users(id,email,name) VALUES ('a','a@example.test','A'),('b','b@example.test','B'),('outside','outside@example.test','Outside')");
  const workspaceId = randomUUID(), otherWorkspaceId = randomUUID();
  await memory.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1,'補完テスト','SHARED','a'),($2,'別家計','PERSONAL','outside')", [workspaceId, otherWorkspaceId]);
  await memory.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'a','OWNER'),($1,'b','MEMBER'),($2,'outside','OWNER')", [workspaceId, otherWorkspaceId]);
  const categoryA = randomUUID(), categoryB = randomUUID(), archived = randomUUID(), foreign = randomUUID();
  await memory.query(`INSERT INTO categories(id,workspace_id,name,color_hex,sort_order,created_by,updated_by)
    VALUES ($1,$5,'食費','#f97316',0,'a','a'),($2,$5,'日用品','#000000',1,'a','a'),
      ($3,$5,'使用停止','#000000',2,'a','a'),($4,$6,'別家計カテゴリ','#000000',0,'outside','outside')`,
  [categoryA, categoryB, archived, foreign, workspaceId, otherWorkspaceId]);
  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  process.env.DATABASE_URL = "postgresql://fixture:fixture@mock.neon.tech/category_suggestions";
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
      return value == null ? null : String(value);
    })) });
  };
  type History = { id?: string; occurredAt?: string; createdAt?: string; actor?: string; source?: string; settled?: boolean;
    workspace?: string; type?: string; confirmed?: boolean; expenseClass?: string };
  const insert = async (merchant: string, category: string | null, options: History = {}) => {
    const id = options.id ?? randomUUID(), actor = options.actor ?? "a";
    const workspace = options.workspace ?? workspaceId;
    await memory.query(`INSERT INTO transactions(id,workspace_id,occurred_at,created_at,merchant,method,type,amount_yen,
      actor_user_id,expense_class,split_weights,external_id,source,created_by,updated_by,category_id,settled_at)
      VALUES ($1::uuid,$2,$3,$4,$5,'現金',$6,100,$7,$11,jsonb_build_object($7::text,1),$1::text,$8,$7,$7,$9,$10)`,
    [id, workspace, options.occurredAt ?? "2026-10-01T00:00:00Z", options.createdAt ?? "2026-10-01T00:00:00Z", merchant,
      options.type ?? "PAYMENT", actor, options.source ?? "MANUAL", category, options.settled ? "2026-10-02T00:00:00Z" : null, options.expenseClass ?? "PERSONAL"]);
    if (options.confirmed === false) {
      // Existing/legacy unconfirmed categories must not become evidence. The
      // ordinary current assignment trigger confirms categories on write.
      await memory.exec("ALTER TABLE transactions DISABLE TRIGGER transactions_category_guard");
      try { await memory.query("UPDATE transactions SET category_confirmed=false WHERE id=$1", [id]); }
      finally { await memory.exec("ALTER TABLE transactions ENABLE TRIGGER transactions_category_guard"); }
    }
    return id;
  };
  const suggest = async (merchants: string[], user = "a") => {
    const start = queries.length;
    const result = await findImportCategorySuggestions(workspaceId, user, merchants);
    assert.equal(queries.length - start, 2, "取引先件数に関係なく所属確認と一括候補取得の2往復");
    return result.suggestions;
  };

  await t.test("取引先ごとの最新30件から最多を選び、古い31件目を票数に含めない", async () => {
    for (let index = 0; index < 31; index++) {
      await insert("30件境界", index <= 15 ? categoryA : categoryB, {
        occurredAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      });
    }
    for (const category of [categoryA, categoryA, categoryA, categoryB, categoryB]) await insert("最多優先", category);
    assert.deepEqual(await suggest(["30件境界", "最多優先", "履歴なし"]), [
      { merchant: "30件境界", categoryId: categoryB }, { merchant: "最多優先", categoryId: categoryA }, { merchant: "履歴なし", categoryId: null },
    ]);
  });

  await t.test("同率は取引日時・作成日時・UUID降順で決まり、日時のマイクロ秒を保持する", async () => {
    await insert("日時同率", categoryA, { occurredAt: "2026-10-10T00:00:00.123455Z" });
    await insert("日時同率", categoryB, { occurredAt: "2026-10-10T00:00:00.123456Z" });
    await insert("作成同率", categoryA, { createdAt: "2026-10-11T00:00:00.123455Z" });
    await insert("作成同率", categoryB, { createdAt: "2026-10-11T00:00:00.123456Z" });
    await insert("UUID同率", categoryA, { id: "00000000-0000-4000-8000-000000000001" });
    await insert("UUID同率", categoryB, { id: "00000000-0000-4000-8000-000000000002" });
    assert.deepEqual(await suggest(["日時同率", "作成同率", "UUID同率"]),
      ["日時同率", "作成同率", "UUID同率"].map(merchant => ({ merchant, categoryId: categoryB })));
  });

  await t.test("DBのUnicode正規化で完全一致し、raw重複除去と元の表記・順序を保持する", async () => {
    await insert("ＳＨＯＰ　Ａ", categoryA);
    await insert("İ ΟΣ ΟΣΑ ẞ", categoryB);
    const merchants = ["shop a", "  ＳＨＯＰ　Ａ  ", "shop a", "i\u0307 ος οσα ß", "shop", "shop a 支店"];
    assert.deepEqual(await suggest(merchants), [
      { merchant: "shop a", categoryId: categoryA }, { merchant: "  ＳＨＯＰ　Ａ  ", categoryId: categoryA },
      { merchant: "i\u0307 ος οσα ß", categoryId: categoryB }, { merchant: "shop", categoryId: null }, { merchant: "shop a 支店", categoryId: null },
    ]);
    const query = queries.at(-1)!;
    assert.deepEqual(JSON.parse(query.params[0]), [...new Set(merchants)]);
    assert.match(query.query, /SELECT DISTINCT merchant_normalized/);
  });

  await t.test("可視範囲の全source・清算済みを含め、不正な履歴と別workspaceを除外してから30件を抽出する", async () => {
    await insert("対象範囲", categoryA, { actor: "a", source: "MANUAL" });
    await insert("対象範囲", categoryA, { actor: "b", source: "PAYPAY", settled: true, expenseClass: "SHARED" });
    await insert("対象範囲", categoryA, { actor: "b", source: "RECURRING", expenseClass: "SHARED" });
    await insert("対象範囲", categoryB, { occurredAt: "2026-10-10T00:00:00Z" });
    await insert("手動履歴だけ", categoryA, { source: "MANUAL" });
    await insert("清算済CSV履歴だけ", categoryB, { actor: "b", source: "PAYPAY", settled: true, expenseClass: "SHARED" });
    await insert("定期履歴だけ", categoryA, { actor: "b", source: "RECURRING", expenseClass: "SHARED" });
    for (let index = 0; index < 31; index++) {
      await insert("対象範囲", index % 2 ? categoryB : null, { occurredAt: "2026-10-11T00:00:00Z", confirmed: false });
      await insert("対象範囲", categoryB, { occurredAt: "2026-10-11T00:00:00Z", type: "RECEIPT" });
      await insert("対象範囲", archived, { occurredAt: "2026-10-11T00:00:00Z" });
      await insert("対象範囲", foreign, { occurredAt: "2026-10-11T00:00:00Z", workspace: otherWorkspaceId, actor: "outside" });
    }
    await memory.query("UPDATE categories SET archived_at=now() WHERE id=$1", [archived]);
    assert.deepEqual(await suggest(["対象範囲", "手動履歴だけ", "清算済CSV履歴だけ", "定期履歴だけ"]), [
      { merchant: "対象範囲", categoryId: categoryA }, { merchant: "手動履歴だけ", categoryId: categoryA },
      { merchant: "清算済CSV履歴だけ", categoryId: categoryB }, { merchant: "定期履歴だけ", categoryId: categoryA },
    ]);
  });

  await t.test("相手の個人費は重複照合・カテゴリ候補・最新30件の枠に含めない", async () => {
    const privateId = await insert("相手の個人費", categoryB, { actor: "b" });
    const sharedId = await insert("共有の履歴", categoryA, { actor: "b", expenseClass: "SHARED" });
    const ownId = await insert("自分の個人費", categoryA);
    await insert("非公開の多数履歴", categoryA);
    for (let index = 0; index < 31; index++) {
      await insert("非公開の多数履歴", categoryB, { actor: "b", occurredAt: "2026-10-20T00:00Z" });
    }
    assert.deepEqual(await suggest(["相手の個人費", "共有の履歴", "自分の個人費", "非公開の多数履歴"]), [
      { merchant: "相手の個人費", categoryId: null }, { merchant: "共有の履歴", categoryId: categoryA },
      { merchant: "自分の個人費", categoryId: categoryA }, { merchant: "非公開の多数履歴", categoryId: categoryA },
    ]);
    assert.deepEqual(await suggest(["相手の個人費"], "b"), [{ merchant: "相手の個人費", categoryId: categoryB }]);
    const keys = [privateId, sharedId, ownId];
    const found = await findImportDuplicates(workspaceId, "a", keys);
    assert.deepEqual(new Set(found.externalIds), new Set([sharedId, ownId]));
    assert.ok(!JSON.stringify(found).includes("相手の個人費"));
    assert.deepEqual(new Set((await findImportDuplicates(workspaceId, "b", keys)).externalIds), new Set([privateId, sharedId]));
  });

  await t.test("非所属・所属削除済み利用者は履歴照会前に拒否し、他の家計の履歴を公開しない", async () => {
    for (const user of ["outside", "missing"]) {
      const start = queries.length;
      await assert.rejects(findImportCategorySuggestions(workspaceId, user, ["対象範囲"]), /権限がありません/);
      assert.equal(queries.length - start, 1);
    }
    await memory.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id='b'", [workspaceId]);
    const start = queries.length;
    await assert.rejects(findImportCategorySuggestions(workspaceId, "b", ["対象範囲"]), /権限がありません/);
    assert.equal(queries.length - start, 1);
  });

  await t.test("最大2000取引先も一括取得し、partial Indexを使って取引先別の履歴を取得できる", async () => {
    const merchants = Array.from({ length: 2000 }, (_, index) => `未登録-${index}`);
    assert.deepEqual(await suggest(merchants), merchants.map(merchant => ({ merchant, categoryId: null })));
    const query = queries.at(-1)!;
    const index = (await memory.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname='transactions_workspace_merchant_category_history_idx'")).rows[0].indexdef;
    assert.match(index, /workspace_id, merchant_normalized, occurred_at DESC, created_at DESC, id DESC/);
    await memory.exec("SET enable_seqscan=off");
    try {
      const plan = await memory.query("EXPLAIN (FORMAT JSON) " + query.query, query.params);
      assert.match(JSON.stringify(plan.rows), /transactions_workspace_merchant_category_history_idx/);
    } finally { await memory.exec("RESET enable_seqscan"); }
  });

  await t.test("候補照会は保存済みの明細・カテゴリ・workspaceを変更しない", async () => {
    const snapshot = async () => (await memory.query(`SELECT jsonb_build_object(
      'transactions',(SELECT jsonb_agg(t ORDER BY id) FROM transactions t),
      'categories',(SELECT jsonb_agg(c ORDER BY id) FROM categories c),
      'workspaces',(SELECT jsonb_agg(w ORDER BY id) FROM workspaces w)) AS data`)).rows;
    const before = await snapshot();
    await suggest(["30件境界", "対象範囲", "履歴なし"]);
    assert.deepEqual(await snapshot(), before);
  });
});

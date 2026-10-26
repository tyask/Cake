import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { createCsvCategoryImportCapture } from "../../scripts/qa/db/csv-category-concurrency-scenarios";
import { appActionInputSchema } from "../../lib/shared/schemas/app-input";

test("CSVの編集した取引先・改行メモを実SQLで保存し、旧入力・既存重複・競合rollbackを維持する", async t => {
  const sql = new PGlite({ extensions: { pgcrypto } });
  t.after(() => sql.close());
  const directory = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
    await sql.exec(await readFile(new URL(name, directory), "utf8"));
  }
  const workspaceId = randomUUID();
  await sql.exec("INSERT INTO app_users(id,email,name,is_enabled,is_admin) VALUES ('a','a@cake.local','A',true,true)");
  await sql.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1,'CSV検証','PERSONAL','a')", [workspaceId]);
  await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,'a','OWNER')", [workspaceId]);
  const capture = await createCsvCategoryImportCapture();
  const item = { occurredAt: "2026-10-18T03:00:42.000Z", merchant: "  編集した店舗  ", memo: "  メモ\n2行目  ",
    method: "PayPay", amountYen: 100, externalId: "first", actorUserId: "a", expenseClass: "PERSONAL" as const, splitWeights: { a: 1 } };
  async function save(items: Array<Omit<typeof item, "memo"> & { memo?: string }>) {
    const parsed = appActionInputSchema.parse({ action: "bulkImport", workspaceId, fileName: "edited.csv", totalRows: items.length, items });
    assert.equal(parsed.action, "bulkImport");
    if (parsed.action !== "bulkImport") throw new Error("unexpected action");
    const captured = await capture({ ...parsed, userId: "a", items: parsed.items.map(row => ({ ...row, expenseClass: "PERSONAL", splitWeights: { a: 1 } })) });
    return sql.transaction(async tx => {
      let result;
      for (const query of captured.queries) result = await tx.query(query.query, query.params);
      return result!.rows;
    });
  }
  assert.deepEqual(await save([item, { ...item, externalId: "legacy", memo: undefined }]), [{ imported_rows: 2, skipped_rows: 0 }]);
  const rows = async () => (await sql.query("SELECT merchant,memo,external_id FROM transactions ORDER BY external_id")).rows;
  const before = await rows();
  assert.deepEqual(before, [
    { merchant: "編集した店舗", memo: item.memo, external_id: "PayPay_20261018120042_first" },
    { merchant: "編集した店舗", memo: "", external_id: "PayPay_20261018120042_legacy" },
  ]);
  assert.deepEqual(await save([{ ...item, memo: "上書きしない" }]), [{ imported_rows: 0, skipped_rows: 1 }]);
  assert.deepEqual(await rows(), before);
  const batches = (await sql.query("SELECT count(*)::int AS n FROM import_batches")).rows;
  await assert.rejects(save([{ ...item, externalId: "aaa-new" }, { ...item, merchant: "衝突する店舗" }]));
  assert.deepEqual(await rows(), before, "競合時は先に挿入した行も取り消す");
  assert.deepEqual((await sql.query("SELECT count(*)::int AS n FROM import_batches")).rows, batches);
});

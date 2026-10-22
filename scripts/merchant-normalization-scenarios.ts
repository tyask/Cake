import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createCsvCategoryImportCapture } from "./csv-category-concurrency-scenarios";
import { previewSampleDataSql } from "./preview-sample-data";
import { transactionRecord } from "../lib/transaction-record";
import type { PayPayImportItem } from "../lib/paypay-import";

export type MerchantNormalizationDatabase = {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};
type Statement = { query: string; params: unknown[] };
type Options = { actorA: string; actorB: string; prefix: string;
  runCase?: (name: string, run: () => Promise<void>) => Promise<void>;
};
type FailureStage = "preflight" | "capture" | "setup" | "case" | "rollback" | "cleanup-delete" | "cleanup-count" | "cleanup-residual";
type CleanupTable = "workspaces" | "workspace_members" | "transactions" | "import_batches" | "categories" | "recurring_payments";
export type MerchantNormalizationReport = {
  success: boolean; cases: { name: string; status: "passed" | "failed"; seconds: number }[]; ownedWorkspaceIds: string[];
  cleanup: Record<CleanupTable, number>;
  failures: { stage: FailureStage; code: string; caseName?: string; table?: CleanupTable }[];
  sqlContract: { manual: number; csv: number; maximumCsvRows: number }; seconds: number;
};
const safeFailureCode = (error: unknown) => {
  try {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code
      : code === "ERR_ASSERTION" ? "ASSERTION_FAILED" : "SCENARIO_FAILED";
  } catch { return "SCENARIO_FAILED"; }
};

// Expected values are a versioned DB contract, never derived with JS lower/NFKC.
export const merchantNormalizationCases = [
  ["ＡＢＣスーパー", "abcスーパー"], ["abcスーパー", "abcスーパー"],
  ["  ABC\t \r\n スーパー  ", "abc スーパー"], ["ABCスーパー", "abcスーパー"],
  ["ABC 東京店", "abc 東京店"], ["ABC 大阪店", "abc 大阪店"],
  ["㈱ＡＢＣ　東京１-２", "(株)abc 東京1-2"], ["ｶﾞｽ・ガス", "ガス・ガス"],
  ["Cafe\u0301 ＣＡＦÉ", "café café"], ["K ㍿ ①", "k 株式会社 1"],
  ["İ ΟΣ ΟΣΑ ẞ", "i\u0307 ος οσα ß"],
  ["\u0085ABC\u0085", "\u0085abc\u0085"], ["\u200bABC\u200b", "\u200babc\u200b"],
  ["\ufeff\u1680A\u2028\u2029B\ufeff", "a b"],
  ["\ua7ce\ua7f1", "\ua7ce\ua7f1"], // PG18 Unicode16, even if Node knows newer mappings.
  ["  \t\n", ""], ["㌕".repeat(240), "キログラム".repeat(240)],
] as const;
export const merchantWhitespaceCodePoints = [9, 10, 11, 12, 13, 32, 160, 5760,
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
  8232, 8233, 8239, 8287, 12288, 65279] as const;

/** Capture current manual store SQL in a private in-memory bundle, never configured db()/env/fetch. */
async function createManualCapture() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundled = await build({ stdin: { resolveDir: root, sourcefile: "merchant-manual-capture.ts", contents: `
    import { neonConfig } from "@neondatabase/serverless";
    import { createAppStore } from "./lib/app-store";
    export async function capture(operation, input, actor, split, id) {
      const previous = neonConfig.fetchFunction, batches = [];
      neonConfig.fetchFunction = async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (!Array.isArray(body.queries)) throw new Error("TRANSACTION_REQUIRED");
        batches.push(body.queries);
        return new Response(JSON.stringify({ results: body.queries.map(() => ({ fields: [], rows: [], rowCount: 0, command: "SELECT" })) }), { status: 200 });
      };
      try {
        const store = createAppStore();
        if (operation === "insert") await store.insertTransaction(input, actor, split, id);
        else await store.updateTransaction(input, actor, split);
        if (batches.length !== 1) throw new Error("SINGLE_TRANSACTION_REQUIRED");
        return batches[0];
      } finally { neonConfig.fetchFunction = previous; }
    }` }, bundle: true, write: false, platform: "node", format: "cjs", target: "node24", logLevel: "silent",
    plugins: [{ name: "offline-manual-db", setup(plugin) {
      plugin.onResolve({ filter: /^\.\/db$/ }, args => args.importer.startsWith(resolve(root, "lib") + "/")
        ? { path: "offline-db", namespace: "offline-db" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "offline-db" }, () => ({ loader: "js", resolveDir: root,
        contents: `import { neon } from "@neondatabase/serverless"; const sql = neon("postgresql://qa:qa@ep-capture.neon.tech/offline"); export function db() { return sql; }` }));
    } }],
  });
  type Capture = (operation: "insert" | "update", input: Record<string, unknown>, actor: Record<string, unknown>, split: Record<string, unknown>, id?: string) => Promise<Statement[]>;
  const compiled = { exports: {} as { capture: Capture } };
  new Function("module", "exports", "require", bundled.outputFiles[0].text)(compiled, compiled.exports, createRequire(import.meta.url));
  return compiled.exports.capture;
}

/** Caller validates the dedicated DB first. This creates/deletes only uniquely named owned workspaces. */
export async function verifyMerchantNormalizationScenarios(sql: MerchantNormalizationDatabase, options: Options): Promise<MerchantNormalizationReport> {
  const started = performance.now(), workspaceIds = [randomUUID(), randomUUID(), randomUUID()];
  const [target, foreign, sample] = workspaceIds;
  const report: MerchantNormalizationReport = { success: false, cases: [], ownedWorkspaceIds: workspaceIds,
    cleanup: { workspaces: -1, workspace_members: -1, transactions: -1, import_batches: -1, categories: -1, recurring_payments: -1 },
    failures: [], sqlContract: { manual: 2, csv: 4, maximumCsvRows: 2000 }, seconds: 0 };
  const weights = { [options.actorA]: 1, [options.actorB]: 1 };
  const actor = { id: options.actorA, email: "fixture@example.invalid", name: "QA", imageUrl: null };
  let active = false, setupAttempted = false, stage: FailureStage = "preflight", currentCase: string | undefined;
  function failure(at: FailureStage, error: unknown, table?: CleanupTable) {
    report.failures.push({ stage: at, code: safeFailureCode(error), ...(currentCase ? { caseName: currentCase } : {}), ...(table ? { table } : {}) });
  }
  async function rollback() {
    if (!active) return true;
    try { await sql.query("ROLLBACK"); active = false; return true; }
    catch (error) { failure("rollback", error); return false; }
  }
  async function atomic<T>(run: () => Promise<T>) {
    active = true;
    try { await sql.query("BEGIN"); const result = await run(); await sql.query("COMMIT"); active = false; return result; }
    catch (error) { await rollback(); throw error; }
  }
  async function replay(queries: Statement[]) {
    return atomic(async () => {
      const result = [];
      for (const statement of queries) result.push(await sql.query(statement.query, statement.params));
      return result;
    });
  }
  async function check(name: string, run: () => Promise<void>) {
    const at = performance.now();
    stage = "case"; currentCase = name;
    try {
      let completed = false;
      const invoke = async () => { await run(); completed = true; };
      if (options.runCase) await options.runCase(name, invoke); else await invoke();
      assert.equal(completed, true);
      report.cases.push({ name, status: "passed", seconds: (performance.now() - at) / 1000 });
      currentCase = undefined;
    } catch (error) {
      report.cases.push({ name, status: "failed", seconds: (performance.now() - at) / 1000 });
      throw error;
    }
  }
  async function snapshot(workspaceId = target) {
    return (await sql.query(`SELECT jsonb_build_object(
      'workspace',(SELECT to_jsonb(w) FROM workspaces w WHERE id=$1::uuid),
      'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM transactions t WHERE workspace_id=$1::uuid),
      'batches',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM import_batches b WHERE workspace_id=$1::uuid)
    ) AS data`, [workspaceId])).rows[0].data;
  }
  async function insertLegacy(merchant: string, workspaceId = target, extraColumn = "", extraValue = "") {
    return (await sql.query(`INSERT INTO transactions(workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,
      expense_class,external_id,created_by,updated_by${extraColumn})
      VALUES ($1::uuid,'2026-10-10T00:00:00.123456Z',$2,'現金','PAYMENT',100,$3,'SHARED',$4,$3,$3${extraValue}) RETURNING *`,
    [workspaceId, merchant, options.actorA, randomUUID()])).rows[0];
  }
  const item = (merchant: string, index: number): PayPayImportItem => ({ occurredAt: "2026-10-10T00:00:00.123Z",
    merchant, method: "PayPay", amountYen: 100 + index, externalId: `${options.prefix}-${index}`,
    actorUserId: options.actorA, expenseClass: "SHARED", splitWeights: weights });
  try {
    assert.match(options.prefix, /^verify-merchant-[a-z0-9-]{1,60}$/);
    assert.notEqual(options.actorA, options.actorB);
    stage = "capture";
    const manual = await createManualCapture(), captureImport = await createCsvCategoryImportCapture();
    stage = "setup"; setupAttempted = true;
    for (const id of workspaceIds) await atomic(async () => {
      await sql.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1::uuid,$2,'SHARED',$3)", [id, options.prefix, options.actorA]);
      await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1::uuid,$2,'OWNER'),($1::uuid,$3,'MEMBER')", [id, options.actorA, options.actorB]);
    });
    await check("固定Unicode・NFKC・大小文字・25種空白の同じSQL規則を使う", async () => {
      const whitespace = merchantWhitespaceCodePoints.map(cp => String.fromCodePoint(cp)).join("");
      const vectors = [...merchantNormalizationCases, ...merchantWhitespaceCodePoints.map(cp =>
        [`${String.fromCodePoint(cp)}A${String.fromCodePoint(cp)}${String.fromCodePoint(cp)}B${String.fromCodePoint(cp)}`, "a b"]),
      [`${whitespace}A${whitespace}B${whitespace}`, "a b"]];
      const rows = (await sql.query(`SELECT original,expected,cake_normalize_merchant(original) AS actual
        FROM jsonb_to_recordset($1::jsonb) AS r(original text,expected text)`, [JSON.stringify(vectors.map(([original, expected]) => ({ original, expected })))] )).rows;
      assert.equal(rows.length, vectors.length);
      for (const row of rows) assert.equal(row.actual, row.expected);
      assert.equal((await sql.query("SELECT cake_normalize_merchant(NULL) AS value")).rows[0].value, null);
    });
    await check("列を知らない旧INSERT/UPDATEと直接SQLでも表示を保持し正規化値を同時更新する", async () => {
      const saved = await insertLegacy("  ＡＢＣ\t スーパー  ");
      assert.equal(saved.merchant, "  ＡＢＣ\t スーパー  "); assert.equal(saved.merchant_normalized, "abc スーパー");
      const updated = (await sql.query("UPDATE transactions SET merchant='ＢＢＢ　大阪店' WHERE id=$1::uuid RETURNING *", [saved.id])).rows[0];
      assert.equal(updated.merchant, "ＢＢＢ　大阪店"); assert.equal(updated.merchant_normalized, "bbb 大阪店");
      const before = { ...saved }, after = { ...updated };
      delete before.merchant; delete before.merchant_normalized;
      delete after.merchant; delete after.merchant_normalized;
      assert.deepEqual(after, before);
      const snapshotBefore = await snapshot();
      for (const value of ["'forged'", "NULL"]) {
        await assert.rejects(sql.query(`UPDATE transactions SET merchant_normalized=${value} WHERE id=$1::uuid`, [saved.id]), { code: "428C9" });
      }
      await assert.rejects(insertLegacy("ＡＢＣ", target, ",merchant_normalized", ",'forged'"), { code: "428C9" });
      assert.deepEqual(await snapshot(), snapshotBefore);
      assert.equal(Object.hasOwn(transactionRecord(updated), "merchantNormalized"), false);
      assert.equal(Object.hasOwn(transactionRecord(updated), "merchant_normalized"), false);
      assert.equal(transactionRecord(updated).merchant, updated.merchant);
    });
    await check("現在の手動追加・取引先編集は同じ2 SQLで確定行と表示用値を返す", async () => {
      const id = randomUUID();
      const input = { action: "saveTransaction", workspaceId: target, occurredAt: "2026-10-10T00:00:00.123Z",
        merchant: "ＡＢＣ　手動", method: "現金", type: "PAYMENT", amountYen: 100, actorUserId: options.actorA };
      const split = { expenseClass: "SHARED", splitWeights: weights };
      const insertedQueries = await manual("insert", input, actor, split, id);
      assert.equal(insertedQueries.length, 2);
      const saved = (await replay(insertedQueries))[1].rows[0];
      assert.equal(saved.merchant, input.merchant); assert.equal(saved.merchant_normalized, "abc 手動");
      const changed = { ...input, transactionId: id, merchant: "ＢＢＢ　変更" };
      const updatedQueries = await manual("update", changed, actor, split);
      assert.equal(updatedQueries.length, 2);
      const updated = (await replay(updatedQueries))[1].rows[0];
      assert.equal(updated.merchant, changed.merchant); assert.equal(updated.merchant_normalized, "bbb 変更");
      assert.equal(updated.category_revision, saved.category_revision); assert.equal(updated.category_id, saved.category_id);
    });
    await check("CSV2000行も4 SQLで保存し、正規化が一致しても生取引先の重複衝突規則を維持する", async () => {
      const items = Array.from({ length: 2000 }, (_, index) => item(index % 2 ? "ＡＢＣ　スーパー" : `ＡＢＣ　${index}`, index));
      const input = { workspaceId: target, userId: options.actorA, fileName: "normalization-qa.csv", totalRows: items.length, items };
      const captured = await captureImport(input);
      const result = (await replay(captured.queries))[3].rows[0];
      assert.deepEqual(result, { imported_rows: 2000, skipped_rows: 0 });
      assert.equal((await sql.query(`SELECT count(*)::int AS n FROM transactions WHERE import_batch_id=$1::uuid
        AND merchant_normalized=cake_normalize_merchant(merchant)`, [captured.batchId])).rows[0].n, 2000);
      const before = await snapshot();
      const duplicate = await captureImport({ ...input, totalRows: 1, items: [items[1]] });
      assert.deepEqual((await replay(duplicate.queries))[3].rows[0], { imported_rows: 0, skipped_rows: 1 });
      const beforeCollision = await snapshot();
      const collision = await captureImport({ ...input, totalRows: 1, items: [{ ...items[1], merchant: "abc スーパー" }] });
      await assert.rejects(replay(collision.queries), { code: "P0001" });
      assert.deepEqual(await snapshot(), beforeCollision);
      const transactionsBefore = (before as { transactions: unknown }).transactions;
      assert.deepEqual((beforeCollision as { transactions: unknown }).transactions, transactionsBefore);
    });
    await check("定期設定のDB生成関数も表示名を保持し同じ正規化列を生成する", async () => {
      const config = { dayOfMonth: 27, merchant: "ＡＢＣ　定期", method: "口座振替", amountYen: 100,
        actorUserId: options.actorA, expenseClass: "SHARED", splitWeights: weights, memo: "fixture" };
      const result = (await sql.query(`SELECT cake_mutate_recurring_payment($1::uuid,$2,'create',NULL,NULL,NULL,$3::jsonb,true,
        '2026-10-10T00:00:00Z') AS result`, [target, options.actorA, JSON.stringify(config)])).rows[0].result as { payment: { id: string } };
      const generated = (await sql.query("SELECT cake_generate_recurring_payment($1::uuid,$2::uuid,true,'2026-10-27T00:00:00Z') AS result", [target, result.payment.id])).rows[0].result as { status: string; transactionId: string };
      assert.equal(generated.status, "created");
      const saved = (await sql.query("SELECT merchant,merchant_normalized,category_id,category_confirmed FROM transactions WHERE id=$1::uuid", [generated.transactionId])).rows[0];
      assert.deepEqual(saved, { merchant: config.merchant, merchant_normalized: "abc 定期", category_id: null, category_confirmed: false });
    });
    await check("Preview seedの集合INSERTも正規化され、表示・カテゴリ・件数を維持する", async () => {
      let statement = previewSampleDataSql(sample, options.actorA, options.actorB);
      // The real seed uses globally fixed IDs; replace only those identifiers so
      // the fixture can coexist with an already seeded dedicated Preview.
      for (let index = 1; index <= 10; index++) statement = statement.replaceAll(`00000000-0000-4000-8100-${String(index).padStart(12, "0")}`, randomUUID());
      await atomic(() => sql.query(`DO $merchant_seed$ BEGIN ${statement} END; $merchant_seed$;`));
      const rows = (await sql.query("SELECT merchant,merchant_normalized FROM transactions WHERE workspace_id=$1::uuid", [sample])).rows;
      assert.equal(rows.length, 8);
      assert.ok(rows.every(row => String(row.merchant).startsWith("[サンプル] ")));
      assert.ok(rows.every(row => row.merchant_normalized === row.merchant));
      assert.equal((await sql.query("SELECT count(*)::int AS n FROM categories WHERE workspace_id=$1::uuid", [sample])).rows[0].n, 10);
    });
    await check("workspaceと正規化後の完全一致で絞り、空白・支店名を区別し複合indexを利用できる", async () => {
      const same = await insertLegacy("ＡＢＣ　東京店");
      await insertLegacy("abc 東京店", foreign); await insertLegacy("ABC大阪店"); await insertLegacy("ABC東京店");
      const query = "SELECT id FROM transactions WHERE workspace_id=$1::uuid AND merchant_normalized=cake_normalize_merchant($2)";
      assert.deepEqual((await sql.query(query, [target, "  abc\t東京店 "])).rows, [{ id: same.id }]);
      active = true; await sql.query("BEGIN");
      try {
        await sql.query("SET LOCAL enable_seqscan=off");
        const plan = JSON.stringify((await sql.query(`EXPLAIN (FORMAT JSON) ${query}`, [target, "abc 東京店"])).rows);
        assert.match(plan, /transactions_workspace_merchant_normalized_idx/);
        assert.match(plan, /Index Cond/); assert.match(plan, /workspace_id/); assert.match(plan, /merchant_normalized/);
      } finally { if (!await rollback()) throw new Error("ROLLBACK_FAILED"); }
      const expanded = await insertLegacy("㌕".repeat(240));
      assert.equal(String(expanded.merchant_normalized).length, 1200);
      // Expanded values can exceed the uncompressed Btree key limit. Exercise
      // mixed compatibility characters as well as compressible repetitions,
      // keeping the existing DB limit of 240 input code points unchanged.
      const alphabet = Array.from({ length: 256 }, (_, index) => String.fromCharCode(0x3300 + index));
      let seed = 12345;
      const expandedInputs = ["ﷺ".repeat(240), "㍿".repeat(240), ...Array.from({ length: 30 }, () =>
        Array.from({ length: 240 }, () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return alphabet[(seed >>> 16) % alphabet.length];
        }).join(""))];
      const inserted = (await sql.query(`INSERT INTO transactions(workspace_id,occurred_at,merchant,method,type,amount_yen,
        actor_user_id,expense_class,external_id,created_by,updated_by)
        SELECT $1::uuid,'2026-10-10T00:00:00Z',input.merchant,'現金','PAYMENT',100,$2,'SHARED',
          $3 || '-' || input.position::text,$2,$2
        FROM unnest($4::text[]) WITH ORDINALITY AS input(merchant,position)
        RETURNING merchant,merchant_normalized`, [target, options.actorA, randomUUID(), expandedInputs])).rows;
      assert.equal(inserted.length, 32);
      assert.equal(String(inserted[0].merchant_normalized).length, 4320);
      assert.ok(inserted.every(row => String(row.merchant).length === 240));
    });
    report.success = true;
  } catch (error) {
    failure(stage, error);
  } finally {
    await rollback();
    if (setupAttempted) {
      try { await sql.query("DELETE FROM workspaces WHERE id=ANY($1::uuid[]) AND name=$2 AND owner_user_id=$3", [workspaceIds, options.prefix, options.actorA]); }
      catch (error) { failure("cleanup-delete", error); }
    }
    for (const table of Object.keys(report.cleanup) as CleanupTable[]) {
      const column = table === "workspaces" ? "id" : "workspace_id";
      try {
        const count = Number((await sql.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=ANY($1::uuid[])`, [workspaceIds])).rows[0].n);
        assert.ok(Number.isSafeInteger(count) && count >= 0);
        report.cleanup[table] = count;
        if (count !== 0) report.failures.push({ stage: "cleanup-residual", code: "RESIDUAL_ROWS", table });
      } catch (error) { failure("cleanup-count", error, table); }
    }
    report.success = report.success && report.failures.length === 0 && Object.values(report.cleanup).every(count => count === 0);
    report.seconds = (performance.now() - started) / 1000;
  }
  return report;
}

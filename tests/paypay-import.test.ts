import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { neonConfig, NeonDbError } from "@neondatabase/serverless";
import { persistPayPayImport, type PayPayImportInput, type PayPayImportItem } from "../lib/paypay-import";

const workspaceId = "00000000-0000-0000-0000-000000000001";
const connectionString = "postgresql://user:password@mock.neon.tech/paypay_import_test";
const collisionMessage = "同じ取引日・取引番号に異なる金額または取引先の明細が登録されています。CSVと登録済み明細を確認してください。";

function item(overrides: Partial<PayPayImportItem> = {}): PayPayImportItem {
  return {
    occurredAt: "2026-10-09T15:00:01.000Z", merchant: "スーパー", method: "PayPay残高", amountYen: 1200,
    externalId: "PayPay_20261010000001_123456789", actorUserId: "member-a", expenseClass: "PERSONAL",
    splitWeights: { "member-a": 1, "member-b": 0 }, ...overrides,
  };
}

function input(items: PayPayImportItem[], totalRows = items.length): PayPayImportInput {
  return { workspaceId, userId: "member-b", fileName: "paypay.csv", totalRows, items };
}

interface Query { query: string; params: unknown[] }
interface Batch { queries: Query[] }

function queryResult(rows: Record<string, string | number>[] = []) {
  const fields = Object.entries(rows[0] ?? {}).map(([name, value]) => ({ name, dataTypeID: typeof value === "number" ? 23 : 25 }));
  return {
    fields, rows: rows.map((row) => fields.map(({ name }) => String(row[name]))),
    rowCount: rows.length, command: "UPDATE",
  };
}

function fixture(t: TestContext, options: { imported?: number; skipped?: number; failure?: { message: string; code: string } } = {}) {
  const previousUrl = process.env.DATABASE_URL;
  const previousLog = process.env.DB_QUERY_LOG;
  const previousFetch = neonConfig.fetchFunction;
  process.env.DATABASE_URL = connectionString;
  process.env.DB_QUERY_LOG = "off";
  t.after(() => {
    neonConfig.fetchFunction = previousFetch;
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousLog === undefined) delete process.env.DB_QUERY_LOG; else process.env.DB_QUERY_LOG = previousLog;
  });
  const requests: { batch: Batch; headers: Headers }[] = [];
  neonConfig.fetchFunction = async (url: RequestInfo | URL, init: RequestInit) => {
    assert.ok(new URL(String(url)).hostname.endsWith(".neon.tech"));
    assert.equal(new URL(String(url)).pathname, "/sql");
    assert.equal(init.method, "POST");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Neon-Connection-String"), connectionString);
    const batch = JSON.parse(String(init.body)) as Batch;
    assert.ok(Array.isArray(batch.queries), "all writes must be sent in one transaction");
    requests.push({ batch, headers });
    if (options.failure) return new Response(JSON.stringify(options.failure), { status: 400 });
    const results = batch.queries.map(() => queryResult());
    results[results.length - 1] = queryResult([{ imported_rows: options.imported ?? 1, skipped_rows: options.skipped ?? 0 }]);
    return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return requests;
}

function insertedItems(batch: Batch) {
  return batch.queries.filter(({ query }) => /INSERT INTO transactions\b/.test(query));
}

test("保存する外部IDはUTC日時から日本時間のYYYYMMDDHHMMSSを使い、未加工の旧API取引番号にも対応する", async (t) => {
  const requests = fixture(t, { imported: 2 });
  const result = await persistPayPayImport(input([
    item({ externalId: "PayPay_20261010000001_123456789" }),
    item({ occurredAt: "2026-10-09T14:59:59.000Z", externalId: "  987654321  " }),
  ]));
  assert.deepEqual(result, { imported: 2, skipped: 0 });
  assert.equal(requests.length, 1);
  const inserts = insertedItems(requests[0].batch);
  assert.deepEqual(inserts.map(({ params }) => params[8]), [
    "PayPay_20261009235959_987654321", "PayPay_20261010000001_123456789",
  ]);
  assert.equal(inserts[1].params[1], "2026-10-09T15:00:01.000Z");
  assert.equal(inserts[1].params[2], "スーパー");
  assert.equal(inserts[1].params[4], "1200");
  assert.equal(inserts[1].params[5], "member-a");
  assert.equal(inserts[1].params[7], JSON.stringify({ "member-a": 1, "member-b": 0 }));
});

test("新形式キーに含まれる日時が取引日時と違えばDB通信前に拒否する", async (t) => {
  const requests = fixture(t);
  await assert.rejects(persistPayPayImport(input([item({ externalId: "PayPay_20261010000002_123456789" })])));
  assert.equal(requests.length, 0);
});

test("同時取込で重複が増えても、取込履歴と戻り値は実際の登録・スキップ件数を使う", async (t) => {
  const requests = fixture(t, { imported: 1, skipped: 3 });
  assert.deepEqual(await persistPayPayImport(input([
    item(), item({ externalId: "123456790" }),
  ], 4)), { imported: 1, skipped: 3 });
  assert.equal(requests.length, 1);
  const batch = requests[0].batch;
  assert.match(batch.queries[0].query, /UPDATE workspaces/);
  const history = batch.queries[1];
  assert.match(history.query, /INSERT INTO import_batches/);
  assert.equal(history.params[4], "4");
  const batchId = history.params[0];
  const countQuery = batch.queries[batch.queries.length - 1];
  assert.match(countQuery.query, /COUNT\(\*\)::integer AS count FROM transactions WHERE import_batch_id/);
  assert.match(countQuery.query, /imported_rows = imported\.count/);
  assert.match(countQuery.query, /skipped_rows = GREATEST\(0, total_rows - imported\.count\)/);
  assert.ok(countQuery.params.every((param) => param === batchId));
  for (const insert of insertedItems(batch)) {
    assert.equal(insert.params[9], batchId);
    assert.match(insert.query, /ON CONFLICT \(workspace_id, external_id\) DO UPDATE/);
    assert.match(insert.query, /SET external_id = transactions\.external_id/);
    assert.match(insert.query, /WHERE cake_assert_paypay_duplicate\(transactions\.source, transactions\.merchant, transactions\.amount_yen,\s*EXCLUDED\.merchant, EXCLUDED\.amount_yen\)/);
    assert.match(insert.query, /RETURNING id/);
  }
});

test("全明細が既存と一致した場合は登録件数を0件として返す", async (t) => {
  fixture(t, { imported: 0, skipped: 1 });
  assert.deepEqual(await persistPayPayImport(input([item()])), { imported: 0, skipped: 1 });
});

test("同じ外部IDで内容が異なる競合はDBエラーを伝え、履歴と明細の書込みを同じトランザクションで失敗させる", async (t) => {
  const requests = fixture(t, { failure: { message: collisionMessage, code: "P0001" } });
  await assert.rejects(persistPayPayImport(input([
    item({ externalId: "123456788" }), item({ amountYen: 1300 }),
  ])), (error: unknown) => error instanceof NeonDbError && error.code === "P0001" && error.message === collisionMessage);
  assert.equal(requests.length, 1);
  const queries = requests[0].batch.queries;
  assert.match(queries[1].query, /INSERT INTO import_batches/);
  assert.equal(insertedItems(requests[0].batch).length, 2);
  assert.match(queries[queries.length - 1].query, /UPDATE import_batches/);
});

test("入力順序が反対でも同じキー順に保存して競合行をロックする", async (t) => {
  const requests = fixture(t, { imported: 2 });
  const first = item({ externalId: "123456789" });
  const second = item({ externalId: "123456790" });
  await persistPayPayImport(input([second, first]));
  await persistPayPayImport(input([first, second]));
  assert.equal(requests.length, 2);
  const keys = requests.map(({ batch }) => insertedItems(batch).map(({ params }) => params[8]));
  assert.deepEqual(keys[0], keys[1]);
  assert.deepEqual(keys[0], ["PayPay_20261010000001_123456789", "PayPay_20261010000001_123456790"]);
});

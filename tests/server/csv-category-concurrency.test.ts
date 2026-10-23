import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { neonConfig } from "@neondatabase/serverless";
import { createCsvCategoryImportCapture, verifyCsvCategoryConcurrency, type CsvCategoryDatabase, type CsvCategoryConcurrencyReport } from "../../scripts/qa/db/csv-category-concurrency-scenarios";
import type { PayPayImportInput, PayPayImportItem } from "../../lib/server/stores/paypay-import";

const head = "a".repeat(40), prefix = "verify-csv-category-offline";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const categoryId = "00000000-0000-4000-8000-000000000002", laterCategoryId = "00000000-0000-4000-8000-000000000003";
const zeroCounts = { workspaces: 0, workspace_members: 0, categories: 0, transactions: 0, import_batches: 0 };
const sensitiveSentinel = "synthetic-connection-and-query-details";

function item(externalId: string, categoryId: string | null): PayPayImportItem {
  return { occurredAt: "2026-10-22T03:00:42.000Z", merchant: "並行取込テスト", method: "PayPay", amountYen: 100,
    externalId, actorUserId: "b", expenseClass: "SHARED", splitWeights: { a: 6, b: 4 }, categoryId };
}
function input(items: PayPayImportItem[]): PayPayImportInput {
  return { workspaceId, userId: "b", fileName: "offline.csv", totalRows: items.length, items };
}

test("実取込の4 SQLを通信なしで捕捉し、入力順・重複の最初の値・全カテゴリの検証対象を維持する", async t => {
  const previous = neonConfig.fetchFunction;
  let parentFetchCalls = 0;
  const parentFetch = async () => { parentFetchCalls++; throw new Error("親Neon clientへ流してはいけません"); };
  neonConfig.fetchFunction = parentFetch;
  t.after(() => { neonConfig.fetchFunction = previous; });
  const capture = await createCsvCategoryImportCapture();
  const first = item("first", categoryId), second = item("second", null);
  const duplicate = { ...first, categoryId: laterCategoryId, method: "重複の別方法" };
  const original = input([second, first, duplicate]), snapshot = structuredClone(original);
  const captured = await capture(original), reversed = await capture(input([first, duplicate, second]));
  assert.equal(captured.queries.length, 4);
  assert.equal(captured.queryHashes.length, 4);
  assert.ok(captured.queryHashes.every(hash => /^[a-f0-9]{64}$/.test(hash)));
  assert.deepEqual(captured.queryHashes, reversed.queryHashes);
  assert.notEqual(captured.batchId, reversed.batchId);
  assert.deepEqual(original, snapshot, "呼出側の配列・明細を変更しない");
  assert.equal(neonConfig.fetchFunction, parentFetch, "capture専用Neon clientを親から分離する");
  assert.equal(parentFetchCalls, 0);
  const targets = JSON.parse(String(captured.queries[0].params[0])) as { workspaceId: string; userId: string; categoryId: string | null }[];
  assert.deepEqual(targets.map(target => target.categoryId).sort(), [null, categoryId, laterCategoryId].sort(), "一致重複として省略する後続行のカテゴリも検証する");
  assert.ok(targets.every(target => target.workspaceId === workspaceId && target.userId === "b"));
  const inserted = JSON.parse(String(captured.queries[2].params[4])) as PayPayImportItem[];
  assert.deepEqual(inserted.map(row => [row.externalId, row.categoryId, row.method]), [
    ["PayPay_20261022120042_first", categoryId, "PayPay"], ["PayPay_20261022120042_second", null, "PayPay"],
  ]);
  assert.deepEqual(captured.queries[1].params.slice(0, 5), [captured.batchId, workspaceId, "b", "offline.csv", "3"]);
  assert.ok(captured.queries[3].params.every(value => value === captured.batchId));
});

test("捕捉中のエラー後もhookを解除し、次の正常な取込SQLを捕捉できる", async () => {
  const capture = await createCsvCategoryImportCapture();
  await assert.rejects(capture(input([item("same", categoryId), { ...item("same", null), amountYen: 101 }])));
  const captured = await capture(input([item("valid", null)]));
  assert.equal(captured.queries.length, 4);
});

test("callerの完全SHAを記録し、接続失敗のSQLSTATEだけを最終callbackと戻り値へ残す", async () => {
  let calls = 0;
  const database: CsvCategoryDatabase = { async query() { calls++; throw { code: "28P01", message: sensitiveSentinel, query: sensitiveSentinel }; } };
  const updates: CsvCategoryConcurrencyReport[] = [];
  const report = await verifyCsvCategoryConcurrency(database, database, "a", "b", {
    prefix, expectedHead: head, onProgress: value => { updates.push(value); },
  });
  assert.equal(calls, 1, "fixtureを作る前の失敗でcleanup SQLは不要");
  assert.equal(report.success, false);
  assert.equal(report.head, head);
  assert.deepEqual(report.failures, [{ stage: "preflight", code: "28P01" }]);
  assert.deepEqual(report.cleanup, zeroCounts);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], report);
  assert.ok(!JSON.stringify(report).includes(sensitiveSentinel));
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  assert.equal(report.sourceSha256, sha256(await readFile(new URL("../../lib/server/stores/paypay-import.ts", import.meta.url), "utf8")));
  assert.equal(report.migrationSha256, sha256(await readFile(new URL("../../db/migrations/018_import_categories.sql", import.meta.url), "utf8")));
});

test("完全SHA・prefix不正は接続や変更を始めず拒否し、callback失敗も秘密値なしで残す", async () => {
  let calls = 0;
  const database: CsvCategoryDatabase = { async query() { calls++; throw new Error("DBへ到達してはいけません"); } };
  for (const options of [
    { expectedHead: "a".repeat(39), prefix }, { expectedHead: "g".repeat(40), prefix }, { expectedHead: head, prefix: "既存workspace" },
  ]) {
    const report = await verifyCsvCategoryConcurrency(database, database, "a", "b", {
      ...options, onProgress: () => { throw new Error(sensitiveSentinel); },
    });
    assert.equal(report.success, false);
    assert.deepEqual(report.failures, [{ stage: "preflight", code: "ASSERTION_FAILED" }, { stage: "report-callback", code: "CALLBACK_FAILED" }]);
    assert.deepEqual(report.ownedWorkspaceIds, []);
    assert.deepEqual(report.cleanup, zeroCounts);
    assert.ok(!JSON.stringify(report).includes(sensitiveSentinel));
  }
  assert.equal(calls, 0);
});

type QueryCall = { pid: number; text: string; params: unknown[] };
function sessions(options: { samePid?: boolean; openTransaction?: boolean; advisoryLock?: boolean; setupFailure?: boolean } = {}) {
  const calls: QueryCall[] = [];
  function client(pid: number): CsvCategoryDatabase {
    return { async query(text, params = []) {
      calls.push({ pid, text, params });
      if (text === "SELECT pg_backend_pid() AS pid") return { rows: [{ pid }] };
      if (text.startsWith("SELECT state,xact_start")) return { rows: [{ state: options.openTransaction ? "idle in transaction" : "idle", xact_start: options.openTransaction ? "2026-10-22" : null }] };
      if (text.includes("FROM pg_locks")) return { rows: [{ held: options.advisoryLock ?? false }] };
      if (text.includes("current_setting('statement_timeout')")) return { rows: [{ statement: "11s", lock: "7s" }] };
      if (text.startsWith("SELECT set_config") || text.startsWith("BEGIN") || text === "ROLLBACK" || text === "COMMIT") return { rows: [] };
      if (text.startsWith("SELECT to_jsonb(u)")) return { rows: [{ snapshot: { id: "a" } }, { snapshot: { id: "b" } }] };
      if (text.startsWith("INSERT INTO workspaces") && options.setupFailure) throw { code: "P0001", message: sensitiveSentinel };
      if (text.startsWith("DELETE FROM workspaces WHERE id=")) return { rows: [] };
      if (text.startsWith("SELECT count(*)")) return { rows: [{ count: 0 }] };
      throw new Error("予期しないfixture SQL");
    } };
  }
  return { first: client(101), second: client(options.samePid ? 101 : 102), calls };
}

for (const [name, flags] of [["同じbackend PID", { samePid: true }], ["既存の未完了Transaction", { openTransaction: true }], ["advisory lockの保持", { advisoryLock: true }]] as const) {
  test(`${name}では並行試験のデータ作成を始めない`, async () => {
    const { first, second, calls } = sessions(flags);
    const report = await verifyCsvCategoryConcurrency(first, second, "a", "b", { prefix, expectedHead: head });
    assert.equal(report.success, false);
    assert.deepEqual(report.failures, [{ stage: "preflight", code: "ASSERTION_FAILED" }]);
    assert.equal(report.cases.length, 0);
    assert.deepEqual(report.cleanup, zeroCounts);
    assert.ok(calls.every(call => call.text.startsWith("SELECT")), "callerの既存Transactionやデータを変更しない");
    assert.ok(calls.every(call => !call.text.includes("set_config")), "preflightを終える前にsession設定を変えない");
  });
}

test("fixture作成の途中失敗もrollback・限定cleanup・session設定復元を行い各caseと最終結果を返す", async () => {
  const { first, second, calls } = sessions({ setupFailure: true });
  const updates: CsvCategoryConcurrencyReport[] = [];
  const report = await verifyCsvCategoryConcurrency(first, second, "a", "b", { prefix, expectedHead: head, onProgress: value => { updates.push(value); } });
  assert.equal(report.success, false);
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0].status, "failed");
  assert.deepEqual(report.cases[0].failures, [{ stage: "setup", code: "P0001" }]);
  assert.deepEqual(report.failures, [{ stage: "setup", code: "P0001" }]);
  assert.deepEqual(report.cases[0].rowCounts, zeroCounts);
  assert.deepEqual(report.cases[0].cleanup, zeroCounts);
  assert.deepEqual(report.cleanup, zeroCounts);
  assert.equal(report.seedUsersUnchanged, true);
  assert.equal(report.ownedWorkspaceIds.length, 1);
  assert.equal(report.cases[0].workspaceId, report.ownedWorkspaceIds[0]);
  assert.ok(calls.some(call => call.text === "ROLLBACK"));
  const deletions = calls.filter(call => call.text.startsWith("DELETE"));
  assert.ok(deletions.length > 0);
  for (const call of deletions) {
    assert.equal(call.text, "DELETE FROM workspaces WHERE id=$1::uuid AND name=$2 AND owner_user_id=$3");
    assert.deepEqual(call.params, [report.ownedWorkspaceIds[0], `${prefix}-1`, "a"]);
  }
  for (const pid of [101, 102]) assert.ok(calls.some(call => call.pid === pid && call.text.startsWith("SELECT set_config") && JSON.stringify(call.params) === '["11s","7s"]'), "変更したtimeoutを復元する");
  assert.equal(updates.length, 2, "case失敗後と全体cleanup後に保存できる");
  assert.deepEqual(updates[1], report);
  assert.ok(!JSON.stringify(report).includes(sensitiveSentinel));
});

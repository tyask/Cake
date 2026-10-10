import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { neon, neonConfig, NeonDbError } from "@neondatabase/serverless";
import { instrumentDatabase } from "../lib/db-query-logging";

const parameterSecret = "private.customer@example.test";
const resultSecret = "private-transaction-result";
const connectionString = "postgresql://private-user:private-password@mock.neon.tech/private-database";

interface QueryPayload { query: string; params: unknown[] }
interface RequestCapture { payload: QueryPayload | { queries: QueryPayload[] }; init: RequestInit }
interface QueryLog {
  event: string;
  operation: string;
  queryId: string;
  tables: string[];
  durationMs: number;
  sqlCount: number;
  status: string;
  slow: boolean;
  errorType?: string;
  errorCode?: string;
}

function fixture(t: TestContext, environment: Record<string, string | undefined> = { DB_QUERY_LOG: "all" }) {
  const variables = ["DB_QUERY_LOG", "DB_SLOW_QUERY_MS", "VERCEL_ENV", "NODE_ENV"];
  const previous = new Map(variables.map(key => [key, process.env[key]]));
  for (const key of variables) {
    const value = environment[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const previousFetch = neonConfig.fetchFunction;
  t.after(() => {
    neonConfig.fetchFunction = previousFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  let now = 1000;
  const state = {
    durationMs: 25, failure: null as Error | null, throwFromLog: false,
    databaseFailure: null as { message: string; code: string } | null,
  };
  const requests: RequestCapture[] = [];
  const output: unknown[][] = [];
  t.mock.method(performance, "now", () => now);
  for (const method of ["log", "error"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      if (state.throwFromLog) throw new Error("log-writer-failure");
      output.push(args);
    });
  }
  const responseResult = {
    fields: [{ name: "value", dataTypeID: 25 }], rows: [[resultSecret]], rowCount: 1, command: "SELECT",
  };
  neonConfig.fetchFunction = async (input: RequestInfo | URL, init: RequestInit) => {
    assert.equal(new URL(String(input)).pathname, "/sql");
    assert.equal(new Headers(init.headers).get("Neon-Connection-String"), connectionString);
    const payload = JSON.parse(String(init.body)) as RequestCapture["payload"];
    requests.push({ payload, init });
    now += state.durationMs;
    if (state.databaseFailure) {
      return new Response(JSON.stringify(state.databaseFailure), { status: 400 });
    }
    if (state.failure) {
      const failure = state.failure;
      const response = new Response("", { status: 200 });
      t.mock.method(response, "json", async () => { throw failure; });
      return response;
    }
    return new Response(JSON.stringify("queries" in payload
      ? { results: payload.queries.map(() => responseResult) }
      : responseResult), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const sql = instrumentDatabase(neon(connectionString));
  const logs = () => output.map(args => {
    assert.equal(args.length, 1, "each database event must be one JSON log entry");
    assert.equal(typeof args[0], "string");
    return JSON.parse(args[0] as string) as QueryLog;
  });
  return { sql, requests, output, state, logs };
}

function assertNoPrivateData(output: unknown[][], extraSecrets: string[] = []) {
  const logged = JSON.stringify(output);
  for (const secret of [parameterSecret, resultSecret, connectionString, "private-password", ...extraSecrets]) {
    assert.equal(logged.includes(secret), false, `database logging exposed ${secret}`);
  }
}

test("SQLを作るだけでは実行せず、await後に時間と安全な識別情報だけを記録する", async (t) => {
  const { sql, requests, output, state, logs } = fixture(t);
  state.durationMs = 123;
  const pending = sql`SELECT '${sql.unsafe(parameterSecret)}' AS value FROM transactions WHERE memo = ${parameterSecret}`;
  assert.equal(requests.length, 0);
  assert.equal(output.length, 0);

  const rows = await pending;
  assert.deepEqual(rows, [{ value: resultSecret }]);
  assert.equal(requests.length, 1);
  const [entry] = logs();
  assert.equal(logs().length, 1);
  assert.equal(entry.event, "db.query");
  assert.equal(entry.operation, "SELECT");
  assert.deepEqual(entry.tables, ["transactions"]);
  assert.ok(entry.queryId.length > 0);
  assert.equal(entry.durationMs, 123);
  assert.equal(entry.sqlCount, 1);
  assert.equal(entry.status, "ok");
  assert.equal(entry.slow, false);
  assertNoPrivateData(output);
});

test("同じSQLのパラメータが変わっても識別子を保ち、値をログへ含めない", async (t) => {
  const { sql, output, logs } = fixture(t);
  await sql`SELECT memo FROM transactions WHERE memo = ${parameterSecret}`;
  await sql`SELECT memo FROM transactions WHERE memo = ${"another-private-value"}`;
  assert.equal(logs()[0].queryId, logs()[1].queryId);
  assertNoPrivateData(output, ["another-private-value"]);
});

test("任意のテーブル名やSQL本文をログへ含めない", async (t) => {
  const { sql, output, logs } = fixture(t);
  await sql.query('SELECT * FROM "private-company-table" WHERE memo = $1', [parameterSecret]);
  assert.deepEqual(logs()[0].tables, []);
  assertNoPrivateData(output, ["private-company-table", "SELECT *"]);
});

test("offは成功・失敗のログを止めてもDB実行とエラーを変更しない", async (t) => {
  const { sql, requests, output, state } = fixture(t, { DB_QUERY_LOG: "off" });
  assert.deepEqual(await sql`SELECT ${parameterSecret} AS value`, [{ value: resultSecret }]);
  state.failure = new Error("private-failure");
  await assert.rejects(sql`SELECT ${parameterSecret} AS value`, error => error === state.failure);
  assert.equal(requests.length, 2);
  assert.equal(output.length, 0);
});

test("slowは設定した閾値未満の成功を省き、閾値以上の成功と高速の失敗を記録する", async (t) => {
  const { sql, output, state, logs } = fixture(t, { DB_QUERY_LOG: "slow", DB_SLOW_QUERY_MS: "100" });
  state.durationMs = 99;
  await sql`SELECT memo FROM transactions`;
  assert.equal(output.length, 0);
  state.durationMs = 100;
  await sql`SELECT memo FROM transactions`;
  assert.equal(logs().length, 1);
  assert.equal(logs()[0].slow, true);
  assert.equal(logs()[0].durationMs, 100);

  state.durationMs = 1;
  state.failure = new TypeError("private-failure");
  await assert.rejects(sql`SELECT memo FROM transactions`, error => error === state.failure);
  assert.equal(logs().length, 2);
  assert.equal(logs()[1].status, "error");
  assert.equal(logs()[1].errorType, "TypeError");
  assert.equal(logs()[1].slow, false);
  assertNoPrivateData(output, ["private-failure"]);
});

test("slowの閾値0は時間0の成功も記録する", async (t) => {
  const { sql, state, logs } = fixture(t, { DB_QUERY_LOG: "slow", DB_SLOW_QUERY_MS: "0" });
  state.durationMs = 0;
  await sql`SELECT memo FROM transactions`;
  assert.equal(logs().length, 1);
  assert.equal(logs()[0].slow, true);
});

test("不正な閾値は500msへ戻す", async (t) => {
  for (const invalid of ["not-a-number", "-1", "Infinity"]) {
    await t.test(invalid, async (subtest) => {
      const { sql, state, output, logs } = fixture(subtest, { DB_QUERY_LOG: "slow", DB_SLOW_QUERY_MS: invalid });
      state.durationMs = 499;
      await sql`SELECT memo FROM transactions`;
      assert.equal(output.length, 0);
      state.durationMs = 500;
      await sql`SELECT memo FROM transactions`;
      assert.equal(logs().length, 1);
      assert.equal(logs()[0].slow, true);
    });
  }
});

test("未設定ならpreview・developmentは全件、productionなどは遅いSQLだけを記録する", async (t) => {
  for (const environment of [
    { VERCEL_ENV: "preview", NODE_ENV: "production", logged: true },
    { NODE_ENV: "development", logged: true },
    { VERCEL_ENV: "production", NODE_ENV: "production", logged: false },
    { NODE_ENV: "test", logged: false },
  ]) {
    await t.test(JSON.stringify(environment), async (subtest) => {
      const { logged, ...variables } = environment;
      const { sql, output } = fixture(subtest, variables);
      await sql`SELECT memo FROM transactions`;
      assert.equal(output.length, logged ? 1 : 0);
    });
  }
});

test("配列transactionは1回のHTTPと1件のログにまとめ、個別クエリを別実行しない", async (t) => {
  const { sql, requests, output, logs } = fixture(t);
  const queries = [
    sql`SELECT memo FROM transactions WHERE memo = ${parameterSecret}`,
    sql`UPDATE app_users SET name = ${parameterSecret} WHERE id = ${"user-secret"}`,
  ];
  assert.equal(requests.length, 0);
  const results = await sql.transaction(queries, { arrayMode: true, fullResults: true, isolationLevel: "Serializable", readOnly: false });
  assert.equal(requests.length, 1);
  const payload = requests[0].payload;
  assert.ok("queries" in payload);
  assert.equal(payload.queries.length, 2);
  assert.deepEqual(results.map(result => result.rows), [[[resultSecret]], [[resultSecret]]]);
  assert.equal(new Headers(requests[0].init.headers).get("Neon-Batch-Isolation-Level"), "Serializable");
  assert.equal(new Headers(requests[0].init.headers).get("Neon-Batch-Read-Only"), "false");
  const entries = logs();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "db.transaction");
  assert.equal(entries[0].operation, "TRANSACTION");
  assert.equal(entries[0].sqlCount, 2);
  assert.deepEqual([...entries[0].tables].sort(), ["app_users", "transactions"]);
  assertNoPrivateData(output, ["user-secret"]);
});

test("callback transactionはcallbackを1度だけ呼び、1回のHTTPと1件のログにまとめる", async (t) => {
  const { sql, requests, logs } = fixture(t);
  let callbackCalls = 0;
  const rows = await sql.transaction(transaction => {
    callbackCalls++;
    return [
      transaction`SELECT memo FROM transactions WHERE memo = ${parameterSecret}`,
      transaction.query("SELECT name FROM app_users WHERE id = $1", ["user-secret"]),
    ];
  });
  assert.equal(callbackCalls, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(rows, [[{ value: resultSecret }], [{ value: resultSecret }]]);
  assert.equal(logs().length, 1);
  assert.equal(logs()[0].event, "db.transaction");
  assert.equal(logs()[0].sqlCount, 2);
});

test("SQL断片の合成とunsafeを保持し、生成時にはHTTPもログも発生させない", async (t) => {
  const { sql, requests, output } = fixture(t);
  const fragment = sql`merchant = ${parameterSecret}`;
  const pending = sql`SELECT ${sql.unsafe("memo")} FROM transactions WHERE ${fragment}`;
  assert.equal(requests.length, 0);
  assert.equal(output.length, 0);
  assert.deepEqual(await pending, [{ value: resultSecret }]);
  assert.deepEqual(requests[0].payload, {
    query: "SELECT memo FROM transactions WHERE merchant = $1", params: [parameterSecret],
  });
  assert.equal(output.length, 1);
});

test("queryのarrayMode・fullResults・fetchOptionsを保持する", async (t) => {
  const { sql, requests, logs } = fixture(t);
  const rows = await sql.query("SELECT memo FROM transactions WHERE memo = $1", [parameterSecret], {
    arrayMode: true, fullResults: true, fetchOptions: { cache: "no-store" },
  });
  assert.deepEqual(rows.rows, [[resultSecret]]);
  assert.equal(rows.rowCount, 1);
  assert.equal(requests[0].init.cache, "no-store");
  assert.equal(logs().length, 1);
});

test("同じqueryを再awaitするとNeonと同様に再実行して各実行時間を記録する", async (t) => {
  const { sql, requests, state, logs } = fixture(t);
  const pending = sql`SELECT memo FROM transactions`;
  await pending;
  state.durationMs = 50;
  await pending;
  assert.equal(requests.length, 2);
  assert.deepEqual(logs().map(entry => entry.durationMs), [25, 50]);
});

test("元のエラーobjectを拒否し、独自のエラー名・messageをログへ漏らさない", async (t) => {
  const { sql, output, state, logs } = fixture(t);
  const failure = Object.assign(new Error("private error message with SQL and email"), {
    name: "private.customer-error", code: "23505",
  });
  state.failure = failure;
  await assert.rejects(sql`SELECT memo FROM transactions`, error => error === failure);
  const [entry] = logs();
  assert.equal(entry.status, "error");
  assert.equal(entry.errorType, "Error");
  assert.equal(entry.errorCode, undefined);
  assertNoPrivateData(output, [failure.name, failure.message]);
});

test("NeonのDBエラーは有効なSQLSTATEだけを記録し、本文や不正なcodeを漏らさない", async (t) => {
  const { sql, state, output, logs } = fixture(t);
  state.databaseFailure = { message: "private constraint error", code: "23505" };
  await assert.rejects(sql`SELECT memo FROM transactions`, error => error instanceof NeonDbError && error.code === "23505");
  assert.equal(logs()[0].errorType, "NeonDbError");
  assert.equal(logs()[0].errorCode, "23505");

  state.databaseFailure.code = "private-customer-code";
  await assert.rejects(sql`SELECT memo FROM transactions`, NeonDbError);
  assert.equal(logs()[1].errorCode, undefined);

  state.databaseFailure = null;
  state.failure = Object.assign(new NeonDbError("private DB error text"), {
    name: "private-customer-name", code: "23505",
  });
  await assert.rejects(sql`SELECT memo FROM transactions`, error => error === state.failure);
  assert.equal(logs()[2].errorType, "NeonDbError");
  assert.equal(logs()[2].errorCode, "23505");
  assertNoPrivateData(output, ["private constraint error", "private-customer-code", state.failure.name, state.failure.message]);
});

test("SQLSTATEに見えないエラーcodeをログへ漏らさない", async (t) => {
  const { sql, state, output, logs } = fixture(t);
  state.failure = Object.assign(new Error("private-failure"), { code: "private-customer-code" });
  await assert.rejects(sql`SELECT memo FROM transactions`, error => error === state.failure);
  assert.equal(logs()[0].errorCode, undefined);
  assertNoPrivateData(output, ["private-customer-code", "private-failure"]);
});

test("ログ書込の失敗で成功結果や元のDBエラーを変更しない", async (t) => {
  const { sql, state } = fixture(t);
  state.throwFromLog = true;
  assert.deepEqual(await sql`SELECT memo FROM transactions`, [{ value: resultSecret }]);
  state.failure = new Error("database-failure");
  await assert.rejects(sql`SELECT memo FROM transactions`, error => error === state.failure);
});

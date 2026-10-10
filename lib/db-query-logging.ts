import { createHash } from "node:crypto";
import { NeonDbError, NeonQueryPromise, SqlTemplate, type NeonQueryFunction, type NeonQueryInTransaction } from "@neondatabase/serverless";

type QueryData = NeonQueryPromise<false, false>["queryData"];
type LogMode = "all" | "slow" | "off";
type QueryStatus = "ok" | "error";

const appTables = new Set([
  "app_users", "workspaces", "workspace_members", "invitations", "transactions",
  "default_rules", "settlements", "settlement_transactions", "import_batches", "schema_migrations", "recurring_payments",
]);
const errorTypes = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError"]);

function loggingOptions(): { mode: LogMode; slowMs: number } {
  const configured = process.env.DB_QUERY_LOG?.trim().toLowerCase();
  const development = process.env.VERCEL_ENV !== "production"
    && (process.env.VERCEL_ENV === "preview" || process.env.NODE_ENV === "development");
  const mode = configured === "all" || configured === "slow" || configured === "off"
    ? configured : development ? "all" : "slow";
  const threshold = process.env.DB_SLOW_QUERY_MS?.trim();
  const slowMs = threshold ? Number(threshold) : 500;
  return { mode, slowMs: Number.isFinite(slowMs) && slowMs >= 0 ? slowMs : 500 };
}

function queryMetadata(queries: readonly QueryData[], transaction: boolean) {
  const shapes = [...new Set(queries.map(data => {
    const query = data instanceof SqlTemplate ? data.toParameterizedQuery().query : data.query;
    return query.replace(/\s+/g, " ").trim();
  }))];
  const tables = new Set<string>();
  for (const shape of shapes) {
    for (const match of shape.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
      const table = match[1].toLowerCase();
      if (appTables.has(table)) tables.add(table);
    }
  }
  return {
    operation: transaction ? "TRANSACTION" : shapes[0]?.match(/^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|TRUNCATE)\b/i)?.[1].toUpperCase() ?? "UNKNOWN",
    queryId: createHash("sha256").update(shapes.join("\0")).digest("hex").slice(0, 12),
    tables: [...tables],
    sqlCount: queries.length,
  };
}

function errorMetadata(error: unknown) {
  if (error instanceof NeonDbError) {
    return {
      errorType: "NeonDbError",
      ...(typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? { errorCode: error.code } : {}),
    };
  }
  return { errorType: error instanceof Error && errorTypes.has(error.name) ? error.name : "Error" };
}

function writeLog(getQueries: () => readonly QueryData[], transaction: boolean, durationMs: number, slow: boolean, status: QueryStatus, error?: unknown) {
  try {
    const entry = {
      event: transaction ? "db.transaction" : "db.query",
      ...queryMetadata(getQueries(), transaction),
      durationMs: Math.round(durationMs * 100) / 100,
      status,
      slow,
      ...(status === "error" ? errorMetadata(error) : {}),
    };
    const line = JSON.stringify(entry);
    if (status === "error") console.error(line);
    else console.log(line);
  } catch {
    // Logging must not change a query's result or original error.
  }
}

async function measure<T>(execute: () => Promise<T>, getQueries: () => readonly QueryData[], transaction: boolean): Promise<T> {
  const { mode, slowMs } = loggingOptions();
  if (mode === "off") return execute();
  const started = performance.now();
  try {
    const result = await execute();
    const durationMs = performance.now() - started;
    const slow = durationMs >= slowMs;
    if (mode === "all" || slow) writeLog(getQueries, transaction, durationMs, slow, "ok");
    return result;
  } catch (error) {
    const durationMs = performance.now() - started;
    writeLog(getQueries, transaction, durationMs, durationMs >= slowMs, "error", error);
    throw error;
  }
}

function instrumentQuery<A extends boolean, F extends boolean, T>(query: NeonQueryPromise<A, F, T>): NeonQueryPromise<A, F, T> {
  // Keep Neon's lazy execution and queryData so composition and batches still work.
  return new NeonQueryPromise(
    (data, options) => measure(() => query.execute(data, options), () => Array.isArray(data) ? data : [data], Array.isArray(data)),
    query.queryData,
    query.opts,
  );
}

export function instrumentDatabase(sql: NeonQueryFunction<false, false>): NeonQueryFunction<false, false> {
  const query: typeof sql.query = (text, params, options) => instrumentQuery(sql.query(text, params, options));
  const transaction: typeof sql.transaction = (queriesOrFn, options) => {
    let captured: readonly NeonQueryInTransaction[] = Array.isArray(queriesOrFn) ? queriesOrFn : [];
    const input = typeof queriesOrFn === "function" ? (transactionSql: Parameters<typeof queriesOrFn>[0]) => {
      const queries = queriesOrFn(transactionSql);
      captured = queries;
      return queries;
    } : queriesOrFn;
    return measure(() => sql.transaction(input, options), () => Array.isArray(captured)
      ? captured.filter(item => item instanceof NeonQueryPromise).map(item => item.queryData) : [], true);
  };
  return new Proxy(sql, {
    apply(target, thisArg, args) { return instrumentQuery(Reflect.apply(target, thisArg, args)); },
    get(target, property, receiver) {
      if (property === "query") return query;
      if (property === "transaction") return transaction;
      return Reflect.get(target, property, receiver);
    },
  });
}

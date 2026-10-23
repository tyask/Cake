import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PGlite, type ParserOptions, type QueryOptions, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { prepareMigration, setupDatabase } from "../db/setup-db.mjs";
import { testSeedSql } from "../db/seed-test-users";
import { previewSampleDataSql } from "../db/preview-sample-data";
import { CLOUD_DATABASE_CONNECTION_STRING } from "../../lib/server/database/cloud-memory";

export { CLOUD_DATABASE_CONNECTION_STRING } from "../../lib/server/database/cloud-memory";
export const MAX_MEMORY_DATABASE_BODY_BYTES = 8 * 1024 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;
type WireQuery = { query: string; params: (string | null)[] };
type WireRequest = { queries: WireQuery[]; batch: boolean };

export type MemoryDatabase = {
  /** A loopback capability URL. Pass to the Next child through its environment only. */
  url: string;
  connectionString: string;
  close(): Promise<void>;
};

class RequestError extends Error {
  constructor(readonly status: number) {
    super("Cake memory database request rejected.");
  }
}

function wireQuery(value: unknown): WireQuery {
  if (typeof value !== "object" || value === null) throw new RequestError(400);
  const { query, params } = value as Record<string, unknown>;
  if (typeof query !== "string" || !query.trim() || !Array.isArray(params)
    || params.some(param => param !== null && typeof param !== "string")) throw new RequestError(400);
  return { query, params };
}

function wireRequest(value: unknown): WireRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RequestError(400);
  const body = value as Record<string, unknown>;
  if ("queries" in body) {
    if ("query" in body || !Array.isArray(body.queries) || body.queries.length === 0) throw new RequestError(400);
    return { queries: body.queries.map(wireQuery), batch: true };
  }
  return { queries: [wireQuery(body)], batch: false };
}

function readBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength && Number(declaredLength) > MAX_MEMORY_DATABASE_BODY_BYTES) {
    request.resume();
    return Promise.reject(new RequestError(413));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MEMORY_DATABASE_BODY_BYTES) {
        // Continue draining without retaining the remaining body or closing the
        // socket before the caller can receive the bounded error response.
        exceeded = true;
        chunks.length = 0;
        reject(new RequestError(413));
      } else if (!exceeded) chunks.push(chunk);
    });
    request.on("end", () => {
      if (exceeded) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new RequestError(400)); }
    });
    request.on("error", () => reject(new RequestError(400)));
    request.on("aborted", () => reject(new RequestError(400)));
  });
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function transactionOptions(request: IncomingMessage): string | undefined {
  const isolationLevels: Record<string, string> = {
    ReadUncommitted: "READ UNCOMMITTED", ReadCommitted: "READ COMMITTED",
    RepeatableRead: "REPEATABLE READ", Serializable: "SERIALIZABLE",
  };
  const options: string[] = [];
  const isolation = request.headers["neon-batch-isolation-level"];
  if (isolation !== undefined) {
    if (typeof isolation !== "string" || !Object.hasOwn(isolationLevels, isolation)) throw new RequestError(400);
    options.push(`ISOLATION LEVEL ${isolationLevels[isolation]}`);
  }
  for (const [header, yes, no] of [
    ["neon-batch-read-only", "READ ONLY", "READ WRITE"],
    ["neon-batch-deferrable", "DEFERRABLE", "NOT DEFERRABLE"],
  ]) {
    const value = request.headers[header];
    if (value === undefined) continue;
    if (value !== "true" && value !== "false") throw new RequestError(400);
    options.push(value === "true" ? yes : no);
  }
  return options.length ? `SET TRANSACTION ${options.join(", ")}` : undefined;
}

async function initialize(memory: PGlite): Promise<QueryOptions> {
  const directory = new URL("../../db/migrations/", import.meta.url);
  await setupDatabase({ DATABASE_URL: CLOUD_DATABASE_CONNECTION_STRING }, {
    connect: () => memory,
    // The established hash check removes only the pinned production bootstrap.
    // The database itself remains a local DB, without Preview ownership metadata.
    readMigration: async name => prepareMigration(name, await readFile(new URL(name, directory), "utf8"), { VERCEL_ENV: "preview" }),
  });
  await memory.query(testSeedSql({ AUTH_MODE: "test" }));
  await memory.transaction(tx => tx.exec(previewSampleDataSql(
    "00000000-0000-4000-8000-000000000001", "test-user-a", "test-user-b",
  )));

  // Neon has already serialized parameters to PostgreSQL text. Likewise Neon
  // parses the text results using each field's OID. Bypass PGlite's JS value
  // conversion in both directions, preserving arrays and timestamp precision.
  const types = await memory.query<{ oid: number }>("SELECT oid FROM pg_type");
  const text = (value: string) => value;
  const parsers: ParserOptions = Object.fromEntries(types.rows.map(({ oid }) => [oid, text]));
  return { rowMode: "array", parsers, serializers: parsers };
}

/** Own one ephemeral database outside Next workers and hot module replacement. */
export async function startMemoryDatabase(environment: Environment = process.env): Promise<MemoryDatabase> {
  if (environment.VERCEL !== undefined || environment.VERCEL_ENV !== undefined) {
    throw new Error("Vercel環境ではCloud用メモリDBを起動できません。");
  }
  const memory = new PGlite({ extensions: { pgcrypto } });
  let queryOptions: QueryOptions;
  try { queryOptions = await initialize(memory); }
  catch {
    await memory.close();
    throw new Error("Cloud用メモリDBのmigration/seedに失敗しました。");
  }
  const path = `/sql/${randomBytes(24).toString("hex")}`;
  let pending: Promise<unknown> = Promise.resolve();
  function exclusively<T>(execute: () => Promise<T>): Promise<T> {
    const result = pending.then(execute);
    pending = result.catch(() => undefined);
    return result;
  }
  async function execute(tx: Transaction, query: WireQuery) {
    const result = await tx.query<(string | null)[]>(query.query, query.params, queryOptions);
    return { ...result, rowCount: result.rowCount ?? result.affectedRows ?? 0 };
  }
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.url !== path) throw new RequestError(404);
        if (request.method !== "POST") throw new RequestError(405);
        if (request.headers.origin !== undefined) throw new RequestError(403);
        if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new RequestError(415);
        if (request.headers["neon-connection-string"] !== CLOUD_DATABASE_CONNECTION_STRING) throw new RequestError(403);
        const body = wireRequest(await readBody(request));
        const options = transactionOptions(request);
        const results = await exclusively(() => memory.transaction(async tx => {
          if (options) await tx.exec(options);
          const results = [];
          for (const query of body.queries) results.push(await execute(tx, query));
          return results;
        }));
        send(response, 200, body.batch ? { results } : results[0]);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "XX000";
        send(response, error instanceof RequestError ? error.status : 400, {
          message: error instanceof RequestError ? error.message : "Cake memory database query failed.", code,
        });
        request.resume();
      }
    })();
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch {
    await memory.close();
    throw new Error("Cloud用メモリDBの待受を開始できません。");
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    await memory.close();
    throw new Error("Cloud用メモリDBの待受を確認できません。");
  }
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    connectionString: CLOUD_DATABASE_CONNECTION_STRING,
    close() {
      return closing ??= (async () => {
        try {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        } finally {
          await pending;
          await memory.close();
        }
      })();
    },
  };
}

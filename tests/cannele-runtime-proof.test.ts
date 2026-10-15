import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { canneleRuntimeProofHandler, type RuntimeProofDatabase } from "../lib/cannele-runtime-proof";

const nonce = Buffer.alloc(32, 3).toString("base64url");
const instanceId = "10000000-0000-4000-8000-000000000001";
const leaseId = "20000000-0000-4000-8000-000000000002";
const attemptId = "30000000-0000-4000-8000-000000000003";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const previewHost = "ep-preview.ap-southeast-1.aws.neon.tech";
const productionHost = "ep-production.ap-southeast-1.aws.neon.tech";
const preview = {
  AUTH_MODE: "test", VERCEL_ENV: "preview", VERCEL_DEPLOYMENT_ID: "dpl_Test123", VERCEL_URL: "cake-feature-123.vercel.app",
  VERCEL_GIT_COMMIT_REF: "codex/feature", VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  CAKE_QA_SLOT: "qa1", CAKE_QA_PR: "34", CAKE_QA_LEASE_TOKEN: leaseId,
  CAKE_QA_SOURCE_BRANCH: "codex/feature", CAKE_QA_SOURCE_SHA: "a".repeat(40),
  CAKE_TEST_DATABASE_URL: `postgresql://neondb_owner:fixture-password@ep-preview-pooler.ap-southeast-1.aws.neon.tech/cake?sslmode=require&channel_binding=require`,
  CAKE_QA_DATABASE_HOST_SHA256: hash(previewHost), CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: hash(productionHost),
  CANNELE_INSTANCE_ID: instanceId, CANNELE_ATTEMPT_ID: attemptId, CANNELE_PHASE: "application",
};

function request(query = `nonce=${nonce}`, method = "GET") {
  return new Request(`https://${preview.VERCEL_URL}/api/qa/cannele?${query}`, { method });
}

function fixture(environment: Readonly<Record<string, string | undefined>> = preview, database?: RuntimeProofDatabase) {
  let databaseCalls = 0;
  const queries: { statement: string; parameters: readonly unknown[]; signal: AbortSignal }[] = [];
  const handler = canneleRuntimeProofHandler({ environment: () => environment, database: () => {
    databaseCalls += 1;
    return database ?? { query: async (statement, parameters, options) => {
      queries.push({ statement, parameters, signal: options.fetchOptions.signal });
      // Extra driver fields must never be copied into a public proof.
      return [{ verified: 1, database_url: "postgresql://fixture-password@private.invalid/db", role: "private-role" }];
    } };
  } });
  return { handler, queries, databaseCalls: () => databaseCalls };
}

async function safeResponse(response: Response) {
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(response.headers.get("Location"), null);
  const text = await response.text();
  assert.doesNotMatch(text, /postgresql|fixture-password|ep-preview|ep-production|private-role|private\.invalid|SELECT|cake_preview_database_identity/);
  return JSON.parse(text) as Record<string, unknown>;
}

test("runtime proof returns only nonce-bound system identity, verified metadata and selected host digests", async () => {
  const f = fixture(); const result = await f.handler(request());
  assert.equal(result.status, 200);
  assert.deepEqual(await safeResponse(result), {
    protocol: "cannele-runtime-proof/v1", appId: "cake", nonce, deploymentId: preview.VERCEL_DEPLOYMENT_ID,
    instanceId, leaseId, attemptId, prNumber: 34, sourceSha: preview.VERCEL_GIT_COMMIT_SHA,
    branch: preview.CAKE_QA_SOURCE_BRANCH, phase: "application", databaseHostDigest: hash(previewHost),
    productionHostDigest: hash(productionHost), connectionVerified: true,
  });
  assert.equal(f.databaseCalls(), 1); assert.equal(f.queries.length, 1);
  assert.match(f.queries[0].statement, /^SELECT 1 AS verified/);
  assert.doesNotMatch(f.queries[0].statement, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|DO|pg_advisory)\b/i);
  assert.match(f.queries[0].statement, /current_database\(\)/);
  assert.deepEqual(f.queries[0].parameters, ["qa1", 34, leaseId, "codex/feature", previewHost, "cake"]);
  assert.ok(f.queries[0].signal instanceof AbortSignal);
});

test("production, development and non-test modes reject before client construction or metadata parsing", async () => {
  for (const change of [{ VERCEL_ENV: "production" }, { VERCEL_ENV: "development" }, { VERCEL_ENV: undefined },
    { AUTH_MODE: "google" }, { AUTH_MODE: undefined }]) {
    const f = fixture({ ...preview, ...change, CAKE_TEST_DATABASE_URL: "unsafe-not-a-url" });
    const response = await f.handler(request("malformed=1"));
    assert.equal(response.status, 404); assert.deepEqual(await safeResponse(response), { code: "NOT_FOUND" });
    assert.equal(f.databaseCalls(), 0);
  }
});

test("legacy QA and missing or invalid Cannele/system tags cannot borrow or fabricate a runtime proof", async () => {
  for (const change of [{ CANNELE_INSTANCE_ID: undefined }, { CANNELE_ATTEMPT_ID: undefined }, { CANNELE_PHASE: undefined },
    { CANNELE_INSTANCE_ID: "other" }, { CANNELE_ATTEMPT_ID: attemptId.toUpperCase().replace("300", "ABC") },
    { CANNELE_PHASE: "provisioning" }, { VERCEL_DEPLOYMENT_ID: undefined }, { VERCEL_DEPLOYMENT_ID: "dpl_other/url" },
    { VERCEL_URL: "attacker.invalid" }, { CAKE_QA_DATABASE_HOST_SHA256: undefined }, { CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: undefined }]) {
    const f = fixture({ ...preview, ...change }); const response = await f.handler(request());
    assert.equal(response.status, 503); assert.deepEqual(await safeResponse(response), { code: "RUNTIME_PROOF_UNAVAILABLE" });
    assert.equal(f.databaseCalls(), 0);
  }
});

test("nonce encoding, unknown or duplicate query values, fragments and other methods fail without a DB connection", async () => {
  const zero = Buffer.alloc(32).toString("base64url");
  const queries = ["", "nonce=", "nonce=short", `nonce=${zero.slice(0, -1)}B`, `nonce=${nonce}=`,
    `nonce=${nonce}&nonce=${nonce}`, `nonce=${nonce}&host=other`, `nonce=${nonce}#secret`, `nonce=${nonce}&sourceSha=${"b".repeat(40)}`];
  for (const query of queries) {
    const f = fixture(); const response = await f.handler(request(query));
    assert.equal(response.status, 400); assert.deepEqual(await safeResponse(response), { code: "INPUT_INVALID" });
    assert.equal(f.databaseCalls(), 0);
  }
  const f = fixture(); const response = await f.handler(request(`nonce=${nonce}`, "POST"));
  assert.equal(response.status, 405); assert.deepEqual(await safeResponse(response), { code: "METHOD_NOT_ALLOWED" });
  assert.equal(f.databaseCalls(), 0);
});

test("existing QA identity and production separation guards run before the actual app client", async () => {
  for (const change of [{ CAKE_QA_LEASE_TOKEN: "different" }, { CAKE_QA_SLOT: "qa4" }, { CAKE_QA_PR: "0" },
    { CAKE_QA_SOURCE_SHA: "b".repeat(40) }, { VERCEL_GIT_COMMIT_REF: "codex/other" }, { CAKE_QA_SOURCE_BRANCH: "main" },
    { CAKE_QA_DATABASE_HOST_SHA256: hash(productionHost) }, { CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: hash(previewHost) },
    { DATABASE_URL: preview.CAKE_TEST_DATABASE_URL },
    { CAKE_TEST_DATABASE_URL: preview.CAKE_TEST_DATABASE_URL.replace("ep-preview-pooler", "ep-other") }]) {
    const f = fixture({ ...preview, ...change }); const response = await f.handler(request());
    assert.equal(response.status, 503); assert.deepEqual(await safeResponse(response), { code: "RUNTIME_PROOF_UNAVAILABLE" });
    assert.equal(f.databaseCalls(), 0);
  }
});

test("connection parameters cannot override the fingerprinted host, database, user, transport or search path", async () => {
  const base = preview.CAKE_TEST_DATABASE_URL.split("?")[0];
  for (const suffix of ["?host=ep-production.invalid", "?hostaddr=127.0.0.1", "?options=-c%20search_path=other", "?service=other",
    "?database=other", "?user=other", "?password=other", "?endpoint=other", "?sslmode=disable", "?channel_binding=disable",
    "?sslmode=require&sslmode=require", "?channel_binding=require&channel_binding=require", "#fragment"]) {
    const f = fixture({ ...preview, CAKE_TEST_DATABASE_URL: base + suffix });
    const response = await f.handler(request()); assert.equal(response.status, 503);
    assert.deepEqual(await safeResponse(response), { code: "RUNTIME_PROOF_UNAVAILABLE" }); assert.equal(f.databaseCalls(), 0);
  }
  for (const value of [base.replace("neondb_owner", "owner%00other"), base.replace("fixture-password", ""), base.replace(".neon.tech/cake", ".neon.tech:6543/cake")]) {
    const f = fixture({ ...preview, CAKE_TEST_DATABASE_URL: value });
    assert.equal((await f.handler(request())).status, 503); assert.equal(f.databaseCalls(), 0);
  }
});

test("missing marker, failed connections and raw driver errors return a fixed private response without logging", async (t) => {
  const errorLog = t.mock.method(console, "error", () => undefined);
  const infoLog = t.mock.method(console, "log", () => undefined);
  for (const query of [async () => [], async () => [{ verified: 0 }], async () => [{ verified: "1" }],
    async () => { throw new Error("postgresql://fixture-password@private.invalid/db SELECT raw SQL"); }]) {
    const f = fixture(preview, { query }); const response = await f.handler(request());
    assert.equal(response.status, 503); assert.deepEqual(await safeResponse(response), { code: "RUNTIME_PROOF_UNAVAILABLE" });
  }
  assert.equal(errorLog.mock.callCount(), 0); assert.equal(infoLog.mock.callCount(), 0);
});

test("actual read-only SQL accepts exactly the selected QA marker and rejects another cached database identity", async () => {
  // Disposable PostgreSQL-compatible memory database, not a live Neon claim.
  const sql = new PGlite();
  try {
    const name = String((await sql.query<{ name: string }>("SELECT current_database() AS name")).rows[0].name);
    await sql.exec(`CREATE TABLE public.cake_preview_database_identity (
      singleton boolean, version integer, slot text, pr integer, lease_token uuid,
      source_branch text, database_host text, database_name text)`);
    await sql.query("INSERT INTO public.cake_preview_database_identity VALUES (true,1,$1,$2,$3,$4,$5,$6)",
      ["qa1", 34, leaseId, "codex/feature", previewHost, name]);
    const environment = { ...preview, CAKE_TEST_DATABASE_URL: preview.CAKE_TEST_DATABASE_URL.replace("/cake?", `/${name}?`) };
    const database: RuntimeProofDatabase = { query: async (statement, parameters) => (await sql.query<Record<string, unknown>>(statement, [...parameters])).rows };
    const f = fixture(environment, database);
    const valid = await f.handler(request()); assert.equal(valid.status, 200); await safeResponse(valid);
    for (const statement of [
      "UPDATE public.cake_preview_database_identity SET database_host='ep-other.ap-southeast-1.aws.neon.tech'",
      "UPDATE public.cake_preview_database_identity SET database_host=$1,lease_token='40000000-0000-4000-8000-000000000004'",
      "UPDATE public.cake_preview_database_identity SET lease_token=$1,database_name='other_database'",
    ]) {
      await sql.query(statement, statement.includes("$1") ? [statement.includes("database_host=$1") ? previewHost : leaseId] : []);
      const invalid = await f.handler(request()); assert.equal(invalid.status, 503); await safeResponse(invalid);
    }
    await sql.query("UPDATE public.cake_preview_database_identity SET database_name=$1", [name]);
    await sql.exec("INSERT INTO public.cake_preview_database_identity SELECT * FROM public.cake_preview_database_identity");
    assert.equal((await f.handler(request())).status, 503, "Duplicate identity rows must not confirm a selected database.");
  } finally { await sql.close(); }
});

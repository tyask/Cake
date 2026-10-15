import { createHash } from "node:crypto";
import { databaseConnectionString, previewDatabaseIdentity } from "./database-environment";

type Environment = Readonly<Record<string, string | undefined>>;
type Rows = readonly Record<string, unknown>[];
export interface RuntimeProofDatabase {
  query(statement: string, parameters: unknown[], options: { fetchOptions: { signal: AbortSignal } }): PromiseLike<Rows>;
}
export interface RuntimeProofDependencies {
  environment: () => Environment;
  /** The application's existing db() client, never a probe-only connection. */
  database: () => RuntimeProofDatabase;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const responseHeaders = {
  "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
};

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: responseHeaders });
}

function unavailable(): never { throw new Error("Runtime proof is unavailable."); }

function canonicalNonce(value: string | null): value is string {
  if (value === null || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

/** Constant read-only SQL verifies the marker on the same client used by Cake.
 * It also catches a cached client that was selected before a different URL.
 * No raw host, database name, credentials or application rows are returned.
 */
const identityQuery = `SELECT 1 AS verified
WHERE (SELECT count(*) FROM public.cake_preview_database_identity) = 1
  AND EXISTS (SELECT 1 FROM public.cake_preview_database_identity
    WHERE singleton AND version = 1 AND slot = $1 AND pr = $2
      AND lease_token = $3::uuid AND source_branch = $4
      AND database_host = $5 AND database_name = $6
      AND database_name = current_database())`;

/** A trusted Cake module reports its selected runtime connection; this is not
 * cryptographic attestation of arbitrary feature-branch code.
 */
export function canneleRuntimeProofHandler(dependencies: RuntimeProofDependencies) {
  return async (request: Request): Promise<Response> => {
    const environment = { ...dependencies.environment() };
    // Evaluate the QA-only gate before parsing metadata or touching the client.
    if (environment.VERCEL_ENV !== "preview" || environment.AUTH_MODE !== "test") {
      return response({ code: "NOT_FOUND" }, 404);
    }
    if (request.method !== "GET") return response({ code: "METHOD_NOT_ALLOWED" }, 405);
    let nonce: string;
    try {
      if (request.url.length > 2048) throw new Error();
      const url = new URL(request.url);
      const candidate = url.searchParams.get("nonce");
      if (url.pathname !== "/api/qa/cannele" || url.username || url.password || url.hash
        || url.searchParams.size !== 1 || url.searchParams.getAll("nonce").length !== 1 || !canonicalNonce(candidate)) throw new Error();
      nonce = candidate;
    } catch { return response({ code: "INPUT_INVALID" }, 400); }

    try {
      if (!uuid.test(environment.CANNELE_INSTANCE_ID ?? "") || !uuid.test(environment.CANNELE_ATTEMPT_ID ?? "")
        || environment.CANNELE_PHASE !== "application" || !/^dpl_[A-Za-z0-9]+$/.test(environment.VERCEL_DEPLOYMENT_ID ?? "")
        || !/^[a-z0-9-]+\.vercel\.app$/.test(environment.VERCEL_URL ?? "")
        || !digest.test(environment.CAKE_QA_DATABASE_HOST_SHA256 ?? "")
        || !digest.test(environment.CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256 ?? "")) unavailable();
      const connectionString = databaseConnectionString(environment);
      // The shared selector validates Cannele connection parameters before
      // any app/build/seed client can connect, including this existing client.
      const selected = new URL(connectionString);
      const identity = previewDatabaseIdentity(environment);
      if (!identity || identity.sourceBranch.length > 255) unavailable();
      const canonicalHost = selected.hostname.toLowerCase().replace(/-pooler(?=\.)/, "");
      const databaseHostDigest = createHash("sha256").update(canonicalHost).digest("hex");
      if (databaseHostDigest !== environment.CAKE_QA_DATABASE_HOST_SHA256
        || databaseHostDigest === environment.CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256) unavailable();
      const rows = await dependencies.database().query(identityQuery,
        [identity.slot, identity.pr, identity.leaseToken, identity.sourceBranch, identity.databaseHost, identity.databaseName],
        { fetchOptions: { signal: AbortSignal.timeout(8_000) } });
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.verified !== 1) unavailable();
      return response({
        protocol: "cannele-runtime-proof/v1", appId: "cake", nonce,
        deploymentId: environment.VERCEL_DEPLOYMENT_ID, instanceId: environment.CANNELE_INSTANCE_ID,
        leaseId: identity.leaseToken, attemptId: environment.CANNELE_ATTEMPT_ID,
        prNumber: identity.pr, sourceSha: environment.VERCEL_GIT_COMMIT_SHA, branch: identity.sourceBranch,
        phase: "application", databaseHostDigest,
        productionHostDigest: environment.CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256, connectionVerified: true,
      });
    } catch { return response({ code: "RUNTIME_PROOF_UNAVAILABLE" }, 503); }
  };
}

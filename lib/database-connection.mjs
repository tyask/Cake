import { previewFixtureBaseValidationSql, previewFixtureEmptyDatabaseSql } from "./preview-fixture-base.mjs";
import { createHash } from "node:crypto";

/** Select the DB before constructing any client. Never include URLs in errors. */
export function databaseVariable(environment) {
  return environment.VERCEL_ENV === "preview" ? "CAKE_TEST_DATABASE_URL" : "DATABASE_URL";
}

function endpoint(value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname)) throw new Error();
  return url.hostname.replace(/-pooler(?=\.)/, "");
}

const QA_VARIABLES = ["CAKE_QA_SLOT", "CAKE_QA_PR", "CAKE_QA_LEASE_TOKEN", "CAKE_QA_SOURCE_BRANCH", "CAKE_QA_SOURCE_SHA", "CAKE_QA_DATABASE_HOST", "CAKE_QA_PRODUCTION_DATABASE_HOST", "CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256"];
const GUARD_ERROR = "QA貸出とDBの照合に失敗しました。確認済みのPR・feature枝・lease・専用Neon endpointと本番endpointを設定してください。DB操作は開始しません。";

/** Metadata is supplied by the trusted QA writer, after Neon identity checks. */
export function previewDatabaseIdentity(environment) {
  if (environment.VERCEL_ENV !== "preview") {
    if (QA_VARIABLES.some((name) => environment[name] !== undefined)) throw new Error(GUARD_ERROR);
    return null;
  }
  try {
    const slot = environment.CAKE_QA_SLOT;
    const pr = environment.CAKE_QA_PR;
    const leaseToken = environment.CAKE_QA_LEASE_TOKEN;
    const sourceBranch = environment.CAKE_QA_SOURCE_BRANCH;
    const sourceSha = environment.CAKE_QA_SOURCE_SHA;
    if (!/^qa[123]$/.test(slot ?? "") || !/^[1-9][0-9]*$/.test(pr ?? "")
      || !Number.isSafeInteger(Number(pr)) || Number(pr) > 2_147_483_647
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(leaseToken ?? "")
      || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(sourceBranch ?? "")
      || sourceBranch === "main" || /^qa[123]$/.test(sourceBranch ?? "")
      || sourceBranch !== environment.VERCEL_GIT_COMMIT_REF
      || !/^[a-f0-9]{40}$/.test(sourceSha ?? "") || sourceSha !== environment.VERCEL_GIT_COMMIT_SHA) throw new Error();
    const value = environment.CAKE_TEST_DATABASE_URL?.trim();
    const expectedHost = environment.CAKE_QA_DATABASE_HOST;
    const productionHost = environment.CAKE_QA_PRODUCTION_DATABASE_HOST;
    const productionDigest = environment.CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256;
    // Missing production comparison evidence is unsafe even when DATABASE_URL
    // has intentionally not been exposed to the Preview deployment.
    if (!value || !expectedHost || (!productionHost && !productionDigest)
      || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(expectedHost)
      || (productionHost && !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(productionHost))
      || (productionDigest !== undefined && !/^[a-f0-9]{64}$/.test(productionDigest))) throw new Error();
    const databaseHost = endpoint(value);
    const digest = (host) => createHash("sha256").update(host).digest("hex");
    if (productionDigest && (digest(databaseHost) === productionDigest
      || productionHost && digest(endpoint(`postgresql://guard@${productionHost}/guard`)) !== productionDigest)) throw new Error();
    if (databaseHost !== endpoint(`postgresql://guard@${expectedHost}/guard`)
      || (productionHost && databaseHost === endpoint(`postgresql://guard@${productionHost}/guard`))
      || (environment.DATABASE_URL && databaseHost === endpoint(environment.DATABASE_URL))) throw new Error();
    const url = new URL(value);
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(databaseName)) throw new Error();
    return { slot, pr: Number(pr), leaseToken, sourceBranch, databaseHost, databaseName };
  } catch {
    throw new Error(GUARD_ERROR);
  }
}

export function databaseConnectionString(environment) {
  const variable = databaseVariable(environment);
  const value = environment[variable]?.trim();
  if (!value || value === "[SENSITIVE]") throw new Error(`${variable} が設定されていません。`);
  previewDatabaseIdentity(environment);
  return value;
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** The guard and caller's statements share a transaction and advisory lock. */
export function previewDatabaseGuardSql(identity, initialize = false, statements = "") {
  const matches = `version = 1 AND singleton AND slot = ${literal(identity.slot)}
    AND pr = ${identity.pr} AND source_branch = ${literal(identity.sourceBranch)}
    AND lease_token = ${literal(identity.leaseToken)}::uuid
    AND database_host = ${literal(identity.databaseHost)}
    AND database_name = ${literal(identity.databaseName)} AND database_name = current_database()`;
  return `DO $cake_preview_guard$
  DECLARE
    relation record;
    has_rows boolean;
    fixture_seeded boolean := false;
    fixture_search_path text;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('cake:preview-database-identity'));
    IF current_database() <> ${literal(identity.databaseName)} THEN
      RAISE EXCEPTION 'Cake Preview DB identity mismatch';
    END IF;
    IF to_regclass('public.cake_preview_database_identity') IS NULL THEN
      ${initialize ? `
      -- Claim only a genuinely empty DB or the complete approved inherited
      -- fixture. An existing same-lease marker never repeats this initial check.
      fixture_search_path := current_setting('search_path');
      PERFORM pg_catalog.set_config('search_path', 'pg_catalog, public', true);
      IF NOT (${previewFixtureEmptyDatabaseSql()}) THEN
        ${previewFixtureBaseValidationSql()}
        fixture_seeded := true;
      END IF;
      PERFORM pg_catalog.set_config('search_path', fixture_search_path, true);
      CREATE TABLE public.cake_preview_database_identity (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        version integer NOT NULL CHECK (version = 1),
        slot text NOT NULL, pr integer NOT NULL, source_branch text NOT NULL,
        lease_token uuid NOT NULL, database_host text NOT NULL, database_name text NOT NULL,
        initialized_at timestamptz NOT NULL DEFAULT now(), seeded_at timestamptz
      );
      INSERT INTO public.cake_preview_database_identity
        (singleton, version, slot, pr, source_branch, lease_token, database_host, database_name, seeded_at)
      VALUES (true, 1, ${literal(identity.slot)}, ${identity.pr}, ${literal(identity.sourceBranch)},
        ${literal(identity.leaseToken)}::uuid, ${literal(identity.databaseHost)}, current_database(),
        CASE WHEN fixture_seeded THEN now() ELSE NULL END);`
        : "RAISE EXCEPTION 'Cake Preview DB identity is missing';"}
    END IF;
    IF (SELECT COUNT(*) FROM public.cake_preview_database_identity) <> 1
      OR NOT EXISTS (SELECT 1 FROM public.cake_preview_database_identity WHERE ${matches}) THEN
      RAISE EXCEPTION 'Cake Preview DB identity mismatch';
    END IF;
    ${statements}
  END;
  $cake_preview_guard$;`;
}

export async function guardPreviewDatabase(sql, environment, initialize = false) {
  const identity = previewDatabaseIdentity(environment);
  if (!identity) return null;
  try {
    await sql.query(previewDatabaseGuardSql(identity, initialize));
    return identity;
  } catch {
    throw new Error("Preview DBの空状態・PR・lease照合を確認できません。DB更新・seedを停止しました。接続情報やDBエラー本文は表示しません。");
  }
}

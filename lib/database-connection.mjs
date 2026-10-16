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

const QA_VARIABLES = ['CAKE_PREVIEW_REPOSITORY', 'CAKE_PREVIEW_PR', 'CAKE_PREVIEW_GENERATION', 'CAKE_PREVIEW_SOURCE_BRANCH', 'CAKE_PREVIEW_SOURCE_SHA', 'CAKE_PREVIEW_DATABASE_BRANCH_ID', 'CAKE_PREVIEW_DATABASE_HOST_SHA256', 'CAKE_PREVIEW_PRODUCTION_HOST_SHA256', 'CAKE_PREVIEW_PHASE'];
const GUARD_ERROR = 'PreviewとDBの照合に失敗しました。PR・専用ブランチ・DB世代・endpointと本番DBの分離を確認してください。DB操作は開始しません。';

/** Validate the Native connection before constructing an application, migration or seed client. */
export function previewDatabaseIdentity(environment) {
  if (environment.VERCEL_ENV !== 'preview') {
    if (QA_VARIABLES.some(name => environment[name] !== undefined)) throw new Error(GUARD_ERROR);
    return null;
  }
  try {
    const pr = environment.CAKE_PREVIEW_PR;
    const generation = environment.CAKE_PREVIEW_GENERATION;
    const sourceBranch = environment.CAKE_PREVIEW_SOURCE_BRANCH;
    const branchId = environment.CAKE_PREVIEW_DATABASE_BRANCH_ID;
    if (environment.AUTH_MODE !== 'test' || environment.CAKE_PREVIEW_PHASE !== 'application'
      || environment.CAKE_PREVIEW_REPOSITORY !== 'tyask/Cake'
      || !/^[1-9][0-9]*$/.test(pr ?? '') || !Number.isSafeInteger(Number(pr)) || Number(pr) > 2147483647
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(generation ?? '')
      || !/^codex\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sourceBranch ?? '') || sourceBranch.length > 66
      || sourceBranch !== environment.VERCEL_GIT_COMMIT_REF
      || !/^[a-f0-9]{40}$/.test(environment.CAKE_PREVIEW_SOURCE_SHA ?? '')
      || environment.CAKE_PREVIEW_SOURCE_SHA !== environment.VERCEL_GIT_COMMIT_SHA
      || !/^br-[a-z0-9-]+$/.test(branchId ?? '')) throw new Error();
    const value = environment.CAKE_TEST_DATABASE_URL?.trim();
    const url = new URL(value);
    if (![ 'postgres:', 'postgresql:' ].includes(url.protocol) || url.hash || url.port && url.port !== '5432'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(decodeURIComponent(url.username)) || !decodeURIComponent(url.password)
      || /[\u0000-\u001f\u007f]/.test(decodeURIComponent(url.password))) throw new Error();
    for (const name of url.searchParams.keys()) {
      const parameter = url.searchParams.get(name);
      if (url.searchParams.getAll(name).length !== 1 || !((name === 'sslmode' && parameter === 'require') || (name === 'channel_binding' && parameter === 'require'))) throw new Error();
    }
    const databaseHost = endpoint(value), databaseName = decodeURIComponent(url.pathname.slice(1));
    const expected = environment.CAKE_PREVIEW_DATABASE_HOST_SHA256, production = environment.CAKE_PREVIEW_PRODUCTION_HOST_SHA256;
    const digest = createHash('sha256').update(databaseHost).digest('hex');
    if (!/^[a-f0-9]{64}$/.test(expected ?? '') || !/^[a-f0-9]{64}$/.test(production ?? '') || digest !== expected || digest === production
      || environment.DATABASE_URL && databaseHost === endpoint(environment.DATABASE_URL)
      || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(databaseName)) throw new Error();
    return { repository: 'tyask/Cake', pr: Number(pr), generation, sourceBranch, branchId, databaseHost, databaseName };
  } catch { throw new Error(GUARD_ERROR); }
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
  const matches = `version = 2 AND singleton AND repository = ${literal(identity.repository)}
    AND pr = ${identity.pr} AND source_branch = ${literal(identity.sourceBranch)}
    AND generation = ${literal(identity.generation)}::uuid AND branch_id = ${literal(identity.branchId)}
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
      -- fixture. An existing same-generation marker never repeats this initial check.
      fixture_search_path := current_setting('search_path');
      PERFORM pg_catalog.set_config('search_path', 'pg_catalog, public', true);
      IF NOT (${previewFixtureEmptyDatabaseSql()}) THEN
        ${previewFixtureBaseValidationSql()}
        fixture_seeded := true;
      END IF;
      PERFORM pg_catalog.set_config('search_path', fixture_search_path, true);
      CREATE TABLE public.cake_preview_database_identity (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        version integer NOT NULL CHECK (version = 2),
        repository text NOT NULL, pr integer NOT NULL, source_branch text NOT NULL,
        generation uuid NOT NULL, branch_id text NOT NULL, database_host text NOT NULL, database_name text NOT NULL,
        initialized_at timestamptz NOT NULL DEFAULT now(), seeded_at timestamptz
      );
      INSERT INTO public.cake_preview_database_identity
        (singleton, version, repository, pr, source_branch, generation, branch_id, database_host, database_name, seeded_at)
      VALUES (true, 2, ${literal(identity.repository)}, ${identity.pr}, ${literal(identity.sourceBranch)},
        ${literal(identity.generation)}::uuid, ${literal(identity.branchId)}, ${literal(identity.databaseHost)}, current_database(),
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
    throw new Error("Preview DBの空状態・PR・DB世代照合を確認できません。DB更新・seedを停止しました。接続情報やDBエラー本文は表示しません。");
  }
}

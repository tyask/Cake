import { createHash } from "node:crypto";
import { PREVIEW_FIXTURE_SCHEMA_SHA256, PREVIEW_FIXTURE_EMPTY_SCHEMA_SHA256, PREVIEW_FIXTURE_SCHEMA_CATEGORIES, PREVIEW_FIXTURE_MIGRATIONS } from "./preview-fixture-reference.mjs";

export { PREVIEW_FIXTURE_SCHEMA_SHA256, PREVIEW_FIXTURE_EMPTY_SCHEMA_SHA256, PREVIEW_FIXTURE_SCHEMA_CATEGORIES, PREVIEW_FIXTURE_MIGRATIONS };
export const PREVIEW_FIXTURE_GUARD_REVISION = "4";

const TABLES = [
  "app_user_access_guard", "app_users", "default_rules", "import_batches", "invitations",
  "recurring_payments", "schema_migrations", "settlement_transactions", "settlements",
  "transactions", "workspace_members", "workspaces",
];
const BUSINESS_TABLES = [
  "default_rules", "import_batches", "invitations", "recurring_payments",
  "settlement_transactions", "settlements", "transactions",
];

function literal(value) { return `'${String(value).replaceAll("'", "''")}'`; }
const userSchema = "n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'";
const aggregate = (query) => `COALESCE((SELECT jsonb_agg(item ORDER BY item::text COLLATE "C") FROM (${query}) items), '[]'::jsonb)`;

/** Stable semantic catalog: object identities replace OIDs; owners and C library
 * paths are deployment details. Routine bodies and extension members stay pinned.
 * Run with search_path=pg_catalog,public so deparsed expressions are repeatable. */
export function previewFixtureCatalogSql() {
  const entries = {
    schemas: `SELECT jsonb_build_object('name', n.nspname) AS item FROM pg_catalog.pg_namespace n WHERE ${userSchema}`,
    extensions: `SELECT jsonb_build_object('name', e.extname, 'schema', n.nspname, 'version', e.extversion,
      'relocatable', e.extrelocatable) AS item FROM pg_catalog.pg_extension e
      JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace`,
    extensionMembers: `SELECT jsonb_build_object('extension', e.extname, 'class', d.classid::regclass::text,
      'type', ident.type, 'schema', ident.schema, 'name', ident.name, 'identity', ident.identity) AS item
      FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
      CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid) ident
      WHERE d.refclassid = 'pg_catalog.pg_extension'::regclass AND d.deptype = 'e' AND e.extname <> 'plpgsql'`,
    relations: `SELECT jsonb_build_object('schema', n.nspname, 'name', c.relname, 'kind', c.relkind,
      'persistence', c.relpersistence, 'partition', c.relispartition, 'rls', c.relrowsecurity,
      'forceRls', c.relforcerowsecurity, 'replicaIdentity', c.relreplident, 'options', c.reloptions,
      'accessMethod', am.amname, 'partitionKey', pg_catalog.pg_get_partkeydef(c.oid)) AS item
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam WHERE ${userSchema}`,
    columns: `SELECT jsonb_build_object('schema', n.nspname, 'table', c.relname, 'position', a.attnum,
      'name', CASE WHEN a.attisdropped THEN NULL ELSE a.attname END, 'dropped', a.attisdropped,
      'type', pg_catalog.format_type(a.atttypid, a.atttypmod), 'dimensions', a.attndims,
      'notNull', a.attnotnull, 'identity', a.attidentity, 'generated', a.attgenerated,
      'default', pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, false),
      'collationSchema', cn.nspname, 'collation', co.collname) AS item
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
      LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
      WHERE ${userSchema} AND a.attnum > 0`,
    constraints: `SELECT jsonb_build_object('schema', n.nspname, 'table', c.relname, 'name', co.conname,
      'type', co.contype, 'definition', pg_catalog.pg_get_constraintdef(co.oid, false),
      'deferrable', co.condeferrable, 'deferred', co.condeferred, 'validated', co.convalidated,
      'noInherit', co.connoinherit, 'local', co.conislocal, 'inheritedCount', co.coninhcount,
      'hasParent', co.conparentid <> 0) AS item
      FROM pg_catalog.pg_constraint co JOIN pg_catalog.pg_namespace n ON n.oid = co.connamespace
      LEFT JOIN pg_catalog.pg_class c ON c.oid = co.conrelid WHERE ${userSchema} AND co.contype <> 'n'`,
    indexes: `SELECT jsonb_build_object('schema', n.nspname, 'table', c.relname, 'name', ix.relname,
      'definition', pg_catalog.pg_get_indexdef(i.indexrelid), 'unique', i.indisunique,
      'primary', i.indisprimary, 'exclusion', i.indisexclusion, 'immediate', i.indimmediate,
      'valid', i.indisvalid, 'ready', i.indisready, 'live', i.indislive,
      'clustered', i.indisclustered, 'replicaIdentity', i.indisreplident,
      'nullsNotDistinct', i.indnullsnotdistinct) AS item
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
      JOIN pg_catalog.pg_class ix ON ix.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${userSchema}`,
    triggers: `SELECT jsonb_build_object('schema', n.nspname, 'table', c.relname,
      'name', CASE WHEN t.tgisinternal THEN NULL ELSE t.tgname END, 'internal', t.tgisinternal,
      'enabled', t.tgenabled, 'definition', CASE WHEN t.tgisinternal THEN NULL ELSE pg_catalog.pg_get_triggerdef(t.oid, false) END,
      'type', t.tgtype, 'constraint', co.conname, 'function', pn.nspname || '.' || p.proname,
      'arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'deferrable', t.tgdeferrable, 'deferred', t.tginitdeferred) AS item
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
      LEFT JOIN pg_catalog.pg_constraint co ON co.oid = t.tgconstraint WHERE ${userSchema}`,
    routines: `SELECT jsonb_build_object('schema', n.nspname, 'name', p.proname,
      'arguments', pg_catalog.pg_get_function_arguments(p.oid), 'result', pg_catalog.pg_get_function_result(p.oid),
      'language', l.lanname, 'kind', p.prokind, 'body', p.prosrc,
      'sqlBody', CASE WHEN p.prosqlbody IS NOT NULL THEN pg_catalog.pg_get_functiondef(p.oid) END,
      'volatility', p.provolatile, 'strict', p.proisstrict, 'securityDefiner', p.prosecdef,
      'leakproof', p.proleakproof, 'parallel', p.proparallel, 'returnsSet', p.proretset,
      'cost', p.procost, 'rows', p.prorows, 'configuration', p.proconfig) AS item
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE ${userSchema}`,
    types: `SELECT jsonb_build_object('schema', n.nspname, 'name', t.typname, 'kind', t.typtype,
      'category', t.typcategory, 'defined', t.typisdefined, 'delimiter', t.typdelim,
      'notNull', t.typnotnull, 'default', t.typdefault, 'relation', c.relname,
      'element', CASE WHEN t.typelem <> 0 THEN pg_catalog.format_type(t.typelem, NULL) END,
      'base', CASE WHEN t.typbasetype <> 0 THEN pg_catalog.format_type(t.typbasetype, t.typtypmod) END,
      'input', t.typinput::regproc::text, 'output', t.typoutput::regproc::text,
      'receive', t.typreceive::regproc::text, 'send', t.typsend::regproc::text,
      'collationSchema', cn.nspname, 'collation', co.collname) AS item
      FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
      LEFT JOIN pg_catalog.pg_collation co ON co.oid = t.typcollation
      LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace WHERE ${userSchema}`,
    otherObjects: `SELECT jsonb_build_object('class', 'operator', 'schema', n.nspname, 'name', o.oprname) AS item
      FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace WHERE ${userSchema}
      UNION ALL SELECT jsonb_build_object('class', 'collation', 'schema', n.nspname, 'name', o.collname)
      FROM pg_catalog.pg_collation o JOIN pg_catalog.pg_namespace n ON n.oid = o.collnamespace WHERE ${userSchema}
      UNION ALL SELECT jsonb_build_object('class', 'conversion', 'schema', n.nspname, 'name', o.conname)
      FROM pg_catalog.pg_conversion o JOIN pg_catalog.pg_namespace n ON n.oid = o.connamespace WHERE ${userSchema}
      UNION ALL SELECT jsonb_build_object('class', 'operatorClass', 'schema', n.nspname, 'name', o.opcname)
      FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace n ON n.oid = o.opcnamespace WHERE ${userSchema}
      UNION ALL SELECT jsonb_build_object('class', 'operatorFamily', 'schema', n.nspname, 'name', o.opfname)
      FROM pg_catalog.pg_opfamily o JOIN pg_catalog.pg_namespace n ON n.oid = o.opfnamespace WHERE ${userSchema}
      UNION ALL SELECT jsonb_build_object('class', 'cast', 'source', pg_catalog.format_type(o.castsource,NULL), 'target', pg_catalog.format_type(o.casttarget,NULL))
      FROM pg_catalog.pg_cast o JOIN pg_catalog.pg_type s ON s.oid = o.castsource JOIN pg_catalog.pg_type t ON t.oid = o.casttarget
      JOIN pg_catalog.pg_namespace sn ON sn.oid = s.typnamespace JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
      WHERE (sn.nspname <> 'information_schema' AND sn.nspname !~ '^pg_') OR (tn.nspname <> 'information_schema' AND tn.nspname !~ '^pg_')
      UNION ALL SELECT jsonb_build_object('class', 'policy', 'schema', n.nspname, 'table', c.relname, 'name', o.polname)
      FROM pg_catalog.pg_policy o JOIN pg_catalog.pg_class c ON c.oid = o.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${userSchema}
      UNION ALL SELECT jsonb_build_object('class', 'rule', 'schema', n.nspname, 'table', c.relname, 'name', o.rulename)
      FROM pg_catalog.pg_rewrite o JOIN pg_catalog.pg_class c ON c.oid = o.ev_class JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${userSchema}
      UNION ALL SELECT jsonb_build_object('class', 'statistics', 'schema', n.nspname, 'name', o.stxname)
      FROM pg_catalog.pg_statistic_ext o JOIN pg_catalog.pg_namespace n ON n.oid = o.stxnamespace WHERE ${userSchema}
      UNION ALL SELECT jsonb_build_object('class', 'inheritance', 'child', o.inhrelid::regclass::text, 'parent', o.inhparent::regclass::text) FROM pg_catalog.pg_inherits o
      UNION ALL SELECT jsonb_build_object('class', 'language', 'name', o.lanname) FROM pg_catalog.pg_language o WHERE o.lanname NOT IN ('internal','c','sql','plpgsql')
      UNION ALL SELECT jsonb_build_object('class', 'eventTrigger', 'name', o.evtname) FROM pg_catalog.pg_event_trigger o
      UNION ALL SELECT jsonb_build_object('class', 'foreignDataWrapper', 'name', o.fdwname) FROM pg_catalog.pg_foreign_data_wrapper o
      UNION ALL SELECT jsonb_build_object('class', 'foreignServer', 'name', o.srvname) FROM pg_catalog.pg_foreign_server o
      UNION ALL SELECT jsonb_build_object('class', 'publication', 'name', o.pubname) FROM pg_catalog.pg_publication o
      UNION ALL SELECT jsonb_build_object('class', 'largeObject') FROM pg_catalog.pg_largeobject_metadata o`,
  };
  return `SELECT jsonb_build_object(${Object.entries(entries).map(([name, query]) => `${literal(name)}, ${aggregate(query)}`).join(",\n")}) AS descriptor`;
}

export function assertPreviewFixtureMigrationNames(names) {
  if (names.length < PREVIEW_FIXTURE_MIGRATIONS.length
    || names.some((name, index) => {
      const baseline = PREVIEW_FIXTURE_MIGRATIONS[index];
      if (baseline) return name !== baseline.name;
      const number = Number(name.match(/^([0-9]+)_[a-z0-9_]+\.sql$/)?.[1]);
      const previous = Number(names[index - 1].match(/^([0-9]+)_/)?.[1]);
      return !Number.isSafeInteger(number) || number <= 11 || number <= previous || name <= names[index - 1];
    })) {
    throw new Error("Previewの承認済みfixture migrationを確認できません。DB更新を停止しました。");
  }
}

export function assertPreviewFixtureMigrationSource(name, sql) {
  const baseline = PREVIEW_FIXTURE_MIGRATIONS.find(migration => migration.name === name);
  if (baseline && createHash("sha256").update(sql).digest("hex") !== baseline.sha256) {
    throw new Error("Previewの承認済みfixture migrationを確認できません。DB更新を停止しました。");
  }
}

/** Full source review remains mandatory before the first Preview DB claim. */
export function assertPreviewFixtureMigrationSources(migrations) {
  assertPreviewFixtureMigrationNames(migrations.map(({ name }) => name));
  for (const { name, sql } of migrations) assertPreviewFixtureMigrationSource(name, sql);
}

export function previewFixtureCatalogFingerprintSql() {
  return `SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(descriptor::text, 'UTF8')), 'hex') AS fingerprint
    FROM (${previewFixtureCatalogSql()}) catalog`;
}

export function previewFixtureEmptyDatabaseSql() {
  return `(${previewFixtureCatalogFingerprintSql()}) IN (${PREVIEW_FIXTURE_EMPTY_SCHEMA_SHA256.map(literal).join(", ")})`;
}

/** Used only before the first Preview marker. All locks, reads and marker insert
 * are in the caller's single DO transaction; no fixture rows are rewritten. */
export function previewFixtureBaseValidationSql() {
  const failure = "RAISE EXCEPTION 'Cake Preview requires a new empty database';";
  const migrations = PREVIEW_FIXTURE_MIGRATIONS.map(({ name }) => literal(name)).join(", ");
  return `
    IF EXISTS (SELECT 1 FROM unnest(ARRAY[${TABLES.map(literal).join(", ")}]) required(name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = required.name AND c.relkind = 'r')) THEN
      ${failure}
    END IF;
    LOCK TABLE ${TABLES.map((name) => `public.${name}`).join(", ")} IN SHARE ROW EXCLUSIVE MODE;
    IF (${previewFixtureCatalogFingerprintSql()}) IS DISTINCT FROM ${literal(PREVIEW_FIXTURE_SCHEMA_SHA256)} THEN
      ${failure}
    END IF;
    IF (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'email', email, 'name', name,
      'image', image_url, 'admin', is_admin, 'enabled', is_enabled) ORDER BY id), '[]'::jsonb) FROM public.app_users)
      IS DISTINCT FROM '[{"id":"test-user-a","email":"test-a@cake.local","name":"テストユーザーA","image":null,"admin":true,"enabled":true},{"id":"test-user-b","email":"test-b@cake.local","name":"テストユーザーB","image":null,"admin":false,"enabled":true}]'::jsonb
      OR (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'type', type, 'owner', owner_user_id) ORDER BY id), '[]'::jsonb) FROM public.workspaces)
        IS DISTINCT FROM '[{"id":"00000000-0000-4000-8000-000000000001","name":"テスト共有家計","type":"SHARED","owner":"test-user-a"}]'::jsonb
      OR (SELECT COALESCE(jsonb_agg(jsonb_build_object('workspace', workspace_id, 'user', user_id, 'role', role, 'weight', weight) ORDER BY workspace_id,user_id), '[]'::jsonb) FROM public.workspace_members)
        IS DISTINCT FROM '[{"workspace":"00000000-0000-4000-8000-000000000001","user":"test-user-a","role":"OWNER","weight":1},{"workspace":"00000000-0000-4000-8000-000000000001","user":"test-user-b","role":"MEMBER","weight":1}]'::jsonb
      OR (SELECT COALESCE(jsonb_agg(jsonb_build_object('singleton', singleton, 'revision', revision::text)), '[]'::jsonb) FROM public.app_user_access_guard)
        IS DISTINCT FROM '[{"singleton":true,"revision":"${PREVIEW_FIXTURE_GUARD_REVISION}"}]'::jsonb
      OR (SELECT array_agg(name ORDER BY name COLLATE "C") FROM public.schema_migrations)
        IS DISTINCT FROM ARRAY[${migrations}]::text[]
      ${BUSINESS_TABLES.map((name) => `OR EXISTS (SELECT 1 FROM public.${name})`).join("\n      ")} THEN
      ${failure}
    END IF;
  `;
}

import { Client } from 'pg';
import { config, fail, hash, record, type Binding, type Connection } from './production-db-migration-provider';

export const appTables = ['app_user_access_guard', 'app_users', 'categories', 'default_rules', 'import_batches', 'invitations',
  'recurring_payments', 'schema_migrations', 'settlement_transactions', 'settlements', 'transactions', 'workspace_members', 'workspaces'] as const;
export const authTables = ['account', 'invitation', 'jwks', 'member', 'organization', 'project_config', 'session', 'user', 'verification'] as const;
export const authIdentityTables = authTables.filter(name => name !== 'jwks' && name !== 'project_config');
export interface Sql {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
export function databaseClient(connection: Connection): Sql {
  const client = new Client({ ...connection, ssl: { rejectUnauthorized: true }, enableChannelBinding: true,
    application_name: 'cake-production-db-migration', connectionTimeoutMillis: 20_000, query_timeout: 90_000 });
  // An asynchronous socket failure must not print a raw pg error or its parameters.
  client.on('error', () => undefined);
  return { connect: async () => { await client.connect(); }, query: (text, values) => client.query(text, values), end: () => client.end() };
}
export const beginReadOnly = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
export const catalogSql = `SELECT
  (SELECT jsonb_agg(x ORDER BY x::text COLLATE "C") FROM (
    SELECT jsonb_build_array(c.relname,row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum),a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
      a.attgenerated,a.attidentity,co.collname,pg_get_expr(d.adbin,d.adrelid)) AS x
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_collation co ON co.oid=a.attcollation
    WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped) q) AS columns,
  (SELECT jsonb_agg(x ORDER BY x::text COLLATE "C") FROM (
    SELECT jsonb_build_array(c.relname,k.conname,k.contype,k.convalidated,k.condeferrable,k.condeferred,
      pg_get_constraintdef(k.oid,true)) AS x FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    -- PG18 catalogs NOT NULL constraints separately; the columns above compare their logical state.
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND k.contype<>'n') q) AS constraints,
  (SELECT jsonb_agg(x ORDER BY x::text COLLATE "C") FROM (
    SELECT jsonb_build_array(c.relname,i.indisvalid,i.indisready,i.indislive,pg_get_indexdef(i.indexrelid)) AS x
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public') q) AS indexes,
  (SELECT jsonb_agg(x ORDER BY x::text COLLATE "C") FROM (
    SELECT jsonb_build_array(c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true)) AS x
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal) q) AS triggers,
  (SELECT jsonb_agg(x ORDER BY x::text COLLATE "C") FROM (
    SELECT jsonb_build_array(p.proname,pg_get_function_identity_arguments(p.oid),p.provolatile,p.proparallel,
      p.prosecdef,p.proconfig,md5(pg_get_functiondef(p.oid))) AS x
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      AND p.prokind IN ('f','p') AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')) q) AS functions`;
// ACL values contain role names and privilege bits, never passwords or Auth configuration.
export const aclSql = `WITH objects AS (
  SELECT 'schema' AS kind,n.nspname AS name,n.nspowner AS owner,
    coalesce(n.nspacl,acldefault('n',n.nspowner)) AS acl FROM pg_namespace n WHERE n.nspname='public'
  UNION ALL SELECT 'table',c.relname,c.relowner,coalesce(c.relacl,acldefault('r',c.relowner))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
  UNION ALL SELECT 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',p.proowner,
    coalesce(p.proacl,acldefault('f',p.proowner)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
) SELECT o.kind,o.name,pg_get_userbyid(o.owner) AS owner,
  CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
  pg_get_userbyid(a.grantor) AS grantor,a.privilege_type,a.is_grantable
FROM objects o LEFT JOIN LATERAL aclexplode(o.acl) a ON true ORDER BY 1,2,4,5,6,7`;
export const structureSql = `SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,
  pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  AND c.relkind IN ('r','p','f','v','m','S') ORDER BY 1,2`;
export const safetySql = `SELECT
  (SELECT count(*)::text FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema','public','neon_auth')) AS unknown_schemas,
  (SELECT count(*)::text FROM pg_largeobject_metadata) AS large_objects,
  (SELECT count(*)::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attacl IS NOT NULL) AS column_acls,
  (SELECT count(*)::text FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') AS policies,
  (SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (c.relrowsecurity OR c.relforcerowsecurity)) AS rls_tables,
  (SELECT count(*)::text FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive)) AS invalid_indexes,
  (SELECT count(*)::text FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT k.convalidated) AS unvalidated_constraints,
  (SELECT count(*)::text FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('d','e','r','m')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')) AS unsupported_types,
  (SELECT count(*)::text FROM pg_depend d CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) a
    CROSS JOIN LATERAL pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid) b WHERE a.schema='public' AND b.schema='neon_auth') AS auth_dependencies,
  (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND
    (p.prosecdef OR p.prosrc ~* 'neon_auth' OR p.prokind NOT IN ('f','p')) AND NOT EXISTS
    (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')) AS unsafe_functions,
  (SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT EXISTS
    (SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p')) AS tables_without_pk`;

export type Inventory = {
  counts: number[]; dataHash: string; schemaHash: string; aclHash: string; ledgerHash: string;
  authSchemaHash: string; authRows: number; publicTables: number; version: number; bytes: number;
  localeHash: string; roleHash: string; extensionsHash: string; defaultAclHash: string; extensionAclHash: string;
};
export type Snapshot = { summary: Inventory; tables: string[]; tableHashes: string[]; ledger: string[]; extensions: string[]; empty: boolean; schemaOwner: string };
function integer(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string' || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) return fail('INVALID_INVENTORY');
  return Number(value);
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail('INVALID_INVENTORY');
  return value;
}
const sameList = (actual: string[], expected: readonly string[]) => JSON.stringify(actual) === JSON.stringify(expected);
export function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) return fail('INVALID_IDENTIFIER');
  return `"${value}"`;
}
export async function startSnapshot(sql: Sql, expected: Binding): Promise<string> {
  await sql.query(beginReadOnly);
  await sql.query("SET LOCAL statement_timeout='60s'");
  await sql.query("SET LOCAL lock_timeout='5s'");
  await sql.query("SET LOCAL search_path=pg_catalog,public");
  await sql.query("SET LOCAL TIME ZONE 'UTC'");
  await sql.query("SET LOCAL DateStyle='ISO, YMD'");
  await sql.query('SET LOCAL extra_float_digits=3');
  const row = record((await sql.query(`SELECT current_database() AS database,current_user AS role,
    current_setting('server_version_num')::integer AS version,current_setting('server_encoding') AS encoding,
    current_setting('transaction_read_only') AS read_only,pg_export_snapshot() AS snapshot`)).rows[0]);
  if (row.database !== expected.database || row.role !== expected.role || Math.floor(integer(row.version)/10000) !== expected.majorVersion
    || row.encoding !== 'UTF8' || row.read_only !== 'on' || typeof row.snapshot !== 'string' || !/^[0-9A-Fa-f-]{1,128}$/.test(row.snapshot)) return fail('DATABASE_BINDING');
  return row.snapshot;
}
/** Only hashes/counts leave the database. Auth keys/configuration are never SELECTed. */
export async function inventory(sql: Sql, expected: Binding): Promise<Snapshot> {
  const structure = (await sql.query(structureSql)).rows;
  const tables = structure.filter(row => row.schema === 'public').map(row => String(row.name));
  if (structure.some(row => !['public','neon_auth'].includes(String(row.schema)) || row.kind !== 'r')
    || tables.length && !sameList(tables, appTables)) return fail('UNKNOWN_STRUCTURE');
  const managed = structure.filter(row => row.schema === 'neon_auth');
  if (!sameList(managed.map(row => String(row.name)), authTables) || managed.some(row => row.owner !== 'neon_auth')) return fail('AUTH_STRUCTURE');
  let authRows = 0;
  for (const name of authIdentityTables) {
    authRows += integer((await sql.query(`SELECT count(*)::text AS rows FROM neon_auth.${quotedIdentifier(name)}`)).rows[0]?.rows);
  }
  if (authRows !== 0) return fail('AUTH_DATA_PRESENT');
  const safety = record((await sql.query(safetySql)).rows[0]);
  if (Object.keys(safety).length !== 11 || Object.values(safety).some(value => integer(value) !== 0)) return fail('UNSUPPORTED_SCHEMA');
  const acl = (await sql.query(aclSql)).rows;
  if (acl.some(row => !(row.kind === 'schema' ? [expected.role,'pg_database_owner'] : [expected.role]).includes(String(row.owner))
    || row.grantee != null && !['PUBLIC',expected.role,'pg_database_owner'].includes(String(row.grantee))
    || row.grantor != null && ![expected.role,'pg_database_owner'].includes(String(row.grantor)))) return fail('UNSUPPORTED_PRIVILEGES');
  const extensions = (await sql.query(`SELECT e.extname,e.extversion,n.nspname AS schema,e.extrelocatable,e.extconfig
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname`)).rows;
  if (extensions.some(row => !['plpgsql','pgcrypto'].includes(String(row.extname)) || row.extconfig != null
    || row.extname === 'pgcrypto' && (row.schema !== 'public' || row.extversion !== '1.3')
    || row.extname === 'plpgsql' && (row.schema !== 'pg_catalog' || row.extversion !== '1.0'))) return fail('UNSUPPORTED_EXTENSION');
  const defaults = (await sql.query(`SELECT pg_get_userbyid(d.defaclrole) AS owner,n.nspname AS schema,d.defaclobjtype AS kind,
    jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable)
      ORDER BY a.privilege_type COLLATE "C") AS privileges
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a GROUP BY d.oid,n.nspname ORDER BY d.defaclobjtype`)).rows;
  if (defaults.length !== 2 || defaults.some(row => row.owner !== 'cloud_admin' || row.schema !== 'public'
    || !['S','r'].includes(String(row.kind)))) return fail('MANAGED_DEFAULT_ACL');
  for (const row of defaults) {
    const privileges = row.kind === 'S' ? ['SELECT','UPDATE','USAGE'] :
      (expected.majorVersion === 17 ? ['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'] : ['DELETE','INSERT','MAINTAIN','SELECT','TRUNCATE','UPDATE']);
    const approved = privileges.map(privilege => ['cloud_admin','neon_superuser',privilege,true]);
    if (JSON.stringify(row.privileges) !== JSON.stringify(approved)) return fail('MANAGED_DEFAULT_ACL');
  }
  const extensionAcl = (await sql.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_userbyid(p.proowner) AS owner,coalesce(p.proacl,acldefault('f',p.proowner))::text AS acl
    FROM pg_proc p JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
    JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='pgcrypto' ORDER BY p.proname,arguments`)).rows;
  const metadata = record((await sql.query(`SELECT current_setting('server_version_num')::integer AS version,
    pg_database_size(current_database())::text AS bytes,
    jsonb_build_array(d.datcollate,d.datctype,to_jsonb(d)->>'datlocprovider',to_jsonb(d)->>'datlocale') AS locale
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0]);
  if (integer(metadata.bytes) > config.maxDatabaseBytes || Math.floor(integer(metadata.version)/10000) !== expected.majorVersion) return fail('DATABASE_LIMIT');
  const role = (await sql.query(`SELECT r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,
    (SELECT jsonb_agg(parent.rolname ORDER BY parent.rolname) FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid WHERE m.member=r.oid) AS memberships
    FROM pg_roles r WHERE r.rolname=current_user`)).rows;
  if (role.length !== 1) return fail('UNSUPPORTED_PRIVILEGES');
  const tableHashes: string[] = [], counts: number[] = [];
  for (const name of tables) {
    const value = record((await sql.query(`SELECT count(*)::text AS rows,encode(sha256(convert_to(coalesce(
      string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text COLLATE "C"),''),'UTF8')),'hex') AS hash FROM public.${quotedIdentifier(name)} t`)).rows[0]);
    counts.push(integer(value.rows)); tableHashes.push(digest(value.hash));
  }
  const ledgerRows = tables.length ? (await sql.query('SELECT name,applied_at::text AS applied_at FROM public.schema_migrations ORDER BY name')).rows : [];
  if (ledgerRows.some(row => typeof row.name !== 'string' || typeof row.applied_at !== 'string')) return fail('INVALID_INVENTORY');
  const catalog = (await sql.query(catalogSql)).rows;
  const authSchema = (await sql.query(`SELECT c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='neon_auth' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2`)).rows;
  const schemaOwner = acl.find(row => row.kind === 'schema')?.owner;
  if (typeof schemaOwner !== 'string') return fail('UNSUPPORTED_PRIVILEGES');
  return { tables, tableHashes, ledger: ledgerRows.map(row => String(row.name)), extensions: extensions.map(row => String(row.extname)), schemaOwner,
    empty: tables.length === 0 && catalog.length === 1 && Object.values(catalog[0]).every(value => value === null), summary: {
    counts, dataHash: hash(JSON.stringify(tableHashes)), schemaHash: hash(JSON.stringify(catalog)), aclHash: hash(JSON.stringify(acl)),
    ledgerHash: hash(JSON.stringify(ledgerRows)), authSchemaHash: hash(JSON.stringify(authSchema)), authRows,
    publicTables: tables.length, version: integer(metadata.version), bytes: integer(metadata.bytes), localeHash: hash(JSON.stringify(metadata.locale)),
    roleHash: hash(JSON.stringify(role)), extensionsHash: hash(JSON.stringify(extensions)),
    defaultAclHash: hash(JSON.stringify(defaults)), extensionAclHash: hash(JSON.stringify(extensionAcl)),
  } };
}

export function assertCopy(source: Snapshot, target: Snapshot): void {
  for (const key of ['dataHash','schemaHash','aclHash','ledgerHash','localeHash','roleHash','extensionsHash','extensionAclHash'] as const) {
    if (source.summary[key] !== target.summary[key]) return fail('COPY_MISMATCH');
  }
  if (!sameList(target.tables, source.tables) || !sameList(target.tableHashes, source.tableHashes)
    || JSON.stringify(source.summary.counts) !== JSON.stringify(target.summary.counts)) return fail('COPY_MISMATCH');
}

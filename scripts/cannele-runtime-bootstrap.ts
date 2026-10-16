import { createHash, hkdfSync } from "node:crypto";

type Object_ = Record<string, unknown>;
export interface BootstrapConnection { host: string; port: number; database: string; user: string; password?: string }
interface Client { query(sql: string, values?: unknown[]): Promise<{ rows: Object_[] }> }
type ErrorCode = "RUNTIME_BOOTSTRAP_INPUT_INVALID" | "RUNTIME_BOOTSTRAP_CONTEXT_MISMATCH" | "RUNTIME_BOOTSTRAP_DATABASE_UNSAFE"
  | "RUNTIME_BOOTSTRAP_ROLE_CONFLICT" | "RUNTIME_BOOTSTRAP_ROLE_UNSAFE" | "RUNTIME_BOOTSTRAP_DATABASE_ERROR"
  | "RUNTIME_BOOTSTRAP_COMMIT_UNKNOWN" | "RUNTIME_BOOTSTRAP_UNLOCK_FAILED";
export class RuntimeBootstrapError extends Error {
  constructor(readonly code: ErrorCode) {
    super("Runtime bootstrap could not be verified; private details suppressed.");
    this.name = "RuntimeBootstrapError";
  }
}
const fail = (code: ErrorCode): never => { throw new RuntimeBootstrapError(code); };
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CONTEXT_KEYS = ["instanceId", "repositoryId", "bindingDigest", "writerEpoch", "schemaVersion", "schemaChecksum"] as const;
const FILES = ["001_registry.sql", "002_authentication.sql", "003_runtime_guard.sql", "004_provider_lifecycle.sql"];
const CONTROL_LOCK = "pg_catalog.hashtextextended('cannele_registry:control',0)";

function object(value: unknown): Object_ {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("RUNTIME_BOOTSTRAP_CONTEXT_MISMATCH");
  return value as Object_;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function validate(input: { connection: BootstrapConnection; context: Object_; roleName: string; migrations: unknown[] }) {
  const { connection: c, context, roleName } = input;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(roleName) || roleName.startsWith("pg_") || roleName === c.user
    || typeof c.host !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(c.host) || c.host.includes("-pooler.")
    || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535
    || typeof c.database !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(c.database)
    || ["postgres", "template0", "template1"].includes(c.database)
    || typeof c.user !== "string" || !c.user || typeof c.password !== "string" || c.password.length < 16 || c.password.length > 4096) return fail("RUNTIME_BOOTSTRAP_INPUT_INVALID");
  if (Object.keys(context).length !== CONTEXT_KEYS.length || CONTEXT_KEYS.some(key => !Object.hasOwn(context, key))
    || typeof context.instanceId !== "string" || !UUID.test(context.instanceId)
    || context.repositoryId !== 1318171856 || context.writerEpoch !== 1 || context.schemaVersion !== 4
    || typeof context.bindingDigest !== "string" || !DIGEST.test(context.bindingDigest)
    || typeof context.schemaChecksum !== "string" || !DIGEST.test(context.schemaChecksum)) return fail("RUNTIME_BOOTSTRAP_INPUT_INVALID");
  if (!Array.isArray(input.migrations) || input.migrations.length !== 4) return fail("RUNTIME_BOOTSTRAP_INPUT_INVALID");
  const migrations = input.migrations.map((value, index) => {
    const m = object(value);
    if (m.version !== index + 1 || m.filename !== FILES[index] || typeof m.sql !== "string" || !m.sql.trim()
      || typeof m.checksum !== "string" || !DIGEST.test(m.checksum) || hash(m.sql) !== m.checksum) return fail("RUNTIME_BOOTSTRAP_INPUT_INVALID");
    return { version: m.version, checksum: m.checksum };
  });
  if (migrations[3].checksum !== context.schemaChecksum) return fail("RUNTIME_BOOTSTRAP_INPUT_INVALID");
  return migrations;
}

// Same dedicated-database boundary as the initializer: extension objects may
// exist, but application objects and legacy schemas may not coexist with Cannele.
const INVENTORY = `WITH user_schemas AS (
  SELECT oid,nspname FROM pg_catalog.pg_namespace WHERE NOT starts_with(nspname,'pg_') AND nspname<>'information_schema'
), allowed_schemas AS (
  SELECT 'public'::text AS name UNION SELECT 'cannele_registry'
  UNION SELECT n.nspname FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
), objects AS (
  SELECT 'pg_catalog.pg_class'::regclass::oid AS class_id,c.oid,c.relnamespace AS namespace_id
    FROM pg_catalog.pg_class c JOIN user_schemas n ON n.oid=c.relnamespace WHERE c.relkind NOT IN ('i','I')
  UNION ALL SELECT 'pg_catalog.pg_proc'::regclass::oid,p.oid,p.pronamespace FROM pg_catalog.pg_proc p JOIN user_schemas n ON n.oid=p.pronamespace
  UNION ALL SELECT 'pg_catalog.pg_type'::regclass::oid,t.oid,t.typnamespace FROM pg_catalog.pg_type t JOIN user_schemas n ON n.oid=t.typnamespace
    WHERE t.typtype<>'c' AND NOT(t.typelem<>0 AND t.typcategory='A')
  UNION ALL SELECT 'pg_catalog.pg_operator'::regclass::oid,o.oid,o.oprnamespace FROM pg_catalog.pg_operator o JOIN user_schemas n ON n.oid=o.oprnamespace
  UNION ALL SELECT 'pg_catalog.pg_collation'::regclass::oid,c.oid,c.collnamespace FROM pg_catalog.pg_collation c JOIN user_schemas n ON n.oid=c.collnamespace
  UNION ALL SELECT 'pg_catalog.pg_opclass'::regclass::oid,c.oid,c.opcnamespace FROM pg_catalog.pg_opclass c JOIN user_schemas n ON n.oid=c.opcnamespace
  UNION ALL SELECT 'pg_catalog.pg_opfamily'::regclass::oid,f.oid,f.opfnamespace FROM pg_catalog.pg_opfamily f JOIN user_schemas n ON n.oid=f.opfnamespace
  UNION ALL SELECT 'pg_catalog.pg_ts_config'::regclass::oid,c.oid,c.cfgnamespace FROM pg_catalog.pg_ts_config c JOIN user_schemas n ON n.oid=c.cfgnamespace
  UNION ALL SELECT 'pg_catalog.pg_ts_dict'::regclass::oid,d.oid,d.dictnamespace FROM pg_catalog.pg_ts_dict d JOIN user_schemas n ON n.oid=d.dictnamespace
  UNION ALL SELECT 'pg_catalog.pg_ts_parser'::regclass::oid,p.oid,p.prsnamespace FROM pg_catalog.pg_ts_parser p JOIN user_schemas n ON n.oid=p.prsnamespace
  UNION ALL SELECT 'pg_catalog.pg_ts_template'::regclass::oid,t.oid,t.tmplnamespace FROM pg_catalog.pg_ts_template t JOIN user_schemas n ON n.oid=t.tmplnamespace
) SELECT NOT EXISTS(SELECT 1 FROM user_schemas WHERE nspname NOT IN (SELECT name FROM allowed_schemas))
 AND NOT EXISTS(SELECT 1 FROM user_schemas WHERE nspname='cake_qa_registry')
 AND NOT EXISTS(SELECT 1 FROM objects o JOIN user_schemas n ON n.oid=o.namespace_id WHERE n.nspname<>'cannele_registry'
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid=o.class_id AND d.objid=o.oid
     AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e')) AS safe`;

const ROLE_PROOF = `SELECT r.rolcanlogin AS login,r.rolsuper AS superuser,r.rolcreaterole AS create_role,
 r.rolcreatedb AS create_database,r.rolreplication AS replication,r.rolbypassrls AS bypass_rls,r.rolinherit AS inherit,
 r.rolconfig IS NULL AS no_config,r.rolvaliduntil IS NULL AS no_expiry,
 pg_catalog.shobj_description(r.oid,'pg_authid') AS marker,
 EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS memberships,
 EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid) AS owns_schema,
 EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba=r.oid) AS owns_database,
 (EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid)) AS owns_objects,
 EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) AS schema_create,
 pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE') AS database_create,
 pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CONNECT') AS connect
 FROM pg_catalog.pg_roles r WHERE r.rolname=$1`;

function safeRole(role: Object_, marker: string): void {
  if (role.marker !== marker) return fail("RUNTIME_BOOTSTRAP_ROLE_CONFLICT");
  if (role.login !== true || role.no_config !== true || role.no_expiry !== true
    || ["superuser", "create_role", "create_database", "replication", "bypass_rls", "inherit", "memberships", "owns_schema", "owns_database", "owns_objects", "schema_create", "database_create"].some(key => role[key] !== false)) return fail("RUNTIME_BOOTSTRAP_ROLE_UNSAFE");
}
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Private in-process result: never serialize the connection, URL or password.
 * The caller must prove the candidate's fresh LOGIN before granting privileges.
 * Keep the same admin client checked out until releaseControl() completes. */
export async function prepareRuntimeBootstrap<C extends BootstrapConnection>(client: Client,
  input: { connection: C; context: Object_; roleName: string; migrations: unknown[] }): Promise<{
    connection: C & { user: string; password: string }; databaseUrl: string; marker: string; roleCreated: boolean;
    transitionId: string; releaseControl(): Promise<void>;
  }> {
  const migrations = validate(input), { connection, context, roleName } = input;
  let begun = false, committing = false, lockAttempted = false;
  let releasePromise: Promise<void> | undefined;
  const releaseControl = (): Promise<void> => releasePromise ??= (async () => {
    try {
      const result = await client.query(`SELECT pg_catalog.pg_advisory_unlock(${CONTROL_LOCK}) AS unlocked`);
      if (result.rows.length !== 1 || result.rows[0]?.unlocked !== true) return fail("RUNTIME_BOOTSTRAP_UNLOCK_FAILED");
    } catch { throw new RuntimeBootstrapError("RUNTIME_BOOTSTRAP_UNLOCK_FAILED"); }
  })();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED"); begun = true;
    await client.query("SET LOCAL search_path=pg_catalog");
    await client.query("SET LOCAL standard_conforming_strings=on");
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
    lockAttempted = true;
    // A session lock spans create, fresh LOGIN and the core provisioner's own TX.
    await client.query(`SELECT pg_catalog.pg_advisory_lock(${CONTROL_LOCK})`);
    const owner = await client.query(`SELECT current_database() AS database_name,current_user AS role_name,session_user AS session_role,
      d.datdba=r.oid AS owns_database,n.nspowner=r.oid AS owns_schema,r.rolcanlogin AS login,r.rolcreaterole AS create_role
      FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_namespace n
      WHERE r.rolname=current_user AND d.datname=current_database() AND n.nspname='cannele_registry'`);
    const admin = owner.rows[0];
    if (owner.rows.length !== 1 || !admin || admin.database_name !== connection.database || admin.role_name !== connection.user
      || admin.session_role !== connection.user || admin.owns_database !== true || admin.owns_schema !== true
      || admin.login !== true || admin.create_role !== true) return fail("RUNTIME_BOOTSTRAP_DATABASE_UNSAFE");
    if ((await client.query(INVENTORY)).rows[0]?.safe !== true) return fail("RUNTIME_BOOTSTRAP_DATABASE_UNSAFE");
    const controls = await client.query("SELECT to_jsonb(c) AS identity FROM cannele_registry.instance_control c FOR UPDATE");
    if (controls.rows.length !== 1) return fail("RUNTIME_BOOTSTRAP_CONTEXT_MISMATCH");
    const identity = object(controls.rows[0].identity), receipt = object(identity.initialization_receipt), transition = object(receipt.legacyTransition);
    if (identity.singleton !== true || identity.instance_id !== context.instanceId || identity.repository_id !== context.repositoryId
      || identity.binding_digest !== context.bindingDigest || identity.writer_mode !== "disabled" || identity.writer_epoch !== 1
      || identity.schema_version !== 4 || identity.schema_checksum !== context.schemaChecksum
      || receipt.instanceId !== context.instanceId || receipt.repositoryId !== String(context.repositoryId)
      || receipt.bindingDigest !== context.bindingDigest || receipt.writerEpoch !== 1 || receipt.schemaVersion !== 4
      || receipt.schemaChecksum !== context.schemaChecksum || transition.protocol !== "cannele-legacy-transition/v1"
      || typeof transition.transitionId !== "string" || !UUID.test(transition.transitionId)
      || transition.databaseHostDigest !== hash(connection.host) || transition.databaseName !== connection.database
      || transition.legacyWriterEpoch !== 2) return fail("RUNTIME_BOOTSTRAP_CONTEXT_MISMATCH");
    const applied = object(transition.result);
    if (applied.schemaVersion !== 4 || applied.schemaChecksum !== context.schemaChecksum
      || canonical(applied.appliedVersions) !== "[1,2,3,4]") return fail("RUNTIME_BOOTSTRAP_CONTEXT_MISMATCH");
    const installed = await client.query("SELECT version,checksum FROM cannele_registry.schema_migrations ORDER BY version");
    if (canonical(installed.rows) !== canonical(migrations)) return fail("RUNTIME_BOOTSTRAP_CONTEXT_MISMATCH");
    const transitionId = transition.transitionId;
    const marker = canonical({ protocol: "cake-cannele-runtime-bootstrap/v1", bootstrapId: transitionId, transitionId, context,
      roleName, database: { name: connection.database, hostDigest: hash(connection.host), port: connection.port } });
    const password = Buffer.from(hkdfSync("sha256", Buffer.from(connection.password!, "utf8"),
      Buffer.from(hash("cake-cannele/bootstrap-runtime/password/v1"), "hex"), Buffer.from(marker, "utf8"), 32)).toString("base64url");
    const existing = await client.query(ROLE_PROOF, [roleName]);
    if (existing.rows.length > 1) return fail("RUNTIME_BOOTSTRAP_ROLE_CONFLICT");
    const roleCreated = existing.rows.length === 0;
    if (roleCreated) {
      // https://neon.com/docs/manage/roles#manage-roles-with-sql
      // Neon requires a plain PASSWORD value. Bind it into transaction-local
      // state so caller SQL text never contains it; PostgreSQL encrypts storage.
      // Provider-side statement/parameter auditing remains the provider's domain.
      await client.query("SET LOCAL password_encryption='scram-sha-256'");
      await client.query("SELECT pg_catalog.set_config('cannele.bootstrap_password',$1,true) IS NOT NULL AS configured", [password]);
      await client.query(`DO $cannele_runtime_bootstrap$ BEGIN
        IF pg_catalog.current_setting('cannele.bootstrap_password') !~ '^[A-Za-z0-9_-]{43}$' THEN
          RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='RUNTIME_BOOTSTRAP_INPUT_INVALID';
        END IF;
        EXECUTE pg_catalog.format('CREATE ROLE "${roleName}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
          pg_catalog.current_setting('cannele.bootstrap_password'));
      END $cannele_runtime_bootstrap$`);
      await client.query("SELECT pg_catalog.set_config('cannele.bootstrap_password','',true)='' AS cleared");
      await client.query(`COMMENT ON ROLE "${roleName}" IS ${literal(marker)}`);
    } else safeRole(existing.rows[0], marker);
    const proof = await client.query(ROLE_PROOF, [roleName]);
    if (proof.rows.length !== 1) return fail("RUNTIME_BOOTSTRAP_ROLE_UNSAFE");
    safeRole(proof.rows[0], marker);
    if (proof.rows[0].connect !== true) {
      if (!roleCreated) return fail("RUNTIME_BOOTSTRAP_ROLE_UNSAFE");
      await client.query(`GRANT CONNECT ON DATABASE "${connection.database.replaceAll('"', '""')}" TO "${roleName}"`);
    }
    committing = true; await client.query("COMMIT"); begun = false;
    const runtime = { ...connection, user: roleName, password };
    const url = new URL(`postgresql://${connection.host}:${connection.port}/${encodeURIComponent(connection.database)}?sslmode=verify-full`);
    url.username = roleName; url.password = password;
    return { connection: runtime, databaseUrl: url.href, marker, roleCreated, transitionId, releaseControl };
  } catch (error) {
    if (begun) { try { await client.query("ROLLBACK"); } catch { /* Preserve the first sanitized failure. */ } }
    if (lockAttempted) { try { await releaseControl(); } catch { /* The caller closes this failed admin connection. */ } }
    if (error instanceof RuntimeBootstrapError) throw error;
    throw new RuntimeBootstrapError(committing ? "RUNTIME_BOOTSTRAP_COMMIT_UNKNOWN" : "RUNTIME_BOOTSTRAP_DATABASE_ERROR");
  }
}

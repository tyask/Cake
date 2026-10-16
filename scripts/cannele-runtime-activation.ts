import { createHash } from "node:crypto";
import manifest from "../docs/cannele/resource-manifest.json";
import { splitSqlStatements } from "./qa-registry-ddl";
import { runtimeManagementInventorySql, type BootstrapConnection } from "./cannele-runtime-bootstrap";

type Object_ = Record<string, unknown>;
interface Client { query(sql: string, values?: unknown[]): Promise<{ rows: Object_[] }> }
type Code = "RUNTIME_ACTIVATION_INPUT_INVALID" | "RUNTIME_ACTIVATION_DATABASE_UNSAFE" | "RUNTIME_ACTIVATION_CONTEXT_MISMATCH"
  | "RUNTIME_ACTIVATION_SCHEMA_MISMATCH" | "RUNTIME_ACTIVATION_LEDGER_USED" | "RUNTIME_ACTIVATION_DATABASE_ERROR" | "RUNTIME_ACTIVATION_COMMIT_UNKNOWN";
export class RuntimeActivationError extends Error {
  constructor(readonly code: Code) {
    super("Runtime activation could not be verified; private details suppressed.");
    this.name = "RuntimeActivationError";
  }
}
const fail = (code: Code): never => { throw new RuntimeActivationError(code); };
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const TRANSITION_ID = "86ee46a3-eb41-414e-85aa-d21e053d152d";
export const runtimeActivationContext = Object.freeze({ instanceId: "34122771-e322-4478-bc7b-96ed363c6c41", repositoryId: 1318171856,
  bindingDigest: "fb847b478ed9e0c5b0eeb972657da0ec8b6205e71c095bfc742633bc2cc5685e", writerEpoch: 1, schemaVersion: 4,
  schemaChecksum: "69d6b54f6ebc4e623876734bd5e0163050450d8136e29d898c2423ecf579fba8" });
const MIGRATIONS = [
  ["001_registry.sql", "bad84bbbcbf28cb4bfffe4f49e669401d7073502a0274e3e6fae178845fec0b2"],
  ["002_authentication.sql", "f293415033fe61060f21bb99d6913b3cedc72fe9038ec7f7e18666f8672d403a"],
  ["003_runtime_guard.sql", "35db3b0b624243888577dbdd72a643dbb49ad96faf63610b916ee7603567c9ee"],
  ["004_provider_lifecycle.sql", runtimeActivationContext.schemaChecksum],
] as const;
function object(value: unknown): Object_ {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("RUNTIME_ACTIVATION_CONTEXT_MISMATCH");
  return value as Object_;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Validate before loading credentials; this one-time Cake entrance cannot target another instance. */
export function validateRuntimeActivationContext(value: Object_): void {
  if (canonical(value) !== canonical(runtimeActivationContext)) fail("RUNTIME_ACTIVATION_INPUT_INVALID");
}
type Migration = { version: number; filename: string; checksum: string; sql: string };
function migrations(input: unknown[]): Migration[] {
  if (!Array.isArray(input) || input.length !== 4) return fail("RUNTIME_ACTIVATION_INPUT_INVALID");
  return input.map((item, index) => {
    const m = object(item);
    if (m.version !== index + 1 || m.filename !== MIGRATIONS[index][0] || m.checksum !== MIGRATIONS[index][1]
      || typeof m.sql !== "string" || hash(m.sql) !== m.checksum) return fail("RUNTIME_ACTIVATION_INPUT_INVALID");
    return { version: index + 1, filename: m.filename as string, checksum: m.checksum as string, sql: m.sql };
  });
}
const normalizeType = (value: string): string => value.trim().replace(/\s+/g, " ").replace(/\btimestamptz\b/g, "timestamp with time zone");
/** Parse only the four checksum-pinned files, never arbitrary SQL. Replacements
 * supersede earlier function bodies just as the immutable migrations do. */
function expectedSchema(source: Migration[]) {
  const functions = new Map<string, Object_>(), tables: string[] = [];
  for (const migration of source) for (const raw of splitSqlStatements(migration.sql)) {
    const sql = raw.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
    const table = /^CREATE TABLE cannele_registry\.([a-z_]+)\s*\(/.exec(sql);
    if (table) tables.push(table[1]);
    if (!/^CREATE (?:OR REPLACE )?FUNCTION\b/.test(sql)) continue;
    const f = /^CREATE (?:OR REPLACE )?FUNCTION cannele_registry\.([a-z_]+)\(([\s\S]*?)\)\s+RETURNS ([\s\S]*?) LANGUAGE (plpgsql|sql)([\s\S]*?) AS (\$\w*\$)([\s\S]*)\6;$/.exec(sql);
    if (!f) return fail("RUNTIME_ACTIVATION_SCHEMA_MISMATCH");
    const args = f[2].split(",").filter(arg => arg.trim()).map(arg => normalizeType(arg.replace(/ DEFAULT [\s\S]*$/, ""))).join(", ");
    const definer = /\bSECURITY DEFINER\b/.test(f[5]);
    functions.set(f[1], { name: f[1], args, result: normalizeType(f[3]), language: f[4], body: f[7],
      definer, config: definer ? ["search_path=pg_catalog, cannele_registry"] : null, volatile: "v", owned: true });
  }
  if (tables.length !== 25 || functions.size !== 55) return fail("RUNTIME_ACTIVATION_SCHEMA_MISMATCH");
  return { tables: tables.sort(), functions: [...functions.values()].sort((a, b) => String(a.name) < String(b.name) ? -1 : 1) };
}

const FUNCTIONS_SQL = `SELECT p.proname AS name,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
 pg_catalog.pg_get_function_result(p.oid) AS result,l.lanname AS language,p.prosrc AS body,p.prosecdef AS definer,
 p.proconfig AS config,p.provolatile AS volatile,p.proowner=n.nspowner AS owned
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 WHERE n.nspname='cannele_registry' ORDER BY p.proname COLLATE "C"`;
const RELATIONS_SQL = `SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,c.relrowsecurity AS rls,
 c.relforcerowsecurity AS force_rls,c.relowner=n.nspowner AS owned
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='cannele_registry' AND c.relkind NOT IN ('i','I') ORDER BY c.relname COLLATE "C"`;

export type RuntimeActivationResult = { writerMode: "api"; writerEpoch: 1; alreadyEnabled: boolean; transitionId: string;
  instanceId: string; bindingDigest: string; schemaVersion: 4; schemaChecksum: string };

/** Current-state idempotence only: no UUID request receipt is inserted. This
 * transaction changes only writer_mode; auth state and all QA rows are retained. */
export async function activateRuntimeWriter(client: Client,
  input: { connection: BootstrapConnection; context: Object_; migrations: unknown[] }): Promise<RuntimeActivationResult> {
  validateRuntimeActivationContext(input.context);
  const source = migrations(input.migrations), schema = expectedSchema(source), { connection, context } = input;
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(connection.host) || connection.host.includes("-pooler.")
    || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535
    || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(connection.database) || ["postgres", "template0", "template1"].includes(connection.database)
    || !connection.user) return fail("RUNTIME_ACTIVATION_INPUT_INVALID");
  let begun = false, committing = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED"); begun = true;
    await client.query("SET LOCAL search_path=pg_catalog");
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cannele_registry:control',0))");
    const owner = await client.query(`SELECT current_database() AS database_name,current_user AS role_name,session_user AS session_role,
      d.datdba=r.oid AS owns_database,n.nspowner=r.oid AS owns_schema,r.rolcanlogin AS login
      FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_namespace n
      WHERE r.rolname=current_user AND d.datname=current_database() AND n.nspname='cannele_registry'`);
    const admin = owner.rows[0];
    if (owner.rows.length !== 1 || !admin || admin.database_name !== connection.database || admin.role_name !== connection.user
      || admin.session_role !== connection.user || admin.owns_database !== true || admin.owns_schema !== true || admin.login !== true
      || (await client.query(runtimeManagementInventorySql)).rows[0]?.safe !== true) return fail("RUNTIME_ACTIVATION_DATABASE_UNSAFE");
    const rows = await client.query("SELECT to_jsonb(c) AS identity FROM cannele_registry.instance_control c FOR UPDATE");
    if (rows.rows.length !== 1) return fail("RUNTIME_ACTIVATION_CONTEXT_MISMATCH");
    const c = object(rows.rows[0].identity), receipt = object(c.initialization_receipt), transition = object(receipt.legacyTransition);
    const slots = manifest.slots;
    if (c.singleton !== true || c.instance_id !== context.instanceId || c.repository_id !== context.repositoryId || c.binding_digest !== context.bindingDigest
      || c.writer_epoch !== 1 || (c.writer_mode !== "disabled" && c.writer_mode !== "api") || c.schema_version !== 4 || c.schema_checksum !== context.schemaChecksum
      || c.feature_branch_prefix !== manifest.repository.featureBranchPrefix || Date.parse(String(c.accepted_pr_created_after)) !== Date.parse(manifest.repository.acceptedPrCreatedAfter)
      || receipt.instanceId !== context.instanceId || receipt.repositoryId !== String(context.repositoryId) || receipt.bindingDigest !== context.bindingDigest
      || receipt.writerEpoch !== 1 || receipt.schemaVersion !== 4 || receipt.schemaChecksum !== context.schemaChecksum
      || receipt.featureBranchPrefix !== manifest.repository.featureBranchPrefix || receipt.acceptedPrCreatedAfter !== manifest.repository.acceptedPrCreatedAfter
      || canonical(receipt.slots) !== canonical(slots) || transition.protocol !== "cannele-legacy-transition/v1" || transition.transitionId !== TRANSITION_ID
      || transition.databaseHostDigest !== hash(connection.host) || transition.databaseName !== connection.database || transition.legacyWriterEpoch !== 2
      || canonical(transition.result) !== canonical({ schemaVersion: 4, schemaChecksum: context.schemaChecksum, appliedVersions: [1, 2, 3, 4] })) return fail("RUNTIME_ACTIVATION_CONTEXT_MISMATCH");
    const installed = await client.query("SELECT version,checksum FROM cannele_registry.schema_migrations ORDER BY version");
    if (canonical(installed.rows) !== canonical(source.map(({ version, checksum }) => ({ version, checksum })))) return fail("RUNTIME_ACTIVATION_SCHEMA_MISMATCH");
    const expectedRelations = [...schema.tables.map(name => ({ name, kind: "r", persistence: "p", rls: false, force_rls: false, owned: true })),
      { name: "lease_history_sequence_seq", kind: "S", persistence: "p", rls: false, force_rls: false, owned: true }].sort((a, b) => a.name < b.name ? -1 : 1);
    if (canonical((await client.query(FUNCTIONS_SQL)).rows) !== canonical(schema.functions)
      || canonical((await client.query(RELATIONS_SQL)).rows) !== canonical(expectedRelations)) return fail("RUNTIME_ACTIVATION_SCHEMA_MISMATCH");
    await client.query("SELECT cannele_registry.assert_context($1::jsonb,false)", [JSON.stringify(context)]);
    const actualSlots = await client.query("SELECT key,position,alias,state,lease_id,to_jsonb(version) AS version,owner_operation_id FROM cannele_registry.slots ORDER BY position");
    if (canonical(actualSlots.rows.map(({ key, position, alias }) => ({ key, position, alias }))) !== canonical(slots)) return fail("RUNTIME_ACTIVATION_CONTEXT_MISMATCH");
    const alreadyEnabled = c.writer_mode === "api";
    if (!alreadyEnabled) {
      if (actualSlots.rows.some(row => row.state !== "free" || row.version !== 0 || row.lease_id !== null || row.owner_operation_id !== null)) return fail("RUNTIME_ACTIVATION_LEDGER_USED");
      const ledger = schema.tables.filter(name => !name.startsWith("auth_") && !["instance_control", "schema_migrations", "slots"].includes(name));
      const unused = await client.query(`SELECT ${ledger.map(name => `NOT EXISTS(SELECT 1 FROM cannele_registry."${name}")`).join(" AND ")}
        AND (SELECT last_value=1 AND NOT is_called FROM cannele_registry.lease_history_sequence_seq) AS unused`);
      if (unused.rows.length !== 1 || unused.rows[0].unused !== true) return fail("RUNTIME_ACTIVATION_LEDGER_USED");
      const updated = await client.query("UPDATE cannele_registry.instance_control SET writer_mode='api' WHERE singleton AND writer_mode='disabled' AND writer_epoch=1 RETURNING writer_mode,writer_epoch::int");
      if (updated.rows.length !== 1 || updated.rows[0].writer_mode !== "api" || updated.rows[0].writer_epoch !== 1) return fail("RUNTIME_ACTIVATION_CONTEXT_MISMATCH");
    }
    await client.query("SELECT cannele_registry.assert_context($1::jsonb,true)", [JSON.stringify(context)]);
    committing = true; await client.query("COMMIT"); begun = false;
    return { writerMode: "api", writerEpoch: 1, alreadyEnabled, transitionId: TRANSITION_ID, instanceId: runtimeActivationContext.instanceId,
      bindingDigest: runtimeActivationContext.bindingDigest, schemaVersion: 4, schemaChecksum: runtimeActivationContext.schemaChecksum };
  } catch (error) {
    if (begun) { try { await client.query("ROLLBACK"); } catch { /* Preserve the sanitized primary failure. */ } }
    if (error instanceof RuntimeActivationError) throw error;
    throw new RuntimeActivationError(committing ? "RUNTIME_ACTIVATION_COMMIT_UNKNOWN" : "RUNTIME_ACTIVATION_DATABASE_ERROR");
  }
}

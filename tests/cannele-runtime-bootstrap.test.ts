import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { prepareRuntimeBootstrap, RuntimeBootstrapError } from "../scripts/cannele-runtime-bootstrap";

type Object_ = Record<string, unknown>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Metadata fixtures exercise the bootstrap's guards; the core provisioner owns
// the separate exact Cannele function/table/ACL verification.
const migrations = ["001_registry.sql", "002_authentication.sql", "003_runtime_guard.sql", "004_provider_lifecycle.sql"]
  .map((filename, index) => { const sql = `-- synthetic migration ${index + 1}\nSELECT ${index + 1};`;
    return { version: index + 1, filename, sql, checksum: hash(sql) }; });
const context = { instanceId: randomUUID(), repositoryId: 1318171856, bindingDigest: "a".repeat(64), writerEpoch: 1,
  schemaVersion: 4, schemaChecksum: migrations[3].checksum };
const transitionId = randomUUID();
const connection = { host: "ep-management.mock.aws.neon.tech", port: 5432, database: "neondb", user: "synthetic_owner",
  password: "synthetic-admin-password-only-for-tests", ssl: { rejectUnauthorized: true }, options: "-c search_path=pg_catalog,cannele_registry", statement_timeout: 30_000 };
const input = { connection, context, roleName: "cannele_runtime", migrations };
function identity(c = connection): Object_ {
  return { singleton: true, instance_id: context.instanceId, repository_id: context.repositoryId, binding_digest: context.bindingDigest,
    writer_mode: "disabled", writer_epoch: 1, schema_version: 4, schema_checksum: context.schemaChecksum,
    initialization_receipt: { ...context, repositoryId: String(context.repositoryId), legacyTransition: {
      protocol: "cannele-legacy-transition/v1", transitionId, legacyWriterEpoch: 2, databaseName: c.database, databaseHostDigest: hash(c.host),
      result: { schemaVersion: 4, schemaChecksum: context.schemaChecksum, appliedVersions: [1, 2, 3, 4] } } } };
}
function safeRole(marker: string): Object_ {
  return { marker, login: true, no_config: true, no_expiry: true, superuser: false, create_role: false, create_database: false,
    replication: false, bypass_rls: false, inherit: false, memberships: false, owns_schema: false, owns_database: false,
    owns_objects: false, schema_create: false, database_create: false, connect: true };
}
function fake(options: { identity?: Object_; role?: Object_; safe?: boolean; error?: (sql: string) => unknown } = {}) {
  const queries: { sql: string; values?: unknown[] }[] = [];
  let role = options.role, created = false;
  const client = { query: async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values }); const failure = options.error?.(sql); if (failure) throw failure;
    if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
    if (sql.includes("d.datdba=r.oid AS owns_database")) return { rows: [{ database_name: connection.database, role_name: connection.user,
      session_role: connection.user, owns_database: true, owns_schema: true, login: true, create_role: true }] };
    if (sql.startsWith("WITH user_schemas")) return { rows: [{ safe: options.safe ?? true }] };
    if (sql.startsWith("SELECT to_jsonb")) return { rows: [{ identity: options.identity ?? identity() }] };
    if (sql.startsWith("SELECT version,checksum")) return { rows: migrations.map(({ version, checksum }) => ({ version, checksum })) };
    if (sql.includes("r.rolcanlogin AS login")) return { rows: role ? [role] : [] };
    if (sql.startsWith("DO $cannele_runtime_bootstrap$")) created = true;
    if (sql.startsWith("COMMENT ON ROLE")) { assert.equal(created, true); role = safeRole(sql.slice(sql.indexOf(" IS '") + 5, -1).replaceAll("''", "'")); }
    return { rows: [] as Object_[] };
  } };
  return { client, queries, getRole: () => role };
}
const errorCode = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof RuntimeBootstrapError); assert.equal(error.code, code);
  assert.equal(error.cause, undefined); assert.doesNotMatch(error.message, /synthetic|postgresql|SCRAM|private-host/); return true;
};

test("bootstrap binds the Neon plain-password input privately, creates LOGIN and provenance atomically, and releases its session fence once", async () => {
  const f = fake(), prepared = await prepareRuntimeBootstrap(f.client, input);
  assert.equal(prepared.roleCreated, true); assert.equal(prepared.transitionId, transitionId);
  assert.equal(prepared.connection.ssl, connection.ssl); assert.equal(prepared.connection.options, connection.options);
  assert.equal(prepared.connection.statement_timeout, 30_000); assert.equal(prepared.connection.user, input.roleName);
  assert.match(prepared.connection.password, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(prepared.databaseUrl).password, prepared.connection.password);
  const create = f.queries.find(item => item.sql.startsWith("DO $cannele_runtime_bootstrap$"))!.sql;
  assert.match(create, /LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L/);
  assert.equal(f.queries.some(item => item.sql.includes(prepared.connection.password) || item.sql.includes(connection.password)), false);
  const passwordBound = f.queries.findIndex(item => item.sql === "SELECT pg_catalog.set_config('cannele.bootstrap_password',$1,true) IS NOT NULL AS configured");
  const passwordCleared = f.queries.findIndex(item => item.sql === "SELECT pg_catalog.set_config('cannele.bootstrap_password','',true)='' AS cleared");
  assert.deepEqual(f.queries[passwordBound].values, [prepared.connection.password]);
  assert.ok(passwordBound < f.queries.findIndex(item => item.sql === create));
  assert.ok(passwordCleared > passwordBound && passwordCleared < f.queries.findIndex(item => item.sql === "COMMIT"));
  assert.ok(f.queries.findIndex(item => item.sql.startsWith("COMMENT ON ROLE")) < f.queries.findIndex(item => item.sql === "COMMIT"));
  assert.equal(f.queries.some(item => item.sql.includes("pg_advisory_unlock")), false);
  await Promise.all([prepared.releaseControl(), prepared.releaseControl()]);
  assert.equal(f.queries.filter(item => item.sql.includes("pg_advisory_unlock")).length, 1);
});

test("exact retry preserves the role and derives the same private candidate without CREATE, GRANT, COMMENT or ALTER", async () => {
  const f = fake(), first = await prepareRuntimeBootstrap(f.client, input); await first.releaseControl();
  const retry = fake({ role: f.getRole() }), second = await prepareRuntimeBootstrap(retry.client, input); await second.releaseControl();
  assert.equal(second.roleCreated, false); assert.equal(second.connection.password, first.connection.password); assert.equal(second.marker, first.marker);
    assert.equal(retry.queries.some(item => /^(CREATE|GRANT|COMMENT|ALTER|DO) /.test(item.sql)), false);
  const rotated = await prepareRuntimeBootstrap(fake({ role: f.getRole() }).client, { ...input, connection: { ...connection, password: "different-synthetic-admin-password" } });
  assert.notEqual(rotated.connection.password, first.connection.password); assert.equal(rotated.roleCreated, false); await rotated.releaseControl();
});

test("foreign marker and unsafe existing roles fail closed without changing or adopting the role", async () => {
  for (const [role, code] of [[safeRole("foreign"), "RUNTIME_BOOTSTRAP_ROLE_CONFLICT"], [{ ...safeRole("unused"), memberships: true }, "RUNTIME_BOOTSTRAP_ROLE_UNSAFE"]] as const) {
    const original = fake(), own = await prepareRuntimeBootstrap(original.client, input); await own.releaseControl();
    const f = fake({ role: code.endsWith("UNSAFE") ? { ...role, marker: own.marker } : role });
    await assert.rejects(prepareRuntimeBootstrap(f.client, input), errorCode(code));
    assert.equal(f.queries.some(item => /^(CREATE|GRANT|COMMENT|ALTER|DO) /.test(item.sql)), false);
    assert.ok(f.queries.some(item => item.sql === "ROLLBACK")); assert.ok(f.queries.some(item => item.sql.includes("pg_advisory_unlock")));
  }
});

test("host/name, context, transition receipt and dedicated-database mismatches refuse before role SQL", async () => {
  const baseline = identity();
  const broken = [
    { ...baseline, writer_mode: "api" }, { ...baseline, writer_epoch: 2 }, { ...baseline, repository_id: 1 },
    { ...baseline, schema_checksum: "b".repeat(64) },
    { ...baseline, initialization_receipt: { ...context, repositoryId: String(context.repositoryId), legacyTransition: {
      ...(baseline.initialization_receipt as Object_).legacyTransition as Object_, databaseHostDigest: "b".repeat(64) } } },
    { ...baseline, initialization_receipt: { ...context, repositoryId: String(context.repositoryId), legacyTransition: {
      ...(baseline.initialization_receipt as Object_).legacyTransition as Object_, databaseName: "another_database" } } },
  ];
  for (const row of broken) {
    const f = fake({ identity: row }); await assert.rejects(prepareRuntimeBootstrap(f.client, input), errorCode("RUNTIME_BOOTSTRAP_CONTEXT_MISMATCH"));
    assert.equal(f.queries.some(item => item.sql.startsWith("DO $cannele_runtime_bootstrap$")), false);
  }
  await assert.rejects(prepareRuntimeBootstrap(fake({ safe: false }).client, input), errorCode("RUNTIME_BOOTSTRAP_DATABASE_UNSAFE"));
});

test("invalid context, changed migration bytes, pooler and role injection are rejected before touching credentials in SQL", async () => {
  for (const changed of [
    { ...input, roleName: 'cannele_runtime"; SELECT 1' }, { ...input, context: { ...context, extra: true } },
    { ...input, migrations: migrations.map((m, i) => i === 0 ? { ...m, sql: "changed" } : m) },
    { ...input, connection: { ...connection, host: "ep-management-pooler.mock.neon.tech" } },
  ]) {
    const f = fake(); await assert.rejects(prepareRuntimeBootstrap(f.client, changed), errorCode("RUNTIME_BOOTSTRAP_INPUT_INVALID")); assert.equal(f.queries.length, 0);
  }
});

test("unknown commit and cleanup failures retain a closed primary error and never reset a password", async () => {
  const privateError = new Error("postgresql://synthetic:private-password@private-host SQL SCRAM private-verifier");
  const f = fake({ error: sql => ["COMMIT", "ROLLBACK"].includes(sql) || sql.includes("pg_advisory_unlock") ? privateError : undefined });
  await assert.rejects(prepareRuntimeBootstrap(f.client, input), errorCode("RUNTIME_BOOTSTRAP_COMMIT_UNKNOWN"));
  assert.equal(f.queries.some(item => item.sql.startsWith("ALTER ROLE")), false);
  const failed = fake({ error: sql => sql.startsWith("COMMENT ON ROLE") || sql === "ROLLBACK" ? privateError : undefined });
  await assert.rejects(prepareRuntimeBootstrap(failed.client, input), errorCode("RUNTIME_BOOTSTRAP_DATABASE_ERROR"));
  assert.ok(failed.queries.some(item => item.sql.includes("pg_advisory_unlock")));
});

const databaseUrl = process.env.CAKE_REGISTRY_FENCE_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CAKE_REGISTRY_FENCE_REQUIRE_DATABASE_TESTS === "true") throw new Error("Disposable PostgreSQL fixture is required for runtime bootstrap tests.");

async function fixture() {
  assert.ok(databaseUrl); const base = new URL(databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(base.protocol)); assert.ok(["127.0.0.1", "localhost"].includes(base.hostname));
  assert.equal(base.pathname, "/cannele_test"); assert.equal(base.search, ""); assert.equal(base.hash, "");
  const suffix = randomUUID().replaceAll("-", ""), name = `cannele_test_bootstrap_${suffix}`;
  const owner = `bootstrap_owner_${suffix}`, runtime = `bootstrap_runtime_${suffix}`, adminPassword = randomBytes(32).toString("base64url");
  const creator = new pg.Client({ connectionString: base.href, connectionTimeoutMillis: 3000 }); await creator.connect();
  const clients: pg.Client[] = [];
  const close = async () => { await Promise.allSettled(clients.map(client => client.end()));
    try { await creator.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await creator.query(`DROP ROLE IF EXISTS "${runtime}"`); await creator.query(`DROP ROLE IF EXISTS "${owner}"`); }
    finally { await creator.end(); } };
  try {
    // PostgreSQL 16+ grants the nonsuperuser creator ADMIN on the new role. This
    // incoming membership must not be confused with runtime's own memberships.
    await creator.query(`CREATE ROLE "${owner}" LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${adminPassword}'`);
    await creator.query(`CREATE DATABASE "${name}" OWNER "${owner}"`);
    const config = { host: base.hostname, port: Number(base.port || 5432), database: name, user: owner, password: adminPassword, connectionTimeoutMillis: 3000 };
    const connect = async (c = config) => { const client = new pg.Client(c); clients.push(client); await client.connect(); return client; };
    const admin = await connect();
    await admin.query("CREATE SCHEMA cannele_registry");
    await admin.query("CREATE TABLE cannele_registry.schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL)");
    await admin.query("CREATE TABLE cannele_registry.instance_control(singleton boolean,instance_id uuid,repository_id bigint,binding_digest text,writer_mode text,writer_epoch bigint,schema_version integer,schema_checksum text,initialization_receipt jsonb)");
    for (const migration of migrations) await admin.query("INSERT INTO cannele_registry.schema_migrations VALUES($1,$2)", [migration.version, migration.checksum]);
    const row = identity({ ...connection, ...config });
    await admin.query("INSERT INTO cannele_registry.instance_control VALUES(true,$1,$2,$3,'disabled',1,4,$4,$5::jsonb)",
      [context.instanceId, context.repositoryId, context.bindingDigest, context.schemaChecksum, JSON.stringify(row.initialization_receipt)]);
    return { admin, creator, connect, config, runtime, close };
  } catch (error) { await close(); throw error; }
}

test("PostgreSQL nonsuperuser owner creates SCRAM runtime, actual fresh LOGIN works, and exact replay leaves pg_authid unchanged", { skip: !databaseUrl }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.admin.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper, false);
    const first = await prepareRuntimeBootstrap(f.admin, { ...input, connection: f.config, roleName: f.runtime });
    assert.equal(first.roleCreated, true);
    assert.equal((await f.admin.query("SELECT coalesce(current_setting('cannele.bootstrap_password',true),'') AS value")).rows[0].value, "");
    const runtime = await f.connect(first.connection);
    assert.deepEqual((await runtime.query("SELECT current_user AS u,session_user AS s,current_database() AS d")).rows,
      [{ u: f.runtime, s: f.runtime, d: f.config.database }]);
    await assert.rejects(runtime.query("SELECT * FROM cannele_registry.instance_control"), error => (error as { code: string }).code === "42501");
    const before = (await f.creator.query("SELECT to_jsonb(r) AS role FROM pg_authid r WHERE rolname=$1", [f.runtime])).rows[0].role;
    assert.match(before.rolpassword, /^SCRAM-SHA-256\$/); assert.equal(before.rolpassword.includes(first.connection.password), false);
    assert.equal((await f.creator.query("SELECT count(*)::int AS c FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)", [f.runtime])).rows[0].c, 0);
    assert.equal((await f.creator.query("SELECT count(*)::int AS c FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname=$1)", [f.runtime])).rows[0].c, 1);
    await first.releaseControl();
    const retry = await prepareRuntimeBootstrap(f.admin, { ...input, connection: f.config, roleName: f.runtime }); await retry.releaseControl();
    assert.equal(retry.roleCreated, false); assert.equal(retry.connection.password, first.connection.password); assert.equal(retry.marker, first.marker);
    assert.deepEqual((await f.creator.query("SELECT to_jsonb(r) AS role FROM pg_authid r WHERE rolname=$1", [f.runtime])).rows[0].role, before);
  } finally { await f.close(); }
});

test("PostgreSQL public CREATE, wrong receipt and foreign existing role fail atomically; control fence is released", { skip: !databaseUrl }, async () => {
  const f = await fixture();
  try {
    await f.admin.query("GRANT CREATE ON SCHEMA public TO PUBLIC");
    await assert.rejects(prepareRuntimeBootstrap(f.admin, { ...input, connection: f.config, roleName: f.runtime }), errorCode("RUNTIME_BOOTSTRAP_ROLE_UNSAFE"));
    assert.equal((await f.admin.query("SELECT coalesce(current_setting('cannele.bootstrap_password',true),'') AS value")).rows[0].value, "");
    assert.equal((await f.creator.query("SELECT count(*)::int AS c FROM pg_roles WHERE rolname=$1", [f.runtime])).rows[0].c, 0);
    await f.admin.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await f.admin.query("UPDATE cannele_registry.instance_control SET writer_mode='api'");
    await assert.rejects(prepareRuntimeBootstrap(f.admin, { ...input, connection: f.config, roleName: f.runtime }), errorCode("RUNTIME_BOOTSTRAP_CONTEXT_MISMATCH"));
    await f.admin.query("UPDATE cannele_registry.instance_control SET writer_mode='disabled'");
    await f.creator.query(`CREATE ROLE "${f.runtime}" LOGIN NOINHERIT`);
    const before = (await f.creator.query("SELECT to_jsonb(r) AS role FROM pg_authid r WHERE rolname=$1", [f.runtime])).rows[0].role;
    await assert.rejects(prepareRuntimeBootstrap(f.admin, { ...input, connection: f.config, roleName: f.runtime }), errorCode("RUNTIME_BOOTSTRAP_ROLE_CONFLICT"));
    assert.deepEqual((await f.creator.query("SELECT to_jsonb(r) AS role FROM pg_authid r WHERE rolname=$1", [f.runtime])).rows[0].role, before);
    const other = await f.connect();
    assert.equal((await other.query("SELECT pg_try_advisory_lock(hashtextextended('cannele_registry:control',0)) AS ok")).rows[0].ok, true);
    await other.query("SELECT pg_advisory_unlock(hashtextextended('cannele_registry:control',0))");
  } finally { await f.close(); }
});

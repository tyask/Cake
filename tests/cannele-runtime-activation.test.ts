import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import manifest from "../docs/cannele/resource-manifest.json";
import { activateRuntimeWriter, RuntimeActivationError, runtimeActivationContext as context, validateRuntimeActivationContext } from "../scripts/cannele-runtime-activation";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const databaseUrl = process.env.CAKE_REGISTRY_FENCE_TEST_DATABASE_URL;
const directory = process.env.CAKE_CANNELE_TEST_MIGRATIONS_DIR;
if (process.env.CAKE_REGISTRY_FENCE_REQUIRE_DATABASE_TESTS === "true" && (!databaseUrl || !directory)) {
  throw new Error("Disposable PostgreSQL and the pinned Cannele SQL directory are required for activation tests.");
}
const migrations = directory ? ["001_registry.sql", "002_authentication.sql", "003_runtime_guard.sql", "004_provider_lifecycle.sql"].map((filename, index) => {
  const sql = readFileSync(join(directory, filename), "utf8"); return { version: index + 1, filename, checksum: hash(sql), sql };
}) : [];
const enabled = Boolean(databaseUrl && directory);
const expectCode = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof RuntimeActivationError); assert.equal(error.code, code); assert.equal(error.cause, undefined);
  assert.doesNotMatch(error.message, /postgresql|password|private-host|SELECT|secret-value/); return true;
};

async function fixture(changes: { transition?: Record<string, unknown>; initial?: Record<string, unknown> } = {}) {
  assert.ok(databaseUrl); const base = new URL(databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(base.protocol)); assert.ok(["127.0.0.1", "localhost"].includes(base.hostname));
  assert.equal(base.pathname, "/cannele_test"); assert.equal(base.search, ""); assert.equal(base.hash, "");
  const suffix = randomUUID().replaceAll("-", ""), name = `cannele_test_activation_${suffix}`, owner = `activation_owner_${suffix}`;
  const creator = new pg.Client({ connectionString: base.href, connectionTimeoutMillis: 3000 }); await creator.connect();
  const password = randomBytes(32).toString("base64url"), clients: pg.Client[] = [];
  const config = { host: base.hostname, port: Number(base.port || 5432), database: name, user: owner, password, connectionTimeoutMillis: 3000 };
  const connect = async () => { const client = new pg.Client(config); clients.push(client); await client.connect(); return client; };
  const close = async () => {
    await Promise.allSettled(clients.map(client => client.end()));
    try { await creator.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await creator.query(`DROP ROLE IF EXISTS "${owner}"`); }
    finally { await creator.end(); }
  };
  try {
    await creator.query(`CREATE ROLE "${owner}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await creator.query(`CREATE DATABASE "${name}" OWNER "${owner}"`);
    const admin = await connect();
    for (const migration of migrations) { await admin.query(migration.sql); await admin.query("INSERT INTO cannele_registry.schema_migrations(version,checksum) VALUES($1,$2)", [migration.version, migration.checksum]); }
    const initialization = { ...context, repositoryId: String(context.repositoryId), featureBranchPrefix: manifest.repository.featureBranchPrefix,
      acceptedPrCreatedAfter: manifest.repository.acceptedPrCreatedAfter, slots: manifest.slots,
      legacyTransition: { protocol: "cannele-legacy-transition/v1", transitionId: "86ee46a3-eb41-414e-85aa-d21e053d152d", legacyWriterEpoch: 2,
        databaseHostDigest: hash(config.host), databaseName: name, result: { schemaVersion: 4, schemaChecksum: context.schemaChecksum, appliedVersions: [1, 2, 3, 4] },
        ...changes.transition }, ...changes.initial };
    await admin.query("SELECT cannele_registry.initialize_instance($1::jsonb)", [JSON.stringify(initialization)]);
    const input = { connection: config, context: { ...context }, migrations };
    const state = async () => (await admin.query("SELECT writer_mode,writer_epoch::int,initialization_receipt FROM cannele_registry.instance_control")).rows[0];
    return { admin, creator, connect, config, input, state, close };
  } catch (error) { await close(); throw error; }
}

test("activation fixes the reviewed instance before any SQL and CI checks out only immutable SQL without credential persistence", async () => {
  validateRuntimeActivationContext({ ...context });
  for (const changed of [{ ...context, instanceId: randomUUID() }, { ...context, writerEpoch: 2 }, { ...context, unknown: true }]) {
    await assert.rejects(activateRuntimeWriter({ query: async () => assert.fail("Invalid context reached SQL") },
      { connection: { host: "127.0.0.1", port: 5432, database: "neondb", user: "owner" }, context: changed, migrations: [] }), expectCode("RUNTIME_ACTIVATION_INPUT_INVALID"));
  }
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /repository: tyask\/cannele\s+ref: 623520315b7b2c982e4b98ecdb72658252709d7c/);
  assert.match(ci, /path: node_modules\/\.cache\/cannele-schema-source\s+persist-credentials: false\s+sparse-checkout: db\/migrations/);
  assert.match(ci, /CAKE_CANNELE_TEST_MIGRATIONS_DIR:.*node_modules\/\.cache\/cannele-schema-source\/db\/migrations/);
});

test("PostgreSQL activation retains auth rows and initialization receipt, changes only disabled→api epoch1, and read-only repeats allow later QA use", { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.admin.query("INSERT INTO cannele_registry.auth_rate_limits VALUES('synthetic-auth',clock_timestamp(),1,60)");
    await f.admin.query("INSERT INTO cannele_registry.auth_pairings(id,public_key,nonce_hash,device_hash,user_code_hash,client_label,created_at,expires_at) VALUES($1,'synthetic-public-key',$2,$3,$4,'fixture',clock_timestamp(),clock_timestamp()+interval '10 minutes')",
      [randomUUID(), "1".repeat(64), "2".repeat(64), "3".repeat(64)]);
    const before = await f.state();
    const activated = await activateRuntimeWriter(f.admin, f.input);
    assert.equal(activated.alreadyEnabled, false); assert.equal(activated.writerMode, "api"); assert.equal(activated.writerEpoch, 1);
    assert.deepEqual(await f.state(), { ...before, writer_mode: "api" });
    assert.equal((await f.admin.query("SELECT count(*)::int AS c FROM cannele_registry.auth_pairings")).rows[0].c, 1);
    assert.equal((await f.admin.query("SELECT count(*)::int AS c FROM cannele_registry.auth_rate_limits")).rows[0].c, 1);
    await f.admin.query("INSERT INTO cannele_registry.pr_lifecycle(pr_number,generation,state,source_sha) VALUES(1,1,'open',$1)", ["a".repeat(40)]);
    await f.admin.query("UPDATE cannele_registry.slots SET version=1 WHERE key='qa1'");
    let writes = 0;
    const repeated = await activateRuntimeWriter({ query: async (sql, args) => { if (/^(UPDATE|INSERT|DELETE|CREATE|ALTER|DROP) /.test(sql)) writes++; return f.admin.query(sql, args); } }, f.input);
    assert.equal(repeated.alreadyEnabled, true); assert.equal(writes, 0);
    assert.equal((await f.admin.query("SELECT version::int FROM cannele_registry.slots WHERE key='qa1'")).rows[0].version, 1);
    assert.deepEqual(await f.state(), { ...before, writer_mode: "api" });
  } finally { await f.close(); }
});

test("PostgreSQL disabled activation refuses used QA tables, changed slot versions and a spent history sequence without clearing them", { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.admin.query("INSERT INTO cannele_registry.pr_lifecycle(pr_number,generation,state,source_sha) VALUES(1,1,'open',$1)", ["a".repeat(40)]);
    await assert.rejects(activateRuntimeWriter(f.admin, f.input), expectCode("RUNTIME_ACTIVATION_LEDGER_USED"));
    assert.equal((await f.state()).writer_mode, "disabled");
    await f.admin.query("DELETE FROM cannele_registry.pr_lifecycle");
    await f.admin.query("UPDATE cannele_registry.slots SET version=1 WHERE key='qa1'");
    await assert.rejects(activateRuntimeWriter(f.admin, f.input), expectCode("RUNTIME_ACTIVATION_LEDGER_USED"));
    await f.admin.query("UPDATE cannele_registry.slots SET version=0 WHERE key='qa1'");
    await f.admin.query("SELECT nextval('cannele_registry.lease_history_sequence_seq')");
    await assert.rejects(activateRuntimeWriter(f.admin, f.input), expectCode("RUNTIME_ACTIVATION_LEDGER_USED"));
    assert.equal((await f.state()).writer_mode, "disabled");
  } finally { await f.close(); }
});

test("PostgreSQL rejects maintenance/epoch drift and a different saved transition or host before enabling", { skip: !enabled }, async () => {
  for (const transition of [{ transitionId: randomUUID() }, { databaseHostDigest: "b".repeat(64) }, { databaseName: "unrelated_database" }]) {
    const f = await fixture({ transition });
    try { await assert.rejects(activateRuntimeWriter(f.admin, f.input), expectCode("RUNTIME_ACTIVATION_CONTEXT_MISMATCH")); assert.equal((await f.state()).writer_mode, "disabled"); }
    finally { await f.close(); }
  }
  const f = await fixture();
  try {
    await f.admin.query("UPDATE cannele_registry.instance_control SET writer_mode='maintenance'");
    await assert.rejects(activateRuntimeWriter(f.admin, f.input), expectCode("RUNTIME_ACTIVATION_CONTEXT_MISMATCH"));
    await f.admin.query("UPDATE cannele_registry.instance_control SET writer_mode='disabled',writer_epoch=2");
    await assert.rejects(activateRuntimeWriter(f.admin, f.input), expectCode("RUNTIME_ACTIVATION_CONTEXT_MISMATCH"));
    assert.equal((await f.state()).writer_mode, "disabled"); assert.equal((await f.state()).writer_epoch, 2);
  } finally { await f.close(); }
});

test("PostgreSQL refuses unknown registry/business objects and changed provider-free SQL guards even when migration metadata matches", { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.admin.query("CREATE TABLE cannele_registry.unknown_fixture(id integer)");
    await assert.rejects(activateRuntimeWriter(f.admin, f.input), expectCode("RUNTIME_ACTIVATION_SCHEMA_MISMATCH"));
    await f.admin.query("DROP TABLE cannele_registry.unknown_fixture");
    await f.admin.query("CREATE TABLE public.unknown_business_fixture(id integer)");
    await assert.rejects(activateRuntimeWriter(f.admin, f.input), expectCode("RUNTIME_ACTIVATION_DATABASE_UNSAFE"));
    await f.admin.query("DROP TABLE public.unknown_business_fixture");
    await f.admin.query("CREATE OR REPLACE FUNCTION cannele_registry.assert_context(p_context jsonb,p_write boolean DEFAULT true) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cannele_registry AS $$BEGIN RETURN; END$$");
    await assert.rejects(activateRuntimeWriter(f.admin, f.input), expectCode("RUNTIME_ACTIVATION_SCHEMA_MISMATCH"));
    assert.equal((await f.state()).writer_mode, "disabled");
  } finally { await f.close(); }
});

test("PostgreSQL serializes first activation behind the control fence and concurrent exact requests converge", { skip: !enabled }, async () => {
  const f = await fixture(); let pending: Promise<unknown> | undefined;
  try {
    const holder = await f.connect(), worker = await f.connect(), pid = (await worker.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    await holder.query("BEGIN"); await holder.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('cannele_registry:control',0))");
    pending = activateRuntimeWriter(worker, f.input);
    let blocked = false;
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if ((await f.admin.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS blocked", [pid])).rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true); assert.equal((await f.state()).writer_mode, "disabled");
    } finally { await holder.query("COMMIT"); }
    const other = await f.connect();
    const results = await Promise.all([pending as ReturnType<typeof activateRuntimeWriter>, activateRuntimeWriter(other, f.input)]);
    assert.deepEqual(results.map(result => result.alreadyEnabled).sort(), [false, true]);
    assert.equal((await f.state()).writer_epoch, 1);
  } finally { if (pending) await pending.catch(() => undefined); await f.close(); }
});

test("PostgreSQL unknown commit can be inspected by an exact read-only retry; later failures roll back and sanitize original SQL details", { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(activateRuntimeWriter({ query: async (sql, args) => { const result = await f.admin.query(sql, args);
      if (sql === "COMMIT") throw new Error("postgresql://owner:secret-value@private-host SQL private details"); return result; } }, f.input), expectCode("RUNTIME_ACTIVATION_COMMIT_UNKNOWN"));
    assert.equal((await f.state()).writer_mode, "api");
    assert.equal((await activateRuntimeWriter(f.admin, f.input)).alreadyEnabled, true);
  } finally { await f.close(); }
  const fresh = await fixture();
  try {
    await assert.rejects(activateRuntimeWriter({ query: async (sql, args) => {
      if (sql.endsWith("($1::jsonb,true)")) throw new Error("postgresql://owner:secret-value@private-host SQL private details");
      const result = await fresh.admin.query(sql, args); if (sql === "ROLLBACK") throw new Error("secondary private details"); return result;
    } }, fresh.input), expectCode("RUNTIME_ACTIVATION_DATABASE_ERROR"));
    assert.equal((await fresh.state()).writer_mode, "disabled");
    assert.equal((await fresh.state()).writer_epoch, 1);
  } finally { await fresh.close(); }
});

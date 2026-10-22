import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aclSql, appTables, assertCopy, authIdentityTables, authTables, beginReadOnly, catalogSql,
  inventory, quotedIdentifier, safetySql, startSnapshot, structureSql,
  type Snapshot, type Sql,
} from '../scripts/production-db-migration-inventory';
import { config, hash, type Binding } from '../scripts/production-db-migration-provider';

const expected: Binding = { ...config.source, database: 'fixture_db', role: 'fixture_owner' };
type Row = Record<string, unknown>;
class FakeSql implements Sql {
  readonly calls: { text: string; values?: unknown[] }[] = [];
  constructor(private readonly respond: (text: string, values?: unknown[]) => Row[]) {}
  async connect(): Promise<void> { assert.fail('unit tests must not open a database connection'); }
  async end(): Promise<void> {}
  async query(text: string, values?: unknown[]): Promise<{ rows: Row[] }> {
    this.calls.push({ text, values });
    return { rows: structuredClone(this.respond(text, values)) };
  }
}

function snapshotRow(): Row {
  return { database: expected.database, role: expected.role, version: expected.majorVersion * 10000 + 3,
    encoding: 'UTF8', read_only: 'on', snapshot: '0000000A-00000010-1' };
}
function snapshotSql(row: Row): FakeSql {
  return new FakeSql(text => text.includes('pg_export_snapshot()') ? [row] : []);
}

test('startSnapshot starts repeatable read/read only, fixes serialization settings, then exports the snapshot', async () => {
  const sql = snapshotSql(snapshotRow());
  assert.equal(await startSnapshot(sql, expected), '0000000A-00000010-1');
  assert.deepEqual(sql.calls.slice(0, -1).map(call => call.text), [
    beginReadOnly,
    "SET LOCAL statement_timeout='60s'", "SET LOCAL lock_timeout='5s'",
    'SET LOCAL search_path=pg_catalog,public', "SET LOCAL TIME ZONE 'UTC'",
    "SET LOCAL DateStyle='ISO, YMD'", 'SET LOCAL extra_float_digits=3',
  ]);
  assert.match(sql.calls.at(-1)!.text, /current_database\(\)[\s\S]*current_user/);
  assert.match(sql.calls.at(-1)!.text, /transaction_read_only[\s\S]*pg_export_snapshot\(\)/);
  assert.ok(sql.calls.every(call => call.values === undefined));
});

const invalidSnapshotRows: [string, Row, string?][] = [
  ['another database', { database: 'other_db' }],
  ['another role', { role: 'other_owner' }],
  ['another major version', { version: 180001 }],
  ['another encoding', { encoding: 'LATIN1' }],
  ['a writable transaction', { read_only: 'off' }],
  ['a missing snapshot', { snapshot: null }],
  ['a snapshot containing SQL', { snapshot: "private'; SELECT secret" }],
  ['an excessively long snapshot', { snapshot: 'a'.repeat(129) }],
  ['a malformed version', { version: 'private-server-detail' }, 'INVALID_INVENTORY'],
];
for (const [name, change, code = 'DATABASE_BINDING'] of invalidSnapshotRows) {
  test(`startSnapshot rejects ${name} with a public error code`, async () => {
    await assert.rejects(startSnapshot(snapshotSql({ ...snapshotRow(), ...change }), expected), {
      message: `PRODUCTION_MIGRATION_${code}`,
    });
  });
}

test('quotedIdentifier accepts only fixed lowercase SQL identifiers', () => {
  assert.equal(quotedIdentifier('schema_migrations'), '"schema_migrations"');
  assert.equal(quotedIdentifier('_fixture123'), '"_fixture123"');
  for (const value of ['', '1table', 'UpperName', 'public.table', 'name-dash', 'name space',
    'name\u0000', 'name"; DROP SCHEMA public CASCADE; --']) {
    assert.throws(() => quotedIdentifier(value), { message: 'PRODUCTION_MIGRATION_INVALID_IDENTIFIER' });
  }
});

type InventoryFixture = {
  structure: Row[]; authCounts: Record<string, unknown>; safety: Row; acl: Row[];
  extensions: Row[]; defaults: Row[]; extensionAcl: Row[]; metadata: Row; roles: Row[];
  table: Row; ledger: Row[]; catalog: Row[]; authSchema: Row[];
};
function managedDefaults(majorVersion = expected.majorVersion): Row[] {
  const tablePrivileges = majorVersion === 17
    ? ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']
    : ['DELETE', 'INSERT', 'MAINTAIN', 'SELECT', 'TRUNCATE', 'UPDATE'];
  return [['S', ['SELECT', 'UPDATE', 'USAGE']], ['r', tablePrivileges]].map(([kind, privileges]) => ({
    owner: 'cloud_admin', schema: 'public', kind,
    privileges: (privileges as string[]).map(privilege => ['cloud_admin', 'neon_superuser', privilege, true]),
  }));
}
function safeFixture(): InventoryFixture {
  return {
    structure: [
      ...authTables.map(name => ({ schema: 'neon_auth', name, kind: 'r', owner: 'neon_auth' })),
      ...appTables.map(name => ({ schema: 'public', name, kind: 'r', owner: expected.role })),
    ],
    authCounts: Object.fromEntries(authIdentityTables.map(name => [name, '0'])),
    safety: Object.fromEntries([...safetySql.matchAll(/\)\s+AS\s+([a-z_]+)/g)].map(match => [match[1], '0'])),
    acl: [{ kind: 'schema', name: 'public', owner: 'pg_database_owner', grantee: 'PUBLIC',
      grantor: 'pg_database_owner', privilege_type: 'USAGE', is_grantable: false }],
    extensions: [
      { extname: 'pgcrypto', extversion: '1.3', schema: 'public', extrelocatable: true, extconfig: null },
      { extname: 'plpgsql', extversion: '1.0', schema: 'pg_catalog', extrelocatable: false, extconfig: null },
    ],
    defaults: managedDefaults(), extensionAcl: [],
    metadata: { version: expected.majorVersion * 10000 + 3, bytes: '1024', locale: ['C', 'C', 'c', null] },
    roles: [{ rolname: expected.role, rolsuper: false, rolcanlogin: true, memberships: ['neon_superuser'] }],
    table: { rows: '1', hash: hash('fixture table contents') },
    ledger: [{ name: '001_fixture.sql', applied_at: '2026-10-23 00:00:00+00' }],
    catalog: [{ columns: [['fixture-column-metadata']], constraints: null, indexes: null, triggers: null, functions: null }],
    authSchema: [{ relname: 'jwks', attnum: 1, attname: 'private_auth_column_fixture', type: 'text', attnotnull: true }],
  };
}
function inventorySql(data: InventoryFixture): FakeSql {
  return new FakeSql(text => {
    if (text === structureSql) return data.structure;
    if (text === safetySql) return [data.safety];
    if (text === aclSql) return data.acl;
    if (text === catalogSql) return data.catalog;
    const authTable = /^SELECT count\(\*\)::text AS rows FROM neon_auth\."([a-z_]+)"$/.exec(text)?.[1];
    if (authTable) {
      assert.ok(authIdentityTables.includes(authTable as typeof authIdentityTables[number]), 'Auth key/config rows must never be read');
      return [{ rows: data.authCounts[authTable] }];
    }
    if (text.includes('FROM pg_extension e')) return data.extensions;
    if (text.startsWith('SELECT pg_get_userbyid(d.defaclrole)')) return data.defaults;
    if (text.startsWith('SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments')) return data.extensionAcl;
    if (text.includes('pg_database_size(current_database())')) return [data.metadata];
    if (text.includes('FROM pg_roles r WHERE r.rolname=current_user')) return data.roles;
    if (text.startsWith('SELECT count(*)::text AS rows,encode(sha256(')) return [data.table];
    if (text === 'SELECT name,applied_at::text AS applied_at FROM public.schema_migrations ORDER BY name') return data.ledger;
    if (text.includes("WHERE n.nspname='neon_auth'") && text.includes('FROM pg_attribute a')) return data.authSchema;
    assert.fail('unexpected inventory query');
  });
}

test('inventory reads only Auth identity counts and exposes hashes rather than SQL or Auth metadata', async () => {
  const data = safeFixture(), sql = inventorySql(data);
  const result = await inventory(sql, expected);
  assert.deepEqual(result.tables, appTables);
  assert.equal(result.summary.authRows, 0);
  assert.equal(result.summary.publicTables, appTables.length);
  assert.equal(result.empty, false);
  const authCountQueries = sql.calls.filter(call => call.text.startsWith('SELECT count(*)::text AS rows FROM neon_auth.'));
  assert.equal(authCountQueries.length, 7);
  assert.deepEqual(authCountQueries.map(call => /\."([a-z_]+)"$/.exec(call.text)?.[1]), authIdentityTables);
  assert.ok(!sql.calls.some(call => /FROM neon_auth\."(?:jwks|project_config)"/.test(call.text)));
  const exposed = JSON.stringify(result);
  assert.ok(!exposed.includes('private_auth_column_fixture'));
  assert.ok(!exposed.includes('fixture-column-metadata'));
  assert.ok(!exposed.includes('SELECT '));
  for (const value of [result.summary.dataHash, result.summary.schemaHash, result.summary.aclHash,
    result.summary.authSchemaHash, result.summary.ledgerHash]) assert.match(value, /^[a-f0-9]{64}$/);
});

const invalidStructures: [string, (data: InventoryFixture) => void, string][] = [
  ['an unknown schema', data => { data.structure.push({ schema: 'unexpected', name: 'private_table', kind: 'r' }); }, 'UNKNOWN_STRUCTURE'],
  ['an unknown public table', data => { data.structure.push({ schema: 'public', name: 'private_table', kind: 'r' }); }, 'UNKNOWN_STRUCTURE'],
  ['a missing application table', data => { data.structure = data.structure.filter(row => row.name !== appTables[0]); }, 'UNKNOWN_STRUCTURE'],
  ['a missing Auth table', data => { data.structure = data.structure.filter(row => row.name !== 'jwks'); }, 'AUTH_STRUCTURE'],
  ['an extra Auth table', data => { data.structure.push({ schema: 'neon_auth', name: 'private_extra', kind: 'r', owner: 'neon_auth' }); }, 'AUTH_STRUCTURE'],
  ['an Auth table owned by another role', data => { data.structure[0].owner = expected.role; }, 'AUTH_STRUCTURE'],
];
for (const [name, change, code] of invalidStructures) {
  test(`inventory rejects ${name} before reading any table data`, async () => {
    const data = safeFixture();
    change(data);
    const sql = inventorySql(data);
    await assert.rejects(inventory(sql, expected), { message: `PRODUCTION_MIGRATION_${code}` });
    assert.equal(sql.calls.length, 1);
  });
}
for (const kind of ['p', 'f', 'v', 'm', 'S']) {
  test(`inventory rejects unsupported relation kind ${kind}`, async () => {
    const data = safeFixture();
    data.structure[0].kind = kind;
    const sql = inventorySql(data);
    await assert.rejects(inventory(sql, expected), { message: 'PRODUCTION_MIGRATION_UNKNOWN_STRUCTURE' });
    assert.equal(sql.calls.length, 1);
  });
}
for (const name of authIdentityTables) {
  test(`inventory rejects nonempty Auth ${name} without reading its rows`, async () => {
    const data = safeFixture();
    data.authCounts[name] = '1';
    const sql = inventorySql(data);
    await assert.rejects(inventory(sql, expected), { message: 'PRODUCTION_MIGRATION_AUTH_DATA_PRESENT' });
    assert.ok(!sql.calls.some(call => call.text === safetySql));
    assert.ok(sql.calls.slice(1).every(call => call.text.startsWith('SELECT count(*)::text AS rows FROM neon_auth.')));
  });
}
for (const key of Object.keys(safeFixture().safety)) {
  test(`inventory rejects nonzero safety result ${key} before inspecting app contents`, async () => {
    const data = safeFixture();
    data.safety[key] = '1';
    const sql = inventorySql(data);
    await assert.rejects(inventory(sql, expected), { message: 'PRODUCTION_MIGRATION_UNSUPPORTED_SCHEMA' });
    assert.ok(!sql.calls.some(call => call.text === aclSql));
  });
}

const invalidPrivileges: [string, (data: InventoryFixture) => void][] = [
  ['another schema owner', data => { data.acl[0].owner = 'private_owner'; }],
  ['another table owner', data => { data.acl.push({ kind: 'table', name: appTables[0], owner: 'private_owner' }); }],
  ['an unknown grantee', data => { data.acl[0].grantee = 'private_grantee'; }],
  ['an unknown grantor', data => { data.acl[0].grantor = 'private_grantor'; }],
];
for (const [name, change] of invalidPrivileges) {
  test(`inventory rejects ${name} without publishing its ACL`, async () => {
    const data = safeFixture();
    change(data);
    await assert.rejects(inventory(inventorySql(data), expected), { message: 'PRODUCTION_MIGRATION_UNSUPPORTED_PRIVILEGES' });
  });
}

test('inventory rejects invalid counts and malformed safety responses without exposing values', async () => {
  for (const value of ['private-count-detail', '-1', '1e3', '9007199254740992', null]) {
    const data = safeFixture();
    data.authCounts[authIdentityTables[0]] = value;
    await assert.rejects(inventory(inventorySql(data), expected), { message: 'PRODUCTION_MIGRATION_INVALID_INVENTORY' });
  }
  const data = safeFixture();
  data.safety = {};
  await assert.rejects(inventory(inventorySql(data), expected), { message: 'PRODUCTION_MIGRATION_UNSUPPORTED_SCHEMA' });
});

test('inventory accepts only the provider default ACL appropriate for the connected major version', async () => {
  const source = await inventory(inventorySql(safeFixture()), expected);
  const data = safeFixture();
  data.metadata.version = 180001;
  data.defaults = managedDefaults(18);
  const target = await inventory(inventorySql(data), { ...expected, majorVersion: 18 });
  assert.notEqual(source.summary.defaultAclHash, target.summary.defaultAclHash);
  assert.equal(source.summary.extensionAclHash, target.summary.extensionAclHash);
  const wrongVersion = safeFixture();
  wrongVersion.defaults = managedDefaults(18);
  await assert.rejects(inventory(inventorySql(wrongVersion), expected), {
    message: 'PRODUCTION_MIGRATION_MANAGED_DEFAULT_ACL',
  });
});

const invalidDefaults: [string, (data: InventoryFixture) => void][] = [
  ['a missing managed default', data => { data.defaults.pop(); }],
  ['an extra managed default', data => { data.defaults.push({ ...data.defaults[0] }); }],
  ['another default owner', data => { data.defaults[0].owner = 'private_owner'; }],
  ['another default schema', data => { data.defaults[0].schema = 'neon_auth'; }],
  ['another default object kind', data => { data.defaults[0].kind = 'f'; }],
  ['an unknown default grantee', data => { data.defaults[0].privileges = [['cloud_admin', 'private_grantee', 'SELECT', true]]; }],
  ['different default privileges', data => { data.defaults[0].privileges = [['cloud_admin', 'neon_superuser', 'SELECT', false]]; }],
];
for (const [name, change] of invalidDefaults) {
  test(`inventory rejects ${name}`, async () => {
    const data = safeFixture();
    change(data);
    await assert.rejects(inventory(inventorySql(data), expected), { message: 'PRODUCTION_MIGRATION_MANAGED_DEFAULT_ACL' });
  });
}

test('inventory marks a target empty only when no app tables or other app schema objects exist', async () => {
  const data = safeFixture();
  data.structure = data.structure.filter(row => row.schema === 'neon_auth');
  data.catalog = [{ columns: null, constraints: null, indexes: null, triggers: null, functions: null }];
  assert.equal((await inventory(inventorySql(data), expected)).empty, true);
  data.catalog[0].functions = [['existing_function']];
  assert.equal((await inventory(inventorySql(data), expected)).empty, false);
});

test('inventory rejects an unsupported extension, database limit or malformed app hash', async () => {
  const badExtension = safeFixture();
  badExtension.extensions[0].extname = 'private_extension';
  await assert.rejects(inventory(inventorySql(badExtension), expected), { message: 'PRODUCTION_MIGRATION_UNSUPPORTED_EXTENSION' });
  for (const change of [{ bytes: String(config.maxDatabaseBytes + 1) }, { version: 180001 }]) {
    const data = safeFixture();
    Object.assign(data.metadata, change);
    await assert.rejects(inventory(inventorySql(data), expected), { message: 'PRODUCTION_MIGRATION_DATABASE_LIMIT' });
  }
  const badHash = safeFixture();
  badHash.table.hash = 'private-table-detail';
  await assert.rejects(inventory(inventorySql(badHash), expected), { message: 'PRODUCTION_MIGRATION_INVALID_INVENTORY' });
});

function copySnapshot(): Snapshot {
  const tableHashes = appTables.map(name => hash(name));
  return {
    tables: [...appTables], tableHashes, ledger: ['001_fixture.sql'], extensions: ['pgcrypto', 'plpgsql'],
    empty: false, schemaOwner: expected.role,
    summary: { counts: appTables.map(() => 1), dataHash: hash(JSON.stringify(tableHashes)), schemaHash: hash('schema'),
      aclHash: hash('acl'), ledgerHash: hash('ledger'), authSchemaHash: hash('source auth schema'), authRows: 0,
      publicTables: appTables.length, version: 170003, bytes: 1024, localeHash: hash('locale'),
      roleHash: hash('role'), extensionsHash: hash('extensions'), defaultAclHash: hash('source defaults'),
      extensionAclHash: hash('extension ACL') },
  };
}
test('assertCopy accepts equal app data while retaining distinct target version and Auth metadata', () => {
  const source = copySnapshot(), target = structuredClone(source);
  target.summary.version = 180001;
  target.summary.bytes = 2048;
  target.summary.authSchemaHash = hash('target auth schema');
  target.summary.defaultAclHash = hash('target defaults');
  assert.doesNotThrow(() => assertCopy(source, target));
});
for (const key of ['dataHash', 'schemaHash', 'aclHash', 'ledgerHash', 'localeHash', 'roleHash', 'extensionsHash', 'extensionAclHash'] as const) {
  test(`assertCopy rejects a changed ${key}`, () => {
    const source = copySnapshot(), target = structuredClone(source);
    target.summary[key] = hash(`different ${key}`);
    assert.throws(() => assertCopy(source, target), { message: 'PRODUCTION_MIGRATION_COPY_MISMATCH' });
  });
}
const copyChanges: [string, (target: Snapshot) => void][] = [
  ['missing table', target => { target.tables.pop(); }],
  ['reordered tables', target => { target.tables.reverse(); }],
  ['changed per-table contents', target => { target.tableHashes[0] = hash('changed old row'); }],
  ['missing per-table hash', target => { target.tableHashes.pop(); }],
  ['changed row count', target => { target.summary.counts[0]++; }],
];
for (const [name, change] of copyChanges) {
  test(`assertCopy rejects ${name} even when aggregate hashes are unchanged`, () => {
    const source = copySnapshot(), target = structuredClone(source);
    change(target);
    assert.throws(() => assertCopy(source, target), { message: 'PRODUCTION_MIGRATION_COPY_MISMATCH' });
  });
}

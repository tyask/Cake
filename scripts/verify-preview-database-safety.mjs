import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewDatabaseIdentity, previewDatabaseGuardSql } from '../lib/database-connection.mjs';
import { PREVIEW_FIXTURE_GUARD_REVISION, PREVIEW_FIXTURE_SCHEMA_SHA256, previewFixtureCatalogFingerprintSql } from '../lib/preview-fixture-base.mjs';
import { setupDatabase } from './setup-db.mjs';
import { seedTestUsers, testSeedSql } from './seed-test-users.ts';

// Optional, local-only PostgreSQL WASM validation. It never loads env files,
// constructs a Neon client, or connects to a configured database. Install
// PGlite outside the repository and point to its dist/index.js module.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--pglite-module' || !args[1]) {
  console.error('Usage: node --import tsx scripts/verify-preview-database-safety.mjs --pglite-module /absolute/path/to/pglite/dist/index.js');
  process.exit(1);
}
const moduleUrl = pathToFileURL(resolve(args[1]));
const { PGlite } = await import(moduleUrl.href);
const { pgcrypto } = await import(new URL('contrib/pgcrypto.js', moduleUrl).href);

const db = new PGlite({ extensions: { pgcrypto } });
let memoryDatabases = 1;
const databaseName = (await db.query('SELECT current_database() AS name')).rows[0].name;
const environment = {
  VERCEL_ENV: 'preview', AUTH_MODE: 'test', VERCEL_GIT_COMMIT_REF: 'codex/sql-review', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
  CAKE_PREVIEW_REPOSITORY: "tyask/Cake", CAKE_PREVIEW_PHASE: "application", CAKE_PREVIEW_DATABASE_BRANCH_ID: "br-preview", CAKE_PREVIEW_PR: '34', CAKE_PREVIEW_GENERATION: '00000000-0000-4000-8000-000000000001',
  CAKE_PREVIEW_SOURCE_BRANCH: 'codex/sql-review', CAKE_PREVIEW_SOURCE_SHA: 'a'.repeat(40),
  CAKE_PREVIEW_DATABASE_HOST_SHA256: createHash('sha256').update('ep-test.ap-southeast-1.aws.neon.tech').digest('hex'),
  CAKE_PREVIEW_PRODUCTION_HOST_SHA256: createHash('sha256').update('ep-production.ap-southeast-1.aws.neon.tech').digest('hex'),
  CAKE_TEST_DATABASE_URL: `postgresql://fake:fake@ep-test.ap-southeast-1.aws.neon.tech/${databaseName}`,
};
const identity = previewDatabaseIdentity(environment);
const outcomes = [];
async function check(name, run) {
  try { await run(); outcomes.push({ name, result: 'PASS' }); }
  catch (error) { outcomes.push({ name, result: 'FAIL' }); throw error; }
}
async function rolledBack(run) {
  await db.exec('BEGIN');
  try { await run(); } finally { await db.exec('ROLLBACK'); }
}
async function scalar(sql, database = db) { return Object.values((await database.query(sql)).rows[0])[0]; }
async function fixtureSnapshot(database = db) {
  return JSON.stringify((await database.query(`SELECT jsonb_build_object(
    'users',(SELECT jsonb_agg(t ORDER BY id) FROM app_users t),
    'workspaces',(SELECT jsonb_agg(t ORDER BY id) FROM workspaces t),
    'members',(SELECT jsonb_agg(t ORDER BY workspace_id,user_id) FROM workspace_members t),
    'transactions',(SELECT jsonb_agg(t ORDER BY id) FROM transactions t),
    'identity',(SELECT jsonb_agg(t) FROM cake_preview_database_identity t)) AS snapshot`)).rows);
}
// This snapshot is independent of the guard's expected-schema manifest. It
// records the actual catalog and every table row before a rejected first claim.
async function databaseSnapshot(database, omitIdentity = false) {
  const schemas = "n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'";
  const identity = omitIdentity ? "AND c.relname <> 'cake_preview_database_identity' AND c.relname <> 'cake_preview_database_identity_pkey'" : '';
  const catalog = (await database.query(`SELECT jsonb_build_object(
    'schemas',(SELECT jsonb_agg(n.nspname ORDER BY n.nspname) FROM pg_namespace n WHERE ${schemas}),
    'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.reloptions,c.relrowsecurity,c.relforcerowsecurity) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${schemas} ${identity}),
    'columns',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY n.nspname,c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE ${schemas} AND a.attnum>0 AND NOT a.attisdropped ${identity}),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY n.nspname,c.relname,k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${schemas} ${identity}),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,pg_get_indexdef(i.indexrelid)) ORDER BY n.nspname,c.relname) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${schemas} ${identity}),
    'triggers',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${schemas} ${identity}),
    'routines',(SELECT jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid)) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${schemas}),
    'types',(SELECT jsonb_agg(jsonb_build_array(n.nspname,t.typname,t.typtype) ORDER BY n.nspname,t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${schemas} ${omitIdentity ? "AND t.typname NOT IN ('cake_preview_database_identity','_cake_preview_database_identity')" : ''}),
    'extensions',(SELECT jsonb_agg(jsonb_build_array(e.extname,e.extversion,n.nspname) ORDER BY e.extname) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace),
    'extension_relations',(SELECT jsonb_agg(jsonb_build_array(e.extname,n.nspname,c.relname) ORDER BY e.extname,n.nspname,c.relname) FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid JOIN pg_class c ON c.oid=d.objid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE d.classid='pg_class'::regclass AND d.refclassid='pg_extension'::regclass AND d.deptype='e')
  ) AS catalog`)).rows;
  const tables = (await database.query(`SELECT n.nspname AS schema_name,c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${schemas} AND c.relkind IN ('r','p') ${identity} ORDER BY n.nspname,c.relname`)).rows;
  const rows = [];
  for (const { schema_name: schema, table_name: table } of tables) {
    const quote = (value) => `"${value.replaceAll('"', '""')}"`;
    rows.push({ schema, table, data: (await database.query(`SELECT to_jsonb(t) AS row FROM ${quote(schema)}.${quote(table)} t ORDER BY to_jsonb(t)::text`)).rows });
  }
  return JSON.stringify({ catalog, rows });
}
async function rejectedWithoutChanges(database, statement, rejection) {
  const before = await databaseSnapshot(database);
  await database.exec('SAVEPOINT review_first_claim');
  try { await assert.rejects(database.query(statement), rejection); }
  finally { await database.exec('ROLLBACK TO SAVEPOINT review_first_claim; RELEASE SAVEPOINT review_first_claim'); }
  assert.equal(await databaseSnapshot(database), before, 'A rejected claim must retain every inherited object and row');
  assert.equal(await scalar("SELECT to_regclass('public.cake_preview_database_identity') IS NULL", database), true);
}
async function assertFixtures(database, emails, administrator) {
  assert.deepEqual((await database.query(`SELECT id,email,name,image_url,is_admin,is_enabled FROM app_users ORDER BY id`)).rows, [
    { id: 'test-user-a', email: emails[0], name: 'テストユーザーA', image_url: null, is_admin: administrator, is_enabled: true },
    { id: 'test-user-b', email: emails[1], name: 'テストユーザーB', image_url: null, is_admin: false, is_enabled: true },
  ]);
  assert.deepEqual((await database.query('SELECT id,name,type,owner_user_id FROM workspaces ORDER BY id')).rows, [
    { id: '00000000-0000-4000-8000-000000000001', name: 'テスト共有家計', type: 'SHARED', owner_user_id: 'test-user-a' },
  ]);
  assert.deepEqual((await database.query('SELECT workspace_id,user_id,role,weight FROM workspace_members ORDER BY workspace_id,user_id')).rows, [
    { workspace_id: '00000000-0000-4000-8000-000000000001', user_id: 'test-user-a', role: 'OWNER', weight: 1 },
    { workspace_id: '00000000-0000-4000-8000-000000000001', user_id: 'test-user-b', role: 'MEMBER', weight: 1 },
  ]);
}
try {
  await check('Marker missing fails closed', async () => {
    await assert.rejects(db.query(previewDatabaseGuardSql(identity, false)), /identity is missing/);
    assert.equal(await scalar("SELECT to_regclass('public.cake_preview_database_identity') IS NULL"), true);
  });
  for (const [name, statement] of [
    ['Empty inherited app schema rejects', 'CREATE TABLE app_users (id text PRIMARY KEY)'],
    ['Unknown schema table rejects', 'CREATE SCHEMA other; CREATE TABLE other.unknown (id integer)'],
    ['Inherited routine rejects', 'CREATE FUNCTION inherited() RETURNS integer LANGUAGE SQL AS $$ SELECT 1 $$'],
    ['Inherited enum rejects', "CREATE TYPE inherited AS ENUM ('a')"],
    ['Extension-owned inherited table rejects', 'CREATE EXTENSION pgcrypto; CREATE TABLE inherited (id integer); ALTER EXTENSION pgcrypto ADD TABLE inherited'],
  ]) {
    await check(name, () => rolledBack(async () => {
      await db.exec(statement);
      await assert.rejects(db.query(previewDatabaseGuardSql(identity, true)), /requires a new empty database/);
    }));
    assert.equal(await scalar("SELECT to_regclass('public.cake_preview_database_identity') IS NULL"), true);
  }
  await check('Empty DB claim and same identity reuse', async () => {
    await db.query(previewDatabaseGuardSql(identity, true));
    await db.query(previewDatabaseGuardSql(identity, true));
    await db.query(previewDatabaseGuardSql(identity, false));
    assert.equal(await scalar('SELECT COUNT(*)::int FROM cake_preview_database_identity'), 1);
  });
  for (const [name, change] of [
    ['Copied marker rejects endpoint mismatch', { databaseHost: 'ep-other.ap-southeast-1.aws.neon.tech' }],
    ['DB name mismatch rejects', { databaseName: 'other' }],
    ['Repository mismatch rejects', { repository: 'other/repo' }],
    ['PR mismatch rejects', { pr: 35 }],
    ['Generation mismatch rejects', { generation: '00000000-0000-4000-8000-000000000002' }],
    ['Source branch mismatch rejects', { sourceBranch: 'codex/other' }],
  ]) {
    await check(name, async () => { await assert.rejects(db.query(previewDatabaseGuardSql({ ...identity, ...change }, false)), /identity mismatch/); });
  }
  await check('All real migrations execute and Preview omits production administrator', async () => {
    await setupDatabase(environment, { connect: () => ({ query: (sql) => db.query(sql) }) });
    assert.equal(await scalar('SELECT COUNT(*)::int FROM schema_migrations'), 11);
    assert.equal(await scalar('SELECT COUNT(*)::int FROM app_users'), 0);
  });
  await check('Business data before initial seed rejects without marker completion', async () => {
    await db.exec("INSERT INTO app_users (id,email,name) VALUES ('unexpected','unexpected@example.test','unexpected')");
    await assert.rejects(db.query(testSeedSql(environment)), /initial data is not empty/);
    assert.equal(await scalar('SELECT seeded_at IS NULL FROM cake_preview_database_identity'), true);
    assert.equal(await scalar('SELECT COUNT(*)::int FROM app_users'), 1);
    await db.exec("DELETE FROM app_users WHERE id='unexpected'");
  });
  await check('Unknown populated table before initial seed rejects', async () => {
    await db.exec('CREATE TABLE unknown_data (id integer); INSERT INTO unknown_data VALUES (1)');
    await assert.rejects(db.query(testSeedSql(environment)), /initial data is not empty/);
    assert.equal(await scalar('SELECT seeded_at IS NULL FROM cake_preview_database_identity'), true);
    assert.equal(await scalar('SELECT COUNT(*)::int FROM app_users'), 0);
    await db.exec('DROP TABLE unknown_data');
  });
  await check('Seed failure after inserts rolls back all fixtures and marker', async () => {
    await db.exec(`CREATE FUNCTION review_fail_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='test-user-b' THEN RAISE EXCEPTION 'review inserted-member failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER review_fail_member BEFORE INSERT ON workspace_members FOR EACH ROW EXECUTE FUNCTION review_fail_member()`);
    await assert.rejects(db.query(testSeedSql(environment)), /review inserted-member failure/);
    assert.equal(await scalar('SELECT COUNT(*)::int FROM app_users'), 0);
    assert.equal(await scalar('SELECT COUNT(*)::int FROM workspaces'), 0);
    assert.equal(await scalar('SELECT COUNT(*)::int FROM workspace_members'), 0);
    assert.equal(await scalar('SELECT seeded_at IS NULL FROM cake_preview_database_identity'), true);
    await db.exec('DROP TRIGGER review_fail_member ON workspace_members; DROP FUNCTION review_fail_member()');
  });
  await check('Initial QA seed has exact users, administrator flags, workspace and members', async () => {
    await db.query(testSeedSql(environment));
    assert.equal(await scalar('SELECT COUNT(*)::int FROM app_users'), 2);
    assert.equal(await scalar('SELECT COUNT(*)::int FROM workspaces'), 1);
    assert.equal(await scalar('SELECT COUNT(*)::int FROM workspace_members'), 2);
    await assertFixtures(db, ['test-a@cake.local', 'test-b@cake.local'], true);
    assert.equal(await scalar('SELECT seeded_at IS NOT NULL FROM cake_preview_database_identity'), true);
    assert.equal(await scalar('SELECT revision::text FROM app_user_access_guard'), '0');
  });
  await check('Same PR redeploy keeps profile, flags, workspace, member and transactions', async () => {
    await db.exec(`UPDATE app_users SET name='edited user', is_admin=false, is_enabled=false WHERE id='test-user-a';
      UPDATE app_users SET is_admin=true WHERE id='test-user-b';
      UPDATE workspaces SET name='edited workspace';
      UPDATE workspace_members SET role='MEMBER',weight=7 WHERE user_id='test-user-a';
      INSERT INTO transactions (workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,expense_class,external_id,created_by,updated_by,split_weights)
      SELECT id,now(),'edited transaction','cash','PAYMENT',123,'test-user-a','SHARED','review-preserved','test-user-a','test-user-a','{"test-user-a":7,"test-user-b":1}'::jsonb FROM workspaces`);
    const before = await fixtureSnapshot();
    const redeploy = { ...environment, CAKE_PREVIEW_SOURCE_SHA: 'b'.repeat(40), VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) };
    await setupDatabase(redeploy, { connect: () => ({ query: (sql) => db.query(sql) }) });
    await db.query(testSeedSql(redeploy));
    assert.equal(await fixtureSnapshot(), before);
  });
  await check('Local seed preserves administrator flags and edits in the seeded QA database', async () => {
    const before = await fixtureSnapshot();
    await db.query(testSeedSql({}));
    assert.equal(await fixtureSnapshot(), before);
  });
  // The legacy local profile has its own memory DB. Apply Preview migrations
  // here as well so the production bootstrap is never part of these fixtures.
  const localDb = new PGlite({ extensions: { pgcrypto } });
  memoryDatabases += 1;
  try {
    const localDatabaseName = await scalar('SELECT current_database() AS name', localDb);
    const localEnvironment = { ...environment, CAKE_TEST_DATABASE_URL: `postgresql://fake:fake@ep-test.ap-southeast-1.aws.neon.tech/${localDatabaseName}` };
    await check('Legacy local seed has exact non-administrator fixtures in a separate empty DB', async () => {
      await setupDatabase(localEnvironment, { connect: () => ({ query: (sql) => localDb.query(sql) }) });
      assert.equal(await scalar('SELECT COUNT(*)::int FROM schema_migrations', localDb), 11);
      assert.equal(await scalar('SELECT COUNT(*)::int FROM app_users', localDb), 0);
      await localDb.query(testSeedSql({}));
      await assertFixtures(localDb, ['test-a@cake.local', 'test-b@cake.local'], false);
      assert.equal(await scalar('SELECT seeded_at IS NULL FROM cake_preview_database_identity', localDb), true);
    });
    await check('QA profile cannot initialize a database containing legacy local fixtures', async () => {
      const before = await fixtureSnapshot(localDb);
      await assert.rejects(localDb.query(testSeedSql(localEnvironment)), /initial data is not empty/);
      assert.equal(await fixtureSnapshot(localDb), before);
    });
    await check('Local seed repeats without membership trigger failures or resetting fixtures', async () => {
      await localDb.exec(`UPDATE app_users SET name='edited local user', is_enabled=false WHERE id='test-user-a';
        UPDATE workspaces SET name='edited local workspace';
        UPDATE workspace_members SET role='MEMBER',weight=7 WHERE user_id='test-user-a';
        INSERT INTO transactions (workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,expense_class,external_id,created_by,updated_by,split_weights)
        SELECT id,now(),'edited local transaction','cash','PAYMENT',123,'test-user-a','SHARED','local-review-preserved','test-user-a','test-user-a','{"test-user-a":7,"test-user-b":1}'::jsonb FROM workspaces`);
      const before = await fixtureSnapshot(localDb);
      await localDb.query(testSeedSql({}));
      await localDb.query(testSeedSql({}));
      assert.equal(await scalar('SELECT COUNT(*)::int FROM app_users WHERE is_admin', localDb), 0);
      assert.equal(await fixtureSnapshot(localDb), before);
    });
  } finally { await localDb.close(); }
  // Model the approved Native parent through the actual migrations and QA seed,
  // then remove the Preview marker. Revision 4 is the read-only observed
  // parent value; a fresh empty database keeps its original revision 0 path.
  const inheritedDb = new PGlite({ extensions: { pgcrypto } });
  memoryDatabases += 1;
  try {
    const inheritedEnvironment = { ...environment, CAKE_TEST_DATABASE_URL: `postgresql://fake:fake@ep-test.ap-southeast-1.aws.neon.tech/${await scalar('SELECT current_database()', inheritedDb)}` };
    const inheritedIdentity = previewDatabaseIdentity(inheritedEnvironment);
    await setupDatabase(inheritedEnvironment, { connect: () => ({ query: (sql) => inheritedDb.query(sql) }) });
    await inheritedDb.query(testSeedSql(inheritedEnvironment));
    await inheritedDb.exec(`DROP TABLE cake_preview_database_identity; UPDATE app_user_access_guard SET revision=${PREVIEW_FIXTURE_GUARD_REVISION}`);
    await assertFixtures(inheritedDb, ['test-a@cake.local', 'test-b@cake.local'], true);
    assert.equal(await scalar('SELECT COUNT(*)::int FROM schema_migrations', inheritedDb), 11);
    await inheritedDb.exec('BEGIN; SET LOCAL search_path=pg_catalog,public');
    try { assert.equal(await scalar(previewFixtureCatalogFingerprintSql(), inheritedDb), PREVIEW_FIXTURE_SCHEMA_SHA256); }
    finally { await inheritedDb.exec('ROLLBACK'); }
    for (const [name, change] of [
      ['Fixture base with an extra user rejects', "INSERT INTO app_users (id,email,name) VALUES ('extra-user','extra@cake.local','extra')"],
      ['Fixture base with a real email rejects', `UPDATE app_users SET email='person@example.com' WHERE id='test-user-a'; UPDATE app_user_access_guard SET revision=${PREVIEW_FIXTURE_GUARD_REVISION}`],
      ['Fixture base with A demoted rejects', "UPDATE app_users SET is_admin=false WHERE id='test-user-a'"],
      ['Fixture base with B promoted rejects', "UPDATE app_users SET is_admin=true WHERE id='test-user-b'"],
      ['Fixture base with a disabled user rejects', "UPDATE app_users SET is_enabled=false WHERE id='test-user-a'"],
      ['Fixture base with a renamed fixture rejects', "UPDATE app_users SET name='renamed fixture' WHERE id='test-user-b'"],
      ['Fixture base with a profile image rejects', "UPDATE app_users SET image_url='https://example.test/image' WHERE id='test-user-a'"],
      ['Fixture base with a renamed workspace rejects', "UPDATE workspaces SET name='renamed workspace'"],
      ['Fixture base with a different workspace owner rejects', "UPDATE workspaces SET owner_user_id='test-user-b'"],
      ['Fixture base with an extra workspace rejects', "INSERT INTO workspaces (id,name,type,owner_user_id) VALUES ('00000000-0000-4000-8000-000000000002','extra','SHARED','test-user-a')"],
      ['Fixture base with a wrong membership role rejects', "UPDATE workspace_members SET role='MEMBER' WHERE user_id='test-user-a'"],
      ['Fixture base with a wrong membership weight rejects', "UPDATE workspace_members SET weight=2 WHERE user_id='test-user-b'"],
      ['Fixture base with a missing membership rejects', "DELETE FROM workspace_members WHERE user_id='test-user-b'"],
      ['Fixture base with a changed guard revision rejects', 'UPDATE app_user_access_guard SET revision=5'],
      ['Fixture base with a missing guard row rejects', 'DELETE FROM app_user_access_guard'],
      ['Fixture base with a missing migration rejects', "DELETE FROM schema_migrations WHERE name='011_recurring_payment_next_scheduled_on.sql'"],
      ['Fixture base with an unknown migration rejects', "INSERT INTO schema_migrations (name) VALUES ('012_unknown.sql')"],
      ['Fixture base with a transaction rejects', `INSERT INTO transactions (workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,expense_class,external_id,created_by,updated_by,split_weights)
        SELECT id,now(),'inherited financial data','cash','PAYMENT',123,'test-user-a','SHARED','inherited-review','test-user-a','test-user-a','{"test-user-a":1,"test-user-b":1}'::jsonb FROM workspaces`],
      ['Fixture base with an invitation rejects', `INSERT INTO invitations (workspace_id,email,token_hash,invited_by,expires_at)
        SELECT id,'invite@cake.local','review-invite','test-user-a',now()+interval '1 day' FROM workspaces`],
      ['Fixture base with an import batch rejects', `INSERT INTO import_batches (workspace_id,imported_by,file_name,total_rows,imported_rows,skipped_rows)
        SELECT id,'test-user-a','review.csv',1,0,1 FROM workspaces`],
      ['Fixture base with a default rule rejects', `INSERT INTO default_rules (workspace_id,merchant_contains,expense_class,created_by,sort_order,split_weights)
        SELECT id,'inherited rule','SHARED','test-user-a',0,'{"test-user-a":1,"test-user-b":1}'::jsonb FROM workspaces`],
      ['Fixture base with a recurring payment rejects', `INSERT INTO recurring_payments (workspace_id,day_of_month,merchant,method,amount_yen,actor_user_id,expense_class,split_weights,next_scheduled_on,authorized_by,created_by,updated_by)
        SELECT id,1,'inherited recurring payment','cash',123,'test-user-a','SHARED','{"test-user-a":1,"test-user-b":1}'::jsonb,DATE '2030-01-01','test-user-a','test-user-a','test-user-a' FROM workspaces`],
      ['Fixture base with a settlement rejects', `INSERT INTO settlements (id,workspace_id,amount_yen,weight_snapshot,calculation_snapshot,completed_by)
        SELECT '00000000-0000-4000-8000-000000000010'::uuid,id,0,'{}'::jsonb,'{}'::jsonb,'test-user-a' FROM workspaces`],
      ['Fixture base with an extra column rejects', 'ALTER TABLE app_users ADD COLUMN inherited text'],
      ['Fixture base with a changed column default rejects', 'ALTER TABLE app_users ALTER COLUMN is_admin SET DEFAULT true'],
      ['Fixture base with a missing constraint rejects', 'ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_weight_check'],
      ['Fixture base with a missing index rejects', 'DROP INDEX transactions_workspace_date_idx'],
      ['Fixture base with a disabled trigger rejects', 'ALTER TABLE app_users DISABLE TRIGGER enabled_user_limit_trigger'],
      ['Fixture base with a changed routine rejects', 'CREATE OR REPLACE FUNCTION cake_recurring_config_valid(config jsonb) RETURNS boolean LANGUAGE SQL IMMUTABLE AS $$ SELECT true $$'],
      ['Fixture base with an unknown routine rejects', 'CREATE FUNCTION inherited() RETURNS integer LANGUAGE SQL AS $$ SELECT 1 $$'],
      ['Fixture base with an unknown enum rejects', "CREATE TYPE inherited AS ENUM ('a')"],
      ['Fixture base with an unknown empty table rejects', 'CREATE TABLE inherited (id integer)'],
      ['Fixture base with an unknown populated table rejects', 'CREATE TABLE inherited (id integer); INSERT INTO inherited VALUES (1)'],
      ['Fixture base with a foreign schema table rejects', 'CREATE SCHEMA other; CREATE TABLE other.inherited (id integer); INSERT INTO other.inherited VALUES (1)'],
      ['Fixture base with missing pgcrypto rejects', 'DROP EXTENSION pgcrypto'],
      // Only this local memory database's extension metadata is changed. These
      // single-field cases isolate extension pinning from member-object checks.
      ['Fixture base with an unknown pgcrypto version rejects', "UPDATE pg_extension SET extversion='review-unknown' WHERE extname='pgcrypto'"],
      ['Fixture base with a different pgcrypto schema rejects', "UPDATE pg_extension SET extnamespace='pg_catalog'::regnamespace WHERE extname='pgcrypto'"],
      ['Fixture base with an extension-owned empty table rejects', 'CREATE TABLE inherited (id integer); ALTER EXTENSION pgcrypto ADD TABLE inherited'],
      ['Fixture base with extension-owned data rejects', 'CREATE TABLE inherited (id integer); INSERT INTO inherited VALUES (1); ALTER EXTENSION pgcrypto ADD TABLE inherited'],
    ]) {
      await check(name, async () => {
        await inheritedDb.exec('BEGIN');
        try {
          await inheritedDb.exec(change);
          await rejectedWithoutChanges(inheritedDb, previewDatabaseGuardSql(inheritedIdentity, true), /Cake Preview/);
        } finally { await inheritedDb.exec('ROLLBACK'); }
      });
    }
    await check('Approved fixture claim and caller failure roll back the new marker atomically', async () => {
      await inheritedDb.exec('BEGIN');
      try {
        await rejectedWithoutChanges(inheritedDb, previewDatabaseGuardSql(inheritedIdentity, true, "RAISE EXCEPTION 'review claim rollback';"), /review claim rollback/);
      } finally { await inheritedDb.exec('ROLLBACK'); }
    });
    await check('Approved canonical fixture base claims a seeded Preview without repairing inherited rows', async () => {
      const before = await databaseSnapshot(inheritedDb, true);
      await setupDatabase(inheritedEnvironment, { connect: () => ({ query: (sql) => inheritedDb.query(sql) }) });
      await inheritedDb.query(testSeedSql(inheritedEnvironment));
      assert.equal(await databaseSnapshot(inheritedDb, true), before);
      assert.equal(await scalar('SELECT COUNT(*)::int FROM cake_preview_database_identity', inheritedDb), 1);
      assert.equal(await scalar('SELECT seeded_at IS NOT NULL FROM cake_preview_database_identity', inheritedDb), true);
      assert.deepEqual((await inheritedDb.query('SELECT version,repository,pr,source_branch,generation,branch_id,database_host,database_name FROM cake_preview_database_identity')).rows, [{
        version: 2, repository: inheritedIdentity.repository, pr: inheritedIdentity.pr, source_branch: inheritedIdentity.sourceBranch,
        generation: inheritedIdentity.generation, branch_id: inheritedIdentity.branchId, database_host: inheritedIdentity.databaseHost, database_name: inheritedIdentity.databaseName,
      }]);
    });
    await check('A foreign Preview generation cannot claim the canonical fixture base with an existing marker', async () => {
      const before = await databaseSnapshot(inheritedDb);
      await assert.rejects(inheritedDb.query(previewDatabaseGuardSql({ ...inheritedIdentity, generation: '00000000-0000-4000-8000-000000000002' }, true)), /identity mismatch/);
      assert.equal(await databaseSnapshot(inheritedDb), before);
    });
    await check('Claimed fixture base keeps disable, demotion, renamed fixtures and financial edits on same PR setup and seed', async () => {
      await inheritedDb.exec(`UPDATE app_users SET name='edited base user',is_admin=false,is_enabled=false WHERE id='test-user-a';
        UPDATE workspaces SET name='edited base workspace';
        UPDATE workspace_members SET role='MEMBER',weight=7 WHERE user_id='test-user-a';
        INSERT INTO transactions (workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,expense_class,external_id,created_by,updated_by,split_weights)
        SELECT id,now(),'edited base transaction','cash','PAYMENT',456,'test-user-a','SHARED','base-preserved','test-user-a','test-user-a','{"test-user-a":7,"test-user-b":1}'::jsonb FROM workspaces;
        UPDATE transactions SET amount_yen=789,memo='QA edit' WHERE external_id='base-preserved'`);
      const before = await databaseSnapshot(inheritedDb);
      const redeploy = { ...inheritedEnvironment, CAKE_PREVIEW_SOURCE_SHA: 'c'.repeat(40), VERCEL_GIT_COMMIT_SHA: 'c'.repeat(40) };
      await setupDatabase(redeploy, { connect: () => ({ query: (sql) => inheritedDb.query(sql) }) });
      await inheritedDb.query(testSeedSql(redeploy));
      await inheritedDb.query(testSeedSql(redeploy));
      assert.equal(await databaseSnapshot(inheritedDb), before);
    });
  } finally { await inheritedDb.close(); }
  const productionDb = new PGlite({ extensions: { pgcrypto } });
  memoryDatabases += 1;
  try {
    await check('Production setup retains the original bootstrap and seed refuses before a client is created', async () => {
      const productionEnvironment = { VERCEL_ENV: 'production', DATABASE_URL: 'postgresql://fake:fake@ep-production.ap-southeast-1.aws.neon.tech/production' };
      await setupDatabase(productionEnvironment, { connect: () => ({ query: (sql) => productionDb.query(sql) }) });
      const migration = readFileSync(new URL('../db/migrations/002_user_access.sql', import.meta.url), 'utf8');
      const bootstrapEmail = migration.match(/VALUES \(gen_random_uuid\(\)::text, '([^']+)'/)?.[1];
      assert.ok(bootstrapEmail);
      assert.deepEqual((await productionDb.query('SELECT email,name,is_admin,is_enabled FROM app_users')).rows, [{ email: bootstrapEmail, name: '管理者', is_admin: true, is_enabled: true }]);
      assert.equal(await scalar('SELECT COUNT(*)::int FROM schema_migrations', productionDb), 11);
      assert.equal(await scalar("SELECT to_regclass('public.cake_preview_database_identity') IS NULL", productionDb), true);
      const before = await databaseSnapshot(productionDb);
      let clients = 0;
      await assert.rejects(seedTestUsers(productionEnvironment, () => { clients++; return { query: (sql) => productionDb.query(sql) }; }), /Productionではテストデータを登録できません/);
      assert.equal(clients, 0);
      assert.equal(await databaseSnapshot(productionDb), before);
    });
  } finally { await productionDb.close(); }
  console.log(JSON.stringify({ engine: 'PGlite', databaseName, memoryDatabases, migrations: 11, cases: outcomes.length, outcomes }, null, 2));
} catch {
  console.log(JSON.stringify({ engine: 'PGlite', databaseName, memoryDatabases, cases: outcomes.length, outcomes, error: 'Local SQL validation failed; raw SQL error omitted.' }, null, 2));
  process.exitCode = 1;
} finally { await db.close(); }

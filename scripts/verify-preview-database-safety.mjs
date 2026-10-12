import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewDatabaseIdentity, previewDatabaseGuardSql } from '../lib/database-connection.mjs';
import { setupDatabase } from './setup-db.mjs';
import { testSeedSql } from './seed-test-users.ts';

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
  VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'codex/sql-review', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
  CAKE_QA_SLOT: 'qa1', CAKE_QA_PR: '34', CAKE_QA_LEASE_TOKEN: '00000000-0000-4000-8000-000000000001',
  CAKE_QA_SOURCE_BRANCH: 'codex/sql-review', CAKE_QA_SOURCE_SHA: 'a'.repeat(40),
  CAKE_QA_DATABASE_HOST: 'ep-test.ap-southeast-1.aws.neon.tech',
  CAKE_QA_PRODUCTION_DATABASE_HOST: 'ep-production.ap-southeast-1.aws.neon.tech',
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
    ['Slot mismatch rejects', { slot: 'qa2' }],
    ['PR mismatch rejects', { pr: 35 }],
    ['Lease mismatch rejects', { leaseToken: '00000000-0000-4000-8000-000000000002' }],
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
  });
  await check('Same PR redeploy keeps profile, flags, workspace, member and transactions', async () => {
    await db.exec(`UPDATE app_users SET name='edited user', is_admin=false, is_enabled=false WHERE id='test-user-a';
      UPDATE app_users SET is_admin=true WHERE id='test-user-b';
      UPDATE workspaces SET name='edited workspace';
      UPDATE workspace_members SET role='MEMBER',weight=7 WHERE user_id='test-user-a';
      INSERT INTO transactions (workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,expense_class,external_id,created_by,updated_by,split_weights)
      SELECT id,now(),'edited transaction','cash','PAYMENT',123,'test-user-a','SHARED','review-preserved','test-user-a','test-user-a','{"test-user-a":7,"test-user-b":1}'::jsonb FROM workspaces`);
    const before = await fixtureSnapshot();
    const redeploy = { ...environment, CAKE_QA_SOURCE_SHA: 'b'.repeat(40), VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) };
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
  console.log(JSON.stringify({ engine: 'PGlite', databaseName, memoryDatabases, migrations: 11, cases: outcomes.length, outcomes }, null, 2));
} catch {
  console.log(JSON.stringify({ engine: 'PGlite', databaseName, memoryDatabases, cases: outcomes.length, outcomes, error: 'Local SQL validation failed; raw SQL error omitted.' }, null, 2));
  process.exitCode = 1;
} finally { await db.close(); }

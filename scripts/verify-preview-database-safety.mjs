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
async function scalar(sql) { return Object.values((await db.query(sql)).rows[0])[0]; }
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
  await check('Initial seed succeeds', async () => {
    await db.query(testSeedSql(environment));
    assert.equal(await scalar('SELECT COUNT(*)::int FROM app_users'), 2);
    assert.equal(await scalar('SELECT COUNT(*)::int FROM workspaces'), 1);
    assert.equal(await scalar('SELECT COUNT(*)::int FROM workspace_members'), 2);
    assert.equal(await scalar('SELECT seeded_at IS NOT NULL FROM cake_preview_database_identity'), true);
  });
  await check('Same PR redeploy keeps profile, flags, workspace, member and transactions', async () => {
    await db.exec(`UPDATE app_users SET name='edited user', is_enabled=false WHERE id='test-user-a';
      UPDATE workspaces SET name='edited workspace';
      UPDATE workspace_members SET role='MEMBER',weight=7 WHERE user_id='test-user-a';
      INSERT INTO transactions (workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,expense_class,external_id,created_by,updated_by,split_weights)
      SELECT id,now(),'edited transaction','cash','PAYMENT',123,'test-user-a','SHARED','review-preserved','test-user-a','test-user-a','{"test-user-a":7,"test-user-b":1}'::jsonb FROM workspaces`);
    const snapshot = async () => JSON.stringify((await db.query(`SELECT jsonb_build_object('users',(SELECT jsonb_agg(t ORDER BY id) FROM app_users t),
      'workspaces',(SELECT jsonb_agg(t ORDER BY id) FROM workspaces t),
      'members',(SELECT jsonb_agg(t ORDER BY workspace_id,user_id) FROM workspace_members t),
      'transactions',(SELECT jsonb_agg(t ORDER BY id) FROM transactions t),
      'identity',(SELECT jsonb_agg(t) FROM cake_preview_database_identity t)) AS snapshot`)).rows);
    const before = await snapshot();
    const redeploy = { ...environment, CAKE_QA_SOURCE_SHA: 'b'.repeat(40), VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) };
    await setupDatabase(redeploy, { connect: () => ({ query: (sql) => db.query(sql) }) });
    await db.query(testSeedSql(redeploy));
    assert.equal(await snapshot(), before);
  });
  await check('Local seed repeats without membership trigger failures or resetting fixtures', async () => {
    const before = JSON.stringify((await db.query(`SELECT jsonb_build_object(
      'users',(SELECT jsonb_agg(t ORDER BY id) FROM app_users t),
      'workspaces',(SELECT jsonb_agg(t ORDER BY id) FROM workspaces t),
      'members',(SELECT jsonb_agg(t ORDER BY workspace_id,user_id) FROM workspace_members t)) AS snapshot`)).rows);
    await db.query(testSeedSql({}));
    const after = JSON.stringify((await db.query(`SELECT jsonb_build_object(
      'users',(SELECT jsonb_agg(t ORDER BY id) FROM app_users t),
      'workspaces',(SELECT jsonb_agg(t ORDER BY id) FROM workspaces t),
      'members',(SELECT jsonb_agg(t ORDER BY workspace_id,user_id) FROM workspace_members t)) AS snapshot`)).rows);
    assert.equal(after, before);
  });
  console.log(JSON.stringify({ engine: 'PGlite', databaseName, migrations: 11, outcomes }, null, 2));
} catch {
  console.log(JSON.stringify({ engine: 'PGlite', databaseName, outcomes, error: 'Local SQL validation failed; raw SQL error omitted.' }, null, 2));
  process.exitCode = 1;
} finally { await db.close(); }

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { setupDatabase } from "../../scripts/db/setup-db.mjs";
import { seedTestUsers, testSeedSql } from "../../scripts/db/seed-test-users";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("Previewの初期サンプルは空の家計へ一度だけ入り、既存データと利用者の変更を保持する", async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  const databaseName = (await db.query<{ name: string }>("SELECT current_database() AS name")).rows[0].name;
  const environment = {
    VERCEL_ENV: "preview", AUTH_MODE: "test", CAKE_PREVIEW_PHASE: "application",
    CAKE_PREVIEW_REPOSITORY: "tyask/Cake", CAKE_PREVIEW_PR: "34",
    CAKE_PREVIEW_GENERATION: "00000000-0000-4000-8000-000000000002", CAKE_PREVIEW_DATABASE_BRANCH_ID: "br-samples",
    CAKE_PREVIEW_SOURCE_BRANCH: "codex/sample-test", VERCEL_GIT_COMMIT_REF: "codex/sample-test",
    CAKE_PREVIEW_SOURCE_SHA: "a".repeat(40), VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
    CAKE_TEST_DATABASE_URL: `postgresql://fixture:fixture@ep-samples.ap-southeast-1.aws.neon.tech/${databaseName}`,
    CAKE_PREVIEW_DATABASE_HOST_SHA256: hash("ep-samples.ap-southeast-1.aws.neon.tech"),
    CAKE_PREVIEW_PRODUCTION_HOST_SHA256: hash("ep-production.ap-southeast-1.aws.neon.tech"),
  };
  const connect = () => ({ query: (statement: string) => db.query(statement) });
  await setupDatabase(environment, { connect });
  const seed = () => db.query(testSeedSql(environment));
  const counts = async () => (await db.query<{ categories: number; transactions: number }>(`SELECT
    (SELECT count(*)::int FROM categories) AS categories,
    (SELECT count(*)::int FROM transactions) AS transactions`)).rows[0];
  const marker = async () => (await db.query<{ users: boolean; samples: boolean }>(`SELECT
    seeded_at IS NOT NULL AS users, samples_seeded_at IS NOT NULL AS samples FROM cake_preview_database_identity`)).rows[0];
  const snapshot = async () => (await db.query<{ data: unknown }>(`SELECT jsonb_build_object(
    'users', (SELECT jsonb_agg(u ORDER BY id) FROM app_users u),
    'workspaces', (SELECT jsonb_agg(w ORDER BY id) FROM workspaces w),
    'members', (SELECT jsonb_agg(m ORDER BY workspace_id,user_id) FROM workspace_members m),
    'categories', (SELECT jsonb_agg(c ORDER BY id) FROM categories c),
    'transactions', (SELECT jsonb_agg(t ORDER BY id) FROM transactions t),
    'access', (SELECT jsonb_agg(g) FROM app_user_access_guard g)
  ) AS data`)).rows[0].data;
  const core = () => db.exec(`INSERT INTO app_users(id,email,name,is_admin,is_enabled) VALUES
    ('test-user-a','test-a@cake.local','テストユーザーA',true,true),
    ('test-user-b','test-b@cake.local','テストユーザーB',false,true);
    INSERT INTO workspaces(id,name,type,owner_user_id)
      VALUES ('${workspaceId}','テスト共有家計','SHARED','test-user-a');
    INSERT INTO workspace_members(workspace_id,user_id,role,weight) VALUES
      ('${workspaceId}','test-user-a','OWNER',1), ('${workspaceId}','test-user-b','MEMBER',1);
    UPDATE cake_preview_database_identity SET seeded_at=now()`);
  const scenario = (name: string, run: () => Promise<void>) => t.test(name, async () => {
    await db.exec("BEGIN");
    try { await run(); } finally { await db.exec("ROLLBACK"); }
  });

  await scenario("空DBには階層カテゴリ10件と当月の架空明細8件を一括登録する", async () => {
    await seed();
    assert.deepEqual(await counts(), { categories: 10, transactions: 8 });
    assert.deepEqual(await marker(), { users: true, samples: true });
    const paths = await db.query<{ path: string }>(`WITH RECURSIVE tree AS (
      SELECT id,name AS path FROM categories WHERE parent_id IS NULL
      UNION ALL SELECT c.id,tree.path || ' / ' || c.name FROM categories c JOIN tree ON c.parent_id=tree.id
    ) SELECT path FROM tree ORDER BY path COLLATE "C"`);
    assert.deepEqual(paths.rows.map(row => row.path).sort(), [
      "食費", "食費 / 食料品", "食費 / 食料品 / スーパー", "食費 / 外食", "暮らし", "暮らし / 日用品", "暮らし / 光熱費", "交通", "趣味", "収入",
    ].sort());
    assert.equal((await db.query<{ valid: boolean }>(`SELECT bool_and(
      workspace_id='${workspaceId}'::uuid AND archived_at IS NULL AND revision=1
      AND color_hex ~ '^#[0-9a-f]{6}$') AS valid FROM categories`)).rows[0].valid, true);
    const transactions = (await db.query<{
      merchant: string; external_id: string; source: string; settled_at: string | null; type: string;
      actor_user_id: string; expense_class: string; category_id: string | null;
      category_confirmed: boolean; category_revision: number; split_weights: Record<string, number>;
      month: boolean; japan_time: string;
    }>(`SELECT *,date_trunc('month',occurred_at AT TIME ZONE 'Asia/Tokyo') =
      date_trunc('month',now() AT TIME ZONE 'Asia/Tokyo') AS month,
      to_char(occurred_at AT TIME ZONE 'Asia/Tokyo','DD HH24:MI') AS japan_time FROM transactions`)).rows;
    assert.equal(transactions.filter(row => row.category_id === null).length, 1);
    assert.equal(transactions.filter(row => row.type === "RECEIPT").length, 1);
    assert.equal(transactions.filter(row => row.expense_class === "PERSONAL").length, 2);
    assert.deepEqual(new Set(transactions.map(row => row.actor_user_id)), new Set(["test-user-a", "test-user-b"]));
    assert.ok(transactions.some(row => row.expense_class === "SHARED"
      && row.split_weights["test-user-a"] === 3 && row.split_weights["test-user-b"] === 2));
    for (const row of transactions) {
      assert.ok(row.merchant.startsWith("[サンプル] "));
      assert.ok(row.external_id.startsWith("cake-preview-sample-v1-"));
      assert.equal(row.source, "MANUAL");
      assert.equal(row.settled_at, null);
      assert.equal(row.month, true);
      assert.equal(row.category_confirmed, row.category_id !== null);
      assert.equal(row.category_revision, row.category_id === null ? 0 : 1);
      if (row.expense_class === "PERSONAL") {
        assert.equal(row.split_weights[row.actor_user_id], 1);
        assert.equal(row.split_weights[row.actor_user_id === "test-user-a" ? "test-user-b" : "test-user-a"], 0);
      }
    }
    assert.deepEqual(transactions.map(row => row.japan_time).sort(), Array.from({ length: 8 }, (_, day) => `${String(day + 1).padStart(2, "0")} 12:00`));
  });

  await scenario("同PRの再実行と更新SHAでも、編集・削除したサンプルを元に戻さない", async () => {
    await seed();
    const initial = await snapshot(), initialMarker = await db.query("SELECT * FROM cake_preview_database_identity");
    await seed();
    assert.deepEqual(await snapshot(), initial);
    assert.deepEqual(await db.query("SELECT * FROM cake_preview_database_identity"), initialMarker);
    await db.exec(`UPDATE transactions SET amount_yen=9876,memo='検証中の編集' WHERE id=(SELECT id FROM transactions ORDER BY id LIMIT 1);
      DELETE FROM transactions WHERE category_id IS NULL;
      UPDATE categories SET name='編集した趣味',color_hex='#123456' WHERE name='趣味';
      SELECT cake_delete_category('${workspaceId}','test-user-a',(SELECT id FROM categories WHERE name='食費'))`);
    const edited = await snapshot();
    const updated = { ...environment, CAKE_PREVIEW_SOURCE_SHA: "b".repeat(40), VERCEL_GIT_COMMIT_SHA: "b".repeat(40) };
    await setupDatabase(updated, { connect });
    await db.query(testSeedSql(updated));
    assert.deepEqual(await snapshot(), edited);
  });

  await scenario("既存のユーザーseed済みPreviewも追加migration後にサンプルを一度だけ登録する", async () => {
    await core();
    await db.exec(`ALTER TABLE cake_preview_database_identity DROP COLUMN samples_seeded_at;
      DELETE FROM schema_migrations WHERE name='017_preview_sample_seed.sql'`);
    await setupDatabase(environment, { connect });
    assert.deepEqual(await marker(), { users: true, samples: false });
    await seed();
    assert.deepEqual(await counts(), { categories: 10, transactions: 8 });
    assert.deepEqual(await marker(), { users: true, samples: true });
    const before = await snapshot();
    await seed();
    assert.deepEqual(await snapshot(), before);
  });

  for (const [name, statement] of [
    ["既存明細", `INSERT INTO transactions(workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,
      expense_class,external_id,created_by,updated_by,split_weights)
      VALUES ('${workspaceId}',now(),'利用者の明細','現金','PAYMENT',500,'test-user-a','SHARED','existing-entry',
        'test-user-a','test-user-a','{"test-user-a":1,"test-user-b":1}')`],
    ["既存カテゴリ", `INSERT INTO categories(workspace_id,name,color_hex,sort_order,created_by,updated_by)
      VALUES ('${workspaceId}','利用者のカテゴリ','#123456',0,'test-user-a','test-user-a')`],
    ["停止済みA", "UPDATE app_users SET is_enabled=false WHERE id='test-user-a'"],
    ["降格済みA", "UPDATE app_users SET is_admin=false WHERE id='test-user-a'"],
    ["昇格済みB", "UPDATE app_users SET is_admin=true WHERE id='test-user-b'"],
    ["変更済み表示名", "UPDATE app_users SET name='変更した表示名' WHERE id='test-user-b'"],
    ["変更済み家計名", "UPDATE workspaces SET name='変更した共有家計'"],
    ["変更済み所属", "UPDATE workspace_members SET role='MEMBER',weight=3 WHERE user_id='test-user-a'"],
    ["削除済み共有家計", `DELETE FROM workspaces WHERE id='${workspaceId}'`],
  ]) {
    await scenario(`${name}があるPreviewは初期値を追加せず、後の再実行でも復元しない`, async () => {
      await core();
      await db.exec(statement);
      const before = await snapshot();
      await seed();
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await marker(), { users: true, samples: true });
      await db.exec("DELETE FROM transactions; DELETE FROM categories");
      const afterDeletion = await snapshot();
      await seed();
      assert.deepEqual(await snapshot(), afterDeletion);
    });
  }

  await scenario("明細登録が途中で失敗した場合は全seedと完了markerをrollbackし、再試行できる", async () => {
    await db.exec(`CREATE FUNCTION reject_preview_sample() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture sample insert rejected'; END; $$;
      CREATE TRIGGER reject_preview_sample BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION reject_preview_sample();
      SAVEPOINT sample_failure`);
    await assert.rejects(seed(), /fixture sample insert rejected/);
    await db.exec("ROLLBACK TO SAVEPOINT sample_failure; RELEASE SAVEPOINT sample_failure");
    assert.deepEqual(await counts(), { categories: 0, transactions: 0 });
    assert.equal((await db.query<{ users: number }>("SELECT count(*)::int AS users FROM app_users")).rows[0].users, 0);
    assert.deepEqual(await marker(), { users: false, samples: false });
    await db.exec("DROP TRIGGER reject_preview_sample ON transactions; DROP FUNCTION reject_preview_sample()");
    await seed();
    assert.deepEqual(await counts(), { categories: 10, transactions: 8 });
    assert.deepEqual(await marker(), { users: true, samples: true });
  });

  await scenario("従来ローカルseedは管理者権限とサンプルを追加しない", async () => {
    await db.query(testSeedSql({}));
    assert.deepEqual(await counts(), { categories: 0, transactions: 0 });
    assert.equal((await db.query<{ admins: number }>("SELECT count(*)::int AS admins FROM app_users WHERE is_admin")).rows[0].admins, 0);
    assert.deepEqual(await marker(), { users: false, samples: false });
  });
});

test("本番migrationはPreviewのseed状態を作らず、seedは接続前に拒否する", async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  const environment = { VERCEL_ENV: "production", DATABASE_URL: "postgresql://fixture:fixture@ep-production.ap-southeast-1.aws.neon.tech/cake" };
  await setupDatabase(environment, { connect: () => ({ query: (statement: string) => db.query(statement) }) });
  assert.equal((await db.query<{ absent: boolean }>("SELECT to_regclass('public.cake_preview_database_identity') IS NULL AS absent")).rows[0].absent, true);
  assert.equal((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM categories")).rows[0].count, 0);
  let clients = 0;
  await assert.rejects(seedTestUsers(environment, () => {
    clients++;
    return { query: (statement: string) => db.query(statement) };
  }), /Productionではテストデータを登録できません/);
  assert.equal(clients, 0);
});

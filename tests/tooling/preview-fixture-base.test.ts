import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { assertPreviewFixtureMigrationSources, PREVIEW_FIXTURE_MIGRATIONS } from "../../lib/server/database/preview-fixture-base.mjs";
import { prepareMigration } from "../../scripts/db/setup-db.mjs";

const directory = new URL("../../db/migrations/", import.meta.url);
const sources = readdirSync(directory).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, directory), "utf8") }));
const baseline = sources.slice(0, 11);
const rejected = /Previewの承認済みfixture migrationを確認できません/;

test("承認済み11 migrationの原文を固定し、実ファイルを受け入れる", () => {
  assert.equal(PREVIEW_FIXTURE_MIGRATIONS.length, 11);
  assert.equal(baseline.length, 11);
  assert.doesNotThrow(() => assertPreviewFixtureMigrationSources(sources));
});

test("適用済みmigrationのSQL変更を同じファイル名でも拒否する", () => {
  const changed = baseline.map((migration, index) => index === 2
    ? { ...migration, sql: migration.sql.replace("weight >= 0", "weight > 0") } : migration);
  assert.notEqual(changed[2].sql, baseline[2].sql);
  assert.throws(() => assertPreviewFixtureMigrationSources(changed), rejected);
});

test("baselineの欠落・別名・順序変更・重複を拒否する", () => {
  for (const changed of [
    baseline.slice(1),
    baseline.map((migration, index) => index === 0 ? { ...migration, name: "001_fixture.sql" } : migration),
    [baseline[1], baseline[0], ...baseline.slice(2)],
    [baseline[0], ...baseline],
  ]) assert.throws(() => assertPreviewFixtureMigrationSources(changed), rejected);
});

test("Production bootstrap除去後のSQLをmigration原文の代用にしない", () => {
  const prepared = baseline.map(({ name, sql }) => ({ name, sql: prepareMigration(name, sql, { VERCEL_ENV: "preview" }) }));
  assert.notEqual(prepared[1].sql, baseline[1].sql);
  assert.throws(() => assertPreviewFixtureMigrationSources(prepared), rejected);
});

test("baseline以降の正しく番号付けされた追加migrationを受け入れる", () => {
  assert.doesNotThrow(() => assertPreviewFixtureMigrationSources([
    ...baseline,
    { name: "012_add_fixture_review.sql", sql: "ALTER TABLE app_users ADD COLUMN reviewed_at timestamptz;" },
    { name: "013_next_review.sql", sql: "CREATE INDEX reviewed_at_idx ON app_users (reviewed_at);" },
  ]));
});

test("追加migrationの番号衝突・重複・逆順・不正名を拒否する", () => {
  for (const later of [
    [{ name: "011_collision.sql", sql: "SELECT 1;" }],
    [{ name: "012_first.sql", sql: "SELECT 1;" }, { name: "012_duplicate.sql", sql: "SELECT 1;" }],
    [{ name: "013_first.sql", sql: "SELECT 1;" }, { name: "012_late.sql", sql: "SELECT 1;" }],
    [{ name: "not_a_migration.sql", sql: "SELECT 1;" }],
    [{ name: "012_invalid-name.sql", sql: "SELECT 1;" }],
    [{ name: "9007199254740993_unsafe_number.sql", sql: "SELECT 1;" }],
  ]) assert.throws(() => assertPreviewFixtureMigrationSources([...baseline, ...later]), rejected);
});

test("原文照合失敗のエラーに変更SQLやfixture内容を含めない", () => {
  const privateSql = "SELECT 'private-fixture-data-and-postgresql://credentials';";
  assert.throws(() => assertPreviewFixtureMigrationSources(baseline.map((migration, index) => index === 0
    ? { ...migration, sql: privateSql } : migration)), (error: unknown) => {
    assert.match(String(error), rejected);
    assert.doesNotMatch(String(error), /private-fixture|postgresql:\/\//);
    return true;
  });
});

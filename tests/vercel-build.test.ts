import test from "node:test";
import assert from "node:assert/strict";
import { buildSteps, runVercelBuild, type BuildStep } from "../scripts/vercel-build";

const previewEnvironment = {
  VERCEL_ENV: "preview", AUTH_MODE: "test", CAKE_TEST_DATABASE_URL: "isolated-test-db", AUTH_SECRET: "test-secret",
};
const productionEnvironment = { ...previewEnvironment, VERCEL_ENV: "production", AUTH_MODE: "google", DATABASE_URL: "production-db" };

test("Previewのテスト認証ではDB更新・テスト登録・ビルドの順に実行する", () => {
  assert.deepEqual(buildSteps(previewEnvironment), ["db:setup", "db:seed:test", "build"]);
});

test("PreviewのGoogle認証ではDB更新を行い、テストユーザーを登録しない", () => {
  assert.deepEqual(buildSteps({ ...previewEnvironment, AUTH_MODE: "google" }), ["db:setup", "build"]);
});

test("Productionではビルド成功後にDB更新を行い、テストユーザーを登録しない", () => {
  for (const AUTH_MODE of ["google", "test", undefined]) {
    const executed: BuildStep[] = [];
    runVercelBuild({ ...productionEnvironment, AUTH_MODE }, (step) => {
      executed.push(step);
      return 0;
    });
    assert.deepEqual(executed, ["build", "db:setup"]);
  }
});

test("Development・ローカルではDB操作を行わない", () => {
  for (const VERCEL_ENV of ["development", undefined]) {
    assert.deepEqual(buildSteps({ ...previewEnvironment, VERCEL_ENV }), ["build"]);
  }
});

test("Preview・Productionの必要な環境変数が未設定ならDB処理もビルドも開始しない", () => {
  for (const environment of [previewEnvironment, productionEnvironment]) {
    const databaseKey = environment.VERCEL_ENV === "preview" ? "CAKE_TEST_DATABASE_URL" : "DATABASE_URL";
    for (const variable of [databaseKey, "AUTH_SECRET"]) {
      for (const invalid of [undefined, "", "   ", "[SENSITIVE]"]) {
        const executed: BuildStep[] = [];
        assert.throws(() => runVercelBuild({ ...environment, [variable]: invalid }, (step) => {
          executed.push(step);
          return 0;
        }), new RegExp(`${environment.VERCEL_ENV === "production" ? "Production" : "Preview"}環境に ${variable}`));
        assert.deepEqual(executed, []);
      }
    }
  }
});

test("Previewに共通DATABASE_URLがあっても専用DBがなければ準備を開始しない", () => {
  assert.throws(() => runVercelBuild({ VERCEL_ENV: "preview", DATABASE_URL: "shared-or-production-db", AUTH_SECRET: "secret" }, () => {
    assert.fail("共通DBには接続しない");
  }), /CAKE_TEST_DATABASE_URL/);
});

test("PreviewのDB更新またはテスト登録に失敗した場合は後続処理を実行しない", () => {
  for (const failed of ["db:setup", "db:seed:test"] as const) {
    const executed: BuildStep[] = [];
    assert.throws(() => runVercelBuild(previewEnvironment, (step) => {
      executed.push(step);
      return step === failed ? 1 : 0;
    }), /失敗しました/);
    assert.deepEqual(executed, failed === "db:setup" ? ["db:setup"] : ["db:setup", "db:seed:test"]);
  }
});

test("Productionのビルドが失敗した場合は本番DBを更新しない", () => {
  const executed: BuildStep[] = [];
  assert.throws(() => runVercelBuild(productionEnvironment, (step) => {
    executed.push(step);
    return 1;
  }), /build が失敗しました/);
  assert.deepEqual(executed, ["build"]);
});

test("ProductionのDB更新が失敗した場合はビルド全体を失敗させ公開を止める", () => {
  const executed: BuildStep[] = [];
  assert.throws(() => runVercelBuild(productionEnvironment, (step) => {
    executed.push(step);
    return step === "db:setup" ? 1 : 0;
  }), /db:setup が失敗しました/);
  assert.deepEqual(executed, ["build", "db:setup"]);
});

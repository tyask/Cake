import test from "node:test";
import assert from "node:assert/strict";
import { buildSteps, runVercelBuild, type BuildStep } from "../scripts/vercel-build";

const previewEnvironment = {
  VERCEL_ENV: "preview", AUTH_MODE: "test", DATABASE_URL: "isolated-test-db", AUTH_SECRET: "test-secret",
};

test("Previewのテスト認証ではDB更新・テスト登録・ビルドの順に実行する", () => {
  assert.deepEqual(buildSteps(previewEnvironment), ["db:setup", "db:seed:test", "build"]);
});

test("PreviewのGoogle認証ではDB更新を行い、テストユーザーを登録しない", () => {
  assert.deepEqual(buildSteps({ ...previewEnvironment, AUTH_MODE: "google" }), ["db:setup", "build"]);
});

test("Production・Development・ローカルではDB操作を行わない", () => {
  for (const VERCEL_ENV of ["production", "development", undefined]) {
    assert.deepEqual(buildSteps({ ...previewEnvironment, VERCEL_ENV }), ["build"]);
  }
});

test("Previewの必要な環境変数が未設定ならDB処理もビルドも開始しない", () => {
  for (const variable of ["DATABASE_URL", "AUTH_SECRET"] as const) {
    for (const invalid of [undefined, "", "   ", "[SENSITIVE]"]) {
      const executed: BuildStep[] = [];
      assert.throws(() => runVercelBuild({ ...previewEnvironment, [variable]: invalid }, (step) => {
        executed.push(step);
        return 0;
      }), new RegExp(variable));
      assert.deepEqual(executed, []);
    }
  }
});

test("DB更新またはテスト登録に失敗した場合は後続処理を実行しない", () => {
  for (const failed of ["db:setup", "db:seed:test"] as const) {
    const executed: BuildStep[] = [];
    assert.throws(() => runVercelBuild(previewEnvironment, (step) => {
      executed.push(step);
      return step === failed ? 1 : 0;
    }), /失敗しました/);
    assert.deepEqual(executed, failed === "db:setup" ? ["db:setup"] : ["db:setup", "db:seed:test"]);
  }
});

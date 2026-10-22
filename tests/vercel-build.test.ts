import { createHash } from 'node:crypto';
import test from "node:test";
import assert from "node:assert/strict";
import { buildSteps, runVercelBuild, type BuildStep } from "../scripts/vercel-build";
import { config } from '../scripts/preview-model';

const csvCategoryQaMarker = '[cake-db-qa:csv-categories]';

const previewEnvironment = {
  VERCEL_ENV: "preview", AUTH_MODE: "test", AUTH_SECRET: "test-secret",
  VERCEL_GIT_COMMIT_REF: "codex/feature", VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  CAKE_PREVIEW_REPOSITORY: "tyask/Cake", CAKE_PREVIEW_PHASE: "application", CAKE_PREVIEW_DATABASE_BRANCH_ID: "br-preview", CAKE_PREVIEW_PR: "34", CAKE_PREVIEW_GENERATION: "00000000-0000-4000-8000-000000000001",
  CAKE_PREVIEW_SOURCE_BRANCH: "codex/feature", CAKE_PREVIEW_SOURCE_SHA: "a".repeat(40),
  CAKE_TEST_DATABASE_URL: "postgresql://user:private@ep-preview-pooler.ap-southeast-1.aws.neon.tech/cake",
  CAKE_PREVIEW_DATABASE_HOST_SHA256: createHash('sha256').update('ep-preview.ap-southeast-1.aws.neon.tech').digest('hex'), CAKE_PREVIEW_PRODUCTION_HOST_SHA256: createHash('sha256').update('ep-production.ap-southeast-1.aws.neon.tech').digest('hex'),
};
const productionEnvironment = { VERCEL_ENV: "production", AUTH_MODE: "google", AUTH_SECRET: "test-secret", DATABASE_URL: "production-db" };

test("Previewのテスト認証ではDB更新・テスト登録・ビルドの順に実行する", () => {
  assert.deepEqual(buildSteps(previewEnvironment), ["db:setup", "db:seed:test", "build"]);
});

test('現在commitの独立行markerで明示したPreviewだけseed後・build前にCSVの実DB検証を行う', () => {
  for (const message of [csvCategoryQaMarker, `CSVカテゴリを検証する\r\n\r\n  ${csvCategoryQaMarker}\t\r\n`, `${csvCategoryQaMarker}\n${csvCategoryQaMarker}`]) {
    const executed: BuildStep[] = [];
    runVercelBuild({ ...previewEnvironment, VERCEL_GIT_COMMIT_MESSAGE: message }, step => {
      executed.push(step);
      return 0;
    });
    assert.deepEqual(executed, ['db:setup', 'db:seed:test', 'qa:db:csv-categories', 'build']);
  }
  // A later commit with no marker does not inherit the preceding opt-in.
  assert.deepEqual(buildSteps({ ...previewEnvironment, VERCEL_GIT_COMMIT_MESSAGE: '次の変更' }), ['db:setup', 'db:seed:test', 'build']);
});

test('文中・未知・不完全なmarkerでは実DB検証を追加しない', () => {
  for (const message of [undefined, '', `説明 ${csvCategoryQaMarker}`, `${csvCategoryQaMarker} を実行`, '[cake-db-qa:other]', '[cake-db-qa:CSV-categories]']) {
    assert.deepEqual(buildSteps({ ...previewEnvironment, VERCEL_GIT_COMMIT_MESSAGE: message }), ['db:setup', 'db:seed:test', 'build']);
  }
});

test('markerがあってもProduction・準備用・常設Preview・Development・ローカルではCSVの実DB検証を行わない', () => {
  assert.deepEqual(buildSteps({ ...productionEnvironment, VERCEL_GIT_COMMIT_MESSAGE: csvCategoryQaMarker }), ['build', 'db:setup']);
  for (const VERCEL_ENV of ['development', undefined]) {
    assert.deepEqual(buildSteps({ VERCEL_ENV, VERCEL_GIT_COMMIT_MESSAGE: csvCategoryQaMarker }), ['build']);
  }
  assert.deepEqual(buildSteps({
    ...previewEnvironment, VERCEL_GIT_COMMIT_MESSAGE: csvCategoryQaMarker,
    CAKE_PREVIEW_PHASE: 'provisioning', CAKE_PREVIEW_DATABASE_BRANCH_ID: '', CAKE_PREVIEW_DATABASE_HOST_SHA256: '',
    CAKE_PREVIEW_PRODUCTION_HOST_SHA256: config.productionHostDigest,
  }), ['provision']);
  assert.deepEqual(buildSteps({
    ...previewEnvironment, VERCEL_GIT_COMMIT_MESSAGE: csvCategoryQaMarker,
    CAKE_PREVIEW_KIND: 'main', CAKE_PREVIEW_PR: '0',
    CAKE_PREVIEW_SOURCE_BRANCH: 'cake-main-preview', VERCEL_GIT_COMMIT_REF: 'cake-main-preview',
  }), ['db:setup', 'db:seed:test', 'build']);
});

test('CSV検証の子処理には専用接続・identity・Node/TLS設定だけを渡す', () => {
  const environment = {
    ...previewEnvironment, VERCEL_GIT_COMMIT_MESSAGE: csvCategoryQaMarker, VERCEL_DEPLOYMENT_ID: 'dpl-preview',
    PATH: '/safe/node/bin', NODE_EXTRA_CA_CERTS: '/safe/ca.pem', SSL_CERT_FILE: '/safe/system.pem',
    VERCEL_TOKEN: 'provider-secret', NEON_API_KEY: 'provider-secret', AUTH_GOOGLE_SECRET: 'auth-secret',
    GH_TOKEN: 'github-secret', VERCEL_OIDC_TOKEN: 'oidc-secret', POSTGRES_URL: 'native-alias-secret',
    DATABASE_URL: 'postgresql://user:private@ep-production-pooler.ap-southeast-1.aws.neon.tech/cake',
    CAKE_UNKNOWN_SECRET: 'unknown-secret', NODE_ENV: 'development', NODE_OPTIONS: '--require private-hook', NODE_TLS_REJECT_UNAUTHORIZED: '0', DEBUG: '*',
  };
  let checked = false;
  runVercelBuild(environment, (step, childEnvironment) => {
    if (step !== 'qa:db:csv-categories') return 0;
    checked = true;
    assert.equal(childEnvironment.NODE_ENV, 'production');
    for (const name of [
      'AUTH_SECRET', 'AUTH_GOOGLE_SECRET', 'VERCEL_TOKEN', 'NEON_API_KEY', 'GH_TOKEN', 'VERCEL_OIDC_TOKEN',
      'POSTGRES_URL', 'DATABASE_URL', 'CAKE_UNKNOWN_SECRET', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'DEBUG',
    ]) assert.equal(childEnvironment[name], undefined, `${name} は子処理に渡さない`);
    for (const name of [
      'VERCEL_ENV', 'AUTH_MODE', 'VERCEL_DEPLOYMENT_ID', 'VERCEL_GIT_COMMIT_MESSAGE', 'VERCEL_GIT_COMMIT_SHA',
      'VERCEL_GIT_COMMIT_REF', 'CAKE_TEST_DATABASE_URL', 'CAKE_PREVIEW_REPOSITORY', 'CAKE_PREVIEW_PR',
      'CAKE_PREVIEW_GENERATION', 'CAKE_PREVIEW_SOURCE_BRANCH', 'CAKE_PREVIEW_SOURCE_SHA',
      'CAKE_PREVIEW_DATABASE_BRANCH_ID', 'CAKE_PREVIEW_DATABASE_HOST_SHA256', 'CAKE_PREVIEW_PRODUCTION_HOST_SHA256',
      'CAKE_PREVIEW_PHASE', 'PATH', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
    ] as const) assert.equal(childEnvironment[name], environment[name]);
    return 0;
  });
  assert.equal(checked, true);
});

test("PreviewのGoogle認証ではDB更新を行い、テストユーザーを登録しない", () => {
  assert.throws(() => buildSteps({ ...previewEnvironment, AUTH_MODE: "google" }), /PreviewとDBの照合/);
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
    assert.deepEqual(buildSteps({ VERCEL_ENV }), ["build"]);
  }
});

test("Previewの所有権とDB比較情報が確認不能ならmigration・seed・buildをすべて止める", () => {
  for (const changed of [{ CAKE_PREVIEW_REPOSITORY: undefined }, { CAKE_PREVIEW_DATABASE_HOST_SHA256: undefined }, { CAKE_PREVIEW_PRODUCTION_HOST_SHA256: undefined }, { VERCEL_GIT_COMMIT_SHA: "b".repeat(40) }]) {
    const executed: BuildStep[] = [];
    assert.throws(() => runVercelBuild({ ...previewEnvironment, VERCEL_GIT_COMMIT_MESSAGE: csvCategoryQaMarker, ...changed }, (step) => {
      executed.push(step);
      return 0;
    }), /PreviewとDBの照合/);
    assert.deepEqual(executed, []);
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
    assert.throws(() => runVercelBuild({ ...previewEnvironment, VERCEL_GIT_COMMIT_MESSAGE: csvCategoryQaMarker }, (step) => {
      executed.push(step);
      return step === failed ? 1 : 0;
    }), /失敗しました/);
    assert.deepEqual(executed, failed === "db:setup" ? ["db:setup"] : ["db:setup", "db:seed:test"]);
  }
});

test('CSVの実DB検証に失敗した場合はNext buildへ進まず公開を止める', () => {
  const executed: BuildStep[] = [];
  assert.throws(() => runVercelBuild({ ...previewEnvironment, VERCEL_GIT_COMMIT_MESSAGE: csvCategoryQaMarker }, step => {
    executed.push(step);
    return step === 'qa:db:csv-categories' ? 1 : 0;
  }), /qa:db:csv-categories が失敗しました/);
  assert.deepEqual(executed, ['db:setup', 'db:seed:test', 'qa:db:csv-categories']);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const dispatcher = readFileSync(new URL('../.github/workflows/cannele-readiness.yml', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../.github/workflows/cannele-readiness-run.yml', import.meta.url), 'utf8');
const validationStart = runner.indexOf("node --input-type=module <<'CANNELE_READINESS_INPUT_JS'\n");
const validationEnd = runner.indexOf('\n          CANNELE_READINESS_INPUT_JS', validationStart);
assert.ok(validationStart > 0 && validationEnd > validationStart);
const validator = new Script(runner.slice(validationStart + "node --input-type=module <<'CANNELE_READINESS_INPUT_JS'\n".length, validationEnd));
const revision = 'a'.repeat(40);
const requestId = '00000000-0000-4000-8000-000000000042';

test('public dispatcher only invokes the same-commit helper from owner current-main first attempt', () => {
  assert.match(dispatcher, /on:\s+workflow_dispatch:/);
  assert.doesNotMatch(dispatcher, /workflow_call:|pull_request|schedule:|cron:/);
  for (const source of [dispatcher, runner]) {
    assert.match(source, /github\.repository == 'tyask\/Cake'/);
    assert.match(source, /github\.ref == 'refs\/heads\/main'/);
    assert.match(source, /github\.actor == github\.repository_owner/);
    assert.match(source, /github\.run_attempt == '1'/);
    assert.match(source, /inputs\.reviewed_revision == github\.sha/);
    assert.match(source, /permissions:\s+contents: read\s+actions: read/);
    assert.doesNotMatch(source, /contents: write|actions: write|id-token:|secrets: inherit|^\s+environment:/m);
  }
  assert.match(dispatcher, /uses: \.\/\.github\/workflows\/cannele-readiness-run\.yml/);
  assert.match(runner, /repository: tyask\/Cake\s+ref: \$\{\{ github\.sha \}\}\s+persist-credentials: false/);
  assert.equal(runner.match(/uses: actions\/checkout@/g)?.length, 1);
});

test('actual public input validation rejects nonce/path injection and source drift before any administrative step', () => {
  const valid = { GITHUB_SHA: revision, CANNELE_READINESS_EXPECTED_REVISION: revision, CANNELE_READINESS_REQUEST_ID: requestId };
  assert.doesNotThrow(() => validator.runInNewContext({ process: { env: valid } }));
  for (const env of [
    { ...valid, CANNELE_READINESS_EXPECTED_REVISION: 'b'.repeat(40) },
    { ...valid, CANNELE_READINESS_EXPECTED_REVISION: 'main' },
    { ...valid, CANNELE_READINESS_REQUEST_ID: '../private-env' },
    { ...valid, CANNELE_READINESS_REQUEST_ID: `${requestId}\ncommand` },
    { ...valid, CANNELE_READINESS_REQUEST_ID: undefined },
  ]) assert.throws(() => validator.runInNewContext({ process: { env } }), /identifiers are invalid/);
  assert.doesNotMatch(runner.slice(validationStart, validationEnd), /\$\{\{/);
  assert.ok(runner.indexOf('Validate public inspection identifiers') < runner.indexOf('Install reviewed dependencies'));
  assert.match(runner, /node-version: "24\.19\.0"/);
});

test('repository variables and explicit masked secrets reach only the read-only inspection step', () => {
  const start = runner.indexOf('      - name: Inspect existing QA registry and provider metadata');
  const end = runner.indexOf('      - name: Upload strict public readiness receipt');
  const inspection = runner.slice(start, end);
  assert.doesNotMatch(runner.slice(runner.indexOf('    steps:'), start), /secrets\.|GITHUB_TOKEN|VERCEL_TOKEN|NEON_API_KEY|CAKE_QA_REGISTRY_DATABASE_/);
  assert.doesNotMatch(runner.slice(end), /secrets\.|GITHUB_TOKEN|VERCEL_TOKEN|NEON_API_KEY|CAKE_QA_REGISTRY_DATABASE_/);
  assert.match(dispatcher, /production_database_host: \$\{\{ vars\.CAKE_QA_PRODUCTION_DATABASE_HOST \}\}/);
  assert.match(inspection, /CAKE_QA_PRODUCTION_DATABASE_HOST: \$\{\{ secrets\.production_database_host \}\}/);
  assert.doesNotMatch(runner, /vars\.CAKE_QA_PRODUCTION_DATABASE_HOST/);
  for (const name of ['CAKE_CANNELE_ENABLED', 'CAKE_QA_POOL_ENABLED', 'CAKE_QA_REGISTRY_ENABLED', 'CAKE_QA_PARENT_BRANCH_ID']) {
    assert.match(inspection, new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`));
  }
  assert.match(inspection, /export QA_TRUSTED_MAIN_SHA="\$\(git rev-parse HEAD\)"\s+node --import tsx scripts\/cannele-readiness\.ts/);
  assert.doesNotMatch(inspection, /run:.*\$\{\{.*inputs\./);
  assert.doesNotMatch([dispatcher, runner].join('\n'), /qa-registry-fence\.ts|qa-registry-initialize\.ts|legacy-transition|runtime-role|deploy:preview|db:setup/);
});

test('the receipt is a single temp result.json with request-bound name, pinned upload and missing-file failure', () => {
  assert.match(runner, /CANNELE_READINESS_RESULT_PATH: \$\{\{ runner\.temp \}\}\/cannele-readiness\/\$\{\{ inputs\.request_id \}\}\/result\.json/);
  assert.match(runner, /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(runner, /name: cannele-readiness-\$\{\{ inputs\.request_id \}\}/);
  assert.match(runner, /path: \$\{\{ runner\.temp \}\}\/cannele-readiness\/\$\{\{ inputs\.request_id \}\}\/result\.json\s+if-no-files-found: error\s+retention-days: 1/);
  assert.doesNotMatch(runner, /path:.*(?:\*|\.env|\.vercel|logs|workspace)/);
  assert.doesNotMatch(runner, /always\(\)/);
});

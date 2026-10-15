import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const readWorkflow = (name: string) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
const pool = readWorkflow("qa-pool.yml");
const diagnostics = readWorkflow("qa-diagnostics.yml");
const runner = readWorkflow("qa-private-run.yml");
const variable = "${{ vars.CAKE_QA_PRODUCTION_DATABASE_HOST }}";
const secret = "${{ secrets.production_database_host }}";
const job = (source: string, name: string) => {
  const start = source.indexOf(`\n  ${name}:\n`, source.indexOf("\njobs:\n"));
  assert.ok(start >= 0, `Missing job: ${name}`);
  const next = source.slice(start + 1).search(/\n  [\w-]+:\n/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
};

test("本番host Variableはrunner起動前のworkflow-call secretとしてだけ渡す", () => {
  for (const [source, name] of [[pool, "inspect"], [pool, "writer"], [diagnostics, "inspect"]]) {
    const call = job(source, name);
    assert.match(call, /    uses: \.\/\.github\/workflows\/qa-private-run\.yml\n/);
    assert.match(call, /    secrets:\n(?:      [^\n]*\n)*      production_database_host: \$\{\{ vars\.CAKE_QA_PRODUCTION_DATABASE_HOST \}\}/);
    assert.equal(call.split(variable).length - 1, 1);
    assert.doesNotMatch(call, /    (?:steps|env|runs-on|environment|concurrency):/);
    assert.doesNotMatch(call.slice(0, call.indexOf("    secrets:")), /CAKE_QA_PRODUCTION_DATABASE_HOST/);
  }
  const directory = new URL("../.github/workflows/", import.meta.url);
  const bindings: string[] = [];
  for (const name of readdirSync(directory).filter((v) => /\.ya?ml$/.test(v))) {
    const source = readWorkflow(name);
    for (const line of source.split("\n").filter((v) => v.includes(variable))) {
      assert.equal(line, `      production_database_host: ${variable}`);
      bindings.push(name);
    }
  }
  assert.deepEqual(bindings.sort(), ["cannele-readiness.yml", "qa-diagnostics.yml", "qa-pool.yml", "qa-pool.yml", "qa-registry.yml"]);
});

test("secretを本番比較guardの同じ環境名へ渡し、runtime権限追加を使わない", () => {
  assert.match(runner, /on:\n  workflow_call:/);
  assert.match(runner, /    secrets:\n(?:      [^\n]*\n)*      production_database_host:\n        required: false/);
  for (const name of ["pool", "diagnostics"]) {
    const execution = job(runner, name);
    assert.match(execution, /          CAKE_QA_PRODUCTION_DATABASE_HOST: \$\{\{ secrets\.production_database_host \}\}/);
    assert.equal(execution.split(secret).length - 1, 1);
    assert.match(execution, /github\.repository == 'tyask\/Cake'/);
    assert.match(execution, /github\.ref == 'refs\/heads\/main'/);
    assert.doesNotMatch(execution, /run:.*\$\{\{|permissions:|add-mask|actions\/variables|secrets: inherit/);
  }
  assert.doesNotMatch(runner, /vars\.CAKE_QA_PRODUCTION_DATABASE_HOST|^\s*(?:permissions|workflow_dispatch|schedule|pull_request_target):/m);
  assert.match(job(pool, "inspect"), /    permissions:\n      contents: read\n      pull-requests: read\n      deployments: read/);
  assert.match(job(pool, "writer"), /    permissions:\n      contents: read\n      pull-requests: read\n      deployments: write/);
  assert.match(diagnostics, /permissions:\n  contents: read\n  pull-requests: read\n  deployments: read/);
});

test("hostを含む削除・alias承認JSONはstep開始前にworkflow-call secretへ渡す", () => {
  for (const [variableName, secretName] of [["CAKE_QA_DELETE_APPROVALS", "delete_approvals"], ["CAKE_QA_ALIAS_APPROVALS", "alias_approvals"]]) {
    assert.match(runner, new RegExp(`      ${secretName}:\\n        required: false`));
    assert.match(job(runner, "pool"), new RegExp(`${variableName}: \\$\\{\\{ secrets\\.${secretName} \\}\\}`));
    assert.doesNotMatch(runner, new RegExp(`vars\\.${variableName}`));
    for (const name of ["inspect", "writer"]) {
      const caller = job(pool, name);
      const secretBlock = caller.slice(caller.indexOf("    secrets:"));
      assert.match(secretBlock, new RegExp(`      ${secretName}: \\$\\{\\{ vars\\.${variableName} \\}\\}`));
      assert.doesNotMatch(caller.slice(0, caller.indexOf("    secrets:")), new RegExp(`(?:with|env|run):[^\\n]*${variableName}`));
    }
    for (const name of readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((v) => /\\.ya?ml$/.test(v))) {
      for (const line of readWorkflow(name).split("\n").filter((v) => v.includes(`vars.${variableName}`) && !v.includes("github.event_name == 'schedule'"))) {
        assert.equal(line, `      ${secretName}: \$\{\{ vars.${variableName} \}\}`);
      }
    }
  }
});

test("単一writer queueとtrusted main、診断のGET専用経路を維持する", () => {
  assert.match(pool, /types: \[opened, synchronize, reopened, closed\]/);
  assert.match(pool, /contains\(fromJSON\('\["preflight","plan-probe","plan-release"\]'\), inputs\.action\)/);
  assert.match(pool, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(pool, /startsWith\(github\.event\.pull_request\.head\.ref, 'codex\/'\)/);
  const execution = job(runner, "pool");
  assert.match(execution, /    environment: Preview/);
  assert.match(execution, /    concurrency:\n      group: cake-qa-pool-writer\n      queue: max\n      cancel-in-progress: false/);
  assert.match(execution, /          ref: refs\/heads\/main/);
  assert.match(execution, /export QA_TRUSTED_MAIN_SHA="\$\(git rev-parse HEAD\)"\s+node --import tsx scripts\/qa-pool-writer\.ts/);
  assert.match(diagnostics, /options: \[preflight, plan-probe, plan-release\]/);
  assert.doesNotMatch(diagnostics, /pull_request_target:|pull_request:|push:|schedule:|: write|environment:/);
  const inspection = job(runner, "diagnostics");
  assert.match(inspection, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(inspection, /run: node --import tsx scripts\/qa-bootstrap\.ts/);
  assert.doesNotMatch(inspection, /environment:|concurrency:|CAKE_QA_POOL_ENABLED|CAKE_QA_DELETE_APPROVALS|CAKE_QA_PROBE_APPROVALS/);
  for (const name of ["pool", "diagnostics"]) {
    const execution = job(runner, name);
    assert.doesNotMatch(execution.slice(0, execution.indexOf("        env:")), /secrets\.|GITHUB_TOKEN:|VERCEL_TOKEN:|NEON_API_KEY:/);
    assert.match(execution, /persist-credentials: false/);
  }
});

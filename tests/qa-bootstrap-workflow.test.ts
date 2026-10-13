import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/qa-diagnostics.yml", import.meta.url), "utf8");
const runner = readFileSync(new URL("../.github/workflows/qa-private-run.yml", import.meta.url), "utf8");
const inspection = runner.slice(runner.indexOf("\n  diagnostics:\n"));

test("診断は手動main実行だけで、PRイベントやscheduled writerを含まない", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.repository == 'tyask\/Cake' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /pull_request_target:|pull_request:|push:|schedule:|queue:|cancel-in-progress:/);
  assert.match(workflow, /options: \[preflight, plan-probe, plan-release\]/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/qa-private-run\.yml/);
  assert.match(workflow, /mode: diagnostics/);
});

test("最小read権限で環境Deploymentを生成せず、資格情報をinstallへ渡さない", () => {
  assert.match(workflow, /contents: read\s+pull-requests: read\s+deployments: read/);
  for (const source of [workflow, inspection]) {
    assert.doesNotMatch(source, /: write|write-all|environment:|CAKE_QA_POOL_ENABLED|CAKE_QA_DELETE_APPROVALS|CAKE_QA_PROBE_APPROVALS/);
  }
  const setup = inspection.slice(0, inspection.indexOf("- name: Inspect without mutations"));
  assert.doesNotMatch(setup, /secrets\.|GITHUB_TOKEN:|VERCEL_TOKEN:|NEON_API_KEY:/);
  assert.match(inspection, /persist-credentials: false/);
});

test("mainのdispatch commitをcheckoutし、入力をshellへ補間しない", () => {
  assert.match(inspection, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(inspection, /run: node --import tsx scripts\/qa-bootstrap\.ts/);
  assert.doesNotMatch(inspection, /run:.*\$\{\{.*inputs\./);
  assert.match(workflow, /source_sha: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(inspection, /QA_BOOTSTRAP_SOURCE_SHA: \$\{\{ inputs\.source_sha \}\}/);
});

test("diagnosticsのJSON出力はpublic projectionを通し、API本文は直接出力しない", () => {
  const script = readFileSync(new URL("../scripts/qa-bootstrap.ts", import.meta.url), "utf8");
  const reader = readFileSync(new URL("../lib/qa-bootstrap.ts", import.meta.url), "utf8");
  assert.match(script, /console\.log\(JSON\.stringify\(publicQaOutput\(report\)/);
  assert.match(reader, /maskQaHosts\(response\.data, this\.env\)/);
  assert.doesNotMatch(reader, /console\.(?:log|error|warn)/);
  assert.match(reader, /database: Omit<DatabaseIdentity, "host">/);
  assert.match(reader, /approvalManifestRequiresPrivateHost: true/);
});

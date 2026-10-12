import test from "node:test";
import assert from "node:assert/strict";
import { assertPreviewSourcePolicy } from "../lib/qa-pool-gate";

const previewEnvironment = () => ({ type: "system", target: "preview" });
const previewRule = (changes: Record<string, unknown> = {}) => ({
  enabled: true,
  environments: [previewEnvironment()],
  sources: ["rest-api"],
  ...changes,
});
const project = (rules: unknown[] = [previewRule()], policyChanges: Record<string, unknown> = {}) => ({
  id: "prj_review",
  previewDeploymentsDisabled: false,
  deploymentPolicy: { deploymentSources: rules, ...policyChanges },
});

function rejects(name: string, value: unknown) {
  test(name, () => assert.throws(() => assertPreviewSourcePolicy(value)));
}

test("明示project policyがPreviewへのREST APIだけを許可するとき受理する", () => {
  assert.doesNotThrow(() => assertPreviewSourcePolicy(project()));
});

test("既存Production rulesとGit source restrictionsを変更せずに検査する", () => {
  const productionRule = {
    enabled: true,
    environments: [{ type: "system", target: "production" }],
    sources: ["git"],
  };
  const value = project([productionRule, previewRule()], {
    gitSources: [{
      enabled: true,
      environments: [{ type: "system", target: "production" }],
      sources: [{ provider: "github", org: "tyask", repo: "Cake" }],
    }],
  });
  const before = structuredClone(value);
  assertPreviewSourcePolicy(value);
  assert.deepEqual(value, before);
});

test("Productionのdeny-allとcustom環境のruleを保持したままPreviewだけ確認する", () => {
  const value = project([
    { enabled: true, environments: [{ type: "system", target: "production" }], sources: [] },
    { enabled: false, environments: [{ type: "custom", environmentId: "env_review" }], sources: ["cli"] },
    previewRule(),
  ]);
  const before = structuredClone(value);
  assert.doesNotThrow(() => assertPreviewSourcePolicy(value));
  assert.deepEqual(value, before);
});

for (const [name, value] of [
  ["projectなし", undefined],
  ["null project", null],
  ["array project", []],
  ["空project", {}],
  ["Preview無効", { ...project(), previewDeploymentsDisabled: true }],
  ["Preview無効flagなし", { deploymentPolicy: project().deploymentPolicy }],
  ["Preview無効flagがstring", { ...project(), previewDeploymentsDisabled: "false" }],
  ["policy未設定", { ...project(), deploymentPolicy: undefined }],
  ["policy null", { ...project(), deploymentPolicy: null }],
  ["policy array", { ...project(), deploymentPolicy: [] }],
  ["deploymentSources未設定", { ...project(), deploymentPolicy: {} }],
  ["deploymentSources非array", { ...project(), deploymentPolicy: { deploymentSources: {} } }],
  ["Preview ruleなし", project([])],
  ["Production ruleしかない", project([{ enabled: true, environments: [{ type: "system", target: "production" }], sources: ["git"] }])],
  ["teamから継承したpolicyだけ", { previewDeploymentsDisabled: false, team: { deploymentPolicy: project().deploymentPolicy } }],
  ["effective policyだけ", { previewDeploymentsDisabled: false, effectiveDeploymentPolicy: project().deploymentPolicy }],
] as const) {
  rejects(`${name}では生成を許可しない`, value);
}

for (const [name, changes] of [
  ["disabled rule", { enabled: false }],
  ["enabled未設定", { enabled: undefined }],
  ["enabledがstring", { enabled: "true" }],
  ["source未設定", { sources: undefined }],
  ["source null", { sources: null }],
  ["sourceがstring", { sources: "rest-api" }],
  ["空sources", { sources: [] }],
  ["未知source", { sources: ["future-source"] }],
  ["Gitまで許可", { sources: ["rest-api", "git"] }],
  ["CLIまで許可", { sources: ["rest-api", "cli"] }],
  ["wildcard source", { sources: ["*"] }],
  ["REST source重複", { sources: ["rest-api", "rest-api"] }],
  ["sourceの大文字表記", { sources: ["REST-API"] }],
  ["sourceの前後空白", { sources: [" rest-api "] }],
  ["object source", { sources: [{ type: "rest-api" }] }],
  ["ruleの未知property", { allowAll: true }],
  ["ruleの継承指定", { inherited: true }],
  ["env未設定", { environments: undefined }],
  ["env非array", { environments: previewEnvironment() }],
  ["空env", { environments: [] }],
  ["env null", { environments: [null] }],
  ["大文字target", { environments: [{ type: "system", target: "Preview" }] }],
  ["大文字type", { environments: [{ type: "System", target: "preview" }] }],
  ["envの未知property", { environments: [{ ...previewEnvironment(), wildcard: true }] }],
  ["PreviewとProduction混在", { environments: [previewEnvironment(), { type: "system", target: "production" }] }],
  ["Previewとcustom混在", { environments: [previewEnvironment(), { type: "custom", id: "env_other" }] }],
  ["Previewと未知target混在", { environments: [previewEnvironment(), { type: "system", target: "future" }] }],
  ["Preview env重複", { environments: [previewEnvironment(), previewEnvironment()] }],
] as const) {
  rejects(`${name}を含むPreview policyは停止する`, project([previewRule(changes)]));
}

rejects("同じPreviewへの複数rulesは優先順位を推定せず停止する", project([
  previewRule(), previewRule({ enabled: false, sources: ["git"] }),
]));
rejects("同じPreviewへの同一rules重複も停止する", project([previewRule(), previewRule()]));
rejects("Preview ruleにpolicyの未知propertyが付いた場合も停止する", project([previewRule()], { inheritFromTeam: true }));

for (const [name, sibling] of [
  ["null rule", null],
  ["array rule", []],
  ["string rule", "preview"],
  ["空rule", {}],
  ["env未設定rule", { enabled: true, sources: ["git"] }],
  ["env非array rule", { enabled: true, environments: "preview", sources: ["git"] }],
  ["env内にnullがあるrule", { enabled: true, environments: [{ type: "system", target: "production" }, null], sources: ["git"] }],
  ["大小文字が違うPreview rule", { enabled: true, environments: [{ type: "system", target: "Preview" }], sources: ["git"] }],
  ["未知typeのPreview rule", { enabled: true, environments: [{ type: "future", target: "preview" }], sources: ["git"] }],
  ["未知target rule", { enabled: true, environments: [{ type: "system", target: "future" }], sources: ["git"] }],
  ["source未設定Production rule", { enabled: true, environments: [{ type: "system", target: "production" }] }],
  ["source非array Production rule", { enabled: true, environments: [{ type: "system", target: "production" }], sources: "git" }],
  ["source内にnullがあるProduction rule", { enabled: true, environments: [{ type: "system", target: "production" }], sources: [null] }],
  ["文字列に変換できるarray sourceのProduction rule", { enabled: true, environments: [{ type: "system", target: "production" }], sources: [["git"]] }],
  ["文字列に変換できるarray targetのProduction rule", { enabled: true, environments: [{ type: "system", target: ["production"] }], sources: ["git"] }],
] as const) {
  rejects(`正しいPreview ruleがあっても${name}を無視しない`, project([previewRule(), sibling]));
}

test("停止した場合もProduction ruleを削除・修正しない", () => {
  const value = project([
    { enabled: true, environments: [{ type: "system", target: "production" }], sources: ["git"] },
    previewRule({ sources: ["rest-api", "git"] }),
  ]);
  const before = structuredClone(value);
  assert.throws(() => assertPreviewSourcePolicy(value));
  assert.deepEqual(value, before);
});

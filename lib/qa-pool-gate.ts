/** Read-only validation of an explicit project override; never applies remote settings. */
export function assertPreviewSourcePolicy(project: unknown): void {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!object(project) || project.previewDeploymentsDisabled !== false || !object(project.deploymentPolicy)
    || Object.keys(project.deploymentPolicy).some((key) => !["deploymentSources", "gitSources"].includes(key))
    || !Array.isArray(project.deploymentPolicy.deploymentSources)) {
    throw new Error("Preview専用Deployment Sources policyを読取確認できません。生成を停止します。");
  }
  const rules = project.deploymentPolicy.deploymentSources;
  const environments = new Set<string>();
  for (const rule of rules) {
    if (!object(rule) || typeof rule.enabled !== "boolean" || !Array.isArray(rule.environments) || !rule.environments.length
      || !Array.isArray(rule.sources) || rule.sources.some((source) => typeof source !== "string" || !["cli", "deploy-hook", "git", "integration", "rest-api", "v0"].includes(source))
      || Object.keys(rule).some((key) => !["enabled", "environments", "sources"].includes(key))) throw new Error("Deployment Sources policyの形式を確認できません。");
    for (const env of rule.environments) {
      if (!object(env) || !(env.type === "system" && typeof env.target === "string" && ["preview", "production"].includes(env.target)
        && Object.keys(env).every((key) => ["type", "target"].includes(key))
        || env.type === "custom" && typeof env.environmentId === "string" && env.environmentId.length > 0
        && Object.keys(env).every((key) => ["type", "environmentId"].includes(key)))) throw new Error("policy環境の形式を確認できません。");
      const key = env.type === "system" ? String(env.target) : `custom:${env.environmentId}`;
      if (environments.has(key)) throw new Error("policy環境が重複しています。");
      environments.add(key);
    }
  }
  const preview = rules.filter((rule) => object(rule) && Array.isArray(rule.environments)
    && rule.environments.some((env) => object(env) && env.type === "system" && env.target === "preview"));
  if (preview.length !== 1) throw new Error("Preview policyが未設定・重複・継承のみです。生成を停止します。");
  const rule = preview[0];
  if (!object(rule) || rule.enabled !== true || !Array.isArray(rule.sources) || rule.sources.length !== 1 || rule.sources[0] !== "rest-api"
    || !Array.isArray(rule.environments) || !rule.environments.length
    || rule.environments.some((env) => !object(env) || env.type !== "system" || env.target !== "preview")) {
    throw new Error("PreviewだけにREST APIを許可するpolicyが有効ではありません。生成を停止します。");
  }
}

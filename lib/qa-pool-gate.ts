import { createHash } from "node:crypto";

export const MAX_GIT_CONFIG_BYTES = 64 * 1024;
export type GitConfigEvidence = { commitSha: string; blobSha: string };
export type GitConfigFile = { config: unknown; blobSha: string; size: number; path: "vercel.json" };

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Validate committed branch rules without changing Vercel settings. */
export function assertMainOnlyGitConfig(config: unknown): void {
  try {
    if (!object(config) || !Object.hasOwn(config, "git") || !object(config.git)
      || !Object.hasOwn(config.git, "deploymentEnabled") || !object(config.git.deploymentEnabled)) throw new Error();
    const rules = config.git.deploymentEnabled;
    if (!Object.hasOwn(rules, "**") || !Object.hasOwn(rules, "main") || rules["**"] !== false || rules.main !== true
      || Reflect.ownKeys(rules).some((branch) => typeof branch !== "string" || typeof rules[branch] !== "boolean"
        || (branch !== "main" && rules[branch] !== false))) throw new Error();
  } catch {
    throw new Error("vercel.jsonでmain以外のGit自動Preview停止を確認できません。");
  }
}

/** Validate a complete GitHub Contents file response and its Git blob identity. */
export function decodeGitConfigFile(response: unknown, expected?: { blobSha?: string }): GitConfigFile {
  try {
    if (!object(response) || response.type !== "file" || response.path !== "vercel.json" || response.name !== "vercel.json"
      || response.encoding !== "base64" || !Number.isSafeInteger(response.size) || Number(response.size) < 1
      || Number(response.size) > MAX_GIT_CONFIG_BYTES || typeof response.sha !== "string" || !/^[a-f0-9]{40}$/.test(response.sha)
      || typeof response.content !== "string" || response.content.length > MAX_GIT_CONFIG_BYTES * 2
      || Object.hasOwn(response, "target") || Object.hasOwn(response, "submodule_git_url")) throw new Error();
    if (expected?.blobSha !== undefined && (!/^[a-f0-9]{40}$/.test(expected.blobSha) || response.sha !== expected.blobSha)) throw new Error();
    const content = response.content.replace(/\r?\n/g, "");
    if (!content || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new Error();
    const bytes = Buffer.from(content, "base64");
    if (bytes.length !== response.size || bytes.length > MAX_GIT_CONFIG_BYTES || bytes.toString("base64") !== content) throw new Error();
    const blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (blobSha !== response.sha) throw new Error();
    const config: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertMainOnlyGitConfig(config);
    return { config, blobSha, size: bytes.length, path: "vercel.json" };
  } catch {
    throw new Error("GitHubのコミット固定vercel.jsonの形式・内容・blob SHAを確認できません。");
  }
}

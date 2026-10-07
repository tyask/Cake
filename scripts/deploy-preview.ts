import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PREVIEW_ALIAS = "cake-preview-fumin1.vercel.app";
type DeployEnvironment = Readonly<Record<string, string | undefined>>;
export type VercelCommandResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string };
export type VercelExecutor = (args: readonly string[], captureStdout: boolean) => Promise<VercelCommandResult>;
export type LinkedVercelProject = { orgId: string; projectId: string };
type DeployOptions = {
  environment?: DeployEnvironment;
  args?: readonly string[];
  scope?: string;
  execute?: VercelExecutor;
  log?: (message: string) => void;
};

const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function previewAlias(environment: DeployEnvironment): string {
  const alias = (environment.CAKE_PREVIEW_ALIAS ?? DEFAULT_PREVIEW_ALIAS).trim().toLowerCase();
  if (!hostPattern.test(alias)) {
    throw new Error("CAKE_PREVIEW_ALIAS はホスト名のみで設定してください（例: cake-preview-fumin1.vercel.app）。https:// やパスは含めません。");
  }
  return alias;
}

function deploymentUrl(stdout: string): string {
  const output = stdout.trim();
  try {
    if (/\s/.test(output) || !output.startsWith("https://")) throw new Error();
    const url = new URL(output);
    if (!hostPattern.test(url.hostname) || url.username || url.password || url.port
      || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error("デプロイ先のURLを確認できませんでした。固定URLは更新していません。");
  }
}

function validateDeployArgs(args: readonly string[]): void {
  const allowedArgs = new Set(["--logs", "--force", "--with-cache"]);
  if (args.some((arg) => !allowedArgs.has(arg))) {
    throw new Error("deploy:preview の追加引数は --logs・--force・--with-cache に対応しています。");
  }
}

const executeVercel: VercelExecutor = (args, captureStdout) => new Promise((resolveResult, reject) => {
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", [...args], {
    stdio: ["inherit", captureStdout ? "pipe" : "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.once("error", () => reject(new Error("Vercel CLIを起動できませんでした。Node.jsとnpxの設定を確認してください。")));
  child.once("close", (status, signal) => resolveResult({ status, signal, stdout }));
});

function readDirectoryProject(projectFile: string): LinkedVercelProject | null {
  if (!existsSync(projectFile)) return null;
  try {
    const project = JSON.parse(readFileSync(projectFile, "utf8"));
    if (typeof project?.orgId !== "string" || !project.orgId.trim()
      || typeof project?.projectId !== "string" || !project.projectId.trim()) return null;
    return { orgId: project.orgId, projectId: project.projectId };
  } catch {
    throw new Error("Vercelの接続情報を読み込めませんでした。npx vercel link で再接続してください。");
  }
}

function readLinkedProject(projectFile: string): LinkedVercelProject | null {
  // Vercel gives a working-directory project.json precedence over repo links.
  const direct = readDirectoryProject(projectFile);
  if (direct) return direct;

  const cwd = dirname(dirname(resolve(projectFile)));
  for (let root = cwd; root !== homedir(); root = dirname(root)) {
    const repoFile = resolve(root, ".vercel/repo.json");
    if (existsSync(repoFile)) {
      try {
        const repo = JSON.parse(readFileSync(repoFile, "utf8"));
        if (!Array.isArray(repo?.projects) || !repo.projects.length) throw new Error();
        const projects: { id?: unknown; directory?: unknown; orgId?: unknown }[] = repo.projects;
        const matches = projects.map((project) => {
          if (typeof project?.directory !== "string" || !project.directory.trim()
            || isAbsolute(project.directory)) throw new Error();
          const directory = resolve(root, project.directory);
          const fromRoot = relative(root, directory);
          if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error();
          const fromProject = relative(directory, cwd);
          const containsCwd = fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject);
          return { project, directory, containsCwd };
        }).filter((match) => match.containsCwd)
          .sort((a, b) => b.directory.length - a.directory.length);
        if (!matches.length || (matches[1] && matches[0].directory === matches[1].directory)) throw new Error();
        const project = matches[0].project;
        const orgId = project.orgId ?? repo.orgId;
        if (typeof orgId !== "string" || !orgId.trim()
          || typeof project.id !== "string" || !project.id.trim()) throw new Error();
        return { orgId, projectId: project.id };
      } catch {
        throw new Error("Vercelのリポジトリ接続情報から接続先を確認できませんでした。Cakeのディレクトリで npx vercel link を実行してください。");
      }
    }
    if (dirname(root) === root) break;
  }
  // `vercel pull` may store only settings here when repo.json owns the link.
  if (existsSync(projectFile)) {
    throw new Error("Vercelの接続情報を読み込めませんでした。npx vercel link で再接続してください。");
  }
  return null;
}

export async function ensureVercelProject({
  projectFile = resolve(".vercel/project.json"), execute = executeVercel, log = console.log,
}: { projectFile?: string; execute?: VercelExecutor; log?: (message: string) => void } = {}): Promise<LinkedVercelProject> {
  const existing = readLinkedProject(projectFile);
  if (existing) return existing;

  log("Cake: Vercelへの接続を設定します。利用するチームと既存のCakeプロジェクトを選択してください。");
  let linked: VercelCommandResult;
  try { linked = await execute(["vercel", "link"], false); }
  catch { throw new Error("Vercelへの接続を開始できませんでした。npx vercel login と npx vercel link を確認してください。"); }
  if (linked.status !== 0 || linked.signal) {
    throw new Error("Vercelへの接続が完了しませんでした。npx vercel login と npx vercel link を確認してください。");
  }
  const project = readLinkedProject(projectFile);
  if (!project) throw new Error("Vercelへの接続情報が保存されませんでした。npx vercel link で接続してください。");
  return project;
}

export async function runPreviewDeployment({
  environment = process.env, args = [], scope, execute = executeVercel, log = console.log,
}: DeployOptions = {}): Promise<{ deploymentUrl: string; fixedUrl: string }> {
  const alias = previewAlias(environment);
  validateDeployArgs(args);
  if (scope !== undefined && !/^[a-zA-Z0-9_-]+$/.test(scope)) {
    throw new Error("Vercelの接続先が不正です。npx vercel link で再接続してください。");
  }
  const scopeArgs = scope ? ["--scope", scope] : [];

  log("Cake: Previewのデプロイとビルド完了を待ちます。");
  let deployed: VercelCommandResult;
  try { deployed = await execute(["vercel", "deploy", "--target", "preview", ...args, ...scopeArgs], true); }
  catch {
    throw new Error("Previewのデプロイを実行できませんでした。Vercel CLIの設定を確認してください。固定URLは更新していません。");
  }
  if (deployed.status !== 0 || deployed.signal) {
    throw new Error("Previewのデプロイまたはビルドに失敗・中断しました。固定URLは更新していません。");
  }
  const url = deploymentUrl(deployed.stdout);
  log(`Cake: Previewを作成しました: ${url}`);

  const retry = `npx vercel alias set ${url} ${alias}${scope ? ` --scope ${scope}` : ""}`;
  const aliasError = `Previewのデプロイは成功しましたが、固定URLの更新を確認できませんでした。\nPreview: ${url}\n再試行: ${retry}`;
  let assigned: VercelCommandResult;
  try { assigned = await execute(["vercel", "alias", "set", url, alias, ...scopeArgs], false); }
  catch { throw new Error(aliasError); }
  if (assigned.status !== 0 || assigned.signal) throw new Error(aliasError);

  const fixedUrl = `https://${alias}`;
  log(`Cake: 固定Preview URL: ${fixedUrl}`);
  return { deploymentUrl: url, fixedUrl };
}

async function main() {
  // Read the CommonJS exports directly, as in the other Node/tsx scripts.
  const { loadEnvConfig } = createRequire(import.meta.url)("@next/env") as typeof import("@next/env");
  loadEnvConfig(process.cwd());
  const args = process.argv.slice(2);
  previewAlias(process.env);
  validateDeployArgs(args);
  const project = await ensureVercelProject();
  // Alias commands use the global CLI scope, so carry the linked team's ID to
  // both commands even when another team is selected in the global settings.
  const scope = project.orgId.startsWith("team_") ? project.orgId : undefined;
  await runPreviewDeployment({ args, scope });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Previewのデプロイに失敗しました。");
    process.exitCode = 1;
  });
}

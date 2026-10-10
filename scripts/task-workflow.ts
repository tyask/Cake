import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const CAKE_REPOSITORY = "tyask/Cake";
export const CAKE_VERCEL_PROJECT = "prj_Z37vquodhpRd08ZTAtYnP0qa59jD";
export const CAKE_VERCEL_SCOPE = "fumin1";
export const VERCEL_CLI_VERSION = "62.2.0";
export type WorkflowCommand = "git" | "npx" | "gh";
export type WorkflowCommandResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string };
export type WorkflowExecutor = (command: WorkflowCommand, args: readonly string[], cwd: string) => Promise<WorkflowCommandResult>;
export type TaskHead = { cwd: string; branch: string; sha: string };
export type TaskPreviewRecord = {
  projectId: string;
  branch: string;
  sha: string;
  url: string;
  deploymentId: string;
  createdAt: string;
};

export const executeWorkflowCommand: WorkflowExecutor = (command, args, cwd) => new Promise((resolveResult, reject) => {
  const executable = process.platform === "win32" && command === "npx" ? "npx.cmd" : command;
  const child = spawn(executable, [...args], {
    cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" && command === "npx",
  });
  let stdout = "";
  const timer = setTimeout(() => { child.kill(); }, 60_000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  // Do not print CLI responses or stderr: they can contain environment values.
  child.stderr.resume();
  child.once("error", () => {
    clearTimeout(timer);
    reject(new Error("コマンドを起動できませんでした。"));
  });
  child.once("close", (status, signal) => {
    clearTimeout(timer);
    resolveResult({ status, signal, stdout });
  });
});

export async function commandOutput(
  execute: WorkflowExecutor, command: WorkflowCommand, args: readonly string[], cwd: string, message: string,
): Promise<string> {
  let result: WorkflowCommandResult;
  try { result = await execute(command, args, cwd); }
  catch { throw new Error(message); }
  if (result.status !== 0 || result.signal) throw new Error(message);
  return result.stdout.trim();
}

export function validTaskBranch(branch: unknown): branch is string {
  if (typeof branch !== "string" || !/^codex\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch)) return false;
  const name = branch.slice("codex/".length);
  return name.length <= 60 && !["main", "preview", "production"].includes(name);
}

export async function cleanTaskHead(cwd: string, execute: WorkflowExecutor): Promise<TaskHead> {
  const root = await commandOutput(execute, "git", ["rev-parse", "--show-toplevel"], cwd,
    "CakeのGitリポジトリ内で実行してください。");
  const branch = await commandOutput(execute, "git", ["rev-parse", "--abbrev-ref", "HEAD"], root,
    "Gitブランチを確認できませんでした。");
  if (!validTaskBranch(branch)) throw new Error("タスク専用の codex/<task-name> ブランチで実行してください。");
  const status = await commandOutput(execute, "git", ["status", "--porcelain=v1", "--untracked-files=all"], root,
    "未コミット変更を確認できませんでした。");
  if (status) throw new Error("未コミット変更があります。検証対象の変更をコミットしてから実行してください。");
  const sha = await commandOutput(execute, "git", ["rev-parse", "HEAD"], root,
    "検証対象のコミットを確認できませんでした。");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("検証対象のコミットSHAが不正です。");
  const origin = await commandOutput(execute, "git", ["remote", "get-url", "origin"], root,
    "originの接続先を確認できませんでした。");
  if (!/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)tyask\/Cake(?:\.git)?$/.test(origin)) {
    throw new Error("originが tyask/Cake を指していません。Gitの接続先を確認してください。");
  }
  return { cwd: root, branch, sha };
}

export function previewUrl(value: unknown): string {
  try {
    if (typeof value !== "string" || !value || /\s/.test(value)) throw new Error();
    const input = value.startsWith("https://") ? value : `https://${value}`;
    const url = new URL(input);
    if (url.protocol !== "https:" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(url.hostname)
      || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash
      || (input !== url.origin && input !== `${url.origin}/`)) throw new Error();
    return url.origin;
  } catch {
    throw new Error("Deployment固有のVercel Preview URLを確認できませんでした。");
  }
}

export function previewRecordPath(cwd: string): string {
  return resolve(cwd, ".cake/preview.json");
}

export async function readPreviewRecord(cwd: string): Promise<TaskPreviewRecord> {
  try {
    const value = JSON.parse(await readFile(previewRecordPath(cwd), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.projectId !== CAKE_VERCEL_PROJECT || !validTaskBranch(value.branch)
      || typeof value.sha !== "string" || !/^[a-f0-9]{40}$/.test(value.sha)
      || typeof value.deploymentId !== "string" || !/^dpl_[a-zA-Z0-9_-]+$/.test(value.deploymentId)
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error();
    const url = previewUrl(value.url);
    if (url !== value.url) throw new Error();
    return { projectId: value.projectId, branch: value.branch, sha: value.sha, url,
      deploymentId: value.deploymentId, createdAt: value.createdAt };
  } catch {
    throw new Error("Previewの記録がないか不正です。npm run deploy:preview を実行し、Previewを検証してください。");
  }
}

export function pullRequestUrl(value: unknown): string {
  if (typeof value !== "string" || !/^https:\/\/github\.com\/tyask\/Cake\/pull\/[1-9][0-9]*$/.test(value)) {
    throw new Error("CakeのPR URLを確認できませんでした。GitHub上のPR一覧を確認してください。");
  }
  return value;
}

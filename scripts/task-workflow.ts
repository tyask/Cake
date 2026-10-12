import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_GIT_CONFIG_BYTES, assertMainOnlyGitConfig, decodeGitConfigFile } from "../lib/qa-pool-gate";
import { QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_TASK, SLOTS, replayDeployments, type Slot } from "../lib/qa-pool";

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
  slot: Slot;
  leaseId: string;
  prNumber: number;
  ledgerRecordId: number;
  database: { projectId: string; branchId: string; endpointId: string; host: string };
};

export type TaskPullRequest = { url: string; number: number; headRefOid: string; isDraft: boolean };

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

export async function assertTaskGitGate(head: TaskHead, execute: WorkflowExecutor): Promise<void> {
  const committed = await commandOutput(execute, "git", ["show", `${head.sha}:vercel.json`], head.cwd,
    "コミット済みvercel.jsonを確認できません。pushを開始しません。");
  try {
    if (Buffer.byteLength(committed, "utf8") > MAX_GIT_CONFIG_BYTES) throw new Error();
    assertMainOnlyGitConfig(JSON.parse(committed));
  } catch {
    throw new Error("コミット済みvercel.jsonで全feature枝のGit自動Preview停止を確認できません。pushを開始しません。");
  }
  const confirmed = await commandOutput(execute, "gh", ["variable", "get", "CAKE_QA_GIT_GATE_CONFIRMED", "--repo", CAKE_REPOSITORY], head.cwd,
    "Git自動Preview停止の確認設定を取得できません。運用者の確認が必要です。pushを開始しません。");
  if (confirmed !== "true") throw new Error("Git自動Preview停止は未確認です。運用者の確認が必要です。pushを開始しません。");
  const response = await commandOutput(execute, "npx", ["--yes", `vercel@${VERCEL_CLI_VERSION}`, "api",
    `/v9/projects/${CAKE_VERCEL_PROJECT}`, "--scope", CAKE_VERCEL_SCOPE, "--method", "GET"], head.cwd,
  "Vercelのproject接続設定を読み取れません。pushを開始しません。");
  try {
    const project = JSON.parse(response);
    if (project.id !== CAKE_VERCEL_PROJECT || project.name !== "cake" || project.accountId !== "team_D1Mcx2TdFWPKcypfu8KzNMub"
      || project.previewDeploymentsDisabled !== false || project.link?.type !== "github" || project.link.org !== "tyask"
      || project.link.repo !== "Cake" || project.link.productionBranch !== "main") throw new Error();
  } catch { throw new Error("対象project/team/repositoryとmainへの接続設定を確認できません。pushを開始しません。"); }
  const main = await commandOutput(execute, "gh", ["api", "--method", "GET", `repos/${CAKE_REPOSITORY}/branches/main`], head.cwd,
    "GitHubのmainコミットを読み取れません。pushを開始しません。");
  let mainSha: string;
  try {
    const branch = JSON.parse(main);
    if (branch.name !== "main" || typeof branch.commit?.sha !== "string" || !/^[a-f0-9]{40}$/.test(branch.commit.sha)) throw new Error();
    mainSha = branch.commit.sha;
  } catch { throw new Error("GitHubのmain完全SHAを確認できません。pushを開始しません。"); }
  const mainConfig = await commandOutput(execute, "gh", ["api", "--method", "GET",
    `repos/${CAKE_REPOSITORY}/contents/vercel.json?ref=${mainSha}`], head.cwd,
  "GitHubのmainにあるvercel.jsonを読み取れません。pushを開始しません。");
  try { decodeGitConfigFile(JSON.parse(mainConfig)); }
  catch { throw new Error("mainのコミット済みvercel.jsonでGit自動Preview停止を確認できません。mainへの設定反映と全有効枝の確認が必要です。pushを開始しません。"); }
}

export async function taskPullRequests(head: TaskHead, execute: WorkflowExecutor): Promise<TaskPullRequest[]> {
  const listed = await commandOutput(execute, "gh", ["pr", "list", "--repo", CAKE_REPOSITORY, "--base", "main",
    "--head", head.branch, "--state", "open", "--json", "url,number,headRefOid,isDraft"], head.cwd,
  "既存PRを確認できませんでした。gh auth status とGitHubへの接続を確認してください。");
  let value: unknown;
  try { value = JSON.parse(listed); }
  catch { throw new Error("GitHubのPR一覧を読み込めませんでした。"); }
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error("GitHubのPR一覧を読み込めませんでした。");
  }
  if (value.length > 1) throw new Error("同じブランチのPRが複数あります。GitHubのPR一覧を確認してください。");
  return value.map((entry: Record<string, unknown>) => {
    if (!Number.isSafeInteger(entry.number) || (entry.number as number) < 1
      || typeof entry.headRefOid !== "string" || !/^[a-f0-9]{40}$/.test(entry.headRefOid)
      || typeof entry.isDraft !== "boolean") throw new Error("GitHubのPR情報が不正です。");
    const url = pullRequestUrl(entry.url);
    if (url !== `https://github.com/${CAKE_REPOSITORY}/pull/${entry.number}`) throw new Error("GitHubのPR情報が不正です。");
    return { url, number: entry.number as number, headRefOid: entry.headRefOid, isDraft: entry.isDraft };
  });
}

export async function readyQaPreview(head: TaskHead, prNumber: number, execute: WorkflowExecutor): Promise<TaskPreviewRecord | null> {
  const listed = await commandOutput(execute, "gh", ["api", "--paginate", "--slurp",
    `repos/${CAKE_REPOSITORY}/deployments?task=${QA_TASK}&environment=${QA_ENVIRONMENT}&per_page=100`], head.cwd,
  "固定QAの台帳を取得できませんでした。GitHubへの接続と権限を確認してください。");
  let snapshots: ReturnType<typeof replayDeployments>;
  try {
    const pages: unknown = JSON.parse(listed);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error();
    snapshots = replayDeployments(pages.flat() as Parameters<typeof replayDeployments>[0]);
  } catch { throw new Error("固定QAの台帳を読み込めませんでした。"); }
  const matches = SLOTS.map((slot) => ({ slot, snapshot: snapshots[slot] }))
    .filter(({ snapshot }) => snapshot?.payload.pr === prNumber && snapshot.payload.state !== "free");
  if (matches.length > 1) throw new Error("同じPRに複数のQA枠があります。固定QAの台帳を確認してください。");
  const match = matches[0];
  if (!match?.snapshot) return null;
  const { payload, id } = match.snapshot;
  if (payload.state === "deleting") throw new Error("このPRのQA枠は返却処理中です。完了後に再予約してください。");
  if (payload.branch !== head.branch || payload.headSha !== head.sha || payload.aliasSha !== head.sha
    || !payload.readyDeploymentId || !payload.database) return null;
  const deployment = payload.deployments.find((entry) => entry.id === payload.readyDeploymentId);
  if (!deployment || deployment.sha !== head.sha || deployment.phase !== "application" || !deployment.url) {
    throw new Error("固定QAの成功Deploymentと台帳が一致しません。");
  }
  return { projectId: CAKE_VERCEL_PROJECT, branch: head.branch, sha: head.sha,
    url: previewUrl(deployment.url), deploymentId: deployment.id, createdAt: payload.updatedAt,
    slot: match.slot, leaseId: payload.leaseId, prNumber, ledgerRecordId: id, database: { ...payload.database } };
}

export async function readPreviewRecord(cwd: string): Promise<TaskPreviewRecord> {
  try {
    const value = JSON.parse(await readFile(previewRecordPath(cwd), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.projectId !== CAKE_VERCEL_PROJECT || !validTaskBranch(value.branch)
      || typeof value.sha !== "string" || !/^[a-f0-9]{40}$/.test(value.sha)
      || typeof value.deploymentId !== "string" || !/^dpl_[a-zA-Z0-9_-]+$/.test(value.deploymentId)
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || !SLOTS.includes(value.slot) || typeof value.leaseId !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.leaseId)
      || !Number.isSafeInteger(value.prNumber) || value.prNumber < 1
      || !Number.isSafeInteger(value.ledgerRecordId) || value.ledgerRecordId < 1
      || !value.database || value.database.projectId !== QA_NEON_PROJECT_ID
      || typeof value.database.branchId !== "string" || !/^br-[a-z0-9-]+$/.test(value.database.branchId)
      || typeof value.database.endpointId !== "string" || !/^ep-[a-z0-9-]+$/.test(value.database.endpointId)
      || typeof value.database.host !== "string" || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(value.database.host)) throw new Error();
    const url = previewUrl(value.url);
    if (url !== value.url) throw new Error();
    return { projectId: value.projectId, branch: value.branch, sha: value.sha, url,
      deploymentId: value.deploymentId, createdAt: value.createdAt, slot: value.slot, leaseId: value.leaseId,
      prNumber: value.prNumber, ledgerRecordId: value.ledgerRecordId, database: { projectId: value.database.projectId,
        branchId: value.database.branchId, endpointId: value.database.endpointId, host: value.database.host } };
  } catch {
    throw new Error("固定QAのPreview記録がないか不正です。npm run deploy:preview を実行し、Previewを検証してください。");
  }
}

export function pullRequestUrl(value: unknown): string {
  if (typeof value !== "string" || !/^https:\/\/github\.com\/tyask\/Cake\/pull\/[1-9][0-9]*$/.test(value)) {
    throw new Error("CakeのPR URLを確認できませんでした。GitHub上のPR一覧を確認してください。");
  }
  return value;
}

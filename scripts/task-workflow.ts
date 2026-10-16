import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MAX_GIT_CONFIG_BYTES, assertMainOnlyGitConfig, decodeGitConfigFile } from "../lib/qa-pool-gate";
import { QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_TASK, SLOTS, qaAlias, replayDeployments, type Slot } from "../lib/qa-pool";
import type { OwnerApprovalState } from "../lib/qa-owner-approval";
import { HttpOwnerApprovalStore } from "./qa-owner-store";
import canneleManifest from "../docs/cannele/resource-manifest.json";

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
  fixedUrl?: string;
  deploymentId: string;
  createdAt: string;
  slot: Slot;
  leaseId: string;
  prNumber: number;
  ledgerRecordId: number;
  database: { projectId: string; branchId: string; endpointId: string; host: string };
};

export type PreviewProviderReader = (path: string) => Promise<unknown>;
export const readPreviewProvider: PreviewProviderReader = async (path) => {
  if (!process.env.VERCEL_TOKEN) throw new Error("固定QAのalias読取には既存VERCEL_TOKENが必要です。");
  try {
    const url = new URL(path, "https://api.vercel.com");
    if (url.origin !== "https://api.vercel.com") throw new Error();
    url.searchParams.set("teamId", "team_D1Mcx2TdFWPKcypfu8KzNMub");
    const response = await fetch(url, { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch { throw new Error("固定QAのprovider読取を確認できませんでした。"); }
};

export type TaskPullRequest = { url: string; number: number; headRefOid: string; isDraft: boolean };

export const executeWorkflowCommand: WorkflowExecutor = (command, args, cwd) => new Promise((resolveResult, reject) => {
  const executable = process.platform === "win32" && command === "npx" ? "npx.cmd" : command;
  const child = spawn(executable, [...args], {
    cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" && command === "npx",
    env: { ...process.env, GH_HOST: "github.com" },
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
  return (await commandText(execute, command, args, cwd, message)).trim();
}

async function commandText(
  execute: WorkflowExecutor, command: WorkflowCommand, args: readonly string[], cwd: string, message: string,
): Promise<string> {
  let result: WorkflowCommandResult;
  try { result = await execute(command, args, cwd); }
  catch { throw new Error(message); }
  if (result.status !== 0 || result.signal) throw new Error(message);
  return result.stdout;
}

export function validTaskBranch(branch: unknown): branch is string {
  if (typeof branch !== "string" || !branch.startsWith("codex/")) return false;
  const name = branch.slice("codex/".length);
  if (name.length > 60) return false;
  // Only this repository's reviewed instance may introduce a path segment.
  // Other generations and recursive paths cannot enter draft/source/Ready flows.
  const task = name.includes("/")
    ? branch.startsWith(canneleManifest.repository.featureBranchPrefix) ? branch.slice(canneleManifest.repository.featureBranchPrefix.length) : ""
    : name;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task) && !/[\r\n]/.test(task) && !["main", "preview", "production"].includes(task);
}

export async function cleanTaskHead(cwd: string, execute: WorkflowExecutor): Promise<TaskHead> {
  const root = await commandOutput(execute, "git", ["rev-parse", "--show-toplevel"], cwd,
    "CakeのGitリポジトリ内で実行してください。");
  const branch = await commandOutput(execute, "git", ["rev-parse", "--abbrev-ref", "HEAD"], root,
    "Gitブランチを確認できませんでした。");
  if (!validTaskBranch(branch)) throw new Error("タスク専用の codex/<task-name> または現在のCannele世代のブランチで実行してください。");
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

export async function assertTaskGitGate(head: TaskHead, execute: WorkflowExecutor): Promise<string> {
  const committed = await commandText(execute, "git", ["show", `${head.sha}:vercel.json`], head.cwd,
    "コミット済みvercel.jsonを確認できません。pushを開始しません。");
  let localBlobSha: string;
  try {
    if (Buffer.byteLength(committed, "utf8") > MAX_GIT_CONFIG_BYTES) throw new Error();
    assertMainOnlyGitConfig(JSON.parse(committed));
    const bytes = Buffer.from(committed);
    localBlobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  } catch {
    throw new Error("コミット済みvercel.jsonで全feature枝のGit自動Preview停止を確認できません。pushを開始しません。");
  }
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
  const blob = await commandOutput(execute, "git", ["rev-parse", `${head.sha}:vercel.json`], head.cwd,
    "対象HEADのvercel.json blobを確認できません。pushを開始しません。");
  if (blob !== localBlobSha) throw new Error("対象HEADのGit設定とblobが一致しません。pushを開始しません。");
  return mainSha;
}

/** Reuse completed immutable run evidence while polling; all reads and incomplete evidence stay fresh. */
export function createTaskPreviewApprovalReader(head: TaskHead, mainSha: string, execute: WorkflowExecutor,
  now: () => number = Date.now): (prNumber: number) => Promise<OwnerApprovalState | null> {
  const api = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    if (method !== "GET" || body !== undefined || !(path === `/repos/${CAKE_REPOSITORY}` || path.startsWith(`/repos/${CAKE_REPOSITORY}/`))) throw new Error();
    return JSON.parse(await commandOutput(execute, "gh", ["api", "--method", "GET", path.slice(1)], head.cwd,
      "固定QAの承認記録を読み取れませんでした。"));
  };
  const store = new HttpOwnerApprovalStore({}, api, async () => { throw new Error(); }, now);
  return async (prNumber) => {
    try {
      const main = await api(`/repos/${CAKE_REPOSITORY}/branches/main`) as { name?: unknown; commit?: { sha?: unknown } };
      if (main.name !== "main" || main.commit?.sha !== mainSha) throw new Error();
      const states = await store.states();
      return [...states.values()].filter(({ plan }) => plan.action === "preview" && plan.pr === prNumber
        && plan.branch === head.branch && plan.sha === head.sha && plan.generatedMainSha === mainSha)
        .sort((a, b) => b.planId - a.planId)[0] ?? null;
    } catch { throw new Error("現在main・HEADの固定QA承認と実行元を確認できませんでした。mainとActionsの承認記録を確認してください。"); }
  };
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

async function qaSnapshots(head: TaskHead, execute: WorkflowExecutor): Promise<ReturnType<typeof replayDeployments>> {
  const listed = await commandOutput(execute, "gh", ["api", "--paginate", "--slurp",
    `repos/${CAKE_REPOSITORY}/deployments?task=${QA_TASK}&environment=${QA_ENVIRONMENT}&per_page=100`], head.cwd,
  "固定QAの台帳を取得できませんでした。GitHubへの接続と権限を確認してください。");
  let snapshots: ReturnType<typeof replayDeployments>;
  try {
    const pages: unknown = JSON.parse(listed);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error();
    snapshots = replayDeployments(pages.flat() as Parameters<typeof replayDeployments>[0]);
  } catch { throw new Error("固定QAの台帳を読み込めませんでした。"); }
  return snapshots;
}

export async function readyQaPreview(head: TaskHead, prNumber: number, execute: WorkflowExecutor,
  provider: PreviewProviderReader = readPreviewProvider): Promise<TaskPreviewRecord | null> {
  const snapshots = await qaSnapshots(head, execute);
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
  const fixedUrl = `https://${qaAlias(match.slot)}`;
  try {
    if (payload.aliasAssignment && (payload.aliasAssignment.state !== "assigned"
      || payload.aliasAssignment.sha !== head.sha || payload.aliasAssignment.deploymentId !== deployment.id
      || payload.aliasAssignment.alias !== qaAlias(match.slot))) throw new Error();
    const object = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    };
    const teamClaims = (value: Record<string, unknown>) => {
      const expected = "team_D1Mcx2TdFWPKcypfu8KzNMub";
      for (const key of ["teamId", "ownerId", "accountId"]) if (value[key] !== undefined && value[key] !== expected) throw new Error();
      for (const key of ["team", "owner"]) {
        if (value[key] === undefined) continue;
        if (typeof value[key] === "string") { if (value[key] !== expected) throw new Error(); continue; }
        const owner = object(value[key]);
        if (owner.id === undefined && owner.uid === undefined || owner.id !== undefined && owner.id !== expected
          || owner.uid !== undefined && owner.uid !== expected) throw new Error();
      }
    };
    const project = object(await provider(`/v9/projects/${CAKE_VERCEL_PROJECT}`));
    const link = object(project.link);
    if (project.id !== CAKE_VERCEL_PROJECT || project.name !== "cake" || project.accountId !== "team_D1Mcx2TdFWPKcypfu8KzNMub"
      || link.type !== "github" || link.org !== "tyask" || link.repo !== "Cake" || link.productionBranch !== "main") throw new Error();
    const alias = object(await provider(`/v4/aliases/${qaAlias(match.slot)}`));
    teamClaims(alias);
    const aliasDeployment = alias.deployment === undefined ? undefined : object(alias.deployment);
    const aliasId = alias.deploymentId ?? aliasDeployment?.id;
    if (alias.projectId !== CAKE_VERCEL_PROJECT || aliasId !== deployment.id
      || aliasDeployment?.id !== undefined && aliasDeployment.id !== aliasId
      || aliasDeployment?.projectId !== undefined && aliasDeployment.projectId !== CAKE_VERCEL_PROJECT
      || alias.alias !== undefined && alias.alias !== qaAlias(match.slot)) throw new Error();
    const remote = object(await provider(`/v13/deployments/${deployment.id}?withGitRepoInfo=true`));
    teamClaims(remote);
    const meta = object(remote.meta), git = remote.gitSource === undefined ? {} : object(remote.gitSource);
    if ((remote.id ?? remote.uid) !== deployment.id || remote.id !== undefined && remote.uid !== undefined && remote.id !== remote.uid
      || remote.projectId !== CAKE_VERCEL_PROJECT
      || !(remote.target === null || remote.target === undefined || remote.target === "preview")
      || (remote.readyState ?? remote.state) !== "READY" || meta.cakeQaPhase !== "application"
      || meta.cakeQaLeaseId !== payload.leaseId || Number(meta.cakeQaPr) !== prNumber
      || (git.ref ?? meta.githubCommitRef) !== head.branch || (git.sha ?? meta.githubCommitSha) !== head.sha
      || git.ref !== undefined && meta.githubCommitRef !== undefined && git.ref !== meta.githubCommitRef
      || git.sha !== undefined && meta.githubCommitSha !== undefined && git.sha !== meta.githubCommitSha
      || previewUrl(remote.url) !== previewUrl(deployment.url)) throw new Error();
    const remainingAlias = object(await provider(`/v4/aliases/${qaAlias(match.slot)}`));
    teamClaims(remainingAlias);
    const remainingDeployment = remainingAlias.deployment === undefined ? undefined : object(remainingAlias.deployment);
    if (remainingAlias.projectId !== CAKE_VERCEL_PROJECT || (remainingAlias.deploymentId ?? remainingDeployment?.id) !== deployment.id
      || remainingDeployment?.id !== undefined && remainingDeployment.id !== deployment.id
      || remainingDeployment?.projectId !== undefined && remainingDeployment.projectId !== CAKE_VERCEL_PROJECT
      || remainingAlias.alias !== undefined && remainingAlias.alias !== qaAlias(match.slot)
      || alias.uid !== undefined && remainingAlias.uid !== alias.uid) throw new Error();
    const pr = object(JSON.parse(await commandOutput(execute, "gh", ["api", "--method", "GET",
      `repos/${CAKE_REPOSITORY}/pulls/${prNumber}`], head.cwd, "現在PRのHEADを読み取れませんでした。")));
    const prHead = object(pr.head), prBase = object(pr.base), prRepo = object(prHead.repo);
    if (pr.number !== prNumber || pr.state !== "open" || prHead.ref !== head.branch || prHead.sha !== head.sha
      || prBase.ref !== "main" || prRepo.full_name !== CAKE_REPOSITORY) throw new Error();
    const latest = (await qaSnapshots(head, execute))[match.slot];
    if (!latest || latest.id !== id || !isDeepStrictEqual(latest.payload, payload)) throw new Error();
  } catch { throw new Error("現在HEADのREADY deployment・固定alias・貸出の一致を確認できませんでした。"); }
  return { projectId: CAKE_VERCEL_PROJECT, branch: head.branch, sha: head.sha,
    url: previewUrl(deployment.url), fixedUrl, deploymentId: deployment.id, createdAt: payload.updatedAt,
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
    const fixedUrl = value.fixedUrl === undefined ? undefined : `https://${qaAlias(value.slot)}`;
    if (value.fixedUrl !== undefined && value.fixedUrl !== fixedUrl) throw new Error();
    return { projectId: value.projectId, branch: value.branch, sha: value.sha, url,
      ...(fixedUrl ? { fixedUrl } : {}),
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

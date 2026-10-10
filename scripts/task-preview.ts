import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAKE_VERCEL_PROJECT, CAKE_VERCEL_SCOPE, VERCEL_CLI_VERSION, cleanTaskHead, commandOutput,
  executeWorkflowCommand, previewRecordPath, previewUrl, type TaskHead, type TaskPreviewRecord, type WorkflowExecutor,
} from "./task-workflow";

type TaskPreviewOptions = {
  args?: readonly string[];
  cwd?: string;
  execute?: WorkflowExecutor;
  log?: (message: string) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

type Deployment = { id: string; url: unknown; state: string; created: number };

function matchingDeployment(stdout: string, head: TaskHead): Deployment | null {
  let payload: unknown;
  try { payload = JSON.parse(stdout); }
  catch { throw new Error("VercelのDeployment一覧を読み込めませんでした。"); }
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { deployments?: unknown }).deployments)) {
    throw new Error("VercelのDeployment一覧の形式が不正です。");
  }
  const deployments = (payload as { deployments: unknown[] }).deployments;
  const matches: Deployment[] = [];
  for (const value of deployments) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const meta = entry.meta as Record<string, unknown> | undefined;
    if (entry.projectId !== CAKE_VERCEL_PROJECT || !(entry.target === null || entry.target === "preview")
      || entry.source !== "git" || !meta || typeof meta !== "object" || Array.isArray(meta)
      || meta.githubCommitRef !== head.branch || meta.githubCommitSha !== head.sha
      || meta.gitDirty === "1" || meta.gitDirty === true || meta.gitDirty === 1) continue;
    const id = entry.uid ?? entry.id;
    const state = entry.readyState ?? entry.state;
    if (typeof id !== "string" || !/^dpl_[a-zA-Z0-9_-]+$/.test(id) || typeof state !== "string") {
      throw new Error("対象PreviewのDeployment情報が不正です。");
    }
    const created = entry.createdAt ?? entry.created;
    matches.push({ id, state, url: entry.url, created: typeof created === "number" ? created : 0 });
  }
  return matches.sort((a, b) => b.created - a.created)[0] ?? null;
}

export async function runTaskPreview({
  args = [], cwd = process.cwd(), execute = executeWorkflowCommand, log = console.log,
  now = Date.now, sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  timeoutMs = 15 * 60_000, pollIntervalMs = 10_000,
}: TaskPreviewOptions = {}): Promise<TaskPreviewRecord> {
  if (args.length) throw new Error("deploy:previewは追加引数なしで実行してください。GitブランチをpushしてPreviewを作成します。");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Previewの待機時間が不正です。");
  }
  const head = await cleanTaskHead(cwd, execute);
  log(`Cake: ${head.branch} (${head.sha.slice(0, 7)}) をpushします。`);
  await commandOutput(execute, "git", ["push", "--set-upstream", "origin", head.branch], head.cwd,
    "ブランチのpushに失敗しました。Gitの接続と認証を確認してください。");
  // A failed new deployment must not leave an older success usable for PR creation.
  await rm(previewRecordPath(head.cwd), { force: true });

  const endpoint = `/v6/deployments?projectId=${CAKE_VERCEL_PROJECT}&sha=${head.sha}&target=preview&limit=20`;
  const deadline = now() + timeoutMs;
  let previousState: string | null = null;
  log("Cake: Git連携によるPreviewの作成とビルド完了を待ちます。");
  while (now() < deadline) {
    const stdout = await commandOutput(execute, "npx", ["--yes", `vercel@${VERCEL_CLI_VERSION}`, "api", endpoint,
      "--scope", CAKE_VERCEL_SCOPE, "--method", "GET"], head.cwd,
    "VercelのPreview状態を取得できませんでした。Vercel CLIのログインと接続先を確認してください。");
    const deployment = matchingDeployment(stdout, head);
    if (deployment) {
      if (["ERROR", "CANCELED", "BLOCKED"].includes(deployment.state)) {
        throw new Error(`Previewのビルドが ${deployment.state} で停止しました。Vercel上のDeploymentログを確認してください。`);
      }
      if (deployment.state === "READY") {
        const url = previewUrl(deployment.url);
        const current = await cleanTaskHead(head.cwd, execute);
        if (current.branch !== head.branch || current.sha !== head.sha) {
          throw new Error("待機中にブランチまたはコミットが変更されました。現在の変更でdeploy:previewを再実行してください。");
        }
        const record: TaskPreviewRecord = { projectId: CAKE_VERCEL_PROJECT, branch: head.branch, sha: head.sha,
          url, deploymentId: deployment.id, createdAt: new Date(now()).toISOString() };
        const recordFile = previewRecordPath(head.cwd);
        await mkdir(dirname(recordFile), { recursive: true, mode: 0o700 });
        const temporaryFile = `${recordFile}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
          await rename(temporaryFile, recordFile);
        } finally {
          await rm(temporaryFile, { force: true });
        }
        log(`Cake: Preview READY: ${url}`);
        log("Cake: このURLでAPI・画面を確認し、検証結果を記録してから npm run task:pr を実行してください。");
        return record;
      }
      if (!["QUEUED", "INITIALIZING", "BUILDING"].includes(deployment.state)) {
        throw new Error("対象PreviewのDeployment状態を確認できませんでした。");
      }
      if (deployment.state !== previousState) {
        log(`Cake: Preview ${deployment.state}`);
        previousState = deployment.state;
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  throw new Error("Previewの作成が待機時間内に完了しませんでした。Git連携とVercelのDeployment状態を確認し、deploy:previewを再実行してください。");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runTaskPreview({ args: process.argv.slice(2) }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "タスク用Previewの作成に失敗しました。");
    process.exitCode = 1;
  });
}

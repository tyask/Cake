import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAKE_REPOSITORY, assertTaskGitGate, cleanTaskHead, commandOutput, createTaskPreviewApprovalReader, executeWorkflowCommand, previewRecordPath,
  readyQaPreview, taskPullRequests, type TaskPreviewRecord, type WorkflowExecutor,
  type PreviewProviderReader,
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
  provider?: PreviewProviderReader;
};

export type TaskPreviewWaiting = { status: "WAIT_APPROVAL"; planId: number; workflowUrl: string };

export async function runTaskPreview({
  args = [], cwd = process.cwd(), execute = executeWorkflowCommand, log = console.log,
  now = Date.now, sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  timeoutMs = 15 * 60_000, pollIntervalMs = 10_000, provider,
}: TaskPreviewOptions = {}): Promise<TaskPreviewRecord | TaskPreviewWaiting> {
  if (args.length) throw new Error("deploy:previewは追加引数なしで実行してください。PRの固定QA枠を待ちます。");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Previewの待機時間が不正です。");
  }
  const head = await cleanTaskHead(cwd, execute);
  const requests = await taskPullRequests(head, execute);
  const request = requests[0];
  if (!request) throw new Error("固定QAには先にdraft PRが必要です。npm run task:pr -- --draft --title '<タイトル>' --verification-file '<報告ファイル>' を実行してください。");
  const mainSha = await assertTaskGitGate(head, execute);
  log(`Cake: ${head.branch} (${head.sha.slice(0, 7)}) をpushします。`);
  // A failed or pending deployment must not leave older evidence usable.
  await rm(previewRecordPath(head.cwd), { force: true });
  await commandOutput(execute, "git", ["push", "origin", `${head.sha}:refs/heads/${head.branch}`], head.cwd,
    "ブランチのpushに失敗しました。Gitの接続と認証を確認してください。");
  const remote = await commandOutput(execute, "git", ["ls-remote", "--heads", "origin", `refs/heads/${head.branch}`], head.cwd,
    "push後のoriginのコミットを確認できませんでした。");
  const pushedRequests = await taskPullRequests(head, execute);
  if (remote !== `${head.sha}\trefs/heads/${head.branch}` || pushedRequests[0]?.number !== request.number
    || pushedRequests[0].headRefOid !== head.sha) throw new Error("push後のブランチまたはPRのHEADが一致しません。現在のHEADでdeploy:previewを再実行してください。");
  const pushedHead = await cleanTaskHead(head.cwd, execute);
  if (pushedHead.sha !== head.sha || pushedHead.branch !== head.branch) {
    throw new Error("push中にブランチまたはコミットが変更されました。現在の変更でdeploy:previewを再実行してください。");
  }
  await commandOutput(execute, "gh", ["workflow", "run", "qa-pool.yml", "--repo", CAKE_REPOSITORY,
    "--ref", "main", "-f", "action=request-preview", "-f", `pr_number=${request.number}`, "-f", `source_sha=${head.sha}`], head.cwd,
  "固定QAの承認計画を要求できませんでした。Actionsの実行とGitHubへの接続を確認してください。");

  const deadline = now() + timeoutMs;
  const readApproval = createTaskPreviewApprovalReader(head, mainSha, execute, now);
  log(`Cake: PR #${request.number} の同じHEADの承認計画を待ちます。満枠時は待機します。`);
  while (now() < deadline) {
    const approval = await readApproval(request.number);
    if (approval?.status === "PENDING") {
      const workflowUrl = `https://github.com/${CAKE_REPOSITORY}/actions/runs/${approval.plan.runId}`;
      log(`Cake: WAIT_APPROVAL 計画ID ${approval.planId} (PR #${request.number} / ${head.sha})`);
      log(`Cake: 計画を確認: ${workflowUrl}`);
      log(`Cake: 本人承認: npm run qa:approve -- --plan-id ${approval.planId}`);
      log("Cake: 承認Actionsの成功確認後に npm run deploy:preview を再実行してください。");
      return { status: "WAIT_APPROVAL", planId: approval.planId, workflowUrl };
    }
    const record = approval?.status === "APPROVED" ? await readyQaPreview(head, request.number, execute, provider) : null;
    if (record) {
      const current = await cleanTaskHead(head.cwd, execute);
      if (current.branch !== head.branch || current.sha !== head.sha) {
        throw new Error("待機中にブランチまたはコミットが変更されました。現在の変更でdeploy:previewを再実行してください。");
      }
      const recordFile = previewRecordPath(head.cwd);
      await mkdir(dirname(recordFile), { recursive: true, mode: 0o700 });
      const temporaryFile = `${recordFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporaryFile, recordFile);
      } finally {
        await rm(temporaryFile, { force: true });
      }
      log(`Cake: ${record.slot} Preview READY: ${record.fixedUrl}`);
      log(`Cake: 診断用Deployment URL: ${record.url}`);
      log("Cake: 固定QA URLでAPI・画面を確認し、検証結果を記録してから npm run task:pr を実行してください。");
      return record;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  throw new Error("固定QAの承認計画またはPreviewが待機時間内に完了しませんでした。QA poolの承認・待機枠・Actionsを確認し、deploy:previewを再実行してください。");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void import("./task-preview-registry").then(({ runTaskPreviewRegistry }) => runTaskPreviewRegistry({ args: process.argv.slice(2) })).then((result) => {
    if (result.status === "FULL") process.exitCode = 2;
  }).catch(() => {
    console.error("タスク用Previewを確認できません。現在の貸出・Actions・CLI認証を確認してください。秘密情報は表示しません。");
    process.exitCode = 1;
  });
}

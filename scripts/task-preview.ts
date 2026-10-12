import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAKE_REPOSITORY, assertTaskGitGate, cleanTaskHead, commandOutput, executeWorkflowCommand, previewRecordPath,
  readyQaPreview, taskPullRequests, type TaskPreviewRecord, type WorkflowExecutor,
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

export async function runTaskPreview({
  args = [], cwd = process.cwd(), execute = executeWorkflowCommand, log = console.log,
  now = Date.now, sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  timeoutMs = 15 * 60_000, pollIntervalMs = 10_000,
}: TaskPreviewOptions = {}): Promise<TaskPreviewRecord> {
  if (args.length) throw new Error("deploy:previewは追加引数なしで実行してください。PRの固定QA枠を待ちます。");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Previewの待機時間が不正です。");
  }
  const head = await cleanTaskHead(cwd, execute);
  const enabled = await commandOutput(execute, "gh", ["variable", "get", "CAKE_QA_POOL_ENABLED", "--repo", CAKE_REPOSITORY], head.cwd,
    "固定QAは未有効または設定を確認できません。設定・承認・DB/retentionの確認後に有効化してください。");
  if (enabled !== "true") throw new Error("固定QAは未有効です。設定・承認・DB/retentionの確認後に有効化してください。");
  const requests = await taskPullRequests(head, execute);
  const request = requests[0];
  if (!request) throw new Error("固定QAには先にdraft PRが必要です。npm run task:pr -- --draft --title '<タイトル>' --verification-file '<報告ファイル>' を実行してください。");
  await assertTaskGitGate(head, execute);
  log(`Cake: ${head.branch} (${head.sha.slice(0, 7)}) をpushします。`);
  // A failed or pending deployment must not leave older evidence usable.
  await rm(previewRecordPath(head.cwd), { force: true });
  await commandOutput(execute, "git", ["push", "--set-upstream", "origin", head.branch], head.cwd,
    "ブランチのpushに失敗しました。Gitの接続と認証を確認してください。");

  const deadline = now() + timeoutMs;
  log(`Cake: PR #${request.number} の固定QA枠と同じHEADの成功を待ちます。満枠時は待機します。`);
  while (now() < deadline) {
    const record = await readyQaPreview(head, request.number, execute);
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
      log(`Cake: ${record.slot} Preview READY: ${record.url}`);
      log("Cake: このURLでAPI・画面を確認し、検証結果を記録してから npm run task:pr を実行してください。");
      return record;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  throw new Error("固定QAのPreviewが待機時間内に完了しませんでした。QA poolの承認・待機枠・Actions/Deploymentを確認し、deploy:previewを再実行してください。");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runTaskPreview({ args: process.argv.slice(2) }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "タスク用Previewの作成に失敗しました。");
    process.exitCode = 1;
  });
}

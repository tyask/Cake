import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAKE_REPOSITORY, assertTaskGitGate, cleanTaskHead, commandOutput, executeWorkflowCommand, pullRequestUrl,
  readPreviewRecord, readyQaPreview, taskPullRequests, type WorkflowExecutor,
} from "./task-workflow";

type TaskPrOptions = { args?: readonly string[]; cwd?: string; execute?: WorkflowExecutor; log?: (message: string) => void };

function prArguments(args: readonly string[]): { title: string; verificationFile: string; draft: boolean } {
  const values = new Map<string, string>();
  let draft = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--draft") {
      if (draft) throw new Error("--draft は一度だけ指定してください。");
      draft = true;
      continue;
    }
    const value = args[++index];
    if (!["--title", "--verification-file"].includes(key) || values.has(key)
      || value === undefined || !value.trim() || value.startsWith("--")) {
      throw new Error("npm run task:pr -- --title '変更内容' --verification-file /path/report.md を指定してください。");
    }
    values.set(key, value);
  }
  const title = values.get("--title")?.trim();
  const verificationFile = values.get("--verification-file");
  if (values.size !== 2 || !title || title.length > 240 || /[\r\n\0]/.test(title) || !verificationFile) {
    throw new Error("PRタイトルと検証結果ファイルを指定してください。タイトルは改行なしの240文字以内にしてください。");
  }
  return { title, verificationFile, draft };
}

export async function runTaskPr({
  args = [], cwd = process.cwd(), execute = executeWorkflowCommand, log = console.log,
}: TaskPrOptions = {}): Promise<{ url: string; existing: boolean }> {
  const { title, verificationFile, draft } = prArguments(args);
  const head = await cleanTaskHead(cwd, execute);
  let verification: string;
  try {
    const reportFile = resolve(cwd, verificationFile);
    const metadata = await stat(reportFile);
    if (!metadata.isFile() || metadata.size > 1_000_000) throw new Error();
    verification = (await readFile(reportFile, "utf8")).trim();
    if (!verification || verification.includes("\0")) throw new Error();
  } catch {
    throw new Error("検証結果ファイルを読み込めませんでした。非空のテキストファイル（1MB以内）を指定してください。");
  }
  let existing = await taskPullRequests(head, execute);
  if (draft && existing[0] && !existing[0].isDraft) throw new Error("既存PRはdraftではありません。固定QAを検証し、--draftなしで更新してください。");
  let remote = await commandOutput(execute, "git", ["ls-remote", "--heads", "origin", `refs/heads/${head.branch}`], head.cwd,
    "originの検証対象コミットを確認できませんでした。Gitの接続と認証を確認してください。");
  if (remote !== `${head.sha}\trefs/heads/${head.branch}` && draft) {
    await assertTaskGitGate(head, execute);
    await commandOutput(execute, "git", ["push", "origin", `${head.sha}:refs/heads/${head.branch}`], head.cwd,
      "ブランチのpushに失敗しました。Gitの接続と認証を確認してください。");
    remote = await commandOutput(execute, "git", ["ls-remote", "--heads", "origin", `refs/heads/${head.branch}`], head.cwd,
      "push後のoriginのコミットを確認できませんでした。");
    existing = await taskPullRequests(head, execute);
  }
  if (remote !== `${head.sha}\trefs/heads/${head.branch}`) {
    throw new Error("originのブランチが現在のコミットと一致しません。git push後にtask:prを再実行してください。");
  }
  let existingUrl: string | undefined;
  if (existing.length === 1) {
    if (existing[0].headRefOid !== head.sha) throw new Error("既存PRのコミットがPreviewの検証対象と一致しません。");
    if (draft && !existing[0].isDraft) throw new Error("既存PRはdraftではありません。固定QAを検証し、--draftなしで更新してください。");
    existingUrl = existing[0].url;
  }

  let evidence: string;
  if (draft) {
    evidence = `## 固定QA\n\n未検証。QA枠の予約・設定/承認・DB分離・Native連携・生成前ゲート・cleanupの確認と、Deployment固有URLでの画面/API検証が必要です。\n\n- ブランチ: \`${head.branch}\`\n- 対象コミット: \`${head.sha}\`\n`;
  } else {
    const preview = await readPreviewRecord(head.cwd);
    if (preview.branch !== head.branch || preview.sha !== head.sha) {
      throw new Error("Previewを検証したブランチ・コミットと現在のHEADが一致しません。deploy:previewから検証をやり直してください。");
    }
    if (!existing[0] || existing[0].number !== preview.prNumber) throw new Error("検証済み固定QAと同じPRがありません。先に--draftでPRを作成してください。");
    const current = await readyQaPreview(head, preview.prNumber, execute);
    if (!current || current.slot !== preview.slot || current.leaseId !== preview.leaseId
      || current.deploymentId !== preview.deploymentId || current.url !== preview.url
      || (["projectId", "branchId", "endpointId", "host"] as const).some((key) => current.database[key] !== preview.database[key])) {
      throw new Error("固定QAの貸出・Deployment・DBが検証記録と一致しません。deploy:previewから検証をやり直してください。");
    }
    evidence = `## Preview\n\n- URL: ${preview.url}\n- ブランチ: \`${head.branch}\`\n- 検証コミット: \`${head.sha}\`\n- Deployment: \`${preview.deploymentId}\`\n- QA枠: \`${preview.slot}\` / PR #${preview.prNumber}\n- 貸出ID: \`${preview.leaseId}\`\n- 台帳Deployment: \`${preview.ledgerRecordId}\`\n- DB: 本番から分離したNeon Previewプロジェクト \`${preview.database.projectId}\` / branch \`${preview.database.branchId}\` / endpoint \`${preview.database.endpointId}\`。\n`;
  }
  const body = `## 変更内容\n\n${title}\n\n${evidence}\n## 検証結果\n\n${verification}\n`;
  const directory = await mkdtemp(join(tmpdir(), "cake-task-pr-"));
  try {
    const bodyFile = join(directory, "body.md");
    await writeFile(bodyFile, body, { mode: 0o600, flag: "wx" });
    if (existingUrl) {
      await commandOutput(execute, "gh", ["pr", "edit", existingUrl, "--repo", CAKE_REPOSITORY,
        "--title", title, "--body-file", bodyFile], head.cwd,
      "既存PRの更新に失敗しました。GitHub上のPR内容を確認し、task:prを再実行してください。");
      log(`Cake: 既存のPRを最新の検証結果へ更新しました: ${existingUrl}`);
      return { url: existingUrl, existing: true };
    }
    const created = await commandOutput(execute, "gh", ["pr", "create", "--repo", CAKE_REPOSITORY,
      "--base", "main", "--head", head.branch, "--title", title, "--body-file", bodyFile, ...(draft ? ["--draft"] : [])], head.cwd,
    "PRを作成できませんでした。gh auth status とGitHubのPR一覧を確認してください。");
    const url = pullRequestUrl(created);
    log(`Cake: PRを作成しました: ${url}`);
    return { url, existing: false };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runTaskPr({ args: process.argv.slice(2) }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "PRの作成に失敗しました。");
    process.exitCode = 1;
  });
}

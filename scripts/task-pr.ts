import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAKE_REPOSITORY, assertTaskGitGate, cleanTaskHead, commandOutput, executeWorkflowCommand, pullRequestUrl,
  taskPullRequests, type WorkflowExecutor,
} from "./task-workflow";
import { source } from "./preview-model";
import { readyPreview } from "./preview-ready";
import { updateTaskPullRequest } from "./task-pr-update";
import { assertVerificationControl, verificationApi } from "./preview-verify-command";

type TaskPrOptions = { args?: readonly string[]; cwd?: string; execute?: WorkflowExecutor; log?: (message: string) => void };

function prArguments(args: readonly string[]): { title: string; verificationFile: string; draft: boolean; remoteProofPath?: string; targetWorktree?: string } {
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
    if (!["--title", "--verification-file", "--remote-proof", "--target-worktree"].includes(key) || values.has(key)
      || value === undefined || !value.trim() || value.startsWith("--")) {
      throw new Error("npm run task:pr -- --title '変更内容' --verification-file /path/report.md を指定してください。");
    }
    values.set(key, value);
  }
  const title = values.get("--title")?.trim();
  const verificationFile = values.get("--verification-file");
  if (values.size !== 2 + Number(values.has('--remote-proof')) + Number(values.has('--target-worktree')) || !title || title.length > 240 || /[\r\n\0]/.test(title) || !verificationFile
    || draft && values.has('--remote-proof') || values.has('--target-worktree') && !values.has('--remote-proof')) {
    throw new Error("PRタイトルと検証結果ファイルを指定してください。タイトルは改行なしの240文字以内にしてください。");
  }
  return { title, verificationFile, draft, remoteProofPath: values.get('--remote-proof'), targetWorktree: values.get('--target-worktree') };
}

export async function runTaskPr({
  args = [], cwd = process.cwd(), execute = executeWorkflowCommand, log = console.log,
}: TaskPrOptions = {}): Promise<{ url: string; existing: boolean }> {
  const { title, verificationFile, draft, remoteProofPath, targetWorktree } = prArguments(args);
  const proofPath = remoteProofPath ? resolve(cwd, remoteProofPath) : undefined;
  if (targetWorktree) await assertVerificationControl(cwd, execute, verificationApi(cwd, execute));
  const head = await cleanTaskHead(targetWorktree ? resolve(cwd, targetWorktree) : cwd, execute);
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
  if (draft && existing[0] && !existing[0].isDraft) throw new Error("既存PRはdraftではありません。Previewを検証し、--draftなしで更新してください。");
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
    if (draft && !existing[0].isDraft) throw new Error("既存PRはdraftではありません。Previewを検証し、--draftなしで更新してください。");
    existingUrl = existing[0].url;
  }

  let evidence: string;
  if (draft) {
    evidence = `## Preview\n\n未検証。現在HEADの固有URLでPC/mobile・A/Bと変更箇所を検証してからReadyにします。\n\n- ブランチ: ${head.branch}\n- 対象コミット: ${head.sha}\n`;
  } else {
    if (!existing[0]) throw new Error("先にdraft PRを作成してください。");
    const current = source(JSON.parse(await commandOutput(execute, "gh", ["api", `repos/${CAKE_REPOSITORY}/pulls/${existing[0].number}`], head.cwd)));
    if (current.sha !== head.sha || current.branch !== head.branch || current.state !== 'open') throw new Error('Previewの現在PRが一致しません。');
    const proof = await readyPreview(current, head.cwd, execute, proofPath);
    evidence = `## Preview\n\n- URL: ${proof.deployment.url}\n- ブランチ: ${head.branch}\n- 検証commit: ${head.sha}\n- Deployment: ${proof.deployment.id}\n- DB branch: ${proof.deployment.database!.branchId}\n- DB endpoint: ${proof.deployment.database!.endpointId}\n- 画面確認: ${proof.cases.join(', ')}\n- 実クリック: ${proof.clicks.length}回\n`;
  }
  const body = `## 変更内容\n\n${title}\n\n${evidence}\n## 検証結果\n\n${verification}\n`;
  if (existingUrl) {
    await updateTaskPullRequest(head, existing[0].number, title, body, execute);
    if (!draft && existing[0].isDraft) {
      const latestHead = await cleanTaskHead(head.cwd, execute);
      if (latestHead.sha !== head.sha || latestHead.branch !== head.branch) throw new Error("HEADが変わりました。draftを解除しません。");
      const requests = await taskPullRequests(head, execute);
      if (requests[0]?.headRefOid !== head.sha) throw new Error('PR headが変わりました。draftを解除しません。');
      await commandOutput(execute, 'gh', ['pr', 'ready', String(existing[0].number), '--repo', CAKE_REPOSITORY], head.cwd);
    }
    log(`Cake: 既存のPRを最新の検証結果へ更新しました: ${existingUrl}`);
    return { url: existingUrl, existing: true };
  }
  const directory = await mkdtemp(join(tmpdir(), "cake-task-pr-"));
  try {
    const bodyFile = join(directory, "body.md");
    await writeFile(bodyFile, body, { mode: 0o600, flag: "wx" });
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
  void runTaskPr({ args: process.argv.slice(2) }).catch(() => {
    console.error("PR操作が失敗しました。認証情報や外部応答は表示しません。draftとQA検証状態を確認してください。");
    process.exitCode = 1;
  });
}

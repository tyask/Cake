import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAKE_REPOSITORY, assertTaskGitGate, cleanTaskHead, commandOutput, executeWorkflowCommand, fullSha, pullRequestUrl,
  taskPullRequests, type TaskHead, type WorkflowExecutor,
} from "./task-workflow";
import { source } from "../preview/preview-model";
import { readyPreview } from "../preview/preview-ready";
import { updateTaskPullRequest } from "./task-pr-update";
import { assertVerificationControl, verificationApi } from "../preview/preview-verify-command";
import { assertTaskIntentReady, readTaskIntent, type TaskIntentRecord } from "./task-intent";
import { parseTaskMetadata } from "./post-merge-model";

type TaskPrOptions = { args?: readonly string[]; cwd?: string; execute?: WorkflowExecutor; log?: (message: string) => void };

type TaskPrArguments = { title: string; changesFile: string; verificationFile: string; draft: boolean;
  remoteProofPath?: string; targetWorktree?: string; intent?: string; legacy: boolean; completesIssue?: boolean; manualPostMerge?: boolean };

function prArguments(args: readonly string[]): TaskPrArguments {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (["--draft", "--legacy", "--completes-issue", "--manual-post-merge", "--no-completes-issue", "--no-manual-post-merge"].includes(key)) {
      if (switches.has(key)) throw new Error(`${key} は一度だけ指定してください。`);
      switches.add(key);
      continue;
    }
    const value = args[++index];
    if (!["--title", "--changes-file", "--verification-file", "--remote-proof", "--target-worktree", "--intent"].includes(key) || values.has(key)
      || value === undefined || !value.trim() || value.startsWith("--")) {
      throw new Error("npm run task:pr -- --title '変更内容' --changes-file /path/changes.md --verification-file /path/report.md を指定してください。");
    }
    values.set(key, value);
  }
  const title = values.get("--title")?.trim();
  const changesFile = values.get("--changes-file");
  const verificationFile = values.get("--verification-file");
  const draft = switches.has('--draft'), legacy = switches.has('--legacy');
  if (values.size !== 3 + Number(values.has('--remote-proof')) + Number(values.has('--target-worktree')) + Number(values.has('--intent')) || !title || title.length > 240 || /[\r\n\0]/.test(title) || !changesFile || !verificationFile
    || draft && values.has('--remote-proof') || values.has('--target-worktree') && !values.has('--remote-proof')) {
    throw new Error("PRタイトル・変更内容ファイル・検証結果ファイルを指定してください。タイトルは改行なしの240文字以内にしてください。");
  }
  if (switches.has('--completes-issue') && switches.has('--no-completes-issue')
    || switches.has('--manual-post-merge') && switches.has('--no-manual-post-merge')) {
    throw new Error('完了PR・手動確認の指定が矛盾しています。');
  }
  if (legacy && (values.has('--intent') || [...switches].some(key => /completes-issue|manual-post-merge/.test(key)))) {
    throw new Error('--legacy は --intent・--completes-issue・--manual-post-merge と併用できません。');
  }
  return { title, changesFile, verificationFile, draft, remoteProofPath: values.get('--remote-proof'),
    targetWorktree: values.get('--target-worktree'), intent: values.get('--intent'), legacy,
    completesIssue: switches.has('--completes-issue') ? true : switches.has('--no-completes-issue') ? false : undefined,
    manualPostMerge: switches.has('--manual-post-merge') ? true : switches.has('--no-manual-post-merge') ? false : undefined };
}

function assertPrContent(title: string, changes: string, verification: string, preview = ''): void {
  const content = `${title}\n${changes}\n${verification}\n${preview}`;
  if (/<!--\s*cake-task\/v1\b/i.test(content)) throw new Error('案件metadataはtask:prが生成します。変更説明・検証報告へ手書きしないでください。');
  if (/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:(?:[\w.-]+\/[\w.-]+)?#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/i.test(content)) {
    throw new Error('Issueはマージ後の確認後に完了します。Closes・Fixes・Resolvesの自動close指定を関連Issueの参照へ変更してください。');
  }
}

function taskMetadata(record: TaskIntentRecord, sha: string, existingBody: string, completesIssue?: boolean, manualPostMerge?: boolean): string {
  if (!fullSha(sha) || record.repository !== CAKE_REPOSITORY || !Number.isSafeInteger(record.issue) || record.issue < 1
    || !/^aidlc\/spaces\/default\/intents\/\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.recordDir)
    || record.recordDir !== `aidlc/spaces/default/intents/${record.id}`) {
    throw new Error('PRに対応するIssue・Intentを確認できません。');
  }
  const previous = parseTaskMetadata(existingBody);
  if (previous && (previous.issue !== record.issue || previous.intent !== record.recordDir)) {
    throw new Error('既存PRとIssue・Intentの対応が異なります。同じ案件のIntentを指定してください。');
  }
  const metadata = { issue: record.issue, intent: record.recordDir,
    completesIssue: completesIssue ?? previous?.completesIssue ?? false,
    manualPostMerge: manualPostMerge ?? previous?.manualPostMerge ?? false };
  return `- 関連Issue: [#${record.issue}](https://github.com/${CAKE_REPOSITORY}/issues/${record.issue})\n`
    + `- Intent: [${record.id}](https://github.com/${CAKE_REPOSITORY}/tree/${sha}/${record.recordDir})\n`
    + `- 案件完了PR: ${metadata.completesIssue ? 'はい' : 'いいえ'}\n- マージ後の手動確認: ${metadata.manualPostMerge ? '必要' : '不要'}\n\n`
    + `<!-- cake-task/v1 ${JSON.stringify(metadata)} -->`;
}

type TaskPrBodyOptions = { head: TaskHead; title: string; changes: string; verification: string; preview: string;
  existingBody?: string; intent?: string; completesIssue?: boolean; manualPostMerge?: boolean };

/** Shared by the regular CLI and the documented document-only Ready procedure. Does not mutate files or GitHub. */
export async function createTaskPrBody({ head, title, changes, verification, preview, existingBody = '', intent, completesIssue, manualPostMerge }: TaskPrBodyOptions): Promise<string> {
  assertPrContent(title, changes, verification, preview);
  const record = await assertTaskIntentReady(head.cwd, intent, head.branch);
  const links = taskMetadata(record, head.sha, existingBody, completesIssue, manualPostMerge);
  return `## 変更内容\n\n${links}\n\n${changes}\n\n${preview}\n## 検証結果\n\n${verification}\n`;
}

async function readPrTextFile(cwd: string, path: string, label: string): Promise<string> {
  try {
    const file = resolve(cwd, path), metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > 1_000_000) throw new Error();
    const value = (await readFile(file, "utf8")).trim();
    if (!value || value.includes("\0")) throw new Error();
    return value;
  } catch {
    throw new Error(`${label}ファイルを読み込めませんでした。非空のテキストファイル（1MB以内）を指定してください。`);
  }
}

export async function runTaskPr({
  args = [], cwd = process.cwd(), execute = executeWorkflowCommand, log = console.log,
}: TaskPrOptions = {}): Promise<{ url: string; existing: boolean }> {
  const { title, changesFile, verificationFile, draft, remoteProofPath, targetWorktree, intent, legacy, completesIssue, manualPostMerge } = prArguments(args);
  const [changes, verification] = await Promise.all([
    readPrTextFile(cwd, changesFile, "変更内容"), readPrTextFile(cwd, verificationFile, "検証結果"),
  ]);
  assertPrContent(title, changes, verification);
  const proofPath = remoteProofPath ? resolve(cwd, remoteProofPath) : undefined;
  if (targetWorktree) await assertVerificationControl(cwd, execute, verificationApi(cwd, execute));
  const head = await cleanTaskHead(targetWorktree ? resolve(cwd, targetWorktree) : cwd, execute);
  let existing = await taskPullRequests(head, execute);
  if (legacy && existing.length !== 1) throw new Error('--legacy はIntent導入前の既存PRの更新だけに使えます。新規PRには承認済みIntentが必要です。');
  let existingBody = '';
  if (existing[0]) {
    const current = JSON.parse(await commandOutput(execute, 'gh', ['api', `repos/${CAKE_REPOSITORY}/pulls/${existing[0].number}`], head.cwd));
    if (current.number !== existing[0].number || typeof current.body !== 'string') throw new Error('既存PRの本文を確認できません。');
    existingBody = current.body;
  }
  if (legacy) {
    if (await readTaskIntent(head.cwd, undefined, head.branch) || /<!--\s*cake-task\/v1\b/i.test(existingBody)) {
      throw new Error('Intentに対応したPRは--legacyで更新できません。承認済みIntentを使ってください。');
    }
  }
  const record = legacy ? null : await assertTaskIntentReady(head.cwd, intent, head.branch);
  const links = record ? `${taskMetadata(record, head.sha, existingBody, completesIssue, manualPostMerge)}\n\n` : '';
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
  const body = `## 変更内容\n\n${links}${changes}\n\n${evidence}\n## 検証結果\n\n${verification}\n`;
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

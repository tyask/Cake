import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAKE_REPOSITORY, cleanTaskHead, commandOutput, executeWorkflowCommand, pullRequestUrl,
  readPreviewRecord, type WorkflowExecutor,
} from "./task-workflow";

type TaskPrOptions = { args?: readonly string[]; cwd?: string; execute?: WorkflowExecutor; log?: (message: string) => void };

function prArguments(args: readonly string[]): { title: string; verificationFile: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
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
  return { title, verificationFile };
}

export async function runTaskPr({
  args = [], cwd = process.cwd(), execute = executeWorkflowCommand, log = console.log,
}: TaskPrOptions = {}): Promise<{ url: string; existing: boolean }> {
  const { title, verificationFile } = prArguments(args);
  const head = await cleanTaskHead(cwd, execute);
  const preview = await readPreviewRecord(head.cwd);
  if (preview.branch !== head.branch || preview.sha !== head.sha) {
    throw new Error("Previewを検証したブランチ・コミットと現在のHEADが一致しません。deploy:previewから検証をやり直してください。");
  }
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
  const remote = await commandOutput(execute, "git", ["ls-remote", "--heads", "origin", `refs/heads/${head.branch}`], head.cwd,
    "originの検証対象コミットを確認できませんでした。Gitの接続と認証を確認してください。");
  if (remote !== `${head.sha}\trefs/heads/${head.branch}`) {
    throw new Error("originのブランチが検証済みコミットと一致しません。deploy:previewから検証をやり直してください。");
  }
  const listed = await commandOutput(execute, "gh", ["pr", "list", "--repo", CAKE_REPOSITORY, "--base", "main",
    "--head", head.branch, "--state", "open", "--json", "url,headRefOid"], head.cwd,
  "既存PRを確認できませんでした。gh auth status とGitHubへの接続を確認してください。");
  let existing: { url: unknown; headRefOid: unknown }[];
  try {
    const value: unknown = JSON.parse(listed);
    if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error();
    existing = value;
  } catch { throw new Error("GitHubのPR一覧を読み込めませんでした。"); }
  if (existing.length > 1) throw new Error("同じブランチのPRが複数あります。GitHubのPR一覧を確認してください。");
  let existingUrl: string | undefined;
  if (existing.length === 1) {
    if (existing[0].headRefOid !== head.sha) throw new Error("既存PRのコミットがPreviewの検証対象と一致しません。");
    existingUrl = pullRequestUrl(existing[0].url);
  }

  const body = `## 変更内容\n\n${title}\n\n## Preview\n\n- URL: ${preview.url}\n- ブランチ: \`${head.branch}\`\n- 検証コミット: \`${head.sha}\`\n- Deployment: \`${preview.deploymentId}\`\n- DB: 本番から分離したNeon Previewリソースのブランチ専用DB（\`CAKE_TEST_DATABASE_URL\`）。\n\n## 検証結果\n\n${verification}\n`;
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
      "--base", "main", "--head", head.branch, "--title", title, "--body-file", bodyFile], head.cwd,
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

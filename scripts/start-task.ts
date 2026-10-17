import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type TaskEnvironment = Readonly<Record<string, string | undefined>>;
type StartTaskOptions = {
  args?: readonly string[];
  cwd?: string;
  environment?: TaskEnvironment;
  installDependencies?: (cwd: string) => void;
  log?: (message: string) => void;
};
export type StartedTask = { branch: string; worktreePath: string };

function taskName(args: readonly string[]): string {
  if (args.length !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args[0]) || /[\r\n]/.test(args[0])
    || args[0].length > 60 || ["main", "preview", "production"].includes(args[0])) {
    throw new Error("npm run task:start -- <task-name> を指定してください。タスク名は60文字以内の英小文字・数字・ハイフンで、main・preview・production以外にしてください。");
  }
  return args[0];
}

function git(cwd: string, args: readonly string[], message: string): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // Remote URLs and command errors may contain credentials, so do not echo stderr.
  if (result.error || result.status !== 0 || result.signal) throw new Error(message);
  return result.stdout.trim();
}

function refExists(cwd: string, ref: string): boolean {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
    cwd, stdio: "ignore",
  });
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error("Gitブランチの状態を確認できませんでした。");
  }
  return result.status === 0;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("worktreeの作成先を確認できませんでした。");
  }
}

export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  return `'${value.replaceAll("'", platform === "win32" ? "''" : "'\\''")}'`;
}

function installDependencies(cwd: string): void {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], {
    cwd, stdio: "inherit", shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0 || result.signal) throw new Error("npm ci が失敗しました。");
}

/** Create a task checkout without modifying or carrying the current working tree. */
export function runStartTask({
  args = [], cwd = process.cwd(), environment = process.env,
  installDependencies: install = installDependencies, log = console.log,
}: StartTaskOptions = {}): StartedTask {
  const name = taskName(args);
  const branch = `codex/${name}`;
  const commonGitDirectory = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "CakeのGitリポジトリ内で実行してください。");
  // Linked worktrees share this directory; the default is stable from any checkout.
  if (basename(commonGitDirectory) !== ".git") {
    throw new Error("通常のGitリポジトリ（.gitディレクトリ）から実行してください。");
  }
  const repositoryRoot = dirname(commonGitDirectory);
  const configuredRoot = environment.CAKE_WORKTREE_ROOT;
  if (configuredRoot !== undefined && !configuredRoot.trim()) {
    throw new Error("CAKE_WORKTREE_ROOTにはworktreeを作成するディレクトリを指定してください。");
  }
  const worktreeRoot = configuredRoot === undefined
    ? resolve(repositoryRoot, "..", `${basename(repositoryRoot)}-worktrees`)
    : resolve(repositoryRoot, configuredRoot);
  const worktreePath = resolve(worktreeRoot, name);
  const changeDirectory = `${process.platform === "win32" ? "Set-Location -LiteralPath" : "cd"} ${shellQuote(worktreePath)}`;
  if (pathExists(worktreePath)) {
    throw new Error(`worktreeの作成先が既に存在します: ${worktreePath}`);
  }
  log("Cake: originから最新のブランチを取得します。");
  git(cwd, ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"],
    "originの取得に失敗しました。worktreeは作成していません。Gitの接続と認証を確認してください。");
  if (!refExists(cwd, "refs/remotes/origin/main")) {
    throw new Error("origin/mainがありません。worktreeは作成していません。");
  }
  if (refExists(cwd, `refs/heads/${branch}`)) {
    throw new Error(`ブランチが既に存在します: ${branch}`);
  }
  if (refExists(cwd, `refs/remotes/origin/${branch}`)) {
    throw new Error(`originにブランチが既に存在します: ${branch}`);
  }
  mkdirSync(worktreeRoot, { recursive: true });
  git(cwd, ["worktree", "add", "--no-track", "-b", branch, worktreePath, "origin/main"],
    "worktreeを作成できませんでした。git worktree list とGitブランチの状態を確認してください。");

  log(`Cake: ${branch} を作成しました: ${worktreePath}`);
  log("Cake: 専用worktreeで npm ci を実行します。");
  try {
    install(worktreePath);
  } catch {
    const retry = process.platform === "win32" ? `${changeDirectory}\nnpm.cmd ci` : `${changeDirectory} && npm ci`;
    throw new Error(`npm ci が失敗しました。作成済みのブランチとworktreeは保持しています。\n作業先: ${worktreePath}\n再試行:\n${retry}`);
  }
  log(`Cake: 作業を開始できます。${changeDirectory}`);
  log("Cake: .env.localとVercel接続情報はコピーしていません。READMEのタスク用環境の手順に従って設定してください。");
  return { branch, worktreePath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runStartTask({ args: process.argv.slice(2) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "開発用worktreeの作成に失敗しました。");
    process.exitCode = 1;
  }
}

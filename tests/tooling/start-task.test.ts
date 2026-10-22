import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStartTask, shellQuote } from "../../scripts/task/start-task";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Cake Test", "-c", "user.email=test@cake.local",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cake-start-task-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  mkdirSync(remote);
  git(remote, "init", "--initial-branch=main");
  writeFileSync(join(remote, "app.txt"), "main version one\n");
  writeFileSync(join(remote, ".env.example"), "DATABASE_URL=placeholder\n");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "initial main");
  const cwd = join(root, "Cake");
  git(root, "clone", remote, cwd);
  // runStartTask's Git inherits system/global config; keep this fixture LF locally.
  git(cwd, "config", "--local", "core.autocrlf", "false");
  git(cwd, "config", "--local", "core.eol", "lf");
  return { root, remote, cwd, defaultWorktreeRoot: join(root, "Cake-worktrees") };
}

const silent = () => {};

test("shellQuoteはPowerShellとPOSIXで空白・アポストロフィを引用する", () => {
  assert.equal(shellQuote("C:\\Cake tasks\\owner's [worktree]", "win32"), "'C:\\Cake tasks\\owner''s [worktree]'");
  assert.equal(shellQuote("/tmp/Cake tasks/owner's [worktree]", "linux"), "'/tmp/Cake tasks/owner'\\''s [worktree]'");
});

test("globalのautocrlf=trueを継承してもfixtureのworktreeはLFを保つ", (t) => {
  const { cwd, root, defaultWorktreeRoot } = repository(t);
  const globalConfig = join(root, "global.gitconfig");
  writeFileSync(globalConfig, "[core]\n\tautocrlf = true\n");
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { runStartTask } from ${JSON.stringify(new URL("../../scripts/task/start-task.ts", import.meta.url).href)};
    runStartTask({ args: ["lf-fixture"], cwd: ${JSON.stringify(cwd)}, environment: {},
      installDependencies() {}, log() {} });
  `], {
    cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const worktreePath = join(defaultWorktreeRoot, "lf-fixture");
  assert.equal(git(cwd, "config", "--local", "core.autocrlf"), "false");
  assert.equal(readFileSync(join(worktreePath, "app.txt"), "utf8"), "main version one\n");
});

test("依存install失敗はworktreeを保持し空白・アポストロフィのある作業先から再試行を案内する", (t) => {
  const { cwd, root } = repository(t);
  const configuredRoot = join(root, "Cake owner's [tasks]");
  const worktreePath = join(configuredRoot, "retry-install");
  const changeDirectory = `${process.platform === "win32" ? "Set-Location -LiteralPath" : "cd"} ${shellQuote(worktreePath)}`;
  const retry = process.platform === "win32" ? `${changeDirectory}\nnpm.cmd ci` : `${changeDirectory} && npm ci`;
  assert.throws(() => runStartTask({ args: ["retry-install"], cwd,
    environment: { CAKE_WORKTREE_ROOT: configuredRoot },
    installDependencies: () => { throw new Error("install failed"); }, log: silent }), {
    message: `npm ci が失敗しました。作成済みのブランチとworktreeは保持しています。\n作業先: ${worktreePath}\n再試行:\n${retry}`,
  });
  assert.equal(git(worktreePath, "branch", "--show-current"), "codex/retry-install");
  assert.equal(git(cwd, "branch", "--show-current"), "main");
});

test("最新origin/mainから作成し、元の未コミット変更と秘密ファイルを保持する", (t) => {
  const { cwd, remote, defaultWorktreeRoot } = repository(t);
  const originalHead = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "app.txt"), "local change\n");
  writeFileSync(join(cwd, ".env.local"), "DATABASE_URL=private-local-value\n");
  mkdirSync(join(cwd, ".vercel"));
  writeFileSync(join(cwd, ".vercel/project.json"), '{"projectId":"private-project"}\n');
  const originalStatus = git(cwd, "status", "--porcelain");
  writeFileSync(join(remote, "app.txt"), "main version two\n");
  git(remote, "commit", "-am", "update main");
  const installs: string[] = [];
  const logs: string[] = [];

  const result = runStartTask({ args: ["new-feature"], cwd, environment: {},
    installDependencies: (path) => { installs.push(path); }, log: (message) => { logs.push(message); } });

  assert.deepEqual(result, { branch: "codex/new-feature", worktreePath: join(defaultWorktreeRoot, "new-feature") });
  assert.deepEqual(installs, [result.worktreePath]);
  assert.equal(git(result.worktreePath, "branch", "--show-current"), "codex/new-feature");
  assert.equal(git(result.worktreePath, "rev-parse", "HEAD"), git(remote, "rev-parse", "HEAD"));
  assert.equal(git(cwd, "rev-parse", "HEAD"), originalHead);
  assert.equal(git(cwd, "status", "--porcelain"), originalStatus);
  assert.equal(readFileSync(join(cwd, "app.txt"), "utf8"), "local change\n");
  assert.equal(readFileSync(join(cwd, ".env.local"), "utf8"), "DATABASE_URL=private-local-value\n");
  assert.equal(readFileSync(join(result.worktreePath, "app.txt"), "utf8"), "main version two\n");
  assert.ok(existsSync(join(result.worktreePath, ".env.example")));
  assert.equal(existsSync(join(result.worktreePath, ".env.local")), false);
  assert.equal(existsSync(join(result.worktreePath, ".vercel")), false);
  assert.equal(git(result.worktreePath, "for-each-ref", "--format=%(upstream)", "refs/heads/codex/new-feature"), "");
  assert.equal(logs.join("\n").includes("private-local-value"), false);
});

test("既存のlinked worktreeから実行しても作成先は元リポジトリの兄弟になる", (t) => {
  const { cwd, root, defaultWorktreeRoot } = repository(t);
  const linked = join(root, "another-location", "existing-worktree");
  git(cwd, "worktree", "add", "-b", "existing-task", linked, "main");
  const result = runStartTask({ args: ["second-task"], cwd: linked, environment: {},
    installDependencies: silent, log: silent });
  assert.equal(result.worktreePath, join(defaultWorktreeRoot, "second-task"));
  assert.equal(git(linked, "branch", "--show-current"), "existing-task");
});

test("CAKE_WORKTREE_ROOTの相対パスは元リポジトリ基準で解決する", (t) => {
  const { cwd, root } = repository(t);
  const linked = join(root, "linked");
  git(cwd, "worktree", "add", "-b", "existing-task", linked, "main");
  const result = runStartTask({ args: ["configured-task"], cwd: linked,
    environment: { CAKE_WORKTREE_ROOT: "../custom-worktrees" }, installDependencies: silent, log: silent });
  assert.equal(result.worktreePath, join(root, "custom-worktrees", "configured-task"));
});

test("不正な引数・予約名をGit操作の前に拒否する", () => {
  const invalidArgs = [[], ["one", "two"], ["main"], ["preview"], ["production"], ["Upper"],
    ["../escape"], ["bad/name"], ["-leading"], ["trailing-"], ["double--dash"], ["two words"],
    ["$(touch secret)"], ["task\n"], ["task\r"], ["a".repeat(61)]];
  for (const args of invalidArgs) {
    assert.throws(() => runStartTask({ args, cwd: "/nonexistent-cake-repository", log: silent }), /タスク名/);
  }
});

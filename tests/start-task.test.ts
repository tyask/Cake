import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStartTask } from "../scripts/start-task";

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
  return { root, remote, cwd, defaultWorktreeRoot: join(root, "Cake-worktrees") };
}

const silent = () => {};

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
    ["$(touch secret)"], ["a".repeat(61)]];
  for (const args of invalidArgs) {
    assert.throws(() => runStartTask({ args, cwd: "/nonexistent-cake-repository", log: silent }), /タスク名/);
  }
});

test("既存のローカルブランチを上書きしない", (t) => {
  const { cwd, defaultWorktreeRoot } = repository(t);
  git(cwd, "branch", "codex/existing-task");
  const before = git(cwd, "rev-parse", "codex/existing-task");
  assert.throws(() => runStartTask({ args: ["existing-task"], cwd, environment: {},
    installDependencies: silent, log: silent }), /ブランチが既に存在/);
  assert.equal(git(cwd, "rev-parse", "codex/existing-task"), before);
  assert.equal(existsSync(join(defaultWorktreeRoot, "existing-task")), false);
});

test("originに同名ブランチがあれば別タスクとして再作成しない", (t) => {
  const { cwd, remote, defaultWorktreeRoot } = repository(t);
  git(remote, "branch", "codex/remote-task");
  assert.throws(() => runStartTask({ args: ["remote-task"], cwd, environment: {},
    installDependencies: silent, log: silent }), /originにブランチが既に存在/);
  assert.equal(existsSync(join(defaultWorktreeRoot, "remote-task")), false);
  assert.equal(git(cwd, "branch", "--list", "codex/remote-task"), "");
});

test("既存ディレクトリ・dangling symlinkを上書きしない", (t) => {
  const { cwd, defaultWorktreeRoot, root } = repository(t);
  const existing = join(defaultWorktreeRoot, "existing-dir");
  mkdirSync(existing, { recursive: true });
  writeFileSync(join(existing, "keep.txt"), "retain me");
  symlinkSync(join(root, "missing-target"), join(defaultWorktreeRoot, "existing-link"));
  for (const name of ["existing-dir", "existing-link"]) {
    assert.throws(() => runStartTask({ args: [name], cwd, environment: {},
      installDependencies: silent, log: silent }), /作成先が既に存在/);
    assert.equal(git(cwd, "branch", "--list", `codex/${name}`), "");
  }
  assert.equal(readFileSync(join(existing, "keep.txt"), "utf8"), "retain me");
});

test("fetchが失敗したらブランチ・worktree・依存パッケージを作らない", (t) => {
  const { cwd, root, defaultWorktreeRoot } = repository(t);
  git(cwd, "remote", "set-url", "origin", join(root, "missing-origin"));
  let installed = false;
  assert.throws(() => runStartTask({ args: ["failed-fetch"], cwd, environment: {},
    installDependencies: () => { installed = true; }, log: silent }), /originの取得に失敗/);
  assert.equal(existsSync(defaultWorktreeRoot), false);
  assert.equal(git(cwd, "branch", "--list", "codex/failed-fetch"), "");
  assert.equal(installed, false);
});

test("origin/mainがない場合はworktreeを作成しない", (t) => {
  const { cwd, remote, defaultWorktreeRoot } = repository(t);
  git(remote, "branch", "-m", "other-default");
  assert.throws(() => runStartTask({ args: ["missing-main"], cwd, environment: {},
    installDependencies: silent, log: silent }), /origin\/mainがありません/);
  assert.equal(existsSync(defaultWorktreeRoot), false);
  assert.equal(git(cwd, "branch", "--list", "codex/missing-main"), "");
});

test("npm ci失敗時は作成済みworktreeを保持して再試行手順を表示する", (t) => {
  const { cwd, root } = repository(t);
  const configuredRoot = join(root, "worktrees with 'quote' and $variable");
  const worktreePath = join(configuredRoot, "retry-install");
  assert.throws(() => runStartTask({ args: ["retry-install"], cwd,
    environment: { CAKE_WORKTREE_ROOT: configuredRoot }, log: silent,
    installDependencies: () => { throw new Error("private-npm-error"); } }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ブランチとworktreeは保持/);
    assert.match(error.message, /再試行: cd '.+' && npm ci/);
    assert.equal(error.message.includes("private-npm-error"), false);
    return true;
  });
  assert.ok(existsSync(worktreePath));
  assert.equal(git(worktreePath, "branch", "--show-current"), "codex/retry-install");
});

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkNodeVersion } from "../../scripts/tooling/check-node-version.mjs";

function configuration(t: TestContext, version = "24.19.0") {
  const rootDirectory = mkdtempSync(join(tmpdir(), "cake node version "));
  t.after(() => rmSync(rootDirectory, { recursive: true, force: true }));
  const engine = `${version.split(".")[0]}.x`;
  writeFileSync(join(rootDirectory, ".node-version"), `${version}\n`);
  writeFileSync(join(rootDirectory, "package.json"), JSON.stringify({ engines: { node: engine } }));
  writeFileSync(join(rootDirectory, "package-lock.json"), JSON.stringify({
    packages: { "": { engines: { node: engine } } },
  }));
  return rootDirectory;
}

test("ローカルの完全な実行版と管理ホストのmajor指定が整合すれば成功する", (t) => {
  const rootDirectory = configuration(t);
  assert.equal(checkNodeVersion({ rootDirectory, runtimeVersion: "24.19.0" }), "24.19.0");
});

test("同じmajorでも異なるminor・patch・prereleaseを拒否する", (t) => {
  const rootDirectory = configuration(t);
  for (const runtimeVersion of ["25.6.0", "24.21.0", "24.19.1", "24.19.0-rc.1"]) {
    assert.throws(() => checkNodeVersion({ rootDirectory, runtimeVersion }), {
      message: `Node.js の実行版が一致しません。必要: v24.19.0 / 実行中: v${runtimeVersion}。既存の Node.js 管理ツールで切り替えて再実行してください。`,
    });
  }
});

test("packageとlockのengineが未指定・別major・完全版指定なら設定のずれを拒否する", (t) => {
  for (const filename of ["package.json", "package-lock.json"]) {
    for (const engine of [undefined, "22.x", "24.19.0"]) {
      const rootDirectory = configuration(t);
      const engines = { node: engine };
      const value = filename === "package.json" ? { engines } : { packages: { "": { engines } } };
      writeFileSync(join(rootDirectory, filename), JSON.stringify(value));
      assert.throws(() => checkNodeVersion({ rootDirectory, runtimeVersion: "24.19.0" }), /engines.node を 24.x に揃えて/);
    }
  }
});

test("不完全な版指定・読み込めない設定を実行版の確認として受理しない", (t) => {
  const rootDirectory = configuration(t);
  for (const version of ["24", "24.x", "v24.19.0", "24.19.0\n24.21.0", "024.19.0", ""]) {
    writeFileSync(join(rootDirectory, ".node-version"), `${version}\n`);
    assert.throws(() => checkNodeVersion({ rootDirectory, runtimeVersion: "24.19.0" }), /major.minor.patch/);
  }
  writeFileSync(join(rootDirectory, ".node-version"), "24.19.0\n");
  writeFileSync(join(rootDirectory, "package.json"), "invalid json");
  assert.throws(() => checkNodeVersion({ rootDirectory, runtimeVersion: "24.19.0" }), /package.json を読み込めません/);
  rmSync(join(rootDirectory, ".node-version"));
  assert.throws(() => checkNodeVersion({ rootDirectory, runtimeVersion: "24.19.0" }), /.node-version を読み込めません/);
});

test("依存なしのCLIはCWDに依存せず空白のあるworktreeで版を検出し、不一致は非0で終了する", (t) => {
  const rootDirectory = configuration(t, process.versions.node);
  const script = join(rootDirectory, "scripts/tooling/check-node-version.mjs");
  mkdirSync(dirname(script), { recursive: true });
  cpSync(new URL("../../scripts/tooling/check-node-version.mjs", import.meta.url), script);
  const run = () => spawnSync(process.execPath, [script], {
    cwd: tmpdir(), encoding: "utf8", timeout: 5_000,
  });
  const accepted = run();
  assert.ifError(accepted.error);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Node.js v.+ を確認しました/);
  writeFileSync(join(rootDirectory, ".node-version"), "0.0.0\n");
  const rejected = run();
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /必要: v0.0.0/);
  assert.equal(rejected.stdout, "");
});

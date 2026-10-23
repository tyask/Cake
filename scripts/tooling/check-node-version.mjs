import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");

function readConfiguration(rootDirectory, filename, parse = (value) => value) {
  try {
    return parse(readFileSync(join(rootDirectory, filename), "utf8"));
  } catch {
    throw new Error(`${filename} を読み込めません。Node.js の実行版設定を確認してください。`);
  }
}

/** Check the pinned local/Actions runtime without installing or changing tools. */
export function checkNodeVersion({
  rootDirectory = repositoryRoot, runtimeVersion = process.versions.node,
} = {}) {
  const expectedVersion = readConfiguration(rootDirectory, ".node-version").trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expectedVersion)) {
    throw new Error(".node-version には major.minor.patch 形式の Node.js 版を指定してください。");
  }
  if (runtimeVersion !== expectedVersion) {
    throw new Error(`Node.js の実行版が一致しません。必要: v${expectedVersion} / 実行中: v${runtimeVersion}。既存の Node.js 管理ツールで切り替えて再実行してください。`);
  }

  // Hosted builds such as Vercel choose a major line and manage patch updates.
  const expectedEngine = `${expectedVersion.split(".")[0]}.x`;
  const packageJson = readConfiguration(rootDirectory, "package.json", JSON.parse);
  const packageLock = readConfiguration(rootDirectory, "package-lock.json", JSON.parse);
  if (packageJson?.engines?.node !== expectedEngine
    || packageLock?.packages?.[""]?.engines?.node !== expectedEngine) {
    throw new Error(`package.json と package-lock.json の engines.node を ${expectedEngine} に揃えてください。ローカル・Actionsの完全な版は .node-version で指定します。`);
  }
  return expectedVersion;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    console.log(`Cake: Node.js v${checkNodeVersion()} を確認しました。`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Node.js の実行版を確認できませんでした。");
    process.exitCode = 1;
  }
}

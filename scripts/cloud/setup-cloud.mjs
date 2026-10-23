import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNodeVersion } from "../tooling/check-node-version.mjs";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function execute(command, args) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: rootDirectory, env: process.env, stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    const cleanup = () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    };
    child.once("error", () => { cleanup(); reject(new Error(`Cake Cloud: ${command} を実行できませんでした。`)); });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0 && !signal) accept();
      else reject(new Error(`Cake Cloud: ${command} が完了しませんでした。`));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--with-deps")) {
    throw new Error("使い方: npm run setup:cloud -- [--with-deps]");
  }
  if (process.platform !== "linux") throw new Error("setup:cloud はCloudのLinux環境専用です。");
  console.log(`Cake Cloud: Node.js v${checkNodeVersion()} を確認しました。`);
  await execute("npm", ["ci"]);
  await execute("npx", ["--no-install", "playwright", "install", ...(args.length ? ["--with-deps"] : []), "chromium"]);
  console.log("Cake Cloud: 依存関係とPlaywright Chromiumを準備しました。");
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : "Cake Cloudの準備に失敗しました。");
  process.exitCode = 1;
});

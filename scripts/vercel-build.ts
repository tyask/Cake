import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type BuildStep = "db:setup" | "db:seed:test" | "build";
type BuildEnvironment = Readonly<Record<string, string | undefined>>;

export function buildSteps(environment: BuildEnvironment): BuildStep[] {
  if (environment.VERCEL_ENV !== "preview") return ["build"];
  for (const variable of ["DATABASE_URL", "AUTH_SECRET"] as const) {
    if (!environment[variable]?.trim() || environment[variable] === "[SENSITIVE]") {
      throw new Error(`VercelのPreview環境に ${variable} を設定してください。`);
    }
  }
  return environment.AUTH_MODE === "test"
    ? ["db:setup", "db:seed:test", "build"]
    : ["db:setup", "build"];
}

function executeStep(step: BuildStep): number {
  const args: Record<BuildStep, string[]> = {
    "db:setup": ["scripts/setup-db.mjs"],
    "db:seed:test": ["--import", "tsx", "scripts/seed-test-users.ts"],
    build: ["node_modules/next/dist/bin/next", "build"],
  };
  console.log(`Cake: ${step} を実行します。`);
  const result = spawnSync(process.execPath, args[step], { stdio: "inherit" });
  return result.error || result.status === null ? 1 : result.status;
}

export function runVercelBuild(
  environment: BuildEnvironment = process.env,
  execute: (step: BuildStep) => number = executeStep,
): void {
  for (const step of buildSteps(environment)) {
    const status = execute(step);
    if (status !== 0) throw new Error(`${step} が失敗しました（終了コード ${status}）。`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runVercelBuild(); } catch (error) {
    console.error(error instanceof Error ? error.message : "Vercelビルドに失敗しました。");
    process.exitCode = 1;
  }
}

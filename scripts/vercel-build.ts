import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseConnectionString, databaseVariable } from "../lib/database-environment";

export type BuildStep = "db:setup" | "db:seed:test" | "build";
type BuildEnvironment = Readonly<Record<string, string | undefined>>;

export function buildSteps(environment: BuildEnvironment): BuildStep[] {
  const target = environment.VERCEL_ENV;
  if (target !== "preview" && target !== "production") return ["build"];
  const targetLabel = target === "production" ? "Production" : "Preview";
  for (const variable of [databaseVariable(environment), "AUTH_SECRET"]) {
    if (!environment[variable]?.trim() || environment[variable] === "[SENSITIVE]") {
      throw new Error(`Vercelの${targetLabel}環境に ${variable} を設定してください。`);
    }
  }
  // Build first to avoid changing the live DB when compilation fails. Vercel
  // can publish only after this build command's migration step also succeeds.
  if (target === "production") return ["build", "db:setup"];
  return environment.AUTH_MODE === "test"
    ? ["db:setup", "db:seed:test", "build"]
    : ["db:setup", "build"];
}

function executeStep(step: BuildStep, environment: BuildEnvironment): number {
  const args: Record<BuildStep, string[]> = {
    "db:setup": ["scripts/setup-db.mjs"],
    "db:seed:test": ["--import", "tsx", "scripts/seed-test-users.ts"],
    build: ["node_modules/next/dist/bin/next", "build"],
  };
  console.log(`Cake: ${step} を実行します。`);
  const childEnvironment = { ...process.env, ...environment };
  if (environment.VERCEL_ENV === "preview") {
    childEnvironment.DATABASE_URL = databaseConnectionString(environment);
  }
  const result = spawnSync(process.execPath, args[step], { stdio: "inherit", env: childEnvironment });
  return result.error || result.status === null ? 1 : result.status;
}

export function runVercelBuild(
  environment: BuildEnvironment = process.env,
  execute: (step: BuildStep, environment: BuildEnvironment) => number = executeStep,
): void {
  for (const step of buildSteps(environment)) {
    const status = execute(step, environment);
    if (status !== 0) throw new Error(`${step} が失敗しました（終了コード ${status}）。`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runVercelBuild(); } catch (error) {
    console.error(error instanceof Error ? error.message : "Vercelビルドに失敗しました。");
    process.exitCode = 1;
  }
}

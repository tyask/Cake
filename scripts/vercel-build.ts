import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseConnectionString, databaseVariable } from "../lib/database-environment";
import { clearProvisioningOutput, provisioningBuild, writeProvisioningOutput } from './preview-provisioning';

export type BuildStep = "provision" | "db:setup" | "db:seed:test" | "qa:db:csv-categories" | "build";
type BuildEnvironment = Readonly<Record<string, string | undefined>>;
const csvCategoryQaMarker = '[cake-db-qa:csv-categories]';
const csvCategoryQaVariables = [
  'PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'VERCEL_ENV', 'AUTH_MODE', 'VERCEL_DEPLOYMENT_ID',
  'VERCEL_GIT_COMMIT_MESSAGE', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_REF',
  'CAKE_TEST_DATABASE_URL', 'CAKE_PREVIEW_KIND', 'CAKE_PREVIEW_REPOSITORY', 'CAKE_PREVIEW_PR',
  'CAKE_PREVIEW_GENERATION', 'CAKE_PREVIEW_SOURCE_BRANCH', 'CAKE_PREVIEW_SOURCE_SHA',
  'CAKE_PREVIEW_DATABASE_BRANCH_ID', 'CAKE_PREVIEW_DATABASE_HOST_SHA256',
  'CAKE_PREVIEW_PRODUCTION_HOST_SHA256', 'CAKE_PREVIEW_PHASE',
] as const;

function csvCategoryQaEnvironment(environment: BuildEnvironment): BuildEnvironment {
  return { NODE_ENV: 'production', ...Object.fromEntries(csvCategoryQaVariables.flatMap(name =>
    environment[name] === undefined ? [] : [[name, environment[name]]],
  )) };
}

export function buildSteps(environment: BuildEnvironment): BuildStep[] {
  if (provisioningBuild(environment)) return ['provision'];
  const target = environment.VERCEL_ENV;
  if (target !== "preview" && target !== "production") return ["build"];
  const targetLabel = target === "production" ? "Production" : "Preview";
  for (const variable of [databaseVariable(environment), "AUTH_SECRET"]) {
    if (!environment[variable]?.trim() || environment[variable] === "[SENSITIVE]") {
      throw new Error(`Vercelの${targetLabel}環境に ${variable} を設定してください。`);
    }
  }
  databaseConnectionString(environment);
  // Build first to avoid changing the live DB when compilation fails. Vercel
  // can publish only after this build command's migration step also succeeds.
  if (target === "production") return ["build", "db:setup"];
  const steps: BuildStep[] = ["db:setup"];
  if (environment.AUTH_MODE === "test") {
    steps.push("db:seed:test");
    if (environment.CAKE_PREVIEW_KIND === undefined
      && environment.VERCEL_GIT_COMMIT_MESSAGE?.split(/\r?\n/).some(line => line.trim() === csvCategoryQaMarker)) {
      steps.push("qa:db:csv-categories");
    }
  }
  return [...steps, "build"];
}

function executeStep(step: BuildStep, environment: BuildEnvironment): number {
  console.log(`Cake: ${step} を実行します。`);
  if (step === 'provision') {
    writeProvisioningOutput();
    console.log('Cake: DBに接続せず、Preview準備中の静的ページを生成しました。');
    return 0;
  }
  if (step === 'build') clearProvisioningOutput();
  const args: Record<Exclude<BuildStep, 'provision'>, string[]> = {
    "db:setup": ["scripts/setup-db.mjs"],
    "db:seed:test": ["--import", "tsx", "scripts/seed-test-users.ts"],
    "qa:db:csv-categories": ["--import", "tsx", "scripts/verify-csv-category-concurrency.ts"],
    build: ["node_modules/next/dist/bin/next", "build"],
  };
  // The opt-in QA receives only its dedicated DB and identity, never provider or application credentials.
  const childEnvironment = step === 'qa:db:csv-categories'
    ? { ...environment, NODE_ENV: 'production' as const }
    : { ...process.env, ...environment };
  const result = spawnSync(process.execPath, args[step], { stdio: "inherit", env: childEnvironment });
  return result.error || result.status === null ? 1 : result.status;
}

export function runVercelBuild(
  environment: BuildEnvironment = process.env,
  execute: (step: BuildStep, environment: BuildEnvironment) => number = executeStep,
): void {
  for (const step of buildSteps(environment)) {
    const status = execute(step, step === 'qa:db:csv-categories' ? csvCategoryQaEnvironment(environment) : environment);
    if (status !== 0) throw new Error(`${step} が失敗しました（終了コード ${status}）。`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runVercelBuild(); } catch (error) {
    console.error(error instanceof Error ? error.message : "Vercelビルドに失敗しました。");
    process.exitCode = 1;
  }
}

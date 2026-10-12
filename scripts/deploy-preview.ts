import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type VercelCommandResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string };
export type VercelExecutor = (args: readonly string[], captureStdout: boolean) => Promise<VercelCommandResult>;
type DeployOptions = {
  environment?: Readonly<Record<string, string | undefined>>;
  args?: readonly string[];
  scope?: string;
  execute?: VercelExecutor;
  log?: (message: string) => void;
};

// Keep the old import/entry point fail-closed during migration. Only the
// serialized trusted QA writer may create deployments or assign QA aliases.
export async function runPreviewDeployment(options: DeployOptions = {}): Promise<never> {
  void options;
  throw new Error("直接のPreviewデプロイは停止しています。draft PRを作成し、固定QAの承認後に npm run deploy:preview を実行してください。");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runPreviewDeployment().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Previewの直接デプロイは停止しています。");
    process.exitCode = 1;
  });
}

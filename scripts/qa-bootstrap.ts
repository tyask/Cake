import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReadOnlyQaBootstrap, validateQaBootstrapOptions, type QaBootstrapOptions, type QaBootstrapTransport } from "../lib/qa-bootstrap";
import { type Slot } from "../lib/qa-bootstrap-ledger";

type Environment = Readonly<Record<string, string | undefined>>;

/** CLI and Actions environment inputs share the same validation and GET-only runner. */
export async function runQaBootstrap(args: readonly string[] = process.argv.slice(2), environment: Environment = process.env, transport?: QaBootstrapTransport) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!["--action", "--pr", "--sha", "--slot", "--lease-id"].includes(name) || !value || values.has(name)) throw new Error("QA bootstrapの引数が不正です。");
    values.set(name, value);
  }
  const input = (argument: string, envName: string) => values.get(argument) ?? (environment[envName] || undefined);
  const number = input("--pr", "QA_BOOTSTRAP_PR_NUMBER");
  if (number !== undefined && !/^[1-9][0-9]*$/.test(number)) throw new Error("QA bootstrapのPR番号が不正です。");
  const options: QaBootstrapOptions = {
    action: (input("--action", "QA_BOOTSTRAP_ACTION") ?? "preflight") as QaBootstrapOptions["action"],
    pr: number === undefined ? undefined : Number(number), sha: input("--sha", "QA_BOOTSTRAP_SOURCE_SHA"),
    slot: input("--slot", "QA_BOOTSTRAP_SLOT") as Slot | undefined, leaseId: input("--lease-id", "QA_BOOTSTRAP_LEASE_ID"),
  };
  validateQaBootstrapOptions(options);
  return new ReadOnlyQaBootstrap(environment, transport).inspect(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runQaBootstrap().then((report) => console.log(JSON.stringify(report, null, 2))).catch(() => {
    // Arguments, remote errors and environment values are never echoed.
    console.error("QA bootstrapの入力または読取を確認できません。変更は実行していません。");
    process.exitCode = 1;
  });
}

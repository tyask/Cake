import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpQaGateway, type QaTransport } from "./qa-pool-writer";
import { SLOTS, fullSha, leaseToken, type Slot } from "../lib/qa-pool";
import { publicQaOutput } from "../lib/qa-output-privacy";

export async function runQaInspection(args: readonly string[] = process.argv.slice(2), environment: Readonly<Record<string, string | undefined>> = process.env, transport?: QaTransport) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!["--action", "--pr", "--sha", "--slot", "--lease-id"].includes(name) || !value || values.has(name)) throw new Error("検査引数が不正です。");
    values.set(name, value);
  }
  const action = values.get("--action") ?? "preflight";
  if (!["preflight", "plan-probe", "plan-release"].includes(action)) throw new Error("GET専用検査のactionを指定してください。");
  const pr = values.has("--pr") ? Number(values.get("--pr")) : undefined;
  const sha = values.get("--sha"), slot = values.get("--slot"), leaseId = values.get("--lease-id");
  if (pr !== undefined && (!Number.isSafeInteger(pr) || pr < 1) || sha !== undefined && !fullSha(sha)
    || slot !== undefined && !SLOTS.includes(slot as Slot) || leaseId !== undefined && !leaseToken(leaseId)) throw new Error("PR・SHA・枠・lease IDが不正です。");
  if (action !== "preflight" && pr === undefined || action === "plan-probe" && (!sha || !slot)
    || action === "plan-release" && !leaseId) throw new Error("計画には対象PR・完全SHA/枠またはlease IDが必要です。");
  const reader = new HttpQaGateway({ ...environment, GITHUB_TOKEN: environment.GITHUB_TOKEN ?? environment.GH_TOKEN }, transport);
  return reader.inspect({ action: action as "preflight" | "plan-probe" | "plan-release", pr, sha, slot: slot as Slot | undefined, leaseId });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runQaInspection().then((report) => { console.log(JSON.stringify(publicQaOutput(report), null, 2)); }).catch(() => {
    console.error("GET専用検査を完了できません。設定・資源を変更していません。"); process.exitCode = 1;
  });
}

import { isDeepStrictEqual } from "node:util";
import { runQaRequest, type QaGateway, type QaPending, type QaRequest } from "./qa-pool-service";

type Options = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  log?: (message: string) => void;
};

/** Finish one PR's asynchronous work in its event/dispatch run; never uses a scheduled scan. */
export async function runQaRequestWithWaiting(gateway: QaGateway, request: QaRequest, {
  now = Date.now, sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  timeoutMs = 180_000, pollIntervalMs = 10_000, log = console.log,
}: Options = {}): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs)
    || pollIntervalMs <= 0 || pollIntervalMs > 60_000) throw new Error("QA待機時間が不正です。");
  const scoped = ["close", "release", "request-release", "request-preview"].includes(request.action);
  if (!scoped) { await runQaRequest(gateway, request, { log }); return; }
  const deadline = now() + timeoutMs;
  let leaseId = request.leaseId;
  let pending: QaPending | undefined;
  for (let pass = 0; pass <= Math.ceil(timeoutMs / pollIntervalMs); pass++) {
    pending = undefined;
    await runQaRequest(gateway, { ...request, leaseId }, { log, onPending: (value) => { pending = value; } });
    if (!pending) return; // Approval waits, ambiguity, and terminal failures are not polling conditions.
    const wait = pending as QaPending;
    if (wait.pr !== request.pr || leaseId && wait.leaseId !== leaseId) throw new Error("QA待機対象のPRまたは貸出が変わりました。");
    leaseId = wait.leaseId;
    const saved = Object.values(await gateway.pool()).find((value) => value?.payload.pr === wait.pr && value.payload.leaseId === leaseId);
    if (!saved || saved.payload.state === "free") throw new Error("QA待機対象の貸出を確認できません。");
    const remaining = deadline - now();
    if (remaining <= 0 || pass === Math.ceil(timeoutMs / pollIntervalMs)) {
      throw new Error("QAの完了確認が待機上限に達しました。貸出台帳を保持します。返却は現在のPR・leaseでreleaseを再実行し、Previewはdeploy:previewを再実行してください。");
    }
    log(`Cake: PR #${wait.pr} の${wait.kind === "cleanup" ? "削除完了" : "Preview完了"}を同じActions内で確認します。`);
    await sleep(Math.min(pollIntervalMs, remaining));
    const current = (await gateway.pool())[saved.payload.slot];
    if (!isDeepStrictEqual(current, saved)) throw new Error("待機中に貸出世代が変わりました。処理を停止します。");
  }
}

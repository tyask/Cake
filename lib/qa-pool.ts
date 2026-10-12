export const SLOTS = ["qa1", "qa2", "qa3"] as const;
export type Slot = typeof SLOTS[number];
export type Lease = { state: "held" | "draining"; token: string; owner: string; pr: number; sourceSha: string; reservedAt: string };
export type Ledger = { version: 1; slots: Record<Slot, Lease | null>; lastRelease?: { slot: Slot; token: string; report: string } };
export const emptyLedger = (): Ledger => ({ version: 1, slots: { qa1: null, qa2: null, qa3: null } });

export function parseLedger(text: string): Ledger {
  const value = JSON.parse(text) as Ledger;
  if (value?.version !== 1 || !value.slots || Object.keys(value.slots).sort().join() !== SLOTS.join()) throw new Error("台帳が不正です。");
  for (const lease of Object.values(value.slots)) {
    if (lease !== null && (!lease || !["held", "draining"].includes(lease.state)
      || !/^[a-f0-9-]{36}$/.test(lease.token) || !/^[a-zA-Z0-9-]+$/.test(lease.owner)
      || !Number.isSafeInteger(lease.pr) || lease.pr < 1 || !/^[a-f0-9]{40}$/.test(lease.sourceSha)
      || !Number.isFinite(Date.parse(lease.reservedAt)))) throw new Error("貸出記録が不正です。");
  }
  return value;
}

export function transition(ledger: Ledger, slot: Slot, action: "reserve" | "drain" | "release", input: Lease | { token: string; report?: string }): Ledger {
  const next = structuredClone(ledger);
  const current = next.slots[slot];
  if (action === "reserve") {
    if (current) throw new Error("この枠は使用中です。失敗やPR closeで自動解放しません。");
    if (!("sourceSha" in input)) throw new Error("予約情報がありません。");
    next.slots[slot] = input;
  } else {
    if (!current || current.token !== input.token) throw new Error("貸出tokenが一致しません。");
    if (action === "drain") current.state = "draining";
    else {
      if (current.state !== "draining" || !("report" in input)
        || !new RegExp(`^https://github\\.com/tyask/Cake/pull/${current.pr}#issuecomment-[1-9][0-9]*$`).test(input.report ?? "")) {
        throw new Error("返却準備と同じPRの停止確認コメントURLが必要です。");
      }
      next.lastRelease = { slot, token: current.token, report: input.report! };
      next.slots[slot] = null;
    }
  }
  return parseLedger(JSON.stringify(next));
}


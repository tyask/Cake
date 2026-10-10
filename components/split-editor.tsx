"use client";

import { useId, useState } from "react";
import { changeSplitAmount, equalSplitWeights, splitAmounts } from "@/lib/split-allocations";
import type { SplitWeights, WorkspaceMember } from "@/lib/types";

export function SplitEditor({ members, value, onChange, onCommit, amountYen, disabled = false, compact = false, inline = false, allowEqualSplit = false, label = "負担割合" }: {
  members: WorkspaceMember[];
  value: SplitWeights;
  onChange?: (value: SplitWeights) => void;
  onCommit?: () => void;
  amountYen?: number;
  disabled?: boolean;
  compact?: boolean;
  inline?: boolean;
  allowEqualSplit?: boolean;
  label?: string;
}) {
  const id = useId();
  const [mode, setMode] = useState<"RATIO" | "AMOUNT">("RATIO");
  const transactionSplit = amountYen !== undefined;
  const validAmount = Number.isInteger(amountYen) && amountYen! > 0 && amountYen! <= 2_147_483_647;
  const total = members.reduce((sum, member) => sum + (value[member.id] ?? 0), 0);
  const percentages = safeAmounts(1000, value, members);
  const amounts = safeAmounts(validAmount ? amountYen! : 0, value, members);
  function updateShare(memberId: string, input: number) {
    if (!onChange || !Number.isFinite(input)) return;
    if (!transactionSplit) { onChange({ ...value, [memberId]: input }); return; }
    const target = mode === "AMOUNT" ? amountYen! : 1000;
    const share = mode === "AMOUNT" ? input : Math.round(input * 10);
    if (!Number.isInteger(share)) return;
    onChange(changeSplitAmount(target, Math.min(target, Math.max(0, share)), memberId, value, members));
  }
  function changeMode(nextMode: string) {
    if (nextMode === "EQUAL") {
      if (!allowEqualSplit || disabled || !onChange || members.length !== 2) return;
      onChange(equalSplitWeights(members));
      setMode("RATIO");
      onCommit?.();
      return;
    }
    if (nextMode === "RATIO" || nextMode === "AMOUNT") setMode(nextMode);
  }
  return (
    <fieldset className={`split-editor${compact ? " split-editor-compact" : ""}${inline ? " split-editor-inline" : ""}`} disabled={disabled}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onCommit?.(); }}
      onKeyDown={(event) => { if (onCommit && event.target instanceof HTMLInputElement && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); onCommit(); } }}>
      <legend>{label}</legend>
      {transactionSplit && !inline && <div className="split-mode" role="group" aria-label={`${label}の設定方法`}>
        <label><input type="radio" name={`${id}-mode`} value="RATIO" checked={mode === "RATIO"} onChange={() => setMode("RATIO")} /><span>割合</span></label>
        <label><input type="radio" name={`${id}-mode`} value="AMOUNT" checked={mode === "AMOUNT"} disabled={!validAmount} onChange={() => setMode("AMOUNT")} /><span>金額</span></label>
      </div>}
      <div className="split-editor-fields" style={inline ? { gridTemplateColumns: `repeat(${members.length}, minmax(0, 1fr)) 3.25rem` } : undefined}>
        {members.map((member) => (
          <label key={member.id} htmlFor={`${id}-${member.id}`}>
            {!inline && <span>{member.name}</span>}
            <div className="split-input"><input id={`${id}-${member.id}`} type="number" required min="0"
              aria-label={`${member.name}の${transactionSplit && mode === "AMOUNT" ? "支払い金額（円）" : "支払い割合"}`}
              max={transactionSplit ? mode === "AMOUNT" ? amountYen : 100 : 2_147_483_647}
              step={transactionSplit && mode === "RATIO" ? "0.1" : "1"}
              value={transactionSplit ? mode === "AMOUNT" ? amounts[member.id] : percentages[member.id] / 10 : value[member.id] ?? 0}
              readOnly={!onChange} disabled={transactionSplit && (members.length < 2 || mode === "AMOUNT" && !validAmount)}
              onChange={(event) => updateShare(member.id, Number(event.target.value))} />
              {transactionSplit && <span aria-hidden="true">{mode === "AMOUNT" ? "円" : "%"}</span>}</div>
            <small>{transactionSplit && mode === "RATIO" ? money(amounts[member.id]) : total > 0 ? `${percentages[member.id] / 10}%` : "—"}</small>
          </label>
        ))}
        {inline && transactionSplit && <select aria-label={`${label}の単位`} value={mode} onChange={(event) => changeMode(event.target.value)}>
          <option value="RATIO">%</option><option value="AMOUNT" disabled={!validAmount}>円</option>
          {allowEqualSplit && <option value="EQUAL" disabled={members.length !== 2 || !onChange}>1:1</option>}
        </select>}
      </div>
      {total <= 0 && <p className="form-error">どちらかの割合を1以上にしてください。</p>}
      {transactionSplit && !validAmount && <small className="split-note">明細の金額を入力すると、円でも設定できます。</small>}
    </fieldset>
  );
}

const money = (value: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(value);

function safeAmounts(total: number, value: SplitWeights, members: WorkspaceMember[]) {
  try { return splitAmounts(total, value, members); }
  catch { return Object.fromEntries(members.map((member) => [member.id, 0])); }
}

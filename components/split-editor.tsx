"use client";

import { cashflowClass, formatTransactionAmount } from "@/lib/shared/display-formatters";

import { MAX_AMOUNT_YEN, MAX_SPLIT_WEIGHT } from "@/lib/shared/domain-values";

import { useId, useState } from "react";
import { changeSplitAmount, equalSplitWeights, splitAmounts } from "@/lib/shared/split-allocations";
import type { SplitWeights, TransactionType, WorkspaceMember } from "@/lib/shared/types";

export function SplitEditor({ members, value, onChange, onCommit, amountYen, type = "PAYMENT", disabled = false, compact = false, inline = false, label = "配分割合" }: {
  members: WorkspaceMember[];
  value: SplitWeights;
  onChange?: (value: SplitWeights) => void;
  onCommit?: () => void;
  amountYen?: number;
  type?: TransactionType;
  disabled?: boolean;
  compact?: boolean;
  inline?: boolean;
  label?: string;
}) {
  const id = useId();
  const [mode, setMode] = useState<"RATIO" | "AMOUNT">("RATIO");
  const [emptyInput, setEmptyInput] = useState<{ memberId: string; value: SplitWeights; mode: typeof mode; amountYen: number | undefined } | null>(null);
  if (emptyInput && (emptyInput.value !== value || emptyInput.mode !== mode || emptyInput.amountYen !== amountYen || disabled)) {
    setEmptyInput(null);
  }
  const transactionSplit = amountYen !== undefined;
  const validAmount = Number.isInteger(amountYen) && amountYen! > 0 && amountYen! <= MAX_AMOUNT_YEN;
  const total = members.reduce((sum, member) => sum + (value[member.id] ?? 0), 0);
  const percentages = safeAmounts(1000, value, members);
  const amounts = safeAmounts(validAmount ? amountYen! : 0, value, members);
  function updateShare(memberId: string, text: string) {
    const input = Number(text);
    if (!onChange || !Number.isFinite(input)) return;
    let next: SplitWeights;
    if (!transactionSplit) next = { ...value, [memberId]: input };
    else {
      const target = mode === "AMOUNT" ? amountYen! : 1000;
      const share = mode === "AMOUNT" ? input : Math.round(input * 10);
      if (!Number.isInteger(share)) return;
      next = changeSplitAmount(target, Math.min(target, Math.max(0, share)), memberId, value, members);
    }
    // Keep a deleted field blank while calculations and saved weights use zero.
    setEmptyInput(text === "" ? { memberId, value: next, mode, amountYen } : null);
    onChange(next);
  }
  function changeMode(nextMode: string) {
    if (nextMode === "EQUAL") {
      if (disabled || !onChange || members.length !== 2) return;
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
            <div className={`split-input${transactionSplit && mode === "AMOUNT" ? " split-input-signed" : ""}`}>
              {transactionSplit && mode === "AMOUNT" && <span className={`amount-sign ${cashflowClass(type === "PAYMENT" ? -amounts[member.id] : amounts[member.id])}`} aria-hidden="true">{amounts[member.id] > 0 ? type === "PAYMENT" ? "−" : "+" : ""}</span>}
              <input id={`${id}-${member.id}`} type="number" min="0" className={transactionSplit && mode === "AMOUNT" ? cashflowClass(type === "PAYMENT" ? -amounts[member.id] : amounts[member.id]) : undefined}
              aria-label={`${member.name}の${transactionSplit && mode === "AMOUNT" ? "配分金額（円）" : "配分割合"}`}
              max={transactionSplit ? mode === "AMOUNT" ? amountYen : 100 : MAX_SPLIT_WEIGHT}
              step={transactionSplit && mode === "RATIO" ? "0.1" : "1"}
              value={emptyInput?.memberId === member.id ? "" : transactionSplit ? mode === "AMOUNT" ? amounts[member.id] : percentages[member.id] / 10 : value[member.id] ?? 0}
              readOnly={!onChange} disabled={transactionSplit && (members.length < 2 || mode === "AMOUNT" && !validAmount)}
              onChange={(event) => updateShare(member.id, event.target.value)} />
              {transactionSplit && <span aria-hidden="true">{mode === "AMOUNT" ? "円" : "%"}</span>}</div>
            <small className={transactionSplit && mode === "RATIO" ? cashflowClass(type === "PAYMENT" ? -amounts[member.id] : amounts[member.id]) : undefined}>{transactionSplit && mode === "RATIO" ? formatTransactionAmount(type, amounts[member.id]) : total > 0 ? `${percentages[member.id] / 10}%` : "—"}</small>
          </label>
        ))}
        {inline && transactionSplit && <select aria-label={`${label}の単位`} value={mode} onChange={(event) => changeMode(event.target.value)}>
          <option value="RATIO">%</option><option value="AMOUNT" disabled={!validAmount}>円</option>
          <option value="EQUAL" disabled={members.length !== 2 || !onChange}>1:1</option>
        </select>}
      </div>
      {total <= 0 && <p className="form-error">どちらかの割合を1以上にしてください。</p>}
      {transactionSplit && !validAmount && <small className="split-note">明細の金額を入力すると、円でも設定できます。</small>}
    </fieldset>
  );
}

function safeAmounts(total: number, value: SplitWeights, members: WorkspaceMember[]) {
  try { return splitAmounts(total, value, members); }
  catch { return Object.fromEntries(members.map((member) => [member.id, 0])); }
}

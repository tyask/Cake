"use client";

import { useMemo, useState } from "react";
import type { RunAppAction } from "@/lib/app-input";
import { commonExpenseClassLabels, expenseClasses, MAX_AMOUNT_YEN, MAX_MERCHANT_LENGTH, MAX_METHOD_LENGTH } from "@/lib/domain-values";
import { defaultSplitWeights, personalSplitWeights, prepareDefaultRuleMatcher, transactionDefaults, validateSplitWeights } from "@/lib/expense-splits";
import { MAX_TRANSACTION_MEMO_LENGTH } from "@/lib/transaction-memo";
import type { ExpenseClass, SplitWeights, WorkspaceData } from "@/lib/types";
import { SplitEditor } from "./split-editor";
import { Modal } from "./dashboard-ui";

// Input initialization keeps its minute precision and input-specific locale.
const inputDateFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const inputDate = (value?: string) => {
  const date = value ? new Date(value) : new Date();
  const parts = inputDateFormatter.format(date);
  return parts.replace(" ", "T");
};
const jstInputToIso = (value: string) => new Date(`${value.length === 16 ? `${value}:00` : value}+09:00`).toISOString();

export function NewTransactionModal({ selected, currentUserId, close, run }: { selected: WorkspaceData; currentUserId: string; close: () => void; run: RunAppAction }) {
  const matchRule = useMemo(() => prepareDefaultRuleMatcher(selected.rules), [selected.rules]);
  const initialActor = selected.members.some((member) => member.id === currentUserId) ? currentUserId : selected.members[0]?.id ?? "";
  const [occurredAt, setOccurredAt] = useState(inputDate());
  const [merchant, setMerchant] = useState("");
  const [method, setMethod] = useState("現金");
  const [amountYen, setAmountYen] = useState(0);
  const [actorUserId, setActorUserId] = useState(initialActor);
  const [expenseClass, setExpenseClass] = useState<ExpenseClass>("SHARED");
  const [splitWeights, setSplitWeights] = useState<SplitWeights>(() => defaultSplitWeights(selected.members));
  const [memo, setMemo] = useState("");
  const [customized, setCustomized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyDefaults(nextMerchant = merchant, nextActor = actorUserId) {
    const defaults = transactionDefaults(nextMerchant, matchRule, selected.members, nextActor, "SHARED");
    setExpenseClass(defaults.expenseClass);
    setSplitWeights(defaults.splitWeights);
  }

  return <Modal title="明細を追加" close={close} className="transaction-modal">
    <form onSubmit={async (event) => {
      event.preventDefault();
      setError(null);
      setSaving(true);
      try {
        validateSplitWeights(splitWeights, selected.members, expenseClass, actorUserId);
        await run({ action: "saveTransaction", workspaceId: selected.workspace.id,
          occurredAt: jstInputToIso(occurredAt), merchant, method, type: "PAYMENT", amountYen, actorUserId, expenseClass, splitWeights, memo },
        "明細を追加しました。");
        close();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "明細を保存できませんでした。");
      } finally { setSaving(false); }
    }}>
      <div className="form-grid">
        <label className="full">取引日時<input type="datetime-local" required value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
        <label className="full">取引先<input required maxLength={MAX_MERCHANT_LENGTH} value={merchant} onChange={(event) => {
          setMerchant(event.target.value);
          if (!customized) applyDefaults(event.target.value);
        }} /></label>
        <label>取引方法<input required maxLength={MAX_METHOD_LENGTH} value={method} onChange={(event) => setMethod(event.target.value)} /></label>
        <label>金額（円）<input type="number" required min="1" max={MAX_AMOUNT_YEN} step="1" value={amountYen || ""} onChange={(event) => setAmountYen(Number(event.target.value))} /></label>
        <label>支払者<select value={actorUserId} onChange={(event) => {
          const nextActor = event.target.value;
          setActorUserId(nextActor);
          if (expenseClass === "PERSONAL") setSplitWeights(personalSplitWeights(selected.members, nextActor));
        }}>{selected.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label>費用区分<select value={expenseClass} onChange={(event) => {
          const nextClass = event.target.value as ExpenseClass;
          setExpenseClass(nextClass);
          setSplitWeights(nextClass === "PERSONAL" ? personalSplitWeights(selected.members, actorUserId) : defaultSplitWeights(selected.members));
          setCustomized(true);
        }}>{expenseClasses.map(value => <option key={value} value={value}>{commonExpenseClassLabels[value]}</option>)}</select></label>
        <div className="full">
          <SplitEditor inline allowEqualSplit label={`支払い割合（${selected.members.map((member) => member.name).join(", ")}）`} amountYen={amountYen} members={selected.members} value={splitWeights}
            disabled={expenseClass === "PERSONAL" || saving} onChange={(next) => { setSplitWeights(next); setCustomized(true); }} />
          <p className="ratio-note">{expenseClass === "PERSONAL" ? "個人費は支払者の負担が100%になります。" : "割合・金額で設定できます。相手の分は自動計算します。"}</p>
          <button type="button" className="text-button" disabled={saving} onClick={() => { applyDefaults(); setCustomized(false); }}>取引先のルールを適用</button>
        </div>
      </div>
      <label className="new-transaction-memo">メモ<textarea maxLength={MAX_TRANSACTION_MEMO_LENGTH} value={memo} disabled={saving} onChange={(event) => setMemo(event.target.value)} rows={2} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={close}>キャンセル</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "追加する"}</button></div>
    </form>
  </Modal>;
}


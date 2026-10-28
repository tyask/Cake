"use client";

import { useMemo, useState } from "react";
import type { RunAppAction } from "@/lib/shared/schemas/app-input";
import { commonExpenseClassLabels, expenseClasses, MAX_AMOUNT_YEN, MAX_MERCHANT_LENGTH, MAX_METHOD_LENGTH, transactionActorLabels, transactionTypeLabels, transactionTypes } from "@/lib/shared/domain-values";
import { defaultSplitWeights, personalSplitWeights, prepareDefaultRuleMatcher, transactionDefaults, validateSplitWeights } from "@/lib/shared/expense-splits";
import { MAX_TRANSACTION_MEMO_LENGTH } from "@/lib/shared/schemas/transaction-memo";
import { cashflowClass } from "@/lib/shared/display-formatters";
import type { ExpenseClass, SplitWeights, TransactionType, WorkspaceMetadata } from "@/lib/shared/types";
import { SplitEditor } from "./split-editor";
import { Modal } from "./dashboard-ui";
import { CategorySelect, prepareCategoryChoices } from "./category-select";

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

export function NewTransactionModal({ selected, currentUserId, close, run }: { selected: WorkspaceMetadata; currentUserId: string; close: () => void; run: RunAppAction }) {
  const matchRule = useMemo(() => prepareDefaultRuleMatcher(selected.rules), [selected.rules]);
  const categoryChoices = useMemo(() => prepareCategoryChoices(selected.categories), [selected.categories]);
  const initialActor = selected.members.some((member) => member.id === currentUserId) ? currentUserId : selected.members[0]?.id ?? "";
  const [occurredAt, setOccurredAt] = useState(inputDate());
  const [merchant, setMerchant] = useState("");
  const [method, setMethod] = useState("現金");
  const [type, setType] = useState<TransactionType>("PAYMENT");
  const [amountYen, setAmountYen] = useState(0);
  const [actorUserId, setActorUserId] = useState(initialActor);
  const [expenseClass, setExpenseClass] = useState<ExpenseClass>("SHARED");
  const [splitWeights, setSplitWeights] = useState<SplitWeights>(() => defaultSplitWeights(selected.members));
  const [memo, setMemo] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [customized, setCustomized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const personalActorInvalid = expenseClass === "PERSONAL" && actorUserId !== currentUserId;

  function applyDefaults(nextMerchant = merchant, nextActor = actorUserId) {
    const defaults = transactionDefaults(nextMerchant, matchRule, selected.members, nextActor, "SHARED");
    setExpenseClass(defaults.expenseClass);
    setSplitWeights(defaults.splitWeights);
  }

  function changeType(nextType: TransactionType) {
    setType(nextType);
    setCustomized(false);
    if (nextType === "RECEIPT") {
      setExpenseClass("PERSONAL");
      setSplitWeights(personalSplitWeights(selected.members, actorUserId));
    } else applyDefaults();
  }

  return <Modal title="明細を追加" close={close} className="transaction-modal">
    <form onSubmit={async (event) => {
      event.preventDefault();
      setError(null);
      setSaving(true);
      try {
        if (personalActorInvalid) throw new Error("個人の取引は本人だけが登録できます。担当者を自分に変更してください。");
        validateSplitWeights(splitWeights, selected.members, expenseClass, actorUserId);
        await run({ action: "saveTransaction", workspaceId: selected.workspace.id,
          occurredAt: jstInputToIso(occurredAt), merchant, method, type, amountYen, actorUserId, expenseClass, splitWeights, memo, categoryId },
        "明細を追加しました。");
        close();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "明細を保存できませんでした。");
      } finally { setSaving(false); }
    }}>
      <div className="form-grid">
        <label className="full">種別<select aria-label="種別" value={type} disabled={saving} onChange={(event) => changeType(event.target.value as TransactionType)}>{transactionTypes.map(value => <option key={value} value={value}>{transactionTypeLabels[value]}</option>)}</select></label>
        <label className="full">取引日時<input type="datetime-local" required disabled={saving} value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
        <label className="full">取引先<input required disabled={saving} maxLength={MAX_MERCHANT_LENGTH} value={merchant} onChange={(event) => {
          setMerchant(event.target.value);
          if (type === "PAYMENT" && !customized) applyDefaults(event.target.value);
        }} /></label>
        <label>取引方法<input required disabled={saving} maxLength={MAX_METHOD_LENGTH} value={method} onChange={(event) => setMethod(event.target.value)} /></label>
        <label>金額（円）<span className="signed-amount-input"><span className={cashflowClass(type === "PAYMENT" ? -amountYen : amountYen)} aria-hidden="true">{amountYen > 0 ? type === "PAYMENT" ? "−" : "+" : ""}</span><input aria-label="金額（円）" type="number" required disabled={saving} className={cashflowClass(type === "PAYMENT" ? -amountYen : amountYen)} min="1" max={MAX_AMOUNT_YEN} step="1" value={amountYen || ""} onChange={(event) => setAmountYen(Number(event.target.value))} /></span></label>
        <label>{transactionActorLabels[type]}<select aria-label={transactionActorLabels[type]} value={actorUserId} disabled={saving} onChange={(event) => {
          const nextActor = event.target.value;
          setActorUserId(nextActor);
          if (expenseClass === "PERSONAL") setSplitWeights(personalSplitWeights(selected.members, nextActor));
        }}>{selected.members.map((member) => <option key={member.id} value={member.id} disabled={expenseClass === "PERSONAL" && member.id !== currentUserId}>{member.name}</option>)}</select></label>
        <label>区分<select aria-label="区分" value={expenseClass} disabled={saving} onChange={(event) => {
          const nextClass = event.target.value as ExpenseClass;
          setExpenseClass(nextClass);
          setSplitWeights(nextClass === "PERSONAL" ? personalSplitWeights(selected.members, actorUserId) : defaultSplitWeights(selected.members));
          setCustomized(true);
        }}>{expenseClasses.map(value => <option key={value} value={value} disabled={value === "PERSONAL" && actorUserId !== currentUserId}>{commonExpenseClassLabels[value]}</option>)}</select></label>
        {actorUserId !== currentUserId && <p className="ratio-note full">個人の取引を登録する場合は、担当者を自分に変更してください。</p>}
        <label className="full">カテゴリ<CategorySelect choices={categoryChoices} value={categoryId} onChange={setCategoryId} disabled={saving} /></label>
        <div className="full">
          <SplitEditor inline label={`配分割合（${selected.members.map((member) => member.name).join(", ")}）`} type={type} amountYen={amountYen} members={selected.members} value={splitWeights}
            disabled={expenseClass === "PERSONAL" || saving} onChange={(next) => { setSplitWeights(next); setCustomized(true); }} />
          <p className="ratio-note">{expenseClass === "PERSONAL" ? `個人の取引は${transactionActorLabels[type]}への配分が100%になります。` : type === "RECEIPT" ? "共有の収入は、設定した割合で配分して清算します。" : "割合・金額で設定できます。相手の分は自動計算します。"}</p>
          {type === "PAYMENT" && <button type="button" className="text-button" disabled={saving} onClick={() => { applyDefaults(); setCustomized(false); }}>取引先のルールを適用</button>}
        </div>
      </div>
      <label className="new-transaction-memo">メモ<textarea aria-label="メモ" maxLength={MAX_TRANSACTION_MEMO_LENGTH} value={memo} disabled={saving} onChange={(event) => setMemo(event.target.value)} rows={2} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={close}>キャンセル</button><button className="primary" disabled={saving || personalActorInvalid}>{saving ? "保存中…" : "追加する"}</button></div>
    </form>
  </Modal>;
}

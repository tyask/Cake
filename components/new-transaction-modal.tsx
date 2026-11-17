"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeTransactionPhoto } from "@/lib/client/photo-transaction";
import { PHOTO_MIME_TYPES } from "@/lib/shared/photo-transaction";
import type { RunAppAction } from "@/lib/shared/schemas/app-input";
import { commonExpenseClassLabels, expenseClasses, MAX_AMOUNT_YEN, MAX_MERCHANT_LENGTH, MAX_METHOD_LENGTH, transactionActorLabels, transactionTypeLabels, transactionTypes } from "@/lib/shared/domain-values";
import { defaultSplitWeights, personalSplitWeights, prepareDefaultRuleMatcher, transactionDefaults, validateSplitWeights } from "@/lib/shared/expense-splits";
import { MAX_TRANSACTION_MEMO_LENGTH } from "@/lib/shared/schemas/transaction-memo";
import { cashflowClass } from "@/lib/shared/display-formatters";
import type { ExpenseClass, SplitWeights, TransactionType, WorkspaceMetadata } from "@/lib/shared/types";
import { SplitEditor } from "./split-editor";
import { Modal } from "./dashboard-ui";
import { CategorySelect, prepareCategoryChoices } from "./category-select";
import styles from "./new-transaction-modal.module.css";

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

type NewTransactionModalProps = { selected: WorkspaceMetadata; currentUserId: string; close: () => void; run: RunAppAction };

export function NewTransactionModal(props: NewTransactionModalProps) {
  // Reset the entire draft and abort pending photo work when the household changes,
  // including callers that do not put a workspace key on the modal themselves.
  return <NewTransactionForm key={props.selected.workspace.id} {...props} />;
}

function NewTransactionForm({ selected, currentUserId, close, run }: NewTransactionModalProps) {
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
  const [categoryCustomized, setCategoryCustomized] = useState(false);
  const [customized, setCustomized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const photoRequest = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const busy = saving || analyzing;
  const personalActorInvalid = expenseClass === "PERSONAL" && actorUserId !== currentUserId;

  useEffect(() => () => {
    requestId.current++;
    photoRequest.current?.abort();
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        requestId.current++;
        photoRequest.current?.abort();
        close();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [close, saving]);

  function closeModal() {
    requestId.current++;
    photoRequest.current?.abort();
    close();
  }

  async function readPhoto(file: File) {
    if (saving || photoRequest.current) return;
    const controller = new AbortController();
    const id = ++requestId.current;
    photoRequest.current = controller;
    setAnalyzing(true);
    setError(null);
    setPhotoMessage(null);
    try {
      const result = await analyzeTransactionPhoto(selected.workspace.id, file, controller.signal);
      if (controller.signal.aborted || requestId.current !== id) return;
      if (result.date !== null || result.time !== null) {
        setOccurredAt(previous => {
          const date = result.date ?? previous.slice(0, 10), time = result.time ?? previous.slice(11);
          return date && time ? `${date}T${time}` : previous;
        });
      }
      if (result.merchant !== null) {
        setMerchant(result.merchant);
        if (type === "PAYMENT" && !customized) applyDefaults(result.merchant);
      }
      if (result.amountYen !== null) setAmountYen(result.amountYen);
      if (result.memo !== null) setMemo(result.memo);
      const candidate = result.categoryId === null ? undefined : categoryChoices.byId.get(result.categoryId);
      if (!categoryCustomized && result.merchant !== null) setCategoryId(candidate && !candidate.archived ? candidate.id : null);
      const missing = [
        result.date === null && "取引日", result.time === null && "取引時刻",
        result.merchant === null && "取引先", result.amountYen === null && "金額", result.memo === null && "メモ",
      ].filter(Boolean);
      const messages = [missing.length === 5
        ? "写真から項目を読み取れませんでした。入力内容を確認するか、写真を撮り直してください。"
        : "写真の読み取り結果を入力しました。内容を確認してから追加してください。"];
      if (missing.length) messages.push(`${missing.join("・")}は読み取れなかったため、現在の入力を保持しています。確認・修正してください。`);
      if (result.date !== null && result.time === null) messages.push(`読み取った取引日は${result.date}です。取引時刻を確認してください。`);
      if (result.date === null && result.time !== null) messages.push(`読み取った取引時刻は${result.time}です。取引日を確認してください。`);
      if (result.categorySuggestionFailed) messages.push("カテゴリを補完できませんでした。カテゴリを確認してください。");
      else if (!categoryCustomized && result.merchant !== null && (!candidate || candidate.archived)) messages.push("カテゴリの候補がないため、未分類にしています。");
      setPhotoMessage(messages.join(" "));
    } catch (failure) {
      if (controller.signal.aborted || requestId.current !== id) return;
      setError(failure instanceof Error ? failure.message : "写真を解析できませんでした。もう一度お試しください。");
    } finally {
      if (requestId.current === id) {
        photoRequest.current = null;
        setAnalyzing(false);
      }
    }
  }

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

  return <Modal title="明細を追加" close={closeModal} className="transaction-modal">
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy || photoRequest.current) return;
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
      <div className={styles.photoActions}>
        <input ref={photoInput} className={styles.photoInput} type="file" aria-label="明細の写真" accept={PHOTO_MIME_TYPES.join(",")} capture="environment" disabled={busy} onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void readPhoto(file);
        }} />
        <button type="button" className={`secondary ${styles.photoButton}`} disabled={busy} onClick={() => photoInput.current?.click()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 5l1.5-2h5L16 5h4a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2z" /><circle cx="12" cy="13" r="4" /></svg>
          写真から入力
        </button>
        <p className={styles.photoHelp}>撮影した写真をOpenAIに送信して読み取ります。登録前に内容を確認できます。</p>
        <div role="status" aria-live="polite" aria-atomic="true">{(analyzing || photoMessage) && <p className={styles.photoStatus}>{analyzing ? "写真を解析しています…" : photoMessage}</p>}</div>
      </div>
      <div className="form-grid" aria-busy={analyzing}>
        <label className="full">種別<select aria-label="種別" value={type} disabled={busy} onChange={(event) => changeType(event.target.value as TransactionType)}>{transactionTypes.map(value => <option key={value} value={value}>{transactionTypeLabels[value]}</option>)}</select></label>
        <label className="full">取引日時<input type="datetime-local" required disabled={busy} value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
        <label className="full">取引先<input required disabled={busy} maxLength={MAX_MERCHANT_LENGTH} value={merchant} onChange={(event) => {
          setMerchant(event.target.value);
          if (type === "PAYMENT" && !customized) applyDefaults(event.target.value);
        }} /></label>
        <label>取引方法<input required disabled={busy} maxLength={MAX_METHOD_LENGTH} value={method} onChange={(event) => setMethod(event.target.value)} /></label>
        <label>金額（円）<span className="signed-amount-input"><span className={cashflowClass(type === "PAYMENT" ? -amountYen : amountYen)} aria-hidden="true">{amountYen > 0 ? type === "PAYMENT" ? "−" : "+" : ""}</span><input aria-label="金額（円）" type="number" required disabled={busy} className={cashflowClass(type === "PAYMENT" ? -amountYen : amountYen)} min="1" max={MAX_AMOUNT_YEN} step="1" value={amountYen || ""} onChange={(event) => setAmountYen(Number(event.target.value))} /></span></label>
        <label>{transactionActorLabels[type]}<select aria-label={transactionActorLabels[type]} value={actorUserId} disabled={busy} onChange={(event) => {
          const nextActor = event.target.value;
          setActorUserId(nextActor);
          if (expenseClass === "PERSONAL") setSplitWeights(personalSplitWeights(selected.members, nextActor));
        }}>{selected.members.map((member) => <option key={member.id} value={member.id} disabled={expenseClass === "PERSONAL" && member.id !== currentUserId}>{member.name}</option>)}</select></label>
        <label>区分<select aria-label="区分" value={expenseClass} disabled={busy} onChange={(event) => {
          const nextClass = event.target.value as ExpenseClass;
          setExpenseClass(nextClass);
          setSplitWeights(nextClass === "PERSONAL" ? personalSplitWeights(selected.members, actorUserId) : defaultSplitWeights(selected.members));
          setCustomized(true);
        }}>{expenseClasses.map(value => <option key={value} value={value} disabled={value === "PERSONAL" && actorUserId !== currentUserId}>{commonExpenseClassLabels[value]}</option>)}</select></label>
        {actorUserId !== currentUserId && <p className="ratio-note full">個人の取引を登録する場合は、担当者を自分に変更してください。</p>}
        <label className="full">カテゴリ<CategorySelect choices={categoryChoices} value={categoryId} onChange={next => { setCategoryId(next); setCategoryCustomized(true); }} disabled={busy} /></label>
        <div className="full">
          <SplitEditor inline label={`配分割合（${selected.members.map((member) => member.name).join(", ")}）`} type={type} amountYen={amountYen} members={selected.members} value={splitWeights}
            disabled={expenseClass === "PERSONAL" || busy} onChange={(next) => { setSplitWeights(next); setCustomized(true); }} />
          <p className="ratio-note">{expenseClass === "PERSONAL" ? `個人の取引は${transactionActorLabels[type]}への配分が100%になります。` : type === "RECEIPT" ? "共有の収入は、設定した割合で配分して清算します。" : "割合・金額で設定できます。相手の分は自動計算します。"}</p>
          {type === "PAYMENT" && <button type="button" className="text-button" disabled={busy} onClick={() => { applyDefaults(); setCustomized(false); }}>取引先のルールを適用</button>}
        </div>
      </div>
      <label className="new-transaction-memo">メモ<textarea aria-label="メモ" maxLength={MAX_TRANSACTION_MEMO_LENGTH} value={memo} disabled={busy} onChange={(event) => setMemo(event.target.value)} rows={2} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={closeModal}>キャンセル</button><button className="primary" disabled={busy || personalActorInvalid}>{saving ? "保存中…" : "追加する"}</button></div>
    </form>
  </Modal>;
}

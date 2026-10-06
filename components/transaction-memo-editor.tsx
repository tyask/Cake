"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_TRANSACTION_MEMO_LENGTH, transactionMemoSchema } from "@/lib/transaction-memo";
import styles from "./transactions-panel.module.css";

export type SaveTransactionMemo = (id: string, memo: string) => Promise<string>;

export function TransactionMemoEditor({ id, merchant, memo, disabled, updating = false, onSave, onPin }: {
  id: string;
  merchant: string;
  memo: string;
  disabled: boolean;
  updating?: boolean;
  onSave: SaveTransactionMemo;
  onPin: (id: string, pinned: boolean) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<{ sources: string[]; memo: string } | null>(null);
  if (acknowledged && memo === acknowledged.memo) setAcknowledged(null);
  const base = acknowledged?.sources.includes(memo) ? acknowledged.memo : memo;
  const baseRef = useRef(base);
  const incomingRef = useRef(memo);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const saveAgain = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef(false);
  const focused = useRef(false);
  const mounted = useRef(true);
  const pinned = useRef(false);

  useLayoutEffect(() => { baseRef.current = base; incomingRef.current = memo; }, [base, memo]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; onPin(id, false); };
  }, [id, onPin]);

  function syncPin() {
    const next = focused.current || savingRef.current || errorRef.current || draftRef.current !== null;
    if (mounted.current && next !== pinned.current) { pinned.current = next; onPin(id, next); }
  }

  async function commit() {
    if (disabled) return;
    if (savingRef.current) { saveAgain.current = true; return; }
    if (draftRef.current === null) return;
    if (draftRef.current === baseRef.current && !errorRef.current) {
      draftRef.current = null; setDraft(null); syncPin(); return;
    }
    const captured = draftRef.current;
    saveAgain.current = false;
    savingRef.current = true;
    setSaving(true);
    errorRef.current = false; setError(null); syncPin();
    try {
      const source = baseRef.current;
      const saved = await onSave(id, transactionMemoSchema.parse(captured));
      baseRef.current = saved;
      if (!mounted.current) return;
      setAcknowledged(current => ({ sources: [...new Set([source, incomingRef.current, ...(current?.sources ?? [])])], memo: saved }));
      if (draftRef.current === captured) { draftRef.current = null; setDraft(null); }
    } catch (failure) {
      errorRef.current = true;
      if (mounted.current) setError(failure instanceof Error ? failure.message : "メモを保存できませんでした。");
    } finally {
      savingRef.current = false;
      if (mounted.current) {
        setSaving(false);
        syncPin();
        if (saveAgain.current && !errorRef.current) { saveAgain.current = false; void commit(); }
      }
    }
  }

  return <div className={styles.memoEditor} data-memo-editor>
    <div className={styles.memoInputRow}>
    <textarea aria-label={merchant + "のメモ"} placeholder="メモ" rows={2} maxLength={MAX_TRANSACTION_MEMO_LENGTH}
      title="入力欄を離れるかCtrl+Enterで保存" value={draft ?? base} disabled={disabled}
      onChange={event => { draftRef.current = event.target.value; setDraft(event.target.value); errorRef.current = false; setError(null); syncPin(); }}
      onFocus={() => { focused.current = true; syncPin(); }}
      onBlur={event => {
        focused.current = false;
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.closest("[data-memo-editor]")?.contains(event.relatedTarget)) void commit();
        syncPin();
      }}
      onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void commit(); } }} />
      <span className={styles.memoStatus}>
        {(saving || updating) && <span className={styles.savingIndicator} role="status" aria-label="保存中"><span className={styles.spinner} aria-hidden="true" /></span>}
      </span>
    </div>
    {error && <div className={styles.error} role="alert">{error}<button type="button" className="text-button" disabled={disabled || saving} onClick={() => { void commit(); }}>再試行</button></div>}
  </div>;
}

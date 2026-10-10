"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_TRANSACTION_MEMO_LENGTH, transactionMemoSchema } from "@/lib/transaction-memo";
import styles from "./transactions-panel.module.css";

export type SaveTransactionMemo = (id: string, memo: string) => Promise<string>;
export type TransactionMemoHandle = { freeze: (value: boolean) => void; flush: () => Promise<void> };

export function TransactionMemoEditor({ id, merchant, memo, disabled, onSave, onPin, onError, onSavingChange, register }: {
  id: string;
  merchant: string;
  memo: string;
  disabled: boolean;
  onSave: SaveTransactionMemo;
  onPin: (id: string, pinned: boolean) => void;
  onError?: () => void;
  onSavingChange: (saving: boolean) => void;
  register?: (handle: TransactionMemoHandle | null) => void;
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
  const inFlight = useRef<Promise<void> | null>(null);
  const frozen = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef(false);
  const focused = useRef(false);
  const mounted = useRef(true);
  const pinned = useRef(false);

  useLayoutEffect(() => { baseRef.current = base; incomingRef.current = memo; }, [base, memo]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; onPin(id, false); onSavingChange(false); };
  }, [id, onPin, onSavingChange]);

  function syncPin() {
    const next = focused.current || savingRef.current || errorRef.current || draftRef.current !== null;
    if (mounted.current && next !== pinned.current) { pinned.current = next; onPin(id, next); }
  }

  function commit(): Promise<void> {
    if (inFlight.current) { saveAgain.current = true; return inFlight.current; }
    if (draftRef.current === null) return Promise.resolve();
    if (draftRef.current === baseRef.current && !errorRef.current) {
      draftRef.current = null; setDraft(null); syncPin(); return Promise.resolve();
    }
    const captured = draftRef.current;
    saveAgain.current = false;
    savingRef.current = true;
    setSaving(true);
    onSavingChange(true);
    errorRef.current = false; setError(null); syncPin();
    const source = baseRef.current;
    const operation = Promise.resolve().then(() => onSave(id, transactionMemoSchema.parse(captured))).then(saved => {
      baseRef.current = saved;
      if (!mounted.current) return;
      setAcknowledged(current => ({ sources: [...new Set([source, incomingRef.current, ...(current?.sources ?? [])])], memo: saved }));
      if (draftRef.current === captured) { draftRef.current = null; setDraft(null); }
    }).catch(failure => {
      errorRef.current = true;
      if (mounted.current) { setError(failure instanceof Error ? failure.message : "メモを保存できませんでした。"); onError?.(); }
      throw failure;
    }).finally(() => {
      inFlight.current = null;
      savingRef.current = false;
      if (mounted.current) {
        setSaving(false);
        onSavingChange(false);
        syncPin();
        if (saveAgain.current && !errorRef.current && !frozen.current && !disabled) { saveAgain.current = false; requestCommit(); }
      }
    });
    inFlight.current = operation;
    return operation;
  }

  function requestCommit() {
    if (!disabled && !frozen.current) void commit().catch(() => undefined);
  }

  async function flush() {
    while (inFlight.current) await inFlight.current;
    await commit();
    while (inFlight.current) await inFlight.current;
  }

  useLayoutEffect(() => {
    register?.({ freeze: value => { frozen.current = value; }, flush });
    return () => register?.(null);
  });

  return <div className={styles.memoEditor} data-memo-editor>
    <textarea aria-label={merchant + "のメモ"} placeholder="メモ" rows={2} maxLength={MAX_TRANSACTION_MEMO_LENGTH}
      title="入力欄を離れるかCtrl+Enterで保存" value={draft ?? base} disabled={disabled}
      onChange={event => { if (disabled || frozen.current) return; draftRef.current = event.target.value; setDraft(event.target.value); errorRef.current = false; setError(null); syncPin(); }}
      onFocus={() => { focused.current = true; syncPin(); }}
      onBlur={event => {
        focused.current = false;
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.closest("[data-memo-editor]")?.contains(event.relatedTarget)) requestCommit();
        syncPin();
      }}
      onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); requestCommit(); } }} />
    {error && <div className={styles.error} role="alert">{error}<button type="button" className="text-button" disabled={disabled || saving} onClick={requestCommit}>再試行</button></div>}
  </div>;
}

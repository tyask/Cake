"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CategorySelect, type CategoryChoices } from "./category-select";
import styles from "./transactions-panel.module.css";

export type SaveTransactionCategory = (id: string, categoryId: string | null) => Promise<{ categoryId: string | null; categoryRevision: number }>;
export type TransactionCategoryHandle = { freeze: (value: boolean) => void; flush: () => Promise<void> };

export function TransactionCategoryEditor({ id, merchant, categoryId, categoryRevision, choices, display, disabled, onSave, onPin, onError, onSavingChange, register }: {
  id: string;
  merchant: string;
  categoryId: string | null;
  categoryRevision: number;
  choices: CategoryChoices;
  display: "root" | "full";
  disabled: boolean;
  onSave: SaveTransactionCategory;
  onPin: (id: string, pinned: boolean) => void;
  onError: () => void;
  onSavingChange: (saving: boolean) => void;
  register: (handle: TransactionCategoryHandle | null) => void;
}) {
  const [draft, setDraft] = useState<string | null | undefined>(undefined);
  const draftRef = useRef<string | null | undefined>(undefined);
  const [acknowledged, setAcknowledged] = useState<{ categoryId: string | null; categoryRevision: number } | null>(null);
  if (acknowledged && categoryRevision >= acknowledged.categoryRevision) setAcknowledged(null);
  const base = acknowledged && acknowledged.categoryRevision > categoryRevision ? acknowledged.categoryId : categoryId;
  const baseRef = useRef(base);
  const incomingRef = useRef(categoryId);
  const incomingRevision = useRef(categoryRevision);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const saveAgain = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const frozen = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef(false);
  const mounted = useRef(true);
  const pinned = useRef(false);

  useLayoutEffect(() => { baseRef.current = base; incomingRef.current = categoryId; incomingRevision.current = categoryRevision; }, [base, categoryId, categoryRevision]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; onPin(id, false); onSavingChange(false); };
  }, [id, onPin, onSavingChange]);

  function syncPin() {
    const next = savingRef.current || errorRef.current || draftRef.current !== undefined;
    if (mounted.current && next !== pinned.current) { pinned.current = next; onPin(id, next); }
  }

  function commit(): Promise<void> {
    if (inFlight.current) { saveAgain.current = true; return inFlight.current; }
    if (draftRef.current === undefined) return Promise.resolve();
    if (draftRef.current === baseRef.current && !errorRef.current) {
      draftRef.current = undefined; setDraft(undefined); syncPin(); return Promise.resolve();
    }
    const captured = draftRef.current;
    saveAgain.current = false;
    savingRef.current = true;
    setSaving(true);
    onSavingChange(true);
    errorRef.current = false; setError(null); syncPin();
    const operation = Promise.resolve().then(() => onSave(id, captured)).then(saved => {
      baseRef.current = saved.categoryRevision > incomingRevision.current ? saved.categoryId : incomingRef.current;
      if (!mounted.current) return;
      setAcknowledged(saved.categoryRevision > incomingRevision.current ? saved : null);
      if (draftRef.current === captured) { draftRef.current = undefined; setDraft(undefined); }
    }).catch(failure => {
      errorRef.current = true;
      if (mounted.current) { setError(failure instanceof Error ? failure.message : "カテゴリを保存できませんでした。選択は保持しています。"); onError(); }
      throw failure;
    }).finally(() => {
      inFlight.current = null;
      savingRef.current = false;
      if (mounted.current) {
        setSaving(false); onSavingChange(false); syncPin();
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
    register({ freeze: value => { frozen.current = value; }, flush });
    return () => register(null);
  });

  return <div data-category-editor>
    <CategorySelect choices={choices} value={draft === undefined ? base : draft} display={display} label={merchant + "のカテゴリ"} disabled={disabled || saving}
      onChange={value => {
        if (disabled || frozen.current) return;
        draftRef.current = value; setDraft(value); errorRef.current = false; setError(null); syncPin(); requestCommit();
      }} />
    {error && <div className={styles.error} role="alert">{error}<button type="button" className="text-button" disabled={disabled || saving} onClick={requestCommit}>再試行</button></div>}
  </div>;
}

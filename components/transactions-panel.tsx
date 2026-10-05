"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { transactionActorPatch, transactionDateInput, transactionDateToIso, transactionExpensePatch, transactionValues, validateTransactionValues, type TransactionValues } from "@/lib/transaction-editing";
import type { ExpenseClass, SplitWeights, TransactionRecord, TransactionType, WorkspaceData, WorkspaceMember } from "@/lib/types";
import styles from "./transactions-panel.module.css";

type RunAction = (payload: Record<string, unknown>, success: string) => Promise<unknown>;
type SaveTransaction = (id: string, getValues: () => TransactionValues) => Promise<TransactionValues>;
type AcknowledgedSave = { sources: string[]; values: TransactionValues };
type RowHandle = { freeze: (value: boolean) => void; flush: () => Promise<void>; acceptRules: (values: TransactionValues) => void };
type BulkAction = "deleteTransactions" | "applyTransactionRules";

const money = (value: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(value);
const dateTime = (value: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));

function signature(values: TransactionValues): string {
  return JSON.stringify([values.occurredAt, values.merchant, values.method, values.type, values.amountYen, values.actorUserId, values.expenseClass, Object.entries(values.splitWeights).sort(([a], [b]) => a.localeCompare(b))]);
}

function fieldEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as SplitWeights;
  const b = right as SplitWeights;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]);
}

export function TransactionsPanel({ selected, add, run }: { selected: WorkspaceData; add: () => void; run: RunAction }) {
  return <TransactionList key={selected.workspace.id} selected={selected} add={add} run={run} />;
}

function SelectAllCheckbox({ checked, partial, disabled, onChange }: { checked: boolean; partial: boolean; disabled: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <input ref={ref} className={styles.checkbox} type="checkbox" aria-label="表示中の未清算明細をすべて選択" checked={checked} disabled={disabled} onChange={onChange} />;
}

function TransactionList({ selected, add, run }: { selected: WorkspaceData; add: () => void; run: RunAction }) {
  const [query, setQuery] = useState("");
  const [expense, setExpense] = useState("ALL");
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState(0);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const bulkBusyRef = useRef(false);
  const handles = useRef(new Map<string, RowHandle>());
  const currentSelected = useRef(selected);
  useLayoutEffect(() => { currentSelected.current = selected; }, [selected]);
  const onPin = useCallback((id: string, pinned: boolean) => {
    setPinnedIds((current) => {
      if (current.has(id) === pinned) return current;
      const next = new Set(current);
      if (pinned) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const register = useCallback((id: string, handle: RowHandle | null) => {
    if (handle) handles.current.set(id, handle); else handles.current.delete(id);
  }, []);
  function matches(item: TransactionRecord) {
    return (expense === "ALL" || item.expenseClass === expense) && item.merchant.toLowerCase().includes(query.toLowerCase());
  }
  const visible = selected.transactions.filter((item) => matches(item) || pinnedIds.has(item.id));
  const editableIds = new Set(selected.transactions.filter((item) => !item.settledAt).map((item) => item.id));
  const checkedIds = [...selectedIds].filter((id) => editableIds.has(id));
  const visibleEditable = visible.filter((item) => !item.settledAt);
  const checkedVisibleCount = visibleEditable.filter((item) => selectedIds.has(item.id)).length;
  const allVisibleChecked = visibleEditable.length > 0 && checkedVisibleCount === visibleEditable.length;
  const hiddenCheckedCount = checkedIds.filter((id) => !visible.some((item) => item.id === id)).length;
  const busy = bulkAction !== null;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    setPending((count) => count + 1);
    const result = queue.current.then(operation);
    queue.current = result.then(() => undefined, () => undefined);
    void result.then(() => setPending((count) => count - 1), () => setPending((count) => count - 1));
    return result;
  }

  const save: SaveTransaction = (transactionId, getValues) => enqueue(async () => {
    const values = getValues();
    await run({ action: "saveTransaction", workspaceId: selected.workspace.id, transactionId, ...values }, "");
    return values;
  });

  function toggle(id: string) {
    if (bulkBusyRef.current) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleVisible() {
    if (bulkBusyRef.current) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const item of visibleEditable) {
        if (allVisibleChecked) next.delete(item.id); else next.add(item.id);
      }
      return next;
    });
  }

  async function performBulk(action: BulkAction) {
    if (bulkBusyRef.current || checkedIds.length === 0) return;
    const ids = [...checkedIds];
    if (action === "deleteTransactions" && !confirm("選択した" + ids.length + "件の明細を削除しますか？")) return;
    bulkBusyRef.current = true;
    for (const handle of handles.current.values()) handle.freeze(true);
    setBulkAction(action);
    setBulkError(null);
    setBulkNotice(null);
    try {
      // A rule must see the saved merchant and actor; no later autosave may undo its result.
      for (const id of ids) await handles.current.get(id)?.flush();
      const latestIds = new Set(currentSelected.current.transactions.filter((item) => !item.settledAt).map((item) => item.id));
      if (ids.some((id) => !latestIds.has(id))) throw new Error("選択した明細が削除または清算されています。選択し直してください。");
      const result = await enqueue(() => run({ action, workspaceId: selected.workspace.id, transactionIds: ids }, action === "deleteTransactions" ? "選択した明細を削除しました。" : "共有費ルールを適用しました。"));
      if (action === "deleteTransactions") {
        setSelectedIds((current) => new Set([...current].filter((id) => !ids.includes(id))));
        setBulkNotice(ids.length + "件の明細を削除しました。");
      } else {
        const applied = (result as { appliedTransactions?: ({ id: string } & TransactionValues)[] } | null)?.appliedTransactions;
        for (const { id, ...values } of applied ?? []) handles.current.get(id)?.acceptRules(values);
        setBulkNotice(ids.length + "件に共有費ルールを適用しました。");
      }
    } catch (failure) {
      setBulkError(failure instanceof Error ? failure.message : "一括処理に失敗しました。選択と入力内容は保持しています。");
    } finally {
      for (const handle of handles.current.values()) handle.freeze(false);
      bulkBusyRef.current = false;
      setBulkAction(null);
    }
  }

  return <>
    <div className="page-heading"><div><span>TRANSACTIONS</span><h1>取引明細</h1><p>一覧から直接編集できます。文字・金額・日時・割合は欄を離れるかEnterで保存し、選択項目はすぐ保存します。</p></div><button className="primary" disabled={busy} onClick={add}>＋ 明細を追加</button></div>
    <section className={"panel " + styles.panel} aria-busy={pending > 0 || busy}>
      <div className={styles.toolbar}>
        <label className={styles.search}><span aria-hidden="true">⌕</span><input aria-label="取引先を検索" placeholder="取引先を検索" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} /></label>
        <select aria-label="費用区分で絞り込み" value={expense} disabled={busy} onChange={(event) => setExpense(event.target.value)}><option value="ALL">すべての費用区分</option><option value="PERSONAL">個人費</option><option value="SHARED">共有費</option></select>
        <span className={styles.count}>{visible.length}件</span>
      </div>
      <div className={styles.bulkBar}>
        <span>{checkedIds.length}件選択{hiddenCheckedCount > 0 && "（非表示" + hiddenCheckedCount + "件を含む）"}</span>
        <button type="button" disabled={busy || checkedIds.length === 0} onClick={() => { void performBulk("applyTransactionRules"); }}>{bulkAction === "applyTransactionRules" ? "適用中…" : "共有費ルールの適用"}</button>
        <button type="button" className={styles.bulkDelete} disabled={busy || checkedIds.length === 0} onClick={() => { void performBulk("deleteTransactions"); }}>{bulkAction === "deleteTransactions" ? "削除中…" : "削除"}</button>
        {checkedIds.length > 0 && <button type="button" className={styles.clearSelection} disabled={busy} onClick={() => setSelectedIds(new Set())}>選択解除</button>}
      </div>
      {bulkError && <p role="alert" className={styles.bulkError}>{bulkError}</p>}
      {bulkNotice && <p role="status" className={styles.bulkNotice}>{bulkNotice}</p>}
      <p className={styles.note}>清算済みの明細は選択・変更できません。絞り込み後も選択を保持します。編集中の明細は編集を終えるまで表示します。</p>
      <div className={styles.tableWrap}><table className={styles.table} aria-label="取引明細">
        <colgroup><col className={styles.selectionColumn} /><col className={styles.dateColumn} /><col className={styles.merchantColumn} /><col className={styles.methodColumn} /><col className={styles.typeColumn} /><col className={styles.amountColumn} /><col className={styles.actorColumn} /><col className={styles.classColumn} />{selected.members.map((member) => <col key={member.id} className={styles.ratioColumn} />)}<col className={styles.settlementColumn} /><col className={styles.sourceColumn} /></colgroup>
        <thead><tr><th className={styles.selectionCell}><SelectAllCheckbox checked={allVisibleChecked} partial={checkedVisibleCount > 0 && !allVisibleChecked} disabled={busy || visibleEditable.length === 0} onChange={toggleVisible} /></th><th>取引日時</th><th>取引先</th><th>方法</th><th>種別</th><th>金額（円）</th><th>担当者</th><th>費用区分</th>{selected.members.map((member) => <th key={member.id} title={member.name + "の負担割合"}>{member.name}の割合</th>)}<th>清算</th><th>登録元</th></tr></thead>
        <tbody>{visible.map((item) => <EditableTransaction key={item.id} item={item} members={selected.members} pinnedOutsideFilter={!matches(item)} checked={selectedIds.has(item.id)} busy={busy} applyingRules={bulkAction === "applyTransactionRules" && selectedIds.has(item.id)} onSelect={toggle} register={register} onPin={onPin} onSave={save} />)}</tbody>
      </table></div>
      {visible.length === 0 && <p className={styles.empty}>条件に一致する明細がありません。</p>}
    </section>
  </>;
}

function EditableTransaction({ item, members, pinnedOutsideFilter, checked, busy, applyingRules, onSelect, register, onPin, onSave }: {
  item: TransactionRecord;
  members: WorkspaceMember[];
  pinnedOutsideFilter: boolean;
  checked: boolean;
  busy: boolean;
  applyingRules: boolean;
  onSelect: (id: string) => void;
  register: (id: string, handle: RowHandle | null) => void;
  onPin: (id: string, pinned: boolean) => void;
  onSave: SaveTransaction;
}) {
  const [changes, setChanges] = useState<Partial<TransactionValues>>({});
  const changesRef = useRef<Partial<TransactionValues>>({});
  const [dateDraft, setDateDraft] = useState<string | null>(null);
  const dateDraftRef = useRef<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<AcknowledgedSave | null>(null);
  const acknowledgedRef = useRef<AcknowledgedSave | null>(null);
  const [pending, setPending] = useState(0);
  const pendingRef = useRef(0);
  const inFlight = useRef(new Set<Promise<void>>());
  const frozenRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef(false);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const lastPinnedRef = useRef(false);
  const mountedRef = useRef(true);
  const itemRef = useRef(item);
  const incoming = transactionValues(item);
  const incomingSignature = signature(incoming);
  if (acknowledged && incomingSignature === signature(acknowledged.values)) setAcknowledged(null);
  const base = acknowledged && acknowledged.sources.includes(incomingSignature) ? acknowledged.values : incoming;
  const baseRef = useRef(base);
  const sourceSignatureRef = useRef(incomingSignature);
  const draft = { ...base, ...changes };

  useLayoutEffect(() => {
    baseRef.current = base;
    sourceSignatureRef.current = incomingSignature;
    acknowledgedRef.current = acknowledged;
    itemRef.current = item;
    if (item.settledAt) { lastPinnedRef.current = false; onPin(item.id, false); }
  }, [acknowledged, base, incomingSignature, item, onPin]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; onPin(item.id, false); };
  }, [item.id, onPin]);

  function editorFocused(target: EventTarget | null = document.activeElement) {
    return target instanceof Element && !!rowRef.current?.contains(target) && !target.closest("[data-selection]");
  }

  function syncPin(focused = editorFocused()) {
    if (!mountedRef.current) return;
    const pinned = !itemRef.current.settledAt && (focused || pendingRef.current > 0 || errorRef.current || dateDraftRef.current !== null || Object.keys(changesRef.current).length > 0);
    if (pinned !== lastPinnedRef.current) { lastPinnedRef.current = pinned; onPin(item.id, pinned); }
  }

  function acceptSaved(saved: TransactionValues) {
    baseRef.current = saved;
    const previous = acknowledgedRef.current;
    const sources = [...new Set([sourceSignatureRef.current, ...(previous?.sources ?? []), ...(previous ? [signature(previous.values)] : [])])];
    const next = sourceSignatureRef.current === signature(saved) ? null : { sources, values: saved };
    acknowledgedRef.current = next;
    setAcknowledged(next);
  }

  function commit(): Promise<void> {
    if (itemRef.current.settledAt) return Promise.reject(new Error("清算済みの明細は変更できません。"));
    if (Object.keys(changesRef.current).length === 0 && dateDraftRef.current === null && !errorRef.current) return Promise.resolve();
    pendingRef.current += 1;
    setPending(pendingRef.current);
    errorRef.current = false;
    setError(null);
    syncPin();
    let captured: Partial<TransactionValues> = {};
    let capturedDate: string | null = null;
    const operation = onSave(item.id, () => {
      if (itemRef.current.settledAt) throw new Error("清算済みの明細は変更できません。");
      captured = { ...changesRef.current };
      capturedDate = dateDraftRef.current;
      const values = { ...baseRef.current, ...captured };
      if (capturedDate !== null) values.occurredAt = transactionDateToIso(capturedDate);
      return validateTransactionValues(values, members);
    }).then((saved) => {
      acceptSaved(saved);
      const remaining = { ...changesRef.current };
      for (const key of Object.keys(captured) as (keyof TransactionValues)[]) {
        if (fieldEqual(remaining[key], captured[key])) delete remaining[key];
      }
      changesRef.current = remaining;
      setChanges(remaining);
      if (dateDraftRef.current === capturedDate) { dateDraftRef.current = null; setDateDraft(null); }
      errorRef.current = false;
      setError(null);
    }).catch((failure) => {
      errorRef.current = true;
      setError(failure instanceof Error ? failure.message : "明細を保存できませんでした。入力内容は保持しています。");
      throw failure;
    }).finally(() => {
      inFlight.current.delete(operation);
      pendingRef.current -= 1;
      setPending(pendingRef.current);
      syncPin();
    });
    inFlight.current.add(operation);
    return operation;
  }

  function requestCommit() {
    if (!frozenRef.current && !busy) void commit().catch(() => undefined);
  }

  async function flush() {
    while (inFlight.current.size > 0) await Promise.all([...inFlight.current]);
    if (itemRef.current.settledAt) throw new Error("清算済みの明細は変更できません。");
    await commit();
    while (inFlight.current.size > 0) await Promise.all([...inFlight.current]);
  }

  useLayoutEffect(() => {
    register(item.id, {
      freeze: (value) => { frozenRef.current = value; },
      flush,
      acceptRules: (values) => {
        acceptSaved(values);
        changesRef.current = {};
        setChanges({});
        dateDraftRef.current = null;
        setDateDraft(null);
        errorRef.current = false;
        setError(null);
        syncPin();
      },
    });
    return () => register(item.id, null);
  });

  function change(patch: Partial<TransactionValues>, saveImmediately = false) {
    if (frozenRef.current || busy) return;
    changesRef.current = { ...changesRef.current, ...patch };
    setChanges(changesRef.current);
    errorRef.current = false;
    setError(null);
    syncPin();
    if (saveImmediately) requestCommit();
  }

  function changeDate(value: string) {
    if (frozenRef.current || busy) return;
    dateDraftRef.current = value;
    setDateDraft(value);
    errorRef.current = false;
    setError(null);
    try { change({ occurredAt: transactionDateToIso(value) }); } catch { syncPin(); }
  }

  function commitOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); requestCommit(); }
  }

  if (item.settledAt) return <SettledTransaction item={item} members={members} />;

  const currentValues = () => ({ ...baseRef.current, ...changesRef.current });
  return <><tr ref={rowRef} data-transaction-id={item.id}
    onFocusCapture={(event) => syncPin(editorFocused(event.target))}
    onBlurCapture={(event) => syncPin(editorFocused(event.relatedTarget))}>
    <td data-label="選択" className={styles.selectionCell} data-selection><input className={styles.checkbox} type="checkbox" aria-label={item.merchant + "の明細を選択"} checked={checked} disabled={busy} onChange={() => onSelect(item.id)} /></td>
    <td data-label="取引日時" className={styles.fullCell + " " + styles.dateCell}><input aria-label="取引日時" type="datetime-local" step="0.001" required value={dateDraft ?? transactionDateInput(draft.occurredAt)} title={dateDraft ?? transactionDateInput(draft.occurredAt)} disabled={busy} onChange={(event) => changeDate(event.target.value)} onBlur={requestCommit} onKeyDown={commitOnEnter} /></td>
    <td data-label="取引先"><input aria-label="取引先" required maxLength={240} value={draft.merchant} disabled={busy} onChange={(event) => change({ merchant: event.target.value })} onBlur={requestCommit} onKeyDown={commitOnEnter} /></td>
    <td data-label="方法"><input aria-label="取引方法" required maxLength={120} value={draft.method} disabled={busy} onChange={(event) => change({ method: event.target.value })} onBlur={requestCommit} onKeyDown={commitOnEnter} /></td>
    <td data-label="種別"><select aria-label="取引種別" value={draft.type} disabled={busy} onChange={(event) => change({ type: event.target.value as TransactionType }, true)}><option value="PAYMENT">支払い</option><option value="RECEIPT">受け取り</option></select></td>
    <td data-label="金額（円）"><input aria-label="金額（円）" type="number" required min="1" max="2147483647" step="1" value={draft.amountYen} disabled={busy} onChange={(event) => change({ amountYen: Number(event.target.value) })} onBlur={requestCommit} onKeyDown={commitOnEnter} /></td>
    <td data-label={draft.type === "PAYMENT" ? "支払者" : "受取者"}><select aria-label={draft.type === "PAYMENT" ? "支払者" : "受取者"} value={draft.actorUserId} disabled={busy} onChange={(event) => change(transactionActorPatch(currentValues(), event.target.value, members), true)}>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></td>
    <td data-label="費用区分"><select aria-label="費用区分" value={draft.expenseClass} disabled={busy} onChange={(event) => change(transactionExpensePatch(currentValues(), event.target.value as ExpenseClass, members), true)}><option value="PERSONAL">個人費</option><option value="SHARED">共有費</option></select></td>
    {members.map((member) => <td key={member.id} data-label={member.name + "の割合"}><input aria-label={member.name + "の割合"} type="number" required min="0" max="2147483647" step="1" value={draft.splitWeights[member.id] ?? 0} disabled={busy || draft.expenseClass === "PERSONAL"}
      onChange={(event) => change({ splitWeights: { ...currentValues().splitWeights, [member.id]: Number(event.target.value) } })} onBlur={requestCommit} onKeyDown={commitOnEnter} /></td>)}
    <td data-label="清算"><span className={draft.expenseClass === "SHARED" ? styles.unsettled : styles.muted}>{draft.expenseClass === "PERSONAL" ? "対象外" : "未清算"}</span></td>
    <td data-label="登録元" className={styles.sourceCell}>
      {item.source === "PAYPAY" ? "PayPay取込" : "手動"}
      {(pending > 0 || applyingRules) && <span className={styles.savingIndicator} role="status" aria-label="保存中"><span className={styles.spinner} aria-hidden="true" /></span>}
    </td>
  </tr>
    {(error || pinnedOutsideFilter) && <tr className={styles.feedbackRow} data-feedback-for={item.id}><td colSpan={10 + members.length} className={styles.feedbackCell}>
      {pinnedOutsideFilter && <small className={styles.filterHint}>編集中のため表示</small>}
      {error && <div className={styles.error} role="alert">{error}<button type="button" className="text-button" disabled={busy || pending > 0} onClick={requestCommit}>再試行</button></div>}
    </td></tr>}
  </>;
}

function SettledTransaction({ item, members }: { item: TransactionRecord; members: WorkspaceMember[] }) {
  return <tr data-transaction-id={item.id} className={styles.settled}>
    <td data-label="選択" className={styles.selectionCell} data-selection><input className={styles.checkbox} type="checkbox" aria-label={item.merchant + "の明細を選択"} checked={false} disabled /></td>
    <td data-label="取引日時" className={styles.fullCell + " " + styles.dateCell} title={dateTime(item.occurredAt)}>{dateTime(item.occurredAt)}</td>
    <td data-label="取引先"><b>{item.merchant}</b></td>
    <td data-label="方法">{item.method}</td>
    <td data-label="種別">{item.type === "PAYMENT" ? "支払い" : "受け取り"}</td>
    <td data-label="金額（円）">{item.type === "PAYMENT" ? "−" : "+"}{money(item.amountYen)}</td>
    <td data-label={item.type === "PAYMENT" ? "支払者" : "受取者"}>{item.actorName}</td>
    <td data-label="費用区分">{item.expenseClass === "PERSONAL" ? "個人費" : "共有費"}</td>
    {members.map((member) => <td key={member.id} data-label={member.name + "の割合"}>{item.splitWeights[member.id] ?? 0}</td>)}
    <td data-label="清算">清算済み</td>
    <td data-label="登録元" className={styles.sourceCell}>{item.source === "PAYPAY" ? "PayPay取込" : "手動"}</td>
  </tr>;
}

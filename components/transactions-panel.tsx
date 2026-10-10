"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { transactionActorPatch, transactionDateInput, transactionDateToIso, transactionExpensePatch, transactionValues, validateTransactionValues, type TransactionValues } from "@/lib/transaction-editing";
import type { ExpenseClass, SplitWeights, TransactionRecord, WorkspaceData, WorkspaceMember } from "@/lib/types";
import styles from "./transactions-panel.module.css";
import { splitAmounts } from "@/lib/split-allocations";
import { SplitEditor } from "./split-editor";
import { TransactionFilterDialog } from "./transaction-filter-dialog";
import { SelectionCheckbox } from "./selection-checkbox";
import { TransactionMemoEditor, type SaveTransactionMemo, type TransactionMemoHandle } from "./transaction-memo-editor";
import { RefreshButton } from "./refresh-button";
import { refreshTransactionEditors } from "@/lib/transaction-refresh";
import { transactionMemoSchema } from "@/lib/transaction-memo";
import { matchesTransactionFilters, transactionColumns, transactionFilterOptions, type TransactionColumn } from "@/lib/transaction-filters";
import { MobileTransactionSummary, TransactionTable, transactionSplitLabel } from "./transaction-table";
import { useTransactionFilters } from "./use-transaction-filters";

type RunAction = (payload: Record<string, unknown>, success: string) => Promise<unknown>;
type SaveTransaction = (id: string, getValues: () => TransactionValues) => Promise<TransactionValues>;
type AcknowledgedSave = { sources: string[]; values: TransactionValues };
type RowHandle = { freeze: (value: boolean) => void; flush: () => Promise<void>; acceptRules: (values: TransactionValues) => void };
type BulkAction = "deleteTransactions" | "applyTransactionRules";
type TransactionListProps = {
  selected: WorkspaceData;
  userId: string;
  add: () => void;
  run: RunAction;
  onRefresh: (prepare: () => Promise<void>) => Promise<void>;
  refreshing: boolean;
};

const money = (value: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(value);
const dateTime = (value: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
const tableColumns = [{ id: "selection", label: "選択" }, ...transactionColumns, { id: "updateStatus", label: "更新状態" }] as const;

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

export function TransactionsPanel(props: TransactionListProps) {
  return <TransactionList key={`${props.userId}:${props.selected.workspace.id}`} {...props} />;
}

function TransactionList({ selected, userId, add, run, onRefresh, refreshing }: TransactionListProps) {
  const [columnFilters, setColumnFilters] = useTransactionFilters(userId, selected.workspace.id);
  const [filterColumn, setFilterColumn] = useState<TransactionColumn | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set());
  const [memoPinnedIds, setMemoPinnedIds] = useState<Set<string>>(() => new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState(0);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [preparingRefresh, setPreparingRefresh] = useState(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const bulkBusyRef = useRef(false);
  const refreshBusyRef = useRef(false);
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
  const onMemoPin = useCallback((id: string, pinned: boolean) => {
    setMemoPinnedIds(current => {
      if (current.has(id) === pinned) return current;
      const next = new Set(current);
      if (pinned) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  function matches(item: TransactionRecord) {
    return matchesTransactionFilters(item, columnFilters, selected.members);
  }
  const visible = selected.transactions.filter((item) => matches(item) || pinnedIds.has(item.id) || memoPinnedIds.has(item.id));
  const editableIds = new Set(selected.transactions.filter((item) => !item.settledAt).map((item) => item.id));
  const checkedIds = [...selectedIds].filter((id) => editableIds.has(id));
  const visibleEditable = visible.filter((item) => !item.settledAt);
  const checkedVisibleCount = visibleEditable.filter((item) => selectedIds.has(item.id)).length;
  const allVisibleChecked = visibleEditable.length > 0 && checkedVisibleCount === visibleEditable.length;
  const hiddenCheckedCount = checkedIds.filter((id) => !visible.some((item) => item.id === id)).length;
  const busy = bulkAction !== null || preparingRefresh || refreshing;
  const filteredColumns = transactionColumns.filter(column => columnFilters[column.id] !== undefined);

  function setColumnFilter(column: TransactionColumn, values: string[] | undefined) {
    setColumnFilters(current => {
      const next = { ...current };
      if (values === undefined) delete next[column]; else next[column] = values;
      return next;
    });
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    setPending((count) => count + 1);
    const result = queue.current.then(operation);
    queue.current = result.then(() => undefined, () => undefined);
    void result.then(() => setPending((count) => count - 1), () => setPending((count) => count - 1));
    return result;
  }

  const save: SaveTransaction = (transactionId, getValues) => enqueue(async () => {
    const values = getValues();
    const result = await run({ action: "saveTransaction", workspaceId: selected.workspace.id, transactionId, ...values }, "") as { transaction: TransactionRecord };
    return transactionValues(result.transaction);
  });
  const saveMemo: SaveTransactionMemo = (transactionId, memo) => enqueue(async () => {
    const result = await run({ action: "saveTransactionMemo", workspaceId: selected.workspace.id, transactionId, memo }, "") as { memo: string };
    return transactionMemoSchema.parse(result.memo);
  });

  function toggle(id: string) {
    if (bulkBusyRef.current || refreshBusyRef.current) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleVisible() {
    if (bulkBusyRef.current || refreshBusyRef.current) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const item of visibleEditable) {
        if (allVisibleChecked) next.delete(item.id); else next.add(item.id);
      }
      return next;
    });
  }

  async function performBulk(action: BulkAction) {
    if (bulkBusyRef.current || refreshBusyRef.current || refreshing || checkedIds.length === 0) return;
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

  async function requestRefresh() {
    if (bulkBusyRef.current || refreshBusyRef.current || refreshing) return;
    refreshBusyRef.current = true;
    setPreparingRefresh(true);
    try {
      await refreshTransactionEditors([...handles.current.values()], () => queue.current, onRefresh);
    } finally {
      refreshBusyRef.current = false;
      setPreparingRefresh(false);
    }
  }

  return <>
    <div className="page-heading"><div><span>TRANSACTIONS</span><h1>取引明細</h1><p>一覧から直接編集できます。支払い割合は割合・金額から選べます。欄を離れるかEnterで保存し、選択項目はすぐ保存します。</p></div><div className="page-actions"><RefreshButton refreshing={preparingRefresh || refreshing} disabled={bulkAction !== null} onClick={() => { void requestRefresh(); }} /><button className="primary" disabled={busy} onClick={add}>＋ 明細を追加</button></div></div>
    <section className={"panel " + styles.panel} aria-busy={pending > 0 || busy}>
      {filteredColumns.length > 0 && <div className={styles.activeFilters}>{filteredColumns.map(column => {
        const labels = new Map(transactionFilterOptions(selected.transactions, column.id, selected.members).map(option => [option.value, option.label]));
        const values = columnFilters[column.id]!.map(value => labels.get(value) || value || "（空白）");
        return <button key={column.id} type="button" disabled={busy} onClick={() => setColumnFilter(column.id, undefined)} aria-label={column.label + "の絞り込みを解除"}>{column.label}：{values.length > 0 ? values.join("、") : "選択なし"} <span aria-hidden="true">×</span></button>;
      })}</div>}
      <div className={styles.bulkBar}>
        <span>{visible.length}件・{checkedIds.length}件選択{hiddenCheckedCount > 0 && "（非表示" + hiddenCheckedCount + "件を含む）"}</span>
        <button type="button" disabled={busy || checkedIds.length === 0} onClick={() => { void performBulk("applyTransactionRules"); }}>{bulkAction === "applyTransactionRules" ? "適用中…" : "共有費ルールの適用"}</button>
        <button type="button" disabled={busy || filteredColumns.length === 0} onClick={() => setColumnFilters({})}>絞り込みをすべて解除</button>
        <button type="button" className={styles.bulkDelete} disabled={busy || checkedIds.length === 0} onClick={() => { void performBulk("deleteTransactions"); }}>{bulkAction === "deleteTransactions" ? "削除中…" : "削除"}</button>
        {checkedIds.length > 0 && <button type="button" className={styles.clearSelection} disabled={busy} onClick={() => setSelectedIds(new Set())}>選択解除</button>}
      </div>
      {bulkError && <p role="alert" className={styles.bulkError}>{bulkError}</p>}
      {bulkNotice && <p role="status" className={styles.bulkNotice}>{bulkNotice}</p>}
      <p className={styles.note}>清算済みの明細はメモのみ編集できます。メモは入力欄を離れるかCtrl+Enterで保存します。絞り込み後も選択を保持します。編集中の明細は編集を終えるまで表示します。</p>
      <TransactionTable columns={tableColumns} label="取引明細" header={<tr><th className={styles.selectionCell}><SelectionCheckbox label="表示中の未清算明細をすべて選択" checked={allVisibleChecked} partial={checkedVisibleCount > 0 && !allVisibleChecked} disabled={busy || visibleEditable.length === 0} onChange={toggleVisible} /></th>{transactionColumns.map(column => <th key={column.id}><button type="button" className={styles.columnHeader} data-active={columnFilters[column.id] !== undefined} disabled={busy} aria-label={column.label + "で絞り込み"} aria-haspopup="dialog" onClick={() => setFilterColumn(column.id)}><span>{column.id === "splitWeights" ? transactionSplitLabel(selected.members) : column.label}</span><span aria-hidden="true">{columnFilters[column.id] !== undefined ? "●" : "▾"}</span></button></th>)}<th className={styles.updateStatusCell} aria-label="更新状態" /></tr>}>
        {visible.map((item) => <EditableTransaction key={item.id} item={item} members={selected.members} pinnedOutsideFilter={!matches(item)} checked={selectedIds.has(item.id)} busy={busy} applyingRules={bulkAction === "applyTransactionRules" && selectedIds.has(item.id)} onSelect={toggle} register={register} onPin={onPin} onSave={save} onSaveMemo={saveMemo} onMemoPin={onMemoPin} />)}
      </TransactionTable>
      {visible.length === 0 && <p className={styles.empty}>条件に一致する明細がありません。</p>}
    </section>
    {filterColumn && <TransactionFilterDialog key={filterColumn} column={filterColumn}
      options={transactionFilterOptions(selected.transactions, filterColumn, selected.members, visible)} selected={columnFilters[filterColumn]}
      onColumnChange={setFilterColumn} onClose={() => setFilterColumn(null)}
      onApply={values => { setColumnFilter(filterColumn, values); setFilterColumn(null); }} />}
  </>;
}

function EditableTransaction({ item, members, pinnedOutsideFilter, checked, busy, applyingRules, onSelect, register, onPin, onSave, onSaveMemo, onMemoPin }: {
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
  onSaveMemo: SaveTransactionMemo;
  onMemoPin: (id: string, pinned: boolean) => void;
}) {
  const [changes, setChanges] = useState<Partial<TransactionValues>>({});
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [memoSaving, setMemoSaving] = useState(false);
  const changesRef = useRef<Partial<TransactionValues>>({});
  const [dateDraft, setDateDraft] = useState<string | null>(null);
  const dateDraftRef = useRef<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<AcknowledgedSave | null>(null);
  const acknowledgedRef = useRef<AcknowledgedSave | null>(null);
  const [pending, setPending] = useState(0);
  const pendingRef = useRef(0);
  const inFlight = useRef(new Set<Promise<void>>());
  const frozenRef = useRef(false);
  const memoHandle = useRef<TransactionMemoHandle | null>(null);
  const registerMemo = useCallback((handle: TransactionMemoHandle | null) => {
    memoHandle.current = handle;
    handle?.freeze(frozenRef.current);
  }, []);
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
      setMobileExpanded(true);
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
    if (!itemRef.current.settledAt) await commit();
    else if (Object.keys(changesRef.current).length > 0 || dateDraftRef.current !== null || errorRef.current) throw new Error("清算済みの明細は変更できません。入力内容は保持しています。");
    while (inFlight.current.size > 0) await Promise.all([...inFlight.current]);
    await memoHandle.current?.flush();
  }

  useLayoutEffect(() => {
    register(item.id, {
      freeze: (value) => { frozenRef.current = value; memoHandle.current?.freeze(value); },
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

  if (item.settledAt) return <SettledTransaction item={item} members={members} busy={busy} pinnedOutsideFilter={pinnedOutsideFilter} onSaveMemo={onSaveMemo} onMemoPin={onMemoPin} expanded={mobileExpanded} onToggle={() => setMobileExpanded(current => !current)} onMemoError={() => setMobileExpanded(true)} updating={pending > 0 || memoSaving} onMemoSavingChange={setMemoSaving} registerMemo={registerMemo} />;

  const currentValues = () => ({ ...baseRef.current, ...changesRef.current });
  const updating = pending > 0 || applyingRules || memoSaving;
  return <><tr ref={rowRef} className={styles.transactionRow} data-transaction-id={item.id} data-expanded={mobileExpanded}
    onFocusCapture={(event) => syncPin(editorFocused(event.target))}
    onBlurCapture={(event) => syncPin(editorFocused(event.relatedTarget))}>
    <MobileTransactionSummary item={{ ...item, ...draft, actorName: members.find(member => member.id === draft.actorUserId)?.name ?? item.actorName }} expanded={mobileExpanded} onToggle={() => setMobileExpanded(current => !current)} checked={checked} disabled={busy} onSelect={() => onSelect(item.id)} columnCount={tableColumns.length} indicator={<SavingIndicator active={updating} />} />
    <td data-label="選択" className={styles.selectionCell} data-selection><input className={styles.checkbox} type="checkbox" aria-label={item.merchant + "の明細を選択"} checked={checked} disabled={busy} onChange={() => onSelect(item.id)} /></td>
    <td data-label="取引日時" className={styles.fullCell + " " + styles.dateCell}><input aria-label="取引日時" type="datetime-local" step="0.001" required value={dateDraft ?? transactionDateInput(draft.occurredAt)} title={dateDraft ?? transactionDateInput(draft.occurredAt)} disabled={busy} onChange={(event) => changeDate(event.target.value)} onBlur={requestCommit} onKeyDown={commitOnEnter} /></td>
    <td data-label="取引先"><input aria-label="取引先" required maxLength={240} value={draft.merchant} disabled={busy} onChange={(event) => change({ merchant: event.target.value })} onBlur={requestCommit} onKeyDown={commitOnEnter} /></td>
    <td data-label="方法"><input aria-label="取引方法" required maxLength={120} value={draft.method} disabled={busy} onChange={(event) => change({ method: event.target.value })} onBlur={requestCommit} onKeyDown={commitOnEnter} /></td>
    <td data-label="金額（円）"><input aria-label="金額（円）" type="number" required min="1" max="2147483647" step="1" value={draft.amountYen} disabled={busy} onChange={(event) => change({ amountYen: Number(event.target.value) })} onBlur={requestCommit} onKeyDown={commitOnEnter} /></td>
    <td data-label={draft.type === "PAYMENT" ? "支払者" : "受取者"}><select aria-label={draft.type === "PAYMENT" ? "支払者" : "受取者"} value={draft.actorUserId} disabled={busy} onChange={(event) => change(transactionActorPatch(currentValues(), event.target.value, members), true)}>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></td>
    <td data-label="費用区分"><select aria-label="費用区分" value={draft.expenseClass} disabled={busy} onChange={(event) => change(transactionExpensePatch(currentValues(), event.target.value as ExpenseClass, members), true)}><option value="PERSONAL">個人費</option><option value="SHARED">共有費</option></select></td>
    <td data-label={transactionSplitLabel(members)} className={styles.splitCell + " " + styles.fullCell}>
      <SplitEditor compact inline label="支払い割合" members={members} value={draft.splitWeights} amountYen={draft.amountYen}
        disabled={busy || draft.expenseClass === "PERSONAL"} onChange={(splitWeights) => change({ splitWeights })} onCommit={requestCommit} />
    </td>
    <td data-label="メモ" className={styles.fullCell}><TransactionMemoEditor id={item.id} merchant={draft.merchant} memo={item.memo} disabled={busy} onSave={onSaveMemo} onPin={onMemoPin} onError={() => setMobileExpanded(true)} onSavingChange={setMemoSaving} register={registerMemo} /></td>
    <td data-label="清算" className={styles.settlementCell}><span className={draft.expenseClass === "SHARED" ? styles.unsettled : styles.muted}>{draft.expenseClass === "PERSONAL" ? "対象外" : "未清算"}</span>
    </td>
    <td className={styles.updateStatusCell}><SavingIndicator active={updating} /></td>
  </tr>
    {(error || pinnedOutsideFilter) && <tr className={styles.feedbackRow} data-feedback-for={item.id}><td colSpan={tableColumns.length} className={styles.feedbackCell}>
      {pinnedOutsideFilter && <small className={styles.filterHint}>編集中のため表示</small>}
      {error && <div className={styles.error} role="alert">{error}<button type="button" className="text-button" disabled={busy || pending > 0} onClick={requestCommit}>再試行</button></div>}
    </td></tr>}
  </>;
}

function SettledTransaction({ item, members, busy, pinnedOutsideFilter, onSaveMemo, onMemoPin, expanded, onToggle, onMemoError, updating, onMemoSavingChange, registerMemo }: {
  item: TransactionRecord; members: WorkspaceMember[]; busy: boolean; pinnedOutsideFilter: boolean;
  onSaveMemo: SaveTransactionMemo; onMemoPin: (id: string, pinned: boolean) => void;
  expanded: boolean; onToggle: () => void; onMemoError: () => void;
  updating: boolean; onMemoSavingChange: (saving: boolean) => void;
  registerMemo: (handle: TransactionMemoHandle | null) => void;
}) {
  const amounts = splitAmounts(item.amountYen, item.splitWeights, members);
  const percentages = splitAmounts(1000, item.splitWeights, members);
  return <tr data-transaction-id={item.id} data-expanded={expanded} className={styles.settled + " " + styles.transactionRow}>
    <MobileTransactionSummary item={item} expanded={expanded} onToggle={onToggle} checked={false} disabled onSelect={() => {}} columnCount={tableColumns.length} status={item.expenseClass === "PERSONAL" ? "個人費" : "清算済み"} indicator={<SavingIndicator active={updating} />} />
    <td data-label="選択" className={styles.selectionCell} data-selection><input className={styles.checkbox} type="checkbox" aria-label={item.merchant + "の明細を選択"} checked={false} disabled /></td>
    <td data-label="取引日時" className={styles.fullCell + " " + styles.dateCell} title={dateTime(item.occurredAt)}>{dateTime(item.occurredAt)}</td>
    <td data-label="取引先"><b>{item.merchant}</b></td>
    <td data-label="方法">{item.method}</td>
    <td data-label="金額（円）">{money(item.amountYen)}</td>
    <td data-label={item.type === "PAYMENT" ? "支払者" : "受取者"}>{item.actorName}</td>
    <td data-label="費用区分">{item.expenseClass === "PERSONAL" ? "個人費" : "共有費"}</td>
    <td data-label={transactionSplitLabel(members)} className={styles.splitCell + " " + styles.fullCell}><span className={styles.settledSplit}>{members.map(member => <span key={member.id}><span>{money(amounts[member.id])}</span><small>{percentages[member.id] / 10}%</small></span>)}</span></td>
    <td data-label="メモ" className={styles.fullCell}><TransactionMemoEditor id={item.id} merchant={item.merchant} memo={item.memo} disabled={busy} onSave={onSaveMemo} onPin={onMemoPin} onError={onMemoError} onSavingChange={onMemoSavingChange} register={registerMemo} />
      {pinnedOutsideFilter && <small className={styles.filterHint}>編集中のため表示</small>}
    </td>
    <td data-label="清算">清算済み</td>
    <td className={styles.updateStatusCell}><SavingIndicator active={updating} /></td>
  </tr>;
}

function SavingIndicator({ active }: { active: boolean }) {
  return active ? <span className={styles.savingIndicator} role="status" aria-label="保存中"><span className={styles.spinner} aria-hidden="true" /></span> : null;
}

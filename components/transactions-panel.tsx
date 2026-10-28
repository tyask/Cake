"use client";

import { formatTransactionAmount, formatJstDateTime, cashflowClass } from "@/lib/shared/display-formatters";

import { expenseClassLabels, expenseClasses, transactionActorLabels, transactionTypes, transactionTypeLabels, type TransactionType, MAX_AMOUNT_YEN, MAX_MERCHANT_LENGTH, MAX_METHOD_LENGTH } from "@/lib/shared/domain-values";

import type { RunAppAction } from "@/lib/shared/schemas/app-input";

import { acknowledge, createAutosaveRequest, fieldEqual, saveChanged } from "@/lib/client/autosave";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { transactionActorPatch, transactionDateInput, transactionDateToIso, transactionExpensePatch, transactionValues, validateTransactionValues, type TransactionValues } from "@/lib/shared/transaction-editing";
import type { ExpenseClass, TransactionRecord, WorkspaceData, WorkspaceMember } from "@/lib/shared/types";
import styles from "./transactions-panel.module.css";
import { splitAmounts } from "@/lib/shared/split-allocations";
import { SplitEditor } from "./split-editor";
import { TransactionFilterDialog } from "./transaction-filter-dialog";
import { SelectionCheckbox } from "./selection-checkbox";
import { TransactionMemoEditor, type SaveTransactionMemo, type TransactionMemoHandle } from "./transaction-memo-editor";
import { RefreshButton } from "./refresh-button";
import { refreshTransactionEditors } from "@/lib/client/transaction-refresh";
import { transactionMemoSchema } from "@/lib/shared/schemas/transaction-memo";
import { createTransactionFilterMatcher, transactionCategoryFilterLabel, transactionColumns, transactionFilterOptions, type TransactionColumn } from "@/lib/shared/transaction-filters";
import { transactionListView } from "@/lib/shared/transaction-list";
import { MobileTransactionSummary, TransactionTable, transactionSplitLabel } from "./transaction-table";
import { useTransactionFilters } from "./use-transaction-filters";
import { prepareCategoryChoices, type CategoryChoices } from "./category-select";
import { TransactionCategoryEditor, type SaveTransactionCategory, type TransactionCategoryHandle } from "./transaction-category-editor";
import { homeMonth, isHomeMonth } from "@/lib/shared/home-summary";
import { addMonths } from "@/lib/shared/recurring-payment-calendar";
import { transactionMatchesView, type TransactionViewSelection } from "@/lib/shared/transaction-view";

type RunAction = RunAppAction;
type SaveTransaction = (id: string, getValues: () => { values: TransactionValues; base: TransactionValues }, accept: (values: TransactionValues) => void) => Promise<void>;
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
  view?: {
    selection: TransactionViewSelection;
    loading: boolean;
    error: string | null;
    onChange: (next: TransactionViewSelection, prepare: () => Promise<void>) => Promise<boolean>;
  };
};

const tableColumns = [{ id: "selection", label: "選択" }, ...transactionColumns, { id: "updateStatus", label: "更新状態" }] as const;

function signature(values: TransactionValues): string {
  return JSON.stringify([values.occurredAt, values.merchant, values.method, values.type, values.amountYen, values.actorUserId, values.expenseClass, Object.entries(values.splitWeights).sort(([a], [b]) => a.localeCompare(b))]);
}


export function TransactionsPanel(props: TransactionListProps) {
  return <TransactionList key={`${props.userId}:${props.selected.workspace.id}`} {...props} />;
}

function TransactionList({ selected, userId, add, run, onRefresh, refreshing, view }: TransactionListProps) {
  const modeName = useId();
  const [columnFilters, setColumnFilters] = useTransactionFilters(userId, selected.workspace.id);
  const [filterColumn, setFilterColumn] = useState<TransactionColumn | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set());
  const [memoPinnedIds, setMemoPinnedIds] = useState<Set<string>>(() => new Set());
  const [categoryPinnedIds, setCategoryPinnedIds] = useState<Set<string>>(() => new Set());
  const [categoryDisplay, setCategoryDisplay] = useState<"root" | "full">("full");
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
  const onCategoryPin = useCallback((id: string, pinned: boolean) => {
    setCategoryPinnedIds(current => {
      if (current.has(id) === pinned) return current;
      const next = new Set(current);
      if (pinned) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const categoryChoices = useMemo(() => prepareCategoryChoices(selected.categories), [selected.categories]);
  const metadataPinnedIds = useMemo(() => new Set([...memoPinnedIds, ...categoryPinnedIds]), [memoPinnedIds, categoryPinnedIds]);
  const selection = view?.selection;
  const matches = useMemo(() => {
    const columnMatches = createTransactionFilterMatcher(columnFilters, selected.members);
    return (item: TransactionRecord) => (!selection || transactionMatchesView(item, selection)) && columnMatches(item);
  }, [columnFilters, selected.members, selection]);
  const { visible, visibleEditable, outsideFilterIds, checkedIds, hiddenCheckedCount, selectionChecked } = useMemo(
    () => transactionListView(selected.transactions, matches, pinnedIds, metadataPinnedIds, selectedIds,
      item => item.expenseClass === "SHARED" || item.actorUserId === userId),
    [selected.transactions, matches, pinnedIds, metadataPinnedIds, selectedIds, userId],
  );
  const busy = bulkAction !== null || preparingRefresh || refreshing || view?.loading === true;
  const filteredColumns = transactionColumns.filter(column => columnFilters[column.id] !== undefined);
  const rulesEligible = checkedIds.length > 0 && !selected.transactions.some(item => !item.settledAt && selectedIds.has(item.id) && item.type !== "PAYMENT");

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

  const save: SaveTransaction = (transactionId, getValues, accept) => enqueue(() => saveChanged(getValues, async values => {
    if (values.expenseClass === "PERSONAL" && values.actorUserId !== userId) {
      throw new Error("個人の取引は本人だけが保存できます。担当者を自分に変更してください。");
    }
    const result = await run({ action: "saveTransaction", workspaceId: selected.workspace.id, transactionId, ...values }, "") as { transaction: TransactionRecord };
    return transactionValues(result.transaction);
  }, accept));
  const saveMemo: SaveTransactionMemo = (transactionId, memo) => enqueue(async () => {
    const result = await run({ action: "saveTransactionMemo", workspaceId: selected.workspace.id, transactionId, memo }, "") as { memo: string };
    return transactionMemoSchema.parse(result.memo);
  });
  const saveCategory: SaveTransactionCategory = (transactionId, categoryId) => enqueue(async () => {
    const result = await run({ action: "saveTransactionCategory", workspaceId: selected.workspace.id, transactionId, categoryId }, "") as { categoryId: string | null; categoryRevision: number };
    return result;
  });

  function toggle(id: string) {
    if (bulkBusyRef.current || refreshBusyRef.current) return;
    const item = currentSelected.current.transactions.find(item => item.id === id);
    if (!item || item.settledAt || (item.expenseClass === "PERSONAL" && item.actorUserId !== userId)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelection() {
    if (bulkBusyRef.current || refreshBusyRef.current) return;
    setSelectedIds((current) => {
      if (selectionChecked) return new Set();
      const next = new Set(current);
      for (const item of visibleEditable) next.add(item.id);
      return next;
    });
  }

  async function performBulk(action: BulkAction, targetIds = checkedIds) {
    if (bulkBusyRef.current || refreshBusyRef.current || refreshing || targetIds.length === 0) return;
    const ids = [...targetIds];
    const deletePrompt = targetIds !== checkedIds && ids.length === 1
      ? `「${currentSelected.current.transactions.find(item => item.id === ids[0])?.merchant ?? "対象"}」の明細を削除しますか？`
      : `選択した${ids.length}件の明細を削除しますか？`;
    if (action === "deleteTransactions" && !confirm(deletePrompt)) return;
    bulkBusyRef.current = true;
    for (const handle of handles.current.values()) handle.freeze(true);
    setBulkAction(action);
    setBulkError(null);
    setBulkNotice(null);
    try {
      // A rule must see the saved merchant and actor; no later autosave may undo its result.
      for (const id of ids) await handles.current.get(id)?.flush();
      const latestTransactions = new Map(currentSelected.current.transactions.filter((item) => !item.settledAt
        && (item.expenseClass === "SHARED" || item.actorUserId === userId)).map((item) => [item.id, item]));
      if (ids.some((id) => !latestTransactions.has(id))) throw new Error("選択した明細が削除または清算されています。選択し直してください。");
      if (action === "applyTransactionRules" && ids.some(id => latestTransactions.get(id)?.type !== "PAYMENT")) {
        throw new Error("区分のルールは支払いの明細だけに適用できます。収入を選択から外してください。");
      }
      const result = await enqueue(() => run({ action, workspaceId: selected.workspace.id, transactionIds: ids }, action === "deleteTransactions" ? "選択した明細を削除しました。" : "区分のルールを適用しました。"));
      if (action === "deleteTransactions") {
        const deletedIds = new Set(ids);
        setSelectedIds((current) => new Set([...current].filter((id) => !deletedIds.has(id))));
        setBulkNotice(ids.length + "件の明細を削除しました。");
      } else {
        const applied = (result as { appliedTransactions?: ({ id: string } & TransactionValues)[] } | null)?.appliedTransactions;
        for (const { id, ...values } of applied ?? []) handles.current.get(id)?.acceptRules(values);
        setBulkNotice(ids.length + "件に区分のルールを適用しました。");
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
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : "更新に失敗しました。入力内容は保持しています。");
    } finally {
      refreshBusyRef.current = false;
      setPreparingRefresh(false);
    }
  }

  async function changeView(next: TransactionViewSelection) {
    if (!view || busy || bulkBusyRef.current || refreshBusyRef.current
      || (next.mode === view.selection.mode && next.month === view.selection.month)) return;
    refreshBusyRef.current = true;
    setPreparingRefresh(true);
    setBulkError(null);
    setBulkNotice(null);
    try {
      await refreshTransactionEditors([...handles.current.values()], () => queue.current, async prepare => {
        if (await view.onChange(next, prepare)) {
          setSelectedIds(new Set());
          setFilterColumn(null);
        }
      });
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : "表示を切り替えられませんでした。入力内容は保持しています。");
    } finally {
      refreshBusyRef.current = false;
      setPreparingRefresh(false);
    }
  }

  function changeMonth(offset: -1 | 1) {
    if (!selection || (selection.month === "0001-01" && offset < 0) || (selection.month === "9999-12" && offset > 0)) return;
    void changeView({ ...selection, month: addMonths(`${selection.month}-01`, offset).slice(0, 7) });
  }

  return <>
    <div className="page-heading"><div><span>TRANSACTIONS</span><h1>取引明細</h1><p>一覧から直接編集できます。配分割合は割合・金額から選べます。欄を離れるかEnterで保存し、選択項目はすぐ保存します。</p></div><div className="page-actions"><RefreshButton refreshing={preparingRefresh || refreshing} disabled={bulkAction !== null} onClick={() => { void requestRefresh(); }} /><button className="primary" disabled={busy} onClick={add}>＋ 明細を追加</button></div></div>
    {view && <div className={styles.viewToolbar}>
      <fieldset className={styles.viewModes} disabled={busy}>
        <legend className={styles.visuallyHidden}>明細の表示モード</legend>
        <label><input type="radio" name={modeName} value="month" checked={view.selection.mode === "month"} onChange={() => { void changeView({ ...view.selection, mode: "month" }); }} />月単位明細</label>
        <label><input type="radio" name={modeName} value="unsettled" checked={view.selection.mode === "unsettled"} onChange={() => { void changeView({ ...view.selection, mode: "unsettled" }); }} />未精算明細</label>
      </fieldset>
      {view.selection.mode === "month" && <div className={styles.monthNavigation} role="group" aria-label="取引明細の対象月">
        <button type="button" className="secondary" aria-label="前の月" disabled={busy || view.selection.month === "0001-01"} onClick={() => changeMonth(-1)}>‹</button>
        <input type="month" aria-label="取引明細の対象年月" min="0001-01" max="9999-12" required disabled={busy} value={view.selection.month} onChange={event => {
          if (isHomeMonth(event.target.value)) void changeView({ ...view.selection, month: event.target.value });
        }} />
        <button type="button" className="secondary" aria-label="次の月" disabled={busy || view.selection.month === "9999-12"} onClick={() => changeMonth(1)}>›</button>
        <button type="button" className={"secondary " + styles.currentMonth} disabled={busy || view.selection.month === homeMonth()} onClick={() => { void changeView({ ...view.selection, month: homeMonth() }); }}>今月</button>
      </div>}
    </div>}
    {view?.loading && <p className={styles.viewStatus} role="status">明細を読み込んでいます…</p>}
    {view?.error && <p className={styles.viewError} role="alert">{view.error}<button type="button" className="secondary" disabled={busy} onClick={() => { void requestRefresh(); }}>再試行</button></p>}
    <section className={"panel " + styles.panel} aria-busy={pending > 0 || busy}>
      {filteredColumns.length > 0 && <div className={styles.activeFilters}>{filteredColumns.map(column => {
        const labels = new Map(transactionFilterOptions(selected.transactions, column.id, selected.members, selected.transactions, categoryChoices.byId).map(option => [option.value, option.label]));
        const values = columnFilters[column.id]!.map(value => column.id === "category"
          ? transactionCategoryFilterLabel(value || null, categoryChoices.byId) : labels.get(value) || value || "（空白）");
        return <button key={column.id} type="button" disabled={busy} onClick={() => setColumnFilter(column.id, undefined)} aria-label={column.label + "の絞り込みを解除"}>{column.label}：{values.length > 0 ? values.join("、") : "選択なし"} <span aria-hidden="true">×</span></button>;
      })}</div>}
      <div className={styles.bulkBar}>
        <span>{visible.length}件・{checkedIds.length}件選択{hiddenCheckedCount > 0 && "（非表示" + hiddenCheckedCount + "件を含む）"}</span>
        <label className={styles.categoryDisplay}>カテゴリ表示<select aria-label="カテゴリの表示範囲" disabled={busy} value={categoryDisplay} onChange={event => setCategoryDisplay(event.target.value as "root" | "full")}><option value="root">大分類</option><option value="full">小分類（全階層）</option></select></label>
        <button type="button" disabled={busy || !rulesEligible} title="区分のルールは支払いだけに適用できます" onClick={() => { void performBulk("applyTransactionRules"); }}>{bulkAction === "applyTransactionRules" ? "適用中…" : "区分のルールの適用"}</button>
        <button type="button" disabled={busy || filteredColumns.length === 0} onClick={() => setColumnFilters({})}>絞り込みをすべて解除</button>
        <button type="button" className={styles.bulkDelete} disabled={busy || checkedIds.length === 0} onClick={() => { void performBulk("deleteTransactions"); }}>{bulkAction === "deleteTransactions" ? "削除中…" : "削除"}</button>
      </div>
      {bulkError && <p role="alert" className={styles.bulkError}>{bulkError}</p>}
      {bulkNotice && <p role="status" className={styles.bulkNotice}>{bulkNotice}</p>}
      <p className={styles.note}>相手の個人明細は閲覧のみです。区分のルールは支払いのみが対象です。清算済みの明細もカテゴリとメモを編集できます。カテゴリは選択時、メモは入力欄を離れるかCtrl+Enterで保存します。絞り込み後も選択を保持します。全選択チェックを外すと非表示の選択も解除します。編集中の明細は編集を終えるまで表示します。</p>
      <TransactionTable wrap columns={tableColumns} label="取引明細" header={<tr><th className={styles.selectionCell}><SelectionCheckbox label={selectionChecked ? "選択した明細をすべて解除" : "表示中の未清算明細をすべて選択"} mobileLabel={selectionChecked ? "全解除" : "全選択"} checked={selectionChecked} partial={checkedIds.length > 0 && !selectionChecked} disabled={busy || (visibleEditable.length === 0 && checkedIds.length === 0)} onChange={toggleSelection} /></th>{transactionColumns.map(column => <th key={column.id}><button type="button" className={styles.columnHeader} data-active={columnFilters[column.id] !== undefined} disabled={busy} aria-label={column.label + "で絞り込み"} aria-haspopup="dialog" onClick={() => setFilterColumn(column.id)}><span>{column.id === "splitWeights" ? transactionSplitLabel(selected.members) : column.label}</span><span aria-hidden="true">{columnFilters[column.id] !== undefined ? "●" : "▾"}</span></button></th>)}<th className={styles.updateStatusCell} aria-label="更新状態" /></tr>}>
        {visible.map((item) => <EditableTransaction key={item.id} item={item} currentUserId={userId} members={selected.members} categoryChoices={categoryChoices} categoryDisplay={categoryDisplay} pinnedOutsideFilter={outsideFilterIds.has(item.id)} checked={selectedIds.has(item.id)} busy={busy} applyingRules={bulkAction === "applyTransactionRules" && selectedIds.has(item.id)} onSelect={toggle} onDelete={() => { void performBulk("deleteTransactions", [item.id]); }} register={register} onPin={onPin} onSave={save} onSaveMemo={saveMemo} onMemoPin={onMemoPin} onSaveCategory={saveCategory} onCategoryPin={onCategoryPin} />)}
      </TransactionTable>
      {visible.length === 0 && <p className={styles.empty}>条件に一致する明細がありません。</p>}
    </section>
    {filterColumn && <TransactionFilterDialog key={filterColumn} column={filterColumn}
      options={transactionFilterOptions(selected.transactions, filterColumn, selected.members, visible, categoryChoices.byId)} selected={columnFilters[filterColumn]}
      onColumnChange={setFilterColumn} onClose={() => setFilterColumn(null)}
      onApply={values => { setColumnFilter(filterColumn, values); setFilterColumn(null); }} />}
  </>;
}

function EditableTransaction({ item, currentUserId, members, categoryChoices, categoryDisplay, pinnedOutsideFilter, checked, busy, applyingRules, onSelect, onDelete, register, onPin, onSave, onSaveMemo, onMemoPin, onSaveCategory, onCategoryPin }: {
  item: TransactionRecord;
  currentUserId: string;
  members: WorkspaceMember[];
  categoryChoices: CategoryChoices;
  categoryDisplay: "root" | "full";
  pinnedOutsideFilter: boolean;
  checked: boolean;
  busy: boolean;
  applyingRules: boolean;
  onSelect: (id: string) => void;
  onDelete: () => void;
  register: (id: string, handle: RowHandle | null) => void;
  onPin: (id: string, pinned: boolean) => void;
  onSave: SaveTransaction;
  onSaveMemo: SaveTransactionMemo;
  onMemoPin: (id: string, pinned: boolean) => void;
  onSaveCategory: SaveTransactionCategory;
  onCategoryPin: (id: string, pinned: boolean) => void;
}) {
  const readOnly = item.expenseClass === "PERSONAL" && item.actorUserId !== currentUserId;
  const [changes, setChanges] = useState<Partial<TransactionValues>>({});
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [memoSaving, setMemoSaving] = useState(false);
  const [categorySaving, setCategorySaving] = useState(false);
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
  const categoryHandle = useRef<TransactionCategoryHandle | null>(null);
  const registerMemo = useCallback((handle: TransactionMemoHandle | null) => {
    memoHandle.current = handle;
    handle?.freeze(frozenRef.current);
  }, []);
  const registerCategory = useCallback((handle: TransactionCategoryHandle | null) => {
    categoryHandle.current = handle;
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
    const next = acknowledge(sourceSignatureRef.current, previous, saved, signature);
    acknowledgedRef.current = next;
    setAcknowledged(next);
  }

  const saveRequest = useRef(createAutosaveRequest()).current;

  function commit(): Promise<void> { return saveRequest(commitOnce); }

  function commitOnce(): Promise<void> {
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
      return { values: validateTransactionValues(values, members), base: baseRef.current };
    }, (saved) => {
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
    await categoryHandle.current?.flush();
  }

  useLayoutEffect(() => {
    register(item.id, {
      freeze: (value) => { frozenRef.current = value; memoHandle.current?.freeze(value); categoryHandle.current?.freeze(value); },
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

  const category = categoryChoices.byId.get(item.categoryId ?? "");
  const rowStyle: CSSProperties | undefined = category ? { "--transaction-category-color": category.colorHex } as CSSProperties : undefined;
  const categoryLabel = category ? (categoryDisplay === "root" ? category.rootLabel : category.label) + (category.archived ? "（使用停止）" : "") : "未分類";
  const categoryEditor = <TransactionCategoryEditor id={item.id} merchant={draft.merchant} categoryId={item.categoryId} categoryRevision={item.categoryRevision} choices={categoryChoices} display={categoryDisplay} disabled={busy} onSave={onSaveCategory} onPin={onCategoryPin} onError={() => setMobileExpanded(true)} onSavingChange={setCategorySaving} register={registerCategory} />;
  if (item.settledAt || readOnly) return <ReadonlyTransaction item={item} members={members} busy={busy} readOnly={readOnly} pinnedOutsideFilter={pinnedOutsideFilter} onSaveMemo={onSaveMemo} onMemoPin={onMemoPin} expanded={mobileExpanded} onToggle={() => setMobileExpanded(current => !current)} onMemoError={() => setMobileExpanded(true)} updating={pending > 0 || memoSaving || categorySaving} onMemoSavingChange={setMemoSaving} registerMemo={registerMemo} categoryEditor={readOnly ? categoryLabel : categoryEditor} categoryLabel={categoryLabel} rowStyle={rowStyle} />;

  const currentValues = () => ({ ...baseRef.current, ...changesRef.current });
  const updating = pending > 0 || applyingRules || memoSaving || categorySaving;
  return <><tr ref={rowRef} className={styles.transactionRow} style={rowStyle} data-transaction-id={item.id} data-expanded={mobileExpanded}
    onFocusCapture={(event) => syncPin(editorFocused(event.target))}
    onBlurCapture={(event) => syncPin(editorFocused(event.relatedTarget))}>
    <MobileTransactionSummary item={{ ...item, ...draft, actorName: members.find(member => member.id === draft.actorUserId)?.name ?? item.actorName }} expanded={mobileExpanded} onToggle={() => setMobileExpanded(current => !current)} checked={checked} disabled={busy} onSelect={() => onSelect(item.id)} columnCount={tableColumns.length} categoryLabel={categoryLabel} onDelete={onDelete} deleteDisabled={busy} indicator={<SavingIndicator active={updating} />} />
    <td data-label="選択" className={styles.selectionCell} data-selection><input className={styles.checkbox} type="checkbox" aria-label={item.merchant + "の明細を選択"} checked={checked} disabled={busy} onChange={() => onSelect(item.id)} /></td>
    <td data-label="取引日時" className={styles.fullCell + " " + styles.dateCell}><input aria-label="取引日時" type="datetime-local" step="0.001" required value={dateDraft ?? transactionDateInput(draft.occurredAt)} title={dateDraft ?? transactionDateInput(draft.occurredAt)} disabled={busy} onChange={(event) => changeDate(event.target.value)} onBlur={requestCommit} onKeyDown={commitOnEnter} /></td>
    <td data-label="取引先"><input aria-label="取引先" required maxLength={MAX_MERCHANT_LENGTH} value={draft.merchant} disabled={busy} onChange={(event) => change({ merchant: event.target.value })} onBlur={requestCommit} onKeyDown={commitOnEnter} />{item.source === "RECURRING" && <span className={styles.sourceTag}>定期</span>}</td>
    <td data-label="方法"><input aria-label="取引方法" required maxLength={MAX_METHOD_LENGTH} value={draft.method} disabled={busy} onChange={(event) => change({ method: event.target.value })} onBlur={requestCommit} onKeyDown={commitOnEnter} /></td>
    <td data-label="種別"><select aria-label="種別" value={draft.type} disabled={busy} onChange={event => change({ type: event.target.value as TransactionType }, true)}>{transactionTypes.map(type => <option key={type} value={type}>{transactionTypeLabels[type]}</option>)}</select></td>
    <td data-label="金額（円）"><span className="signed-amount-input"><span className={cashflowClass(draft.type === "PAYMENT" ? -draft.amountYen : draft.amountYen)} aria-hidden="true">{draft.amountYen === 0 ? "" : draft.type === "PAYMENT" ? "−" : "+"}</span><input aria-label="金額（円）" className={cashflowClass(draft.type === "PAYMENT" ? -draft.amountYen : draft.amountYen)} type="number" required min="1" max={MAX_AMOUNT_YEN} step="1" value={draft.amountYen} disabled={busy} onChange={(event) => change({ amountYen: Number(event.target.value) })} onBlur={requestCommit} onKeyDown={commitOnEnter} /></span></td>
    <td data-label={transactionActorLabels[draft.type]}><select aria-label={transactionActorLabels[draft.type]} value={draft.actorUserId} disabled={busy} onChange={(event) => change(transactionActorPatch(currentValues(), event.target.value, members), true)}>{members.map((member) => <option key={member.id} value={member.id} disabled={draft.expenseClass === "PERSONAL" && member.id !== currentUserId}>{member.name}</option>)}</select></td>
    <td data-label="区分"><select aria-label="区分" value={draft.expenseClass} disabled={busy} onChange={(event) => change(transactionExpensePatch(currentValues(), event.target.value as ExpenseClass, members), true)}>{expenseClasses.map(value => <option key={value} value={value} disabled={value === "PERSONAL" && draft.actorUserId !== currentUserId}>{expenseClassLabels[value]}</option>)}</select>{draft.actorUserId !== currentUserId && <small className="ratio-note">個人に変更する場合は、担当者を自分に変更してください。</small>}</td>
    <td data-label={transactionSplitLabel(members)} className={styles.splitCell + " " + styles.fullCell}>
      <SplitEditor compact inline label="配分割合" members={members} value={draft.splitWeights} amountYen={draft.amountYen} type={draft.type}
        disabled={busy || draft.expenseClass === "PERSONAL"} onChange={(splitWeights) => change({ splitWeights })} onCommit={requestCommit} />
    </td>
    <td data-label="カテゴリ" className={styles.categoryCell + " " + styles.fullCell}>{categoryEditor}</td>
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

function ReadonlyTransaction({ item, members, busy, readOnly, pinnedOutsideFilter, onSaveMemo, onMemoPin, expanded, onToggle, onMemoError, updating, onMemoSavingChange, registerMemo, categoryEditor, categoryLabel, rowStyle }: {
  item: TransactionRecord; members: WorkspaceMember[]; busy: boolean; readOnly: boolean; pinnedOutsideFilter: boolean;
  onSaveMemo: SaveTransactionMemo; onMemoPin: (id: string, pinned: boolean) => void;
  expanded: boolean; onToggle: () => void; onMemoError: () => void;
  updating: boolean; onMemoSavingChange: (saving: boolean) => void;
  registerMemo: (handle: TransactionMemoHandle | null) => void;
  categoryEditor: ReactNode;
  categoryLabel: string;
  rowStyle: CSSProperties | undefined;
}) {
  const amounts = splitAmounts(item.amountYen, item.splitWeights, members);
  const percentages = splitAmounts(1000, item.splitWeights, members);
  return <tr data-transaction-id={item.id} data-expanded={expanded} className={(item.settledAt ? styles.settled + " " : "") + styles.transactionRow} style={rowStyle}>
    <MobileTransactionSummary item={item} expanded={expanded} onToggle={onToggle} checked={false} disabled onSelect={() => {}} columnCount={tableColumns.length} categoryLabel={categoryLabel} status={item.expenseClass === "PERSONAL" ? "個人" : "清算済み"} indicator={<SavingIndicator active={updating} />} />
    <td data-label="選択" className={styles.selectionCell} data-selection><input className={styles.checkbox} type="checkbox" aria-label={item.merchant + "の明細を選択"} checked={false} disabled /></td>
    <td data-label="取引日時" className={styles.fullCell + " " + styles.dateCell} title={formatJstDateTime(item.occurredAt)}>{formatJstDateTime(item.occurredAt)}</td>
    <td data-label="取引先"><b>{item.merchant}</b>{item.source === "RECURRING" && <span className={styles.sourceTag}>定期</span>}</td>
    <td data-label="方法">{item.method}</td>
    <td data-label="種別">{transactionTypeLabels[item.type]}</td>
    <td data-label="金額（円）" className={item.type === "PAYMENT" ? "negative" : "positive"}>{formatTransactionAmount(item.type, item.amountYen)}</td>
    <td data-label={transactionActorLabels[item.type]}>{item.actorName}</td>
    <td data-label="区分">{expenseClassLabels[item.expenseClass]}</td>
    <td data-label={transactionSplitLabel(members)} className={styles.splitCell + " " + styles.fullCell}><span className={styles.settledSplit}>{members.map(member => <span key={member.id}><span className={cashflowClass(item.type === "PAYMENT" ? -amounts[member.id] : amounts[member.id])}>{formatTransactionAmount(item.type, amounts[member.id])}</span><small>{percentages[member.id] / 10}%</small></span>)}</span></td>
    <td data-label="カテゴリ" className={styles.categoryCell + " " + styles.fullCell}>{categoryEditor}</td>
    <td data-label="メモ" className={styles.fullCell}>{readOnly ? <span style={{ whiteSpace: "pre-wrap" }}>{item.memo}</span> : <TransactionMemoEditor id={item.id} merchant={item.merchant} memo={item.memo} disabled={busy} onSave={onSaveMemo} onPin={onMemoPin} onError={onMemoError} onSavingChange={onMemoSavingChange} register={registerMemo} />}
      {pinnedOutsideFilter && <small className={styles.filterHint}>編集中のため表示</small>}
    </td>
    <td data-label="清算">{item.expenseClass === "PERSONAL" ? "対象外" : "清算済み"}</td>
    <td className={styles.updateStatusCell}><SavingIndicator active={updating} /></td>
  </tr>;
}

function SavingIndicator({ active }: { active: boolean }) {
  return active ? <span className={styles.savingIndicator} role="status" aria-label="保存中"><span className={styles.spinner} aria-hidden="true" /></span> : null;
}

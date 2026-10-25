"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { RunAppAction } from "@/lib/shared/schemas/app-input";
import { defaultSplitWeights, personalSplitWeights, validateSplitWeights } from "@/lib/shared/expense-splits";
import { isPayPayRowImportable, parsePayPayCsv, payPayDateToIso, type PayPayPreviewRow } from "@/lib/shared/paypay";
import { applyPayPayDuplicateChecks, MAX_DUPLICATE_CHECK_IDS, type ExistingPayPayTransaction } from "@/lib/shared/import-duplicates";
import { MAX_IMPORT_CATEGORY_SUGGESTION_MERCHANTS, type ImportCategorySuggestionsResponse } from "@/lib/shared/import-category-suggestions";
import type { ExpenseClass, WorkspaceData } from "@/lib/shared/types";
import { IMPORT_FORMATS, type ImportFormat } from "@/lib/shared/import-history";
import { ImportPreviewTable } from "./import-preview-table";
import { PageHeading } from "./dashboard-ui";
import { ImportHelpDialog } from "./import-help-dialog";
import { ImportHistoryPanel } from "./import-history-panel";
import { CategorySelect, prepareCategoryChoices } from "./category-select";
import styles from "./import-panel.module.css";

const importFormats = { PAYPAY: { ...IMPORT_FORMATS.PAYPAY, parse: parsePayPayCsv } };
const pastedFileName = "PayPay貼り付け.csv";
const clipboardReadError = "クリップボードを読み取れませんでした。ペーストを許可して再度試すか、「ファイルを選択」からCSVを取り込んでください。";
const subscribeToBrowser = () => () => {};
const getServerSafariSnapshot = () => false;
const categorySuggestionDescription = "未分類の明細について、最近の登録履歴に基づいてカテゴリを補完します";
function getSafariSnapshot() {
  const userAgent = navigator.userAgent;
  return /Version\/[\d.]+.*Safari\//.test(userAgent)
    && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|OPiOS|OPT\/|Android|DuckDuckGo|Ddg|GSA|YaBrowser|YxiOS|Brave/i.test(userAgent);
}

function CategorySuggestionButton({ disabled, working, onClick }: { disabled: boolean; working: boolean; onClick: () => void }) {
  const descriptionId = useId();
  const container = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <div ref={container} className={styles.categorySuggestion}
    onPointerEnter={event => { if (event.pointerType === "mouse") setOpen(true); }}
    onPointerLeave={event => {
      if (event.pointerType === "mouse" && !event.currentTarget.contains(document.activeElement)) setOpen(false);
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" disabled={disabled} onClick={() => { setOpen(false); onClick(); }} onFocus={event => { if (event.currentTarget.matches(":focus-visible")) setOpen(true); }}
      aria-describedby={open ? descriptionId : undefined}>{working ? "カテゴリ補完中…" : "カテゴリ自動補完"}</button>
    <button type="button" className={styles.categorySuggestionInfo} aria-label="カテゴリ自動補完の説明"
      aria-expanded={open} aria-controls={open ? descriptionId : undefined} aria-describedby={open ? descriptionId : undefined}
      onClick={() => setOpen(value => !value)}>ⓘ</button>
    {open && <div id={descriptionId} className={styles.categorySuggestionTooltip} role="tooltip">{categorySuggestionDescription}</div>}
  </div>;
}

export function ImportPanel({ selected, currentUserId, run, importHistoryRevision }: { selected: WorkspaceData; currentUserId: string; run: RunAppAction; importHistoryRevision: number }) {
  const isSafari = useSyncExternalStore(subscribeToBrowser, getSafariSnapshot, getServerSafariSnapshot);
  const inputRef = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<ImportFormat>("PAYPAY");
  const [rows, setRows] = useState<PayPayPreviewRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [fileName, setFileName] = useState("");
  const [actorId, setActorId] = useState(currentUserId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionStatus, setSuggestionStatus] = useState<string | null>(null);
  const [helpUrl, setHelpUrl] = useState<string | null>(null);
  const [bulkCategoryId, setBulkCategoryId] = useState<string | null>(null);
  const categoryChoices = useMemo(() => prepareCategoryChoices(selected.categories), [selected.categories]);
  const fileRequest = useRef(0);
  const suggestionController = useRef<AbortController | null>(null);
  const latestWorkspace = useRef(selected);
  const importableRows = rows.filter(isPayPayRowImportable);
  const selectedCount = importableRows.filter(row => row.selected).length;
  const busy = reading || saving || suggesting;
  const unclassifiedCount = importableRows.filter(row => row.categoryId === null).length;

  useEffect(() => { latestWorkspace.current = selected; }, [selected]);
  useEffect(() => () => {
    fileRequest.current += 1;
    suggestionController.current?.abort();
    suggestionController.current = null;
  }, [selected.workspace.id]);

  async function readCsv(readText: () => string | Promise<string>, sourceName: string) {
    if (busy) return;
    const requestId = ++fileRequest.current;
    setReading(true);
    setRows([]);
    setBulkCategoryId(null);
    setFileName("");
    setError(null);
    setSuggestionStatus(null);
    try {
      const text = await readText();
      if (requestId !== fileRequest.current) return;
      if (!text.trim()) throw new Error("CSVの内容が空です。CSVをコピーし直すか、ファイルを選択してください。");
      const parsed = importFormats[format].parse(text, selected.rules, new Set(), selected.members, actorId);
      if (parsed.length === 0) throw new Error("取引内容が「支払い」の行がありません。PayPayの取引履歴を確認してください。");
      const externalIds = [...new Set(parsed.filter(row => !row.error).map(row => row.externalId).filter(Boolean))];
      const existing: ExistingPayPayTransaction[] = [];
      for (let offset = 0; offset < externalIds.length; offset += MAX_DUPLICATE_CHECK_IDS) {
        const response = await fetch("/api/import/duplicates", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: selected.workspace.id, externalIds: externalIds.slice(offset, offset + MAX_DUPLICATE_CHECK_IDS) }),
        });
        const result = await response.json();
        if (requestId !== fileRequest.current) return;
        if (!response.ok) throw new Error(result.error ?? "重複の確認に失敗しました。");
        existing.push(...result.transactions as ExistingPayPayTransaction[]);
      }
      if (requestId !== fileRequest.current) return;
      setRows(applyPayPayDuplicateChecks(parsed, existing));
      setTotalRows(parsed.length);
      setFileName(sourceName);
      setError(null);
    } catch (failure) {
      if (requestId === fileRequest.current) {
        setError(failure instanceof Error ? failure.message : "CSVを読み込めませんでした。");
      }
    } finally {
      if (requestId === fileRequest.current) setReading(false);
    }
  }

  function removePreviewRow(key: string) {
    if (busy) return;
    const row = rows.find(item => item.key === key);
    if (!row || !confirm(`「${row.merchant || "取引先未設定"}」を取込一覧から削除しますか？`)) return;
    setRows(current => current.filter(item => item.key !== key));
  }

  function removeSelectedPreviewRows() {
    if (busy || selectedCount === 0 || !confirm(`選択した${selectedCount}件を取込一覧から削除しますか？`)) return;
    setRows(current => current.filter(row => !row.selected || !isPayPayRowImportable(row)));
  }

  function choose(file?: File) {
    if (file) void readCsv(() => file.text(), file.name);
  }

  function pasteAndPreview() {
    // Invoke readText before the first await so Safari retains the tap's activation.
    void readCsv(() => {
      if (!navigator.clipboard?.readText) throw new Error(clipboardReadError);
      return navigator.clipboard.readText().catch(() => { throw new Error(clipboardReadError); });
    }, pastedFileName);
  }

  function changeActor(nextActor: string) {
    setActorId(nextActor);
    setRows((current) => current.map((row) => row.expenseClass === "PERSONAL"
      ? { ...row, splitWeights: personalSplitWeights(selected.members, nextActor) } : row));
  }

  function changeClass(row: PayPayPreviewRow, expenseClass: ExpenseClass): PayPayPreviewRow {
    if (row.expenseClass === expenseClass) return row;
    return { ...row, expenseClass, splitWeights: expenseClass === "PERSONAL"
      ? personalSplitWeights(selected.members, actorId) : defaultSplitWeights(selected.members) };
  }

  function bulk(expenseClass: ExpenseClass) {
    setRows((current) => current.map((row) => row.selected ? changeClass(row, expenseClass) : row));
  }

  function bulkCategory() {
    if (busy || selectedCount === 0) return;
    setRows(current => current.map(row => row.selected && isPayPayRowImportable(row)
      ? { ...row, categoryId: bulkCategoryId } : row));
  }

  async function suggestCategories() {
    if (busy || suggestionController.current || unclassifiedCount === 0) return;
    const controller = new AbortController();
    suggestionController.current = controller;
    const workspaceId = selected.workspace.id;
    const requestId = fileRequest.current;
    const isCurrent = () => !controller.signal.aborted && suggestionController.current === controller
      && requestId === fileRequest.current && latestWorkspace.current.workspace.id === workspaceId;
    const merchants = [...new Set(importableRows.filter(row => row.categoryId === null).map(row => row.merchant))];
    setSuggesting(true);
    setError(null);
    setSuggestionStatus(null);
    try {
      const suggestions = new Map<string, string | null>();
      for (let offset = 0; offset < merchants.length; offset += MAX_IMPORT_CATEGORY_SUGGESTION_MERCHANTS) {
        const response = await fetch("/api/import/category-suggestions", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ workspaceId, merchants: merchants.slice(offset, offset + MAX_IMPORT_CATEGORY_SUGGESTION_MERCHANTS) }),
        });
        const result = await response.json() as ImportCategorySuggestionsResponse & { error?: string };
        if (!isCurrent()) return;
        if (!response.ok) throw new Error(result.error ?? "カテゴリの補完に失敗しました。再度お試しください。");
        for (const suggestion of result.suggestions) suggestions.set(suggestion.merchant, suggestion.categoryId);
      }
      if (!isCurrent()) return;
      const availableCategories = new Set(latestWorkspace.current.categories.filter(category => category.archivedAt === null).map(category => category.id));
      const suggestedCategory = (row: PayPayPreviewRow) => {
        const categoryId = suggestions.get(row.merchant);
        return isPayPayRowImportable(row) && row.categoryId === null && categoryId && availableCategories.has(categoryId) ? categoryId : null;
      };
      const count = rows.filter(row => suggestedCategory(row) !== null).length;
      setRows(current => current.map(row => {
        const categoryId = suggestedCategory(row);
        return categoryId === null ? row : { ...row, categoryId };
      }));
      setSuggestionStatus(count > 0 ? `${count}件のカテゴリを補完しました。` : "補完できるカテゴリがありませんでした。");
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : "カテゴリの補完に失敗しました。再度お試しください。");
    } finally {
      if (suggestionController.current === controller) {
        suggestionController.current = null;
        setSuggesting(false);
      }
    }
  }

  async function submit() {
    if (busy) return;
    setError(null);
    setSaving(true);
    try {
      const items = importableRows.map((row) => ({
        occurredAt: payPayDateToIso(row.occurredAt), merchant: row.merchant, method: row.method,
        amountYen: row.amountYen, externalId: row.externalId, expenseClass: row.expenseClass, actorUserId: actorId,
        splitWeights: validateSplitWeights(row.splitWeights, selected.members, row.expenseClass, actorId),
        categoryId: row.categoryId,
      }));
      if (items.length === 0) { setError("登録可能な明細がありません。"); return; }
      await run({ action: "bulkImport", workspaceId: selected.workspace.id, fileName, totalRows, items }, "明細を取り込みました。");
      setRows([]);
      setFileName("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "明細を登録できませんでした。"); }
    finally { setSaving(false); }
  }

  return <>
    <PageHeading eyebrow="IMPORT" title="明細を取込" />
    <section className="panel import-format">
      <p className="import-destination"><span>取込先の家計</span><b>{selected.workspace.name}</b></p>
      <label>ファイル形式<select value={format} disabled={busy || rows.length > 0} onChange={event => setFormat(event.target.value as keyof typeof importFormats)}>
        {Object.entries(importFormats).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
      </select></label>
    </section>
    {rows.length === 0 ? <>
      <div className="import-inputs" aria-busy={reading}>
        <section className="panel import-paste" aria-labelledby="import-paste-title">
          <h2 id="import-paste-title">クリップボードから貼り付け</h2>
          <button className="primary import-clipboard-button" disabled={busy} onClick={pasteAndPreview}>貼り付け</button>
          {isSafari && <small>※Safariの確認が出たら「ペースト」を選んでください</small>}
          <button type="button" className="text-button import-help-button" disabled={busy} aria-haspopup="dialog"
            onClick={event => { event.currentTarget.focus(); setHelpUrl(new URL("/?tab=import", window.location.origin).href); }}>ヘルプ</button>
        </section>
        <section className="panel upload-panel"
          onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}>
          <div className="upload-icon">⇧</div><h2>CSVファイルをここにドロップ</h2>
          <button className="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>ファイルを選択</button>
          <input ref={inputRef} hidden type="file" accept=".csv,text/csv" aria-label="CSVファイル" disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            choose(file);
          }} />
        </section>
      </div>
      {reading && <p className="import-input-note" role="status">CSVを読み込み、重複を確認しています…</p>}
      {error && <p className="import-error form-error" role="alert">{error}</p>}
    </> : <section className="panel table-panel">
      <div className="import-summary">
        <div><span>取込先の家計</span><b>{selected.workspace.name}</b></div><div><span>取込元</span><b>{fileName}</b></div><div><span>取込対象</span><b>{importableRows.length} / {rows.length}件</b></div>
        <label>支払者<select disabled={busy} value={actorId} onChange={(event) => changeActor(event.target.value)}>{selected.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      </div>
      <div className={`bulk-bar ${styles.bulkBar}`}>
        <div className={styles.categoryGroup} role="group" aria-label="カテゴリ">
          <span className={styles.groupHeading}>カテゴリ</span>
          <div className={styles.categoryControls}>
            <div className={styles.categoryBulk}>
              <div className={styles.categoryChoice}><CategorySelect choices={categoryChoices} value={bulkCategoryId}
                label="選択行のカテゴリ" disabled={busy || selectedCount === 0} onChange={setBulkCategoryId} /></div>
              <button disabled={busy || selectedCount === 0} onClick={bulkCategory}>カテゴリを設定</button>
            </div>
            <CategorySuggestionButton disabled={busy || unclassifiedCount === 0} working={suggesting} onClick={() => void suggestCategories()} />
          </div>
        </div>
        <div className={styles.selectionGroup} role="group" aria-label="選択行の操作">
          <div className={styles.selectionHeading}><span className={styles.groupHeading}>選択行の操作</span><span className={styles.selectedCount}>{selectedCount}件を選択中</span></div>
          <div className={styles.selectionControls}>
            <button disabled={busy || selectedCount === 0} onClick={() => bulk("PERSONAL")}>個人に変更</button><button disabled={busy || selectedCount === 0} onClick={() => bulk("SHARED")}>共有に変更</button>
            <button disabled={busy || selectedCount === 0} onClick={removeSelectedPreviewRows}>削除</button>
          </div>
        </div>
        <button disabled={busy} className={`text-button ${styles.restart}`} onClick={() => { setRows([]); setFileName(""); setSuggestionStatus(null); }}>やり直す</button>
      </div>
      {suggesting && <p className={styles.suggestionStatus} role="status">カテゴリを補完しています…</p>}
      {suggestionStatus && <p className={styles.suggestionStatus} role="status">{suggestionStatus}</p>}
      <ImportPreviewTable onDelete={removePreviewRow} rows={rows} members={selected.members} actorId={actorId} saving={busy} categoryChoices={categoryChoices}
        onSelect={(key, checked) => setRows(current => current.map(row => row.key === key ? { ...row, selected: checked } : row))}
        onSelectAll={checked => setRows(current => current.map(row => isPayPayRowImportable(row) ? { ...row, selected: checked } : row))}
        onChangeClass={(key, expenseClass) => setRows(current => current.map(row => row.key === key ? changeClass(row, expenseClass) : row))}
        onChangeSplit={(key, splitWeights) => setRows(current => current.map(row => row.key === key ? { ...row, splitWeights } : row))}
        onChangeCategory={(key, categoryId) => setRows(current => current.map(row => row.key === key && isPayPayRowImportable(row) && !busy ? { ...row, categoryId } : row))} />
      {error && <p className="import-error form-error" role="alert">{error}</p>}
      <div className={`sticky-actions ${styles.confirmActions}`}>
        <small className={styles.confirmation}>表示中のカテゴリを確定し、次回のカテゴリ補完に利用します。</small>
        <button className="secondary" disabled={busy} onClick={() => { setRows([]); setFileName(""); setSuggestionStatus(null); }}>キャンセル</button>
        <button className="primary" disabled={busy || importableRows.length === 0} onClick={submit}>{saving ? "登録中…" : "確認して登録"}</button>
      </div>
    </section>}
    <ImportHistoryPanel key={`${selected.workspace.id}:${format}`} workspaceId={selected.workspace.id} format={format} refreshKey={importHistoryRevision} />
    {helpUrl !== null && <ImportHelpDialog importUrl={helpUrl} close={() => setHelpUrl(null)} />}
  </>;
}

"use client";

import { useEffect, useRef, useState } from "react";
import type { RunAppAction } from "@/lib/app-input";
import { defaultSplitWeights, personalSplitWeights, validateSplitWeights } from "@/lib/expense-splits";
import { parsePayPayCsv, payPayDateToIso, type PayPayPreviewRow } from "@/lib/paypay";
import { applyPayPayDuplicateChecks, MAX_DUPLICATE_CHECK_IDS, type ExistingPayPayTransaction } from "@/lib/import-duplicates";
import type { ExpenseClass, WorkspaceData } from "@/lib/types";
import { ImportPreviewTable } from "./import-preview-table";
import { PageHeading } from "./dashboard-ui";

const importFormats = { PAYPAY: { label: "PayPay", parse: parsePayPayCsv } };
const pastedFileName = "PayPay貼り付け.csv";
const clipboardReadError = "クリップボードを読み取れませんでした。「CSVの内容」を長押ししてペーストし、「内容を確認」を押してください。";

export function ImportPanel({ selected, currentUserId, run }: { selected: WorkspaceData; currentUserId: string; run: RunAppAction }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [format, setFormat] = useState<keyof typeof importFormats>("PAYPAY");
  const [rows, setRows] = useState<PayPayPreviewRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [actorId, setActorId] = useState(currentUserId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const fileRequest = useRef(0);
  const selectedCount = rows.filter((row) => row.selected).length;
  const busy = reading || saving;

  useEffect(() => () => { fileRequest.current += 1; }, []);
  useEffect(() => {
    if (focusRequest > 0 && focusRequest === fileRequest.current && !reading) textRef.current?.focus();
  }, [focusRequest, reading]);

  async function readCsv(readText: () => string | Promise<string>, sourceName: string, updateDraft = false) {
    if (busy) return;
    const requestId = ++fileRequest.current;
    setReading(true);
    setRows([]);
    setFileName("");
    setError(null);
    try {
      const text = await readText();
      if (requestId !== fileRequest.current) return;
      if (updateDraft) setCsvText(text);
      if (!text.trim()) throw new Error("CSVの内容が空です。CSVの内容を貼り付けるか、ファイルを選択してください。");
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
      setFileName(sourceName);
      setError(null);
    } catch (failure) {
      if (requestId === fileRequest.current) {
        setError(failure instanceof Error ? failure.message : "CSVを読み込めませんでした。");
        if (updateDraft) setFocusRequest(requestId);
      }
    } finally {
      if (requestId === fileRequest.current) setReading(false);
    }
  }

  function choose(file?: File) {
    if (file) void readCsv(() => file.text(), file.name);
  }

  function pasteAndPreview() {
    // Invoke readText before the first await so Safari retains the tap's activation.
    void readCsv(() => {
      if (!navigator.clipboard?.readText) throw new Error(clipboardReadError);
      return navigator.clipboard.readText().catch(() => { throw new Error(clipboardReadError); });
    }, pastedFileName, true);
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

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      const items = rows.filter((row) => row.selected).map((row) => ({
        occurredAt: payPayDateToIso(row.occurredAt), merchant: row.merchant, method: row.method,
        amountYen: row.amountYen, externalId: row.externalId, expenseClass: row.expenseClass, actorUserId: actorId,
        splitWeights: validateSplitWeights(row.splitWeights, selected.members, row.expenseClass, actorId),
      }));
      if (items.length === 0) { setError("登録する行を選択してください。"); return; }
      await run({ action: "bulkImport", workspaceId: selected.workspace.id, fileName, totalRows: rows.length, items }, "明細を取り込みました。");
      setRows([]);
      setFileName("");
      setCsvText("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "明細を登録できませんでした。"); }
    finally { setSaving(false); }
  }

  return <>
    <PageHeading eyebrow="IMPORT" title="明細を取込" description="費用区分と負担割合を確認してから、支払い明細を登録します。" />
    <section className="panel import-format">
      <p className="import-destination"><span>取込先の家計</span><b>{selected.workspace.name}</b></p>
      <label>ファイル形式<select value={format} disabled={busy || rows.length > 0} onChange={event => setFormat(event.target.value as keyof typeof importFormats)}>
        {Object.entries(importFormats).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
      </select></label>
    </section>
    {rows.length === 0 ? <>
      <div className="import-inputs" aria-busy={reading}>
        <section className="panel import-paste" aria-labelledby="import-paste-title">
          <h2 id="import-paste-title">CSVを貼り付けて取込</h2>
          <p id="import-paste-help">PayPayの共有からショートカットでCSVをコピーし、「貼り付けて確認」を押してください。Safariの確認が出たら「ペースト」を選びます。</p>
          <button className="primary import-clipboard-button" disabled={busy} onClick={pasteAndPreview}>貼り付けて確認</button>
          <label htmlFor="import-csv-text">CSVの内容</label>
          <textarea ref={textRef} id="import-csv-text" value={csvText} disabled={busy} rows={7} spellCheck={false} autoCapitalize="none" autoCorrect="off" autoComplete="off"
            aria-describedby="import-paste-help" placeholder="見出し行を含むCSVの内容を貼り付けてください"
            onChange={event => { setCsvText(event.target.value); setError(null); }} />
          <button className="secondary" disabled={busy} onClick={() => void readCsv(() => csvText, pastedFileName)}>内容を確認</button>
          <small>読み取れない場合は入力欄を長押ししてペーストし、「内容を確認」を押してください。登録する明細は確認画面で選べます。</small>
        </section>
        <section className="panel upload-panel"
          onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}>
          <div className="upload-icon">⇧</div><h2>CSVファイルをここにドロップ</h2>
          <p>またはファイル選択から{importFormats[format].label}の取引履歴を指定してください。</p>
          <button className="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>ファイルを選択</button>
          <input ref={inputRef} hidden type="file" accept=".csv,text/csv" aria-label="CSVファイル" disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            choose(file);
          }} />
          <small>保存済みのCSVからも取り込めます。</small>
        </section>
      </div>
      <p className="import-input-note">取引内容が「支払い」の行のみ対象 · CSVの原本はサーバーに送信・保存されません</p>
      {reading && <p className="import-input-note" role="status">CSVを読み込み、重複を確認しています…</p>}
      {error && <p className="import-error form-error" role="alert">{error}</p>}
    </> : <section className="panel table-panel">
      <div className="import-summary">
        <div><span>取込先の家計</span><b>{selected.workspace.name}</b></div><div><span>取込元</span><b>{fileName}</b></div><div><span>取込対象</span><b>{selectedCount} / {rows.length}件</b></div>
        <label>支払者<select disabled={saving} value={actorId} onChange={(event) => changeActor(event.target.value)}>{selected.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      </div>
      <div className="bulk-bar"><span>{selectedCount}件を選択中</span>
        <button disabled={saving} onClick={() => bulk("PERSONAL")}>個人費に変更</button><button disabled={saving} onClick={() => bulk("SHARED")}>共通費に変更</button>
        <button disabled={saving} className="text-button" onClick={() => { setRows([]); setFileName(""); }}>やり直す</button>
      </div>
      <ImportPreviewTable rows={rows} members={selected.members} actorId={actorId} saving={saving}
        onSelect={(key, checked) => setRows(current => current.map(row => row.key === key ? { ...row, selected: checked } : row))}
        onSelectAll={checked => setRows(current => current.map(row => row.error || row.duplicate ? row : { ...row, selected: checked }))}
        onChangeClass={(key, expenseClass) => setRows(current => current.map(row => row.key === key ? changeClass(row, expenseClass) : row))}
        onChangeSplit={(key, splitWeights) => setRows(current => current.map(row => row.key === key ? { ...row, splitWeights } : row))} />
      {error && <p className="import-error form-error" role="alert">{error}</p>}
      <div className="sticky-actions"><button className="secondary" disabled={saving} onClick={() => { setRows([]); setFileName(""); }}>キャンセル</button>
        <button className="primary" disabled={saving || selectedCount === 0} onClick={submit}>{saving ? "登録中…" : `選択した${selectedCount}件を登録`}</button>
      </div>
    </section>}
  </>;
}

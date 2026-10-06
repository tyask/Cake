"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import { UserManagement } from "./user-management";
import { MobileAccessQr } from "./mobile-access-qr";
import { SplitEditor } from "./split-editor";
import { WorkspaceRules } from "./workspace-rules";
import { CakeIcon } from "./cake-icon";
import { TransactionsPanel } from "./transactions-panel";
import { defaultSplitWeights, matchingDefaultRule, personalSplitWeights, transactionDefaults, validateSplitWeights } from "@/lib/expense-splits";
import { parsePayPayCsv, payPayDateToIso, type PayPayPreviewRow } from "@/lib/paypay";
import { MAX_TRANSACTION_MEMO_LENGTH } from "@/lib/transaction-memo";
import { applyTransactionUpdate } from "@/lib/transaction-updates";
import type {
  BootstrapData,
  ExpenseClass,
  WorkspaceData,
  WorkspaceType,
  SplitWeights,
  WorkspaceMember,
} from "@/lib/types";

type Tab = "home" | "transactions" | "import" | "settlement" | "settings";

const money = (value: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(value);
const dateTime = (value: string) => new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}).format(new Date(value));
const inputDate = (value?: string) => {
  const date = value ? new Date(value) : new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
  return parts.replace(" ", "T");
};
const jstInputToIso = (value: string) => new Date(`${value.length === 16 ? `${value}:00` : value}+09:00`).toISOString();

async function postAction(payload: Record<string, unknown>) {
  const response = await fetch("/api/app", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "処理に失敗しました。");
  return result;
}

const navItems: { id: Tab; label: string; icon: string }[] = [
  { id: "home", label: "ホーム", icon: "⌂" },
  { id: "transactions", label: "取引明細", icon: "≡" },
  { id: "import", label: "取込", icon: "⇩" },
  { id: "settlement", label: "清算", icon: "↔" },
  { id: "settings", label: "設定", icon: "⚙" },
];

export function Dashboard({ initialData, testAuth = false }: { initialData: BootstrapData; testAuth?: boolean }) {
  const [data, setData] = useState(initialData);
  const [tab, setTab] = useState<Tab>("home");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspaceModal, setWorkspaceModal] = useState(false);
  const [transactionModal, setTransactionModal] = useState(false);
  const selected = data.selected;
  const workspaceView = useRef({ workspaceId: initialData.selected?.workspace.id, generation: 0 });
  const pendingRequests = useRef(0);
  const dataRevision = useRef(0);
  const refreshRequest = useRef(0);

  function startLoading() { pendingRequests.current += 1; setLoading(true); }
  function finishLoading() { pendingRequests.current -= 1; setLoading(pendingRequests.current > 0); }

  async function refresh(workspaceId = workspaceView.current.workspaceId, generation = workspaceView.current.generation) {
    const requestId = ++refreshRequest.current;
    const revision = dataRevision.current;
    const desiredWorkspaceId = workspaceView.current.workspaceId;
    const response = await fetch(`/api/app${workspaceId ? `?workspaceId=${workspaceId}` : ""}`, { cache: "no-store" });
    const next = await response.json();
    if (!response.ok) throw new Error(next.error ?? "更新に失敗しました。");
    // An autosave for a previous workspace must not replace the newly selected view.
    if (generation !== workspaceView.current.generation || desiredWorkspaceId !== workspaceView.current.workspaceId || revision !== dataRevision.current || requestId !== refreshRequest.current) return false;
    workspaceView.current.workspaceId = next.selected?.workspace.id;
    setData(next);
    return true;
  }

  async function run(payload: Record<string, unknown>, success: string, workspaceId?: string) {
    const originWorkspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : selected?.workspace.id;
    const generation = workspaceView.current.generation;
    const isCurrentView = () => generation === workspaceView.current.generation && originWorkspaceId === workspaceView.current.workspaceId;
    startLoading();
    if (isCurrentView()) dataRevision.current += 1;
    if (isCurrentView()) setNotice(null);
    try {
      const result = await postAction(payload);
      if (isCurrentView()) {
        dataRevision.current += 1;
        if (payload.action === "saveTransaction" && result.transaction && originWorkspaceId) {
          setData(current => isCurrentView() ? applyTransactionUpdate(current, originWorkspaceId, { transaction: result.transaction }) : current);
          setNotice(success);
        } else if (payload.action === "saveTransactionMemo" && result.transactionId && typeof result.memo === "string" && originWorkspaceId) {
          setData(current => isCurrentView() ? applyTransactionUpdate(current, originWorkspaceId, { transactionId: result.transactionId, memo: result.memo }) : current);
          setNotice(success);
        } else {
          const applied = await refresh(workspaceId ?? result.workspaceId ?? originWorkspaceId, generation);
          if (applied && generation === workspaceView.current.generation) setNotice(success);
        }
      }
      return result;
    } catch (error) {
      if (isCurrentView()) setNotice(error instanceof Error ? error.message : "処理に失敗しました。");
      throw error;
    } finally { finishLoading(); }
  }

  async function switchWorkspace(workspaceId: string) {
    const generation = workspaceView.current.generation + 1;
    workspaceView.current = { workspaceId, generation };
    startLoading(); setNotice(null);
    try { await refresh(workspaceId, generation); }
    catch (error) {
      if (generation === workspaceView.current.generation) {
        workspaceView.current = { workspaceId: selected?.workspace.id, generation: generation + 1 };
        setNotice(error instanceof Error ? error.message : "読込に失敗しました。");
      }
    } finally { finishLoading(); }
  }

  function openTab(next: Tab) {
    if (next === tab) return;
    setTab(next);
    startLoading();
    const generation = workspaceView.current.generation;
    void refresh().catch(error => {
      if (generation === workspaceView.current.generation) setNotice(error instanceof Error ? error.message : "読込に失敗しました。");
    }).finally(finishLoading);
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-logo"><CakeIcon decorative /><b>Cake</b></div>
        <div className="workspace-picker">
          <label>ワークスペース</label>
          <select value={selected?.workspace.id ?? ""} onChange={(event) => switchWorkspace(event.target.value)}>
            {data.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <button className="small-link" onClick={() => setWorkspaceModal(true)}>＋ 新しく作成</button>
        </div>
        <nav className="app-nav">
          {navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => openTab(item.id)}><i>{item.icon}</i><span>{item.label}</span></button>)}
        </nav>
        <div className="sidebar-footer">
          <MobileAccessQr />
          <div className="profile">
            <span className="avatar">{data.user.imageUrl ? <Image src={data.user.imageUrl} alt="" width={36} height={36} /> : data.user.name.slice(0, 1)}</span>
            <span><b>{data.user.name}</b><small>{data.user.email}</small></span>
            {testAuth && <span className="demo-chip">TEST</span>}
            <button title="ログアウト" onClick={() => signOut({ redirectTo: "/" })}>↪</button>
          </div>
        </div>
      </aside>

      <main className="app-main">
        <header className="mobile-header"><div className="app-logo"><CakeIcon decorative size={34} /><b>Cake</b></div><select value={selected?.workspace.id ?? ""} onChange={(event) => switchWorkspace(event.target.value)}>{data.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></header>
        {testAuth && <div className="demo-banner">テストログインで使用中です（{data.user.name}）</div>}
        {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice(null)}>×</button></div>}
        {loading && <div className="loading-line" />}
        {selected && tab === "home" && <HomePanel selected={selected} pending={data.pendingInvitations.length} setTab={openTab} add={() => setTransactionModal(true)} />}
        {selected && tab === "transactions" && <TransactionsPanel key={selected.workspace.id} selected={selected} add={() => setTransactionModal(true)} run={run} />}
        {selected && tab === "import" && <ImportPanel key={selected.workspace.id} selected={selected} run={run} />}
        {selected && tab === "settlement" && <SettlementPanel key={selected.workspace.id} selected={selected} run={run} />}
        {selected && tab === "settings" && <SettingsPanel key={selected.workspace.id} selected={selected} currentUserId={data.user.id} run={run} afterDelete={async () => { await refresh(); }} />}
        {tab === "settings" && data.user.isAdmin === true && !testAuth && <>
          {!selected && <PageHeading eyebrow="SETTINGS" title="設定" description="Cakeを利用できる人を管理します。" />}
          <UserManagement />
        </>}
      </main>

      <nav className="bottom-nav">{navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => openTab(item.id)}><i>{item.icon}</i><span>{item.label}</span></button>)}</nav>
      {workspaceModal && <WorkspaceModal close={() => setWorkspaceModal(false)} run={run} />}
      {transactionModal && selected && <NewTransactionModal key={selected.workspace.id} selected={selected} currentUserId={data.user.id} close={() => setTransactionModal(false)} run={run} />}
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <span>{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

function HomePanel({ selected, pending, setTab, add }: { selected: WorkspaceData; pending: number; setTab: (tab: Tab) => void; add: () => void }) {
  const month = new Date().getMonth();
  const monthTransactions = selected.transactions.filter((item) => new Date(item.occurredAt).getMonth() === month);
  const payments = monthTransactions.filter((item) => item.type === "PAYMENT").reduce((sum, item) => sum + item.amountYen, 0);
  const shared = selected.transactions.filter((item) => item.expenseClass === "SHARED" && !item.settledAt).reduce((sum, item) => sum + (item.type === "PAYMENT" ? item.amountYen : -item.amountYen), 0);
  return <>
    <div className="home-actions"><button className="primary" onClick={add}>＋ 明細を追加</button></div>
    {pending > 0 && <button className="invite-alert" onClick={() => setTab("settings")}>あなた宛ての招待が{pending}件あります <span>確認する →</span></button>}
    <div className="kpi-grid">
      <article className="kpi"><span>今月の支払い</span><strong>{money(payments)}</strong><small>{monthTransactions.length}件の取引</small></article>
      <article className="kpi"><span>未清算の共通費</span><strong>{money(shared)}</strong><small>{selected.transactions.filter((item) => item.expenseClass === "SHARED" && !item.settledAt).length}件が対象</small></article>
      <article className="kpi accent"><span>次の清算</span>{selected.settlement?.payerName && selected.settlement.payeeName ? <div className="next-settlement"><div className="settlement-person"><span className="settlement-avatar" aria-hidden="true">{Array.from(selected.settlement.payerName)[0]}</span><div><small>支払う人</small><b>{selected.settlement.payerName}</b></div></div><div className="settlement-transfer"><span className="settlement-arrow" aria-hidden="true">↓</span><strong>{selected.settlement.amountYen.toLocaleString("ja-JP")}<small>円</small></strong></div><div className="settlement-person"><span className="settlement-avatar payee" aria-hidden="true">{Array.from(selected.settlement.payeeName)[0]}</span><div><small>受け取る人</small><b>{selected.settlement.payeeName}</b></div></div></div> : <><strong>清算なし</strong><small>現在差額はありません</small></>}</article>
    </div>
    <div className="content-grid">
      <section className="panel recent"><div className="panel-head"><div><span>RECENT</span><h2>最近の取引</h2></div><button className="text-button" onClick={() => setTab("transactions")}>すべて見る →</button></div>
        <div className="recent-list">{selected.transactions.slice(0, 6).map((item) => <div className="recent-row" key={item.id}><span className="recent-name"><b>{item.merchant}</b><small>{dateTime(item.occurredAt)} · {item.actorName}</small></span><span className="recent-class">{item.expenseClass === "SHARED" ? "共通費" : "個人費"}</span><strong className={item.type === "RECEIPT" ? "positive" : ""}>{money(item.amountYen)}</strong></div>)}{selected.transactions.length === 0 && <Empty text="まだ取引がありません" />}</div>
      </section>
      <section className="panel quick"><div className="panel-head"><div><span>QUICK ACTIONS</span><h2>すぐにできること</h2></div></div>
        <button onClick={add}><i>＋</i><span><b>明細を追加</b><small>現金や受け取りを手動登録</small></span></button>
        <button onClick={() => setTab("import")}><i>⇩</i><span><b>PayPay CSVを取込</b><small>支払い明細をまとめて登録</small></span></button>
        <button onClick={() => setTab("settlement")}><i>↔</i><span><b>清算を確認</b><small>ふたりの差額を計算</small></span></button>
      </section>
    </div>
  </>;
}

const importFormats = {
  PAYPAY: { label: "PayPay", parse: parsePayPayCsv },
};

function ImportPanel({ selected, run }: { selected: WorkspaceData; run: (payload: Record<string, unknown>, success: string) => Promise<unknown> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<keyof typeof importFormats>("PAYPAY");
  const [rows, setRows] = useState<PayPayPreviewRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [actorId, setActorId] = useState(selected.members[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selectedCount = rows.filter((row) => row.selected).length;

  async function choose(file?: File) {
    if (!file) return;
    try {
      const text = await file.text();
      const existing = new Set(selected.transactions.map((item) => item.externalId));
      setRows(importFormats[format].parse(text, selected.rules, existing, selected.members, actorId));
      setFileName(file.name);
      setError(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "CSVを読み込めませんでした。"); }
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
      await run({ action: "bulkImport", workspaceId: selected.workspace.id, fileName, totalRows: rows.length, items }, `${items.length}件を取り込みました。`);
      setRows([]);
      setFileName("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "明細を登録できませんでした。"); }
    finally { setSaving(false); }
  }

  return <>
    <PageHeading eyebrow="IMPORT" title="明細を取込" description="費用区分と負担割合を確認してから、支払い明細を登録します。" />
    <section className="panel import-format">
      <label>ファイル形式<select value={format} disabled={saving || rows.length > 0} onChange={event => setFormat(event.target.value as keyof typeof importFormats)}>
        {Object.entries(importFormats).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
      </select></label>
    </section>
    {rows.length === 0 ? <section className="panel upload-panel"
      onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}>
      <div className="upload-icon">⇧</div><h2>CSVファイルをここにドロップ</h2>
      <p>またはファイル選択から{importFormats[format].label}の取引履歴を指定してください。</p>
      <button className="primary" onClick={() => inputRef.current?.click()}>ファイルを選択</button>
      <input ref={inputRef} hidden type="file" accept=".csv,text/csv" onChange={(event) => choose(event.target.files?.[0])} />
      <small>取引内容が「支払い」の行のみ対象 · CSVは保存されません</small>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section> : <section className="panel table-panel">
      <div className="import-summary">
        <div><span>選択したファイル</span><b>{fileName}</b></div><div><span>取込対象</span><b>{selectedCount} / {rows.length}件</b></div>
        <label>支払者<select disabled={saving} value={actorId} onChange={(event) => changeActor(event.target.value)}>{selected.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      </div>
      <div className="bulk-bar"><span>{selectedCount}件を選択中</span>
        <button disabled={saving} onClick={() => bulk("PERSONAL")}>個人費に変更</button><button disabled={saving} onClick={() => bulk("SHARED")}>共通費に変更</button>
        <button disabled={saving} className="text-button" onClick={() => { setRows([]); setFileName(""); }}>やり直す</button>
      </div>
      <div className="data-table-wrap"><table className="data-table import-preview"><thead><tr>
        <th><input type="checkbox" aria-label="取込対象をすべて選択" disabled={saving}
          checked={selectedCount > 0 && selectedCount === rows.filter((row) => !row.error && !row.duplicate).length}
          onChange={(event) => setRows((current) => current.map((row) => row.error || row.duplicate ? row : { ...row, selected: event.target.checked }))} /></th>
        <th>取引日時</th><th>取引先</th><th>方法</th><th>金額</th><th>費用区分</th><th>支払い割合</th><th>状態</th>
      </tr></thead><tbody>{rows.map((row) => <tr key={row.key} className={!row.selected ? "muted-row" : ""}>
        <td><input type="checkbox" aria-label={`${row.merchant}を取り込む`} checked={row.selected} disabled={saving || !!row.error || row.duplicate}
          onChange={(event) => setRows((current) => current.map((item) => item.key === row.key ? { ...item, selected: event.target.checked } : item))} /></td>
        <td data-label="取引日時">{row.occurredAt}</td><td data-label="取引先"><b>{row.merchant}</b></td><td data-label="方法">{row.method}</td><td data-label="金額">{money(row.amountYen)}</td>
        <td data-label="費用区分"><select aria-label={`${row.merchant}の費用区分`} disabled={saving} value={row.expenseClass}
          onChange={(event) => setRows((current) => current.map((item) => item.key === row.key ? changeClass(item, event.target.value as ExpenseClass) : item))}>
          <option value="PERSONAL">個人費</option><option value="SHARED">共通費</option>
        </select></td>
        <td data-label="支払い割合"><SplitEditor compact label={`${row.merchant}の支払い割合`} amountYen={row.amountYen}
          members={ratioMembers(selected.members, row.expenseClass, actorId)} value={row.splitWeights} disabled={saving || row.expenseClass === "PERSONAL"}
          onChange={(splitWeights) => setRows((current) => current.map((item) => item.key === row.key ? { ...item, splitWeights } : item))} /></td>
        <td data-label="状態">{row.duplicate ? <span className="error-tag">登録済み</span> : row.error ? <span className="error-tag">{row.error}</span> : <span className="success-tag">登録可能</span>}</td>
      </tr>)}</tbody></table></div>
      {error && <p className="import-error form-error" role="alert">{error}</p>}
      <div className="sticky-actions"><button className="secondary" disabled={saving} onClick={() => { setRows([]); setFileName(""); }}>キャンセル</button>
        <button className="primary" disabled={saving || selectedCount === 0} onClick={submit}>{saving ? "登録中…" : `選択した${selectedCount}件を登録`}</button>
      </div>
    </section>}
  </>;
}

function SettlementPanel({ selected, run }: { selected: WorkspaceData; run: (payload: Record<string, unknown>, success: string) => Promise<unknown> }) {
  const result = selected.settlement;
  async function complete() { if (confirm("表示中の明細を清算済みにしますか？ 実際の送金は別途行ってください。")) await run({ action: "completeSettlement", workspaceId: selected.workspace.id }, "清算を完了しました。"); }
  return <>
    <PageHeading eyebrow="SETTLEMENT" title="共通費を清算" description="未清算の共通費から、ふたりの差額を計算します。" />
    {selected.workspace.type === "PERSONAL" ? <section className="panel"><Empty text="清算は共有ワークスペースで利用できます" /></section> : selected.members.length < 2 ? <section className="panel"><Empty text="相手を招待すると清算計算を利用できます" /></section> : !result ? <section className="panel"><Empty text="現在、清算対象の共通費はありません" /></section> : <>
      <section className="settlement-hero"><span>今回の清算</span>{result.amountYen > 0 ? <><div className="people-flow"><b>{result.payerName}</b><i>→</i><b>{result.payeeName}</b></div><strong>{money(result.amountYen)}</strong><p>{result.payerName}さんが{result.payeeName}さんへ支払うと、差額が解消されます。</p></> : <><strong>清算不要</strong><p>現在の負担額に差はありません。</p></>}<button className="light-button" onClick={complete}>清算を完了する</button></section>
      <div className="settlement-grid"><section className="panel"><div className="panel-head"><div><span>CALCULATION</span><h2>計算の内訳</h2></div></div><dl className="summary-list"><div><dt>共通支払い</dt><dd>{money(result.paymentTotal)}</dd></div><div><dt>共通収入</dt><dd>− {money(result.receiptTotal)}</dd></div><div className="total"><dt>正味共通費</dt><dd>{money(result.netTotal)}</dd></div></dl></section><section className="panel"><div className="panel-head"><div><span>ALLOCATION</span><h2>ふたりの負担</h2></div></div>{result.people.map((person) => <div className="person-calc" key={person.userId}><div><b>{person.name}</b><span>明細ごとの割合で計算</span></div><p>実質負担 <b>{money(person.actual)}</b></p><p>目標負担 <b>{money(person.target)}</b></p><p className={person.balance >= 0 ? "positive" : "negative"}>差額 <b>{person.balance >= 0 ? "+" : ""}{money(person.balance)}</b></p></div>)}</section></div>
    </>}
    {selected.settlementHistory.length > 0 && <section className="panel history"><div className="panel-head"><div><span>HISTORY</span><h2>清算履歴</h2></div></div>{selected.settlementHistory.map((item) => <div key={item.id}><span>{dateTime(item.completedAt)}</span><b>{item.payerName && item.payeeName ? `${item.payerName} → ${item.payeeName}` : "清算不要"}</b><strong>{money(item.amountYen)}</strong></div>)}</section>}
  </>;
}

function SettingsPanel({ selected, currentUserId, run, afterDelete }: { selected: WorkspaceData; currentUserId: string; run: (payload: Record<string, unknown>, success: string) => Promise<unknown>; afterDelete: () => Promise<void> }) {
  const [name, setName] = useState(selected.workspace.name);
  const [email, setEmail] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [weights, setWeights] = useState<SplitWeights>(() => defaultSplitWeights(selected.members));
  const [deleteName, setDeleteName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savingWeights, setSavingWeights] = useState(false);

  async function invite() {
    setError(null);
    try {
      const result = await run({ action: "createInvite", workspaceId: selected.workspace.id, email }, "招待リンクを作成しました。") as { invitePath: string };
      setInviteLink(`${location.origin}${result.invitePath}`);
      setEmail("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "招待できませんでした。"); }
  }

  async function saveWeights() {
    setError(null);
    setSavingWeights(true);
    try {
      const validWeights = validateSplitWeights(weights, selected.members);
      await run({ action: "updateWeights", workspaceId: selected.workspace.id,
        weights: selected.members.map((member) => ({ userId: member.id, weight: validWeights[member.id] })) }, "共有費のデフォルト割合を保存しました。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "割合を保存できませんでした。"); }
    finally { setSavingWeights(false); }
  }

  async function removeWorkspace() {
    if (deleteName !== selected.workspace.name) return;
    if (!confirm("関連する明細・ルール・清算履歴もすべて削除されます。続けますか？")) return;
    await postAction({ action: "deleteWorkspace", workspaceId: selected.workspace.id, confirmationName: deleteName });
    await afterDelete();
  }

  return <>
    <PageHeading eyebrow="SETTINGS" title="ワークスペース設定" description="デフォルト割合とルールを参加者全員で共有します。" />
    <div className="settings-grid">
      <section className="panel settings-section">
        <div className="panel-head"><div><span>GENERAL</span><h2>基本情報</h2></div></div>
        <label>ワークスペース名<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>種類<input value={selected.workspace.type === "SHARED" ? "共有用" : "個人用"} disabled /></label>
        <button className="secondary" onClick={() => run({ action: "updateWorkspace", workspaceId: selected.workspace.id, name }, "名前を変更しました。")}>変更を保存</button>
      </section>
      <section className="panel settings-section">
        <div className="panel-head"><div><span>DEFAULT SPLIT</span><h2>共有費のデフォルト割合</h2></div></div>
        {selected.members.map((member) => <div className="member-row" key={member.id}>
          <span className="avatar">{member.name.slice(0, 1)}</span>
          <span><b>{member.name}{member.id === currentUserId && "（あなた）"}</b><small>{member.email}</small></span>
        </div>)}
        {selected.workspace.type === "SHARED" && <div className="default-split-settings">
          <SplitEditor members={selected.members} value={weights} onChange={setWeights} disabled={savingWeights || selected.members.length < 2} label="デフォルト割合" />
          <p className="ratio-note">新しい共有費の初期値に使います。保存済みの明細は、それぞれの割合で清算します。</p>
          {selected.members.length === 2 && <button className="secondary" disabled={savingWeights} onClick={saveWeights}>{savingWeights ? "保存中…" : "割合を保存"}</button>}
        </div>}
        {selected.workspace.type === "SHARED" && selected.members.length < 2 && <div className="invite-form">
          <label>相手のGoogleアカウントのメール<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="partner@example.com" /></label>
          <button className="secondary" onClick={invite}>招待リンクを作成</button>
          {inviteLink && <div className="copy-box"><input readOnly value={inviteLink} /><button onClick={() => navigator.clipboard.writeText(inviteLink)}>コピー</button></div>}
        </div>}
        {error && <p className="settings-error form-error" role="alert">{error}</p>}
      </section>
    </div>
    <WorkspaceRules selected={selected} run={run} />
    <section className="panel danger-zone">
      <div><span>DANGER ZONE</span><h2>ワークスペースを削除</h2><p>関連する明細、招待、ルール、清算履歴がすべて削除され、元に戻せません。</p></div>
      <label>確認のため「{selected.workspace.name}」と入力<input value={deleteName} onChange={(event) => setDeleteName(event.target.value)} /></label>
      <button disabled={deleteName !== selected.workspace.name} onClick={removeWorkspace}>完全に削除</button>
    </section>
  </>;
}

function WorkspaceModal({ close, run }: { close: () => void; run: (payload: Record<string, unknown>, success: string, workspaceId?: string) => Promise<unknown> }) {
  const [name, setName] = useState(""); const [type, setType] = useState<WorkspaceType>("PERSONAL");
  return <Modal title="ワークスペースを作成" close={close}><form onSubmit={async (event) => { event.preventDefault(); await run({ action: "createWorkspace", name, type }, "ワークスペースを作成しました。"); close(); }}><label>名前<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="例: ふたりの家計" /></label><fieldset><legend>種類</legend><label className={`choice ${type === "PERSONAL" ? "selected" : ""}`}><input type="radio" checked={type === "PERSONAL"} onChange={() => setType("PERSONAL")} /><span><b>個人用</b><small>自分だけで管理する家計</small></span></label><label className={`choice ${type === "SHARED" ? "selected" : ""}`}><input type="radio" checked={type === "SHARED"} onChange={() => setType("SHARED")} /><span><b>共有用</b><small>もう一人を招待して清算</small></span></label></fieldset><div className="modal-actions"><button type="button" className="secondary" onClick={close}>キャンセル</button><button className="primary">作成する</button></div></form></Modal>;
}

function NewTransactionModal({ selected, currentUserId, close, run }: { selected: WorkspaceData; currentUserId: string; close: () => void; run: (payload: Record<string, unknown>, success: string) => Promise<unknown> }) {
  const initialActor = selected.members.some((member) => member.id === currentUserId) ? currentUserId : selected.members[0]?.id ?? "";
  const [occurredAt, setOccurredAt] = useState(inputDate());
  const [merchant, setMerchant] = useState("");
  const [method, setMethod] = useState("現金");
  const [amountYen, setAmountYen] = useState(0);
  const [actorUserId, setActorUserId] = useState(initialActor);
  const [expenseClass, setExpenseClass] = useState<ExpenseClass>("SHARED");
  const [splitWeights, setSplitWeights] = useState<SplitWeights>(() => defaultSplitWeights(selected.members));
  const [memo, setMemo] = useState("");
  const [customized, setCustomized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyDefaults(nextMerchant = merchant, nextActor = actorUserId) {
    const defaults = matchingDefaultRule(nextMerchant, selected.rules)
      ? transactionDefaults(nextMerchant, selected.rules, selected.members, nextActor)
      : { expenseClass: "SHARED" as const, splitWeights: defaultSplitWeights(selected.members) };
    setExpenseClass(defaults.expenseClass);
    setSplitWeights(defaults.splitWeights);
  }

  return <Modal title="明細を追加" close={close} className="transaction-modal">
    <form onSubmit={async (event) => {
      event.preventDefault();
      setError(null);
      setSaving(true);
      try {
        validateSplitWeights(splitWeights, selected.members, expenseClass, actorUserId);
        await run({ action: "saveTransaction", workspaceId: selected.workspace.id,
          occurredAt: jstInputToIso(occurredAt), merchant, method, type: "PAYMENT", amountYen, actorUserId, expenseClass, splitWeights, memo },
        "明細を追加しました。");
        close();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "明細を保存できませんでした。");
      } finally { setSaving(false); }
    }}>
      <div className="form-grid">
        <label className="full">取引日時<input type="datetime-local" required value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
        <label className="full">取引先<input required maxLength={240} value={merchant} onChange={(event) => {
          setMerchant(event.target.value);
          if (!customized) applyDefaults(event.target.value);
        }} /></label>
        <label>取引方法<input required maxLength={120} value={method} onChange={(event) => setMethod(event.target.value)} /></label>
        <label>金額（円）<input type="number" required min="1" step="1" value={amountYen || ""} onChange={(event) => setAmountYen(Number(event.target.value))} /></label>
        <label>支払者<select value={actorUserId} onChange={(event) => {
          const nextActor = event.target.value;
          setActorUserId(nextActor);
          if (expenseClass === "PERSONAL") setSplitWeights(personalSplitWeights(selected.members, nextActor));
        }}>{selected.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label>費用区分<select value={expenseClass} onChange={(event) => {
          const nextClass = event.target.value as ExpenseClass;
          setExpenseClass(nextClass);
          setSplitWeights(nextClass === "PERSONAL" ? personalSplitWeights(selected.members, actorUserId) : defaultSplitWeights(selected.members));
          setCustomized(true);
        }}><option value="PERSONAL">個人費</option><option value="SHARED">共通費</option></select></label>
        <div className="full">
          <SplitEditor inline label={`支払い割合（${selected.members.map((member) => member.name).join(", ")}）`} amountYen={amountYen} members={selected.members} value={splitWeights}
            disabled={expenseClass === "PERSONAL" || saving} onChange={(next) => { setSplitWeights(next); setCustomized(true); }} />
          <p className="ratio-note">{expenseClass === "PERSONAL" ? "個人費は支払者の負担が100%になります。" : "割合・金額で設定できます。相手の分は自動計算します。"}</p>
          <button type="button" className="text-button" disabled={saving} onClick={() => { applyDefaults(); setCustomized(false); }}>取引先のルールを適用</button>
        </div>
      </div>
      <label className="new-transaction-memo">メモ<textarea maxLength={MAX_TRANSACTION_MEMO_LENGTH} value={memo} disabled={saving} onChange={(event) => setMemo(event.target.value)} rows={2} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={close}>キャンセル</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "追加する"}</button></div>
    </form>
  </Modal>;
}

function ratioMembers(members: WorkspaceMember[], expenseClass: ExpenseClass, actorUserId: string) {
  return expenseClass === "PERSONAL" ? [...members].sort((a, b) => Number(b.id === actorUserId) - Number(a.id === actorUserId)) : members;
}

function Modal({ title, close, children, className = "" }: { title: string; close: () => void; children: React.ReactNode; className?: string }) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={close}>×</button></header>{children}</section></div>; }
function Empty({ text }: { text: string }) { return <div className="empty"><span>○</span><p>{text}</p></div>; }

"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { signOut } from "next-auth/react";
import { parsePayPayCsv, payPayDateToIso, type PayPayPreviewRow } from "@/lib/paypay";
import type {
  BootstrapData,
  ExpenseClass,
  TransactionRecord,
  TransactionType,
  WorkspaceData,
  WorkspaceType,
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
  const [transactionModal, setTransactionModal] = useState<TransactionRecord | "new" | null>(null);
  const selected = data.selected;

  async function refresh(workspaceId = selected?.workspace.id) {
    const response = await fetch(`/api/app${workspaceId ? `?workspaceId=${workspaceId}` : ""}`, { cache: "no-store" });
    const next = await response.json();
    if (!response.ok) throw new Error(next.error ?? "更新に失敗しました。");
    setData(next);
  }

  async function run(payload: Record<string, unknown>, success: string, workspaceId?: string) {
    setLoading(true); setNotice(null);
    try {
      const result = await postAction(payload);
      await refresh(workspaceId ?? result.workspaceId ?? selected?.workspace.id);
      setNotice(success);
      return result;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "処理に失敗しました。");
      throw error;
    } finally { setLoading(false); }
  }

  async function switchWorkspace(workspaceId: string) {
    setLoading(true); setNotice(null);
    try { await refresh(workspaceId); } catch (error) { setNotice(error instanceof Error ? error.message : "読込に失敗しました。"); }
    finally { setLoading(false); }
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-logo"><span>C</span><b>Cake</b></div>
        <div className="workspace-picker">
          <label>ワークスペース</label>
          <select value={selected?.workspace.id ?? ""} onChange={(event) => switchWorkspace(event.target.value)}>
            {data.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <button className="small-link" onClick={() => setWorkspaceModal(true)}>＋ 新しく作成</button>
        </div>
        <nav className="app-nav">
          {navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><i>{item.icon}</i><span>{item.label}</span></button>)}
        </nav>
        <div className="profile">
          <span className="avatar">{data.user.imageUrl ? <Image src={data.user.imageUrl} alt="" width={36} height={36} /> : data.user.name.slice(0, 1)}</span>
          <span><b>{data.user.name}</b><small>{data.user.email}</small></span>
          {testAuth && <span className="demo-chip">TEST</span>}
          <button title="ログアウト" onClick={() => signOut({ redirectTo: "/" })}>↪</button>
        </div>
      </aside>

      <main className="app-main">
        <header className="mobile-header"><div className="app-logo"><span>C</span><b>Cake</b></div><select value={selected?.workspace.id ?? ""} onChange={(event) => switchWorkspace(event.target.value)}>{data.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></header>
        {testAuth && <div className="demo-banner">テストログインで使用中です（{data.user.name}）</div>}
        {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice(null)}>×</button></div>}
        {loading && <div className="loading-line" />}
        {selected && tab === "home" && <HomePanel selected={selected} pending={data.pendingInvitations.length} setTab={setTab} add={() => setTransactionModal("new")} />}
        {selected && tab === "transactions" && <TransactionsPanel key={selected.workspace.id} selected={selected} add={() => setTransactionModal("new")} edit={setTransactionModal} run={run} />}
        {selected && tab === "import" && <ImportPanel key={selected.workspace.id} selected={selected} run={run} />}
        {selected && tab === "settlement" && <SettlementPanel key={selected.workspace.id} selected={selected} run={run} />}
        {selected && tab === "settings" && <SettingsPanel key={selected.workspace.id} selected={selected} currentUserId={data.user.id} run={run} afterDelete={() => refresh()} />}
      </main>

      <nav className="bottom-nav">{navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><i>{item.icon}</i><span>{item.label}</span></button>)}</nav>
      {workspaceModal && <WorkspaceModal close={() => setWorkspaceModal(false)} run={run} />}
      {transactionModal && selected && <TransactionModal value={transactionModal} selected={selected} close={() => setTransactionModal(null)} run={run} />}
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><span>{eyebrow}</span><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

function HomePanel({ selected, pending, setTab, add }: { selected: WorkspaceData; pending: number; setTab: (tab: Tab) => void; add: () => void }) {
  const month = new Date().getMonth();
  const monthTransactions = selected.transactions.filter((item) => new Date(item.occurredAt).getMonth() === month);
  const payments = monthTransactions.filter((item) => item.type === "PAYMENT").reduce((sum, item) => sum + item.amountYen, 0);
  const shared = selected.transactions.filter((item) => item.expenseClass === "SHARED" && !item.settledAt).reduce((sum, item) => sum + (item.type === "PAYMENT" ? item.amountYen : -item.amountYen), 0);
  return <>
    <PageHeading eyebrow="OVERVIEW" title={`おかえりなさい`} description={`${selected.workspace.name}のいまを、ひと目で確認できます。`} action={<button className="primary" onClick={add}>＋ 明細を追加</button>} />
    {pending > 0 && <button className="invite-alert" onClick={() => setTab("settings")}>あなた宛ての招待が{pending}件あります <span>確認する →</span></button>}
    <div className="kpi-grid">
      <article className="kpi"><span>今月の支払い</span><strong>{money(payments)}</strong><small>{monthTransactions.length}件の取引</small></article>
      <article className="kpi"><span>未清算の共通費</span><strong>{money(shared)}</strong><small>{selected.transactions.filter((item) => item.expenseClass === "SHARED" && !item.settledAt).length}件が対象</small></article>
      <article className="kpi accent"><span>次の清算</span><strong>{selected.settlement?.payerName && selected.settlement.payeeName ? `${selected.settlement.payerName} → ${selected.settlement.payeeName}` : "清算なし"}</strong><small>{selected.settlement ? money(selected.settlement.amountYen) : "現在差額はありません"}</small></article>
    </div>
    <div className="content-grid">
      <section className="panel recent"><div className="panel-head"><div><span>RECENT</span><h2>最近の取引</h2></div><button className="text-button" onClick={() => setTab("transactions")}>すべて見る →</button></div>
        <div className="recent-list">{selected.transactions.slice(0, 6).map((item) => <div className="recent-row" key={item.id}><span className={`tx-icon ${item.type.toLowerCase()}`}>{item.type === "PAYMENT" ? "↗" : "↙"}</span><span className="recent-name"><b>{item.merchant}</b><small>{dateTime(item.occurredAt)} · {item.actorName}</small></span><span className="recent-class">{item.expenseClass === "SHARED" ? "共通費" : "個人費"}</span><strong className={item.type === "RECEIPT" ? "positive" : ""}>{item.type === "PAYMENT" ? "−" : "+"}{money(item.amountYen)}</strong></div>)}{selected.transactions.length === 0 && <Empty text="まだ取引がありません" />}</div>
      </section>
      <section className="panel quick"><div className="panel-head"><div><span>QUICK ACTIONS</span><h2>すぐにできること</h2></div></div>
        <button onClick={add}><i>＋</i><span><b>明細を追加</b><small>現金や受け取りを手動登録</small></span></button>
        <button onClick={() => setTab("import")}><i>⇩</i><span><b>PayPay CSVを取込</b><small>支払い明細をまとめて登録</small></span></button>
        <button onClick={() => setTab("settlement")}><i>↔</i><span><b>清算を確認</b><small>ふたりの差額を計算</small></span></button>
      </section>
    </div>
  </>;
}

function TransactionsPanel({ selected, add, edit, run }: { selected: WorkspaceData; add: () => void; edit: (item: TransactionRecord) => void; run: (payload: Record<string, unknown>, success: string) => Promise<unknown> }) {
  const [query, setQuery] = useState("");
  const [expense, setExpense] = useState("ALL");
  const filtered = selected.transactions.filter((item) => (expense === "ALL" || item.expenseClass === expense) && item.merchant.toLowerCase().includes(query.toLowerCase()));
  async function remove(item: TransactionRecord) {
    if (!confirm(`${item.merchant}の明細を削除しますか？`)) return;
    await run({ action: "deleteTransaction", workspaceId: selected.workspace.id, transactionId: item.id }, "明細を削除しました。");
  }
  return <>
    <PageHeading eyebrow="TRANSACTIONS" title="取引明細" description="支払いと受け取りを、ワークスペース単位で管理します。" action={<button className="primary" onClick={add}>＋ 明細を追加</button>} />
    <section className="panel table-panel"><div className="toolbar"><div className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="取引先を検索" /></div><select value={expense} onChange={(event) => setExpense(event.target.value)}><option value="ALL">すべての費用区分</option><option value="PERSONAL">個人費</option><option value="SHARED">共通費</option></select><span className="count">{filtered.length}件</span></div>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>取引日時</th><th>取引先 / 方法</th><th>種別</th><th>金額</th><th>担当者</th><th>費用区分</th><th>清算</th><th>操作</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td data-label="取引日時">{dateTime(item.occurredAt)}</td><td data-label="取引先"><b>{item.merchant}</b><small>{item.method}</small></td><td data-label="種別"><span className={`type-tag ${item.type.toLowerCase()}`}>{item.type === "PAYMENT" ? "支払い" : "受け取り"}</span></td><td data-label="金額" className={item.type === "RECEIPT" ? "positive" : ""}>{item.type === "PAYMENT" ? "−" : "+"}{money(item.amountYen)}</td><td data-label="担当者">{item.actorName}</td><td data-label="費用区分"><span className={`class-tag ${item.expenseClass.toLowerCase()}`}>{item.expenseClass === "SHARED" ? "共通費" : "個人費"}</span></td><td data-label="清算">{item.expenseClass === "PERSONAL" ? "対象外" : item.settledAt ? "清算済み" : <span className="unsettled">未清算</span>}</td><td data-label="操作"><div className="row-actions"><button disabled={!!item.settledAt} onClick={() => edit(item)}>編集</button><button disabled={!!item.settledAt} className="danger-text" onClick={() => remove(item)}>削除</button></div></td></tr>)}</tbody></table>{filtered.length === 0 && <Empty text="条件に一致する明細がありません" />}</div>
    </section>
  </>;
}

function ImportPanel({ selected, run }: { selected: WorkspaceData; run: (payload: Record<string, unknown>, success: string) => Promise<unknown> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<PayPayPreviewRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [actorId, setActorId] = useState(selected.members[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const selectedCount = rows.filter((row) => row.selected).length;
  async function choose(file?: File) {
    if (!file) return;
    try {
      const text = await file.text();
      const existing = new Set(selected.transactions.map((item) => item.externalId));
      setRows(parsePayPayCsv(text, selected.rules, existing)); setFileName(file.name); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "CSVを読み込めませんでした。"); }
  }
  function bulk(expenseClass: ExpenseClass) { setRows((current) => current.map((row) => row.selected ? { ...row, expenseClass } : row)); }
  async function submit() {
    try {
      setError(null);
      const items = rows.filter((row) => row.selected).map((row) => ({ occurredAt: payPayDateToIso(row.occurredAt), merchant: row.merchant, method: row.method, amountYen: row.amountYen, externalId: row.externalId, expenseClass: row.expenseClass, actorUserId: actorId }));
      if (items.length === 0) { setError("登録する行を選択してください。"); return; }
      await run({ action: "bulkImport", workspaceId: selected.workspace.id, fileName, totalRows: rows.length, items }, `${items.length}件を取り込みました。`);
      setRows([]); setFileName("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "明細を登録できませんでした。");
    }
  }
  return <>
    <PageHeading eyebrow="IMPORT" title="PayPay明細を取込" description="支払い明細だけを抽出し、登録前に費用区分を確認できます。" />
    {rows.length === 0 ? <section className="panel upload-panel" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}><div className="upload-icon">⇧</div><h2>CSVファイルをここにドロップ</h2><p>またはファイル選択からPayPayの取引履歴を指定してください。</p><button className="primary" onClick={() => inputRef.current?.click()}>ファイルを選択</button><input ref={inputRef} hidden type="file" accept=".csv,text/csv" onChange={(event) => choose(event.target.files?.[0])} /><small>取引内容が「支払い」の行のみ対象 · CSVは保存されません</small>{error && <p className="form-error">{error}</p>}</section> : <section className="panel table-panel"><div className="import-summary"><div><span>選択したファイル</span><b>{fileName}</b></div><div><span>取込対象</span><b>{selectedCount} / {rows.length}件</b></div><label>支払者<select value={actorId} onChange={(event) => setActorId(event.target.value)}>{selected.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div><div className="bulk-bar"><span>{selectedCount}件を選択中</span><button onClick={() => bulk("PERSONAL")}>個人費に変更</button><button onClick={() => bulk("SHARED")}>共通費に変更</button><button className="text-button" onClick={() => { setRows([]); setFileName(""); }}>やり直す</button></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th><input type="checkbox" checked={selectedCount > 0 && selectedCount === rows.filter((row) => !row.error && !row.duplicate).length} onChange={(event) => setRows((current) => current.map((row) => row.error || row.duplicate ? row : { ...row, selected: event.target.checked }))} /></th><th>取引日時</th><th>取引先</th><th>方法</th><th>金額</th><th>費用区分</th><th>状態</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key} className={!row.selected ? "muted-row" : ""}><td><input type="checkbox" checked={row.selected} disabled={!!row.error || row.duplicate} onChange={(event) => setRows((current) => current.map((item) => item.key === row.key ? { ...item, selected: event.target.checked } : item))} /></td><td>{row.occurredAt}</td><td><b>{row.merchant}</b></td><td>{row.method}</td><td>{money(row.amountYen)}</td><td><select value={row.expenseClass} onChange={(event) => setRows((current) => current.map((item) => item.key === row.key ? { ...item, expenseClass: event.target.value as ExpenseClass } : item))}><option value="PERSONAL">個人費</option><option value="SHARED">共通費</option></select></td><td>{row.duplicate ? <span className="error-tag">登録済み</span> : row.error ? <span className="error-tag">{row.error}</span> : <span className="success-tag">登録可能</span>}</td></tr>)}</tbody></table></div>{error && <p className="form-error">{error}</p>}<div className="sticky-actions"><button className="secondary" onClick={() => { setRows([]); setFileName(""); }}>キャンセル</button><button className="primary" onClick={submit}>選択した{selectedCount}件を登録</button></div></section>}
  </>;
}

function SettlementPanel({ selected, run }: { selected: WorkspaceData; run: (payload: Record<string, unknown>, success: string) => Promise<unknown> }) {
  const result = selected.settlement;
  async function complete() { if (confirm("表示中の明細を清算済みにしますか？ 実際の送金は別途行ってください。")) await run({ action: "completeSettlement", workspaceId: selected.workspace.id }, "清算を完了しました。"); }
  return <>
    <PageHeading eyebrow="SETTLEMENT" title="共通費を清算" description="未清算の共通費から、ふたりの差額を計算します。" />
    {selected.workspace.type === "PERSONAL" ? <section className="panel"><Empty text="清算は共有ワークスペースで利用できます" /></section> : selected.members.length < 2 ? <section className="panel"><Empty text="相手を招待すると清算計算を利用できます" /></section> : !result ? <section className="panel"><Empty text="現在、清算対象の共通費はありません" /></section> : <>
      <section className="settlement-hero"><span>今回の清算</span>{result.amountYen > 0 ? <><div className="people-flow"><b>{result.payerName}</b><i>→</i><b>{result.payeeName}</b></div><strong>{money(result.amountYen)}</strong><p>{result.payerName}さんが{result.payeeName}さんへ支払うと、差額が解消されます。</p></> : <><strong>清算不要</strong><p>現在の負担額に差はありません。</p></>}<button className="light-button" onClick={complete}>清算を完了する</button></section>
      <div className="settlement-grid"><section className="panel"><div className="panel-head"><div><span>CALCULATION</span><h2>計算の内訳</h2></div></div><dl className="summary-list"><div><dt>共通支払い</dt><dd>{money(result.paymentTotal)}</dd></div><div><dt>共通収入</dt><dd>− {money(result.receiptTotal)}</dd></div><div className="total"><dt>正味共通費</dt><dd>{money(result.netTotal)}</dd></div></dl></section><section className="panel"><div className="panel-head"><div><span>WEIGHTS</span><h2>ふたりの負担</h2></div></div>{result.people.map((person) => <div className="person-calc" key={person.userId}><div><b>{person.name}</b><span>重み {person.weight}</span></div><p>実質負担 <b>{money(person.actual)}</b></p><p>目標負担 <b>{money(person.target)}</b></p><p className={person.balance >= 0 ? "positive" : "negative"}>差額 <b>{person.balance >= 0 ? "+" : ""}{money(person.balance)}</b></p></div>)}</section></div>
    </>}
    {selected.settlementHistory.length > 0 && <section className="panel history"><div className="panel-head"><div><span>HISTORY</span><h2>清算履歴</h2></div></div>{selected.settlementHistory.map((item) => <div key={item.id}><span>{dateTime(item.completedAt)}</span><b>{item.payerName && item.payeeName ? `${item.payerName} → ${item.payeeName}` : "清算不要"}</b><strong>{money(item.amountYen)}</strong></div>)}</section>}
  </>;
}

function SettingsPanel({ selected, currentUserId, run, afterDelete }: { selected: WorkspaceData; currentUserId: string; run: (payload: Record<string, unknown>, success: string) => Promise<unknown>; afterDelete: () => Promise<void> }) {
  const [name, setName] = useState(selected.workspace.name);
  const [email, setEmail] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [weights, setWeights] = useState(() => Object.fromEntries(selected.members.map((member) => [member.id, member.weight])));
  const [merchant, setMerchant] = useState("");
  const [ruleClass, setRuleClass] = useState<ExpenseClass>("PERSONAL");
  const [priority, setPriority] = useState(100);
  const [deleteName, setDeleteName] = useState("");
  async function invite() { const result = await run({ action: "createInvite", workspaceId: selected.workspace.id, email }, "招待リンクを作成しました。") as { invitePath: string }; const link = `${location.origin}${result.invitePath}`; setInviteLink(link); setEmail(""); }
  async function removeWorkspace() { if (deleteName !== selected.workspace.name) return; if (!confirm("関連する明細・ルール・清算履歴もすべて削除されます。続けますか？")) return; await postAction({ action: "deleteWorkspace", workspaceId: selected.workspace.id, confirmationName: deleteName }); await afterDelete(); }
  return <>
    <PageHeading eyebrow="SETTINGS" title="ワークスペース設定" description="参加者、負担の重み、取込ルールを管理します。" />
    <div className="settings-grid">
      <section className="panel settings-section"><div className="panel-head"><div><span>GENERAL</span><h2>基本情報</h2></div></div><label>ワークスペース名<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>種類<input value={selected.workspace.type === "SHARED" ? "共有用" : "個人用"} disabled /></label><button className="secondary" onClick={() => run({ action: "updateWorkspace", workspaceId: selected.workspace.id, name }, "名前を変更しました。")}>変更を保存</button></section>
      <section className="panel settings-section"><div className="panel-head"><div><span>MEMBERS</span><h2>参加者と重み</h2></div></div>{selected.members.map((member) => <div className="member-row" key={member.id}><span className="avatar">{member.name.slice(0, 1)}</span><span><b>{member.name}{member.id === currentUserId && "（あなた）"}</b><small>{member.email}</small></span>{selected.workspace.type === "SHARED" && <label>重み<input type="number" min="1" value={weights[member.id] ?? 1} onChange={(event) => setWeights((current) => ({ ...current, [member.id]: Number(event.target.value) }))} /></label>}</div>)}{selected.workspace.type === "SHARED" && selected.members.length === 2 && <button className="secondary" onClick={() => run({ action: "updateWeights", workspaceId: selected.workspace.id, weights: selected.members.map((member) => ({ userId: member.id, weight: weights[member.id] })) }, "重みを更新しました。")}>重みを保存</button>}{selected.workspace.type === "SHARED" && selected.members.length < 2 && <div className="invite-form"><label>相手のGoogleアカウントのメール<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="partner@example.com" /></label><button className="secondary" onClick={invite}>招待リンクを作成</button>{inviteLink && <div className="copy-box"><input readOnly value={inviteLink} /><button onClick={() => navigator.clipboard.writeText(inviteLink)}>コピー</button></div>}</div>}</section>
    </div>
    <section className="panel settings-section rules-section"><div className="panel-head"><div><span>IMPORT RULES</span><h2>費用区分のデフォルトルール</h2></div></div><p className="section-note">取引先に指定文字が含まれる場合、優先順位の小さいルールから適用します。</p><div className="rule-form"><input value={merchant} onChange={(event) => setMerchant(event.target.value)} placeholder="例: ヨークフーズ" /><select value={ruleClass} onChange={(event) => setRuleClass(event.target.value as ExpenseClass)}><option value="PERSONAL">個人費</option><option value="SHARED">共通費</option></select><input type="number" min="0" max="9999" value={priority} onChange={(event) => setPriority(Number(event.target.value))} /><button className="primary" onClick={async () => { await run({ action: "createRule", workspaceId: selected.workspace.id, merchantContains: merchant, expenseClass: ruleClass, priority }, "ルールを追加しました。"); setMerchant(""); }}>追加</button></div><div className="rule-list">{selected.rules.map((rule) => <div key={rule.id}><span>「<b>{rule.merchantContains}</b>」を含む</span><span className={`class-tag ${rule.expenseClass.toLowerCase()}`}>{rule.expenseClass === "SHARED" ? "共通費" : "個人費"}</span><small>優先 {rule.priority}</small><button className="danger-text" onClick={() => run({ action: "deleteRule", workspaceId: selected.workspace.id, ruleId: rule.id }, "ルールを削除しました。")}>削除</button></div>)}{selected.rules.length === 0 && <Empty text="デフォルトルールはまだありません" />}</div></section>
    <section className="panel danger-zone"><div><span>DANGER ZONE</span><h2>ワークスペースを削除</h2><p>関連する明細、招待、ルール、清算履歴がすべて削除され、元に戻せません。</p></div><label>確認のため「{selected.workspace.name}」と入力<input value={deleteName} onChange={(event) => setDeleteName(event.target.value)} /></label><button disabled={deleteName !== selected.workspace.name} onClick={removeWorkspace}>完全に削除</button></section>
  </>;
}

function WorkspaceModal({ close, run }: { close: () => void; run: (payload: Record<string, unknown>, success: string, workspaceId?: string) => Promise<unknown> }) {
  const [name, setName] = useState(""); const [type, setType] = useState<WorkspaceType>("PERSONAL");
  return <Modal title="ワークスペースを作成" close={close}><form onSubmit={async (event) => { event.preventDefault(); await run({ action: "createWorkspace", name, type }, "ワークスペースを作成しました。"); close(); }}><label>名前<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="例: ふたりの家計" /></label><fieldset><legend>種類</legend><label className={`choice ${type === "PERSONAL" ? "selected" : ""}`}><input type="radio" checked={type === "PERSONAL"} onChange={() => setType("PERSONAL")} /><span><b>個人用</b><small>自分だけで管理する家計</small></span></label><label className={`choice ${type === "SHARED" ? "selected" : ""}`}><input type="radio" checked={type === "SHARED"} onChange={() => setType("SHARED")} /><span><b>共有用</b><small>もう一人を招待して清算</small></span></label></fieldset><div className="modal-actions"><button type="button" className="secondary" onClick={close}>キャンセル</button><button className="primary">作成する</button></div></form></Modal>;
}

function TransactionModal({ value, selected, close, run }: { value: TransactionRecord | "new"; selected: WorkspaceData; close: () => void; run: (payload: Record<string, unknown>, success: string) => Promise<unknown> }) {
  const item = value === "new" ? null : value;
  const [occurredAt, setOccurredAt] = useState(inputDate(item?.occurredAt)); const [merchant, setMerchant] = useState(item?.merchant ?? ""); const [method, setMethod] = useState(item?.method ?? "現金"); const [type, setType] = useState<TransactionType>(item?.type ?? "PAYMENT"); const [amountYen, setAmountYen] = useState(item?.amountYen ?? 0); const [actorUserId, setActorUserId] = useState(item?.actorUserId ?? selected.members[0]?.id ?? ""); const [expenseClass, setExpenseClass] = useState<ExpenseClass>(item?.expenseClass ?? "PERSONAL");
  return <Modal title={item ? "明細を編集" : "明細を追加"} close={close}><form onSubmit={async (event) => { event.preventDefault(); await run({ action: "saveTransaction", workspaceId: selected.workspace.id, transactionId: item?.id, occurredAt: jstInputToIso(occurredAt), merchant, method, type, amountYen, actorUserId, expenseClass }, item ? "明細を更新しました。" : "明細を追加しました。"); close(); }}><div className="form-grid"><label className="full">取引日時<input type="datetime-local" required value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label><label className="full">取引先<input required maxLength={240} value={merchant} onChange={(event) => setMerchant(event.target.value)} /></label><label>取引方法<input required maxLength={120} value={method} onChange={(event) => setMethod(event.target.value)} /></label><label>取引種別<select value={type} onChange={(event) => setType(event.target.value as TransactionType)}><option value="PAYMENT">支払い</option><option value="RECEIPT">受け取り</option></select></label><label>金額（円）<input type="number" required min="1" value={amountYen || ""} onChange={(event) => setAmountYen(Number(event.target.value))} /></label><label>{type === "PAYMENT" ? "支払者" : "受取者"}<select value={actorUserId} onChange={(event) => setActorUserId(event.target.value)}>{selected.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><label className="full">費用区分<select value={expenseClass} onChange={(event) => setExpenseClass(event.target.value as ExpenseClass)}><option value="PERSONAL">個人費</option><option value="SHARED">共通費</option></select></label></div><div className="modal-actions"><button type="button" className="secondary" onClick={close}>キャンセル</button><button className="primary">{item ? "変更を保存" : "追加する"}</button></div></form></Modal>;
}

function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) { return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={close}>×</button></header>{children}</section></div>; }
function Empty({ text }: { text: string }) { return <div className="empty"><span>○</span><p>{text}</p></div>; }

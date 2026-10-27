"use client";

import { cashflowClass, formatCashflow, formatYen, formatJstDateTime } from "@/lib/shared/display-formatters";
import { cashflowSummary, currentMonthTransactions, workspaceCashflowSummary } from "@/lib/shared/home-summary";
import type { RunAppAction } from "@/lib/shared/schemas/app-input";
import type { DashboardTab as Tab, WorkspaceData } from "@/lib/shared/types";

export function HomePanel({ selected, pending, setTab, add, run, refreshAction, refreshing }: { selected: WorkspaceData; userId: string; pending: number; setTab: (tab: Tab) => void; add: () => void; run: RunAppAction; refreshAction: React.ReactNode; refreshing: boolean }) {
  const monthTransactions = currentMonthTransactions(selected.transactions);
  const month = workspaceCashflowSummary(monthTransactions, selected.members);
  const columns = [...selected.members.map(member => ({ id: member.id, name: member.name, ...month.people.get(member.id)! })),
    { id: "total", name: "合計", ...month.total }];
  const unsettledShared = selected.transactions.filter((item) => item.expenseClass === "SHARED" && !item.settledAt);
  const shared = cashflowSummary(unsettledShared);
  const result = selected.settlement;
  const settlementUnavailable = selected.workspace.type === "PERSONAL"
    ? "清算は共有ワークスペースで利用できます"
    : selected.members.length < 2
      ? "相手を招待すると清算計算を利用できます"
      : !result ? "現在、清算対象の共有の支払い・収入はありません" : null;
  async function complete() {
    if (confirm("表示中の明細を清算済みにしますか？ 実際の送金は別途行ってください。")) {
      await run({ action: "completeSettlement", workspaceId: selected.workspace.id }, "清算を完了しました。");
    }
  }
  return <>
    <div className="home-actions page-actions">{refreshAction}<button className="primary" disabled={refreshing} onClick={add}>＋ 明細を追加</button></div>
    {pending > 0 && <button className="invite-alert" onClick={() => setTab("settings")}>あなた宛ての招待が{pending}件あります <span>確認する →</span></button>}
    <div className="kpi-grid">
      <article className="kpi home-month-summary">
        <table className="home-summary-table">
          <caption>今月の収支</caption>
          <thead><tr><td />{columns.map(column => <th scope="col" key={column.id}>{column.name}</th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">収入</th>{columns.map(column => <td key={column.id} className={cashflowClass(column.receiptTotal)}>{formatCashflow(column.receiptTotal)}</td>)}</tr>
            <tr><th scope="row">支出</th>{columns.map(column => <td key={column.id} className={cashflowClass(-column.paymentTotal)}>{formatCashflow(-column.paymentTotal)}</td>)}</tr>
            <tr><th scope="row">収支</th>{columns.map(column => <td key={column.id} className={cashflowClass(column.balanceYen)}>{formatCashflow(column.balanceYen)}</td>)}</tr>
          </tbody>
        </table>
        <p className="section-note">各ユーザーの個人収支と、共有の収支を配分した金額です。清算済み・当月の未来日付を含みます。</p>
      </article>
      <section className="settlement-hero">
        <span>次の清算</span>
        {settlementUnavailable ? <p>{settlementUnavailable}</p> : result && <>
          {result.amountYen > 0 ? <>
            <div className="people-flow"><b>{result.payerName}</b><i>→</i><b>{result.payeeName}</b></div>
            <strong>{formatYen(result.amountYen)}</strong>
            <p>{result.payerName}さんが{result.payeeName}さんへ支払うと、差額が解消されます。</p>
          </> : <><strong>清算不要</strong><p>現在の負担額に差はありません。</p></>}
          <button className="light-button" disabled={refreshing} onClick={complete}>清算を完了する</button>
        </>}
        <div className="unsettled-summary">
          <span>未清算の共有収支</span>
          <strong className={cashflowClass(shared.balanceYen)}>{formatCashflow(shared.balanceYen)}</strong>
          <small>{unsettledShared.length.toLocaleString("ja-JP")}件が対象</small>
        </div>
      </section>
    </div>
    <div className="content-grid">
      {!settlementUnavailable && result && <section className="panel allocation" aria-labelledby="allocation-title">
        <div className="panel-head"><div><span>ALLOCATION</span><h2 id="allocation-title">共有費配分</h2></div></div>
        <p className="section-note">明細ごとの配分割合で計算。精算額の＋は受け取り、−は支払いです。</p>
        <div className="allocation-table-wrap">
          <table className="allocation-table" aria-labelledby="allocation-title">
            <thead><tr><td />{result.people.map(person => <th scope="col" key={person.userId}>{person.name}</th>)}</tr></thead>
            <tbody>
              <tr><th scope="row">現在の収支</th>{result.people.map(person => <td className={cashflowClass(-person.actual)} key={person.userId}>{formatCashflow(-person.actual)}</td>)}</tr>
              <tr><th scope="row">配分後の収支</th>{result.people.map(person => <td className={cashflowClass(-person.target)} key={person.userId}>{formatCashflow(-person.target)}</td>)}</tr>
              <tr><th scope="row">精算額</th>{result.people.map(person => <td className={cashflowClass(person.balance)} key={person.userId}>{formatCashflow(person.balance)}</td>)}</tr>
            </tbody>
          </table>
        </div>
      </section>}
      <section className="panel quick"><div className="panel-head"><div><span>QUICK ACTIONS</span><h2>すぐにできること</h2></div></div>
        <button disabled={refreshing} onClick={add}><i>＋</i><span><b>明細を追加</b><small>支払いや収入を手動登録</small></span></button>
        <button onClick={() => setTab("import")}><i>⇩</i><span><b>PayPay CSVを取込</b><small>支払い明細をまとめて登録</small></span></button>
        <button onClick={() => setTab("analytics")}><i>▥</i><span><b>集計を見る</b><small>支出の内訳と月別の推移</small></span></button>
      </section>
    </div>
    {selected.settlementHistory.length > 0 && <section className="panel history"><div className="panel-head"><div><span>HISTORY</span><h2>清算履歴</h2></div></div>{selected.settlementHistory.map((item) => <div key={item.id}><span>{formatJstDateTime(item.completedAt)}</span><b>{item.payerName && item.payeeName ? `${item.payerName} → ${item.payeeName}` : "清算不要"}</b><strong>{formatYen(item.amountYen)}</strong></div>)}</section>}
  </>;
}

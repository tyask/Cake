"use client";

import { cashflowClass, formatCashflow, formatTransactionAmount, formatJstDateTime } from "@/lib/shared/display-formatters";
import { commonExpenseClassLabels } from "@/lib/shared/domain-values";
import { cashflowSummary, currentMonthTransactions } from "@/lib/shared/home-summary";
import type { DashboardTab as Tab } from "@/lib/shared/types";
import type { WorkspaceData } from "@/lib/shared/types";
import { Empty } from "./dashboard-ui";

export function HomePanel({ selected, pending, setTab, add, refreshAction, refreshing }: { selected: WorkspaceData; pending: number; setTab: (tab: Tab) => void; add: () => void; refreshAction: React.ReactNode; refreshing: boolean }) {
  const monthTransactions = currentMonthTransactions(selected.transactions);
  const month = cashflowSummary(monthTransactions);
  const unsettledShared = selected.transactions.filter((item) => item.expenseClass === "SHARED" && !item.settledAt);
  const shared = cashflowSummary(unsettledShared);
  return <>
    <div className="home-actions page-actions">{refreshAction}<button className="primary" disabled={refreshing} onClick={add}>＋ 明細を追加</button></div>
    {pending > 0 && <button className="invite-alert" onClick={() => setTab("settings")}>あなた宛ての招待が{pending}件あります <span>確認する →</span></button>}
    <div className="kpi-grid">
      <article className="kpi">
        <table className="home-summary-table">
          <caption>今月の収支</caption>
          <tbody>
            <tr><th scope="row">収入</th><td className={cashflowClass(month.receiptTotal)}>{formatCashflow(month.receiptTotal)}</td></tr>
            <tr><th scope="row">支出</th><td className={cashflowClass(-month.paymentTotal)}>{formatCashflow(-month.paymentTotal)}</td></tr>
            <tr><th scope="row">収支</th><td className={cashflowClass(month.balanceYen)}>{formatCashflow(month.balanceYen)}</td></tr>
            <tr><th scope="row">取引件数</th><td>{monthTransactions.length.toLocaleString("ja-JP")}件</td></tr>
          </tbody>
        </table>
      </article>
      <article className="kpi accent">
        <span>次の清算</span>
        {selected.settlement?.payerName && selected.settlement.payeeName ? <div className="next-settlement"><div className="settlement-person"><span className="settlement-avatar" aria-hidden="true">{Array.from(selected.settlement.payerName)[0]}</span><div><small>支払う人</small><b>{selected.settlement.payerName}</b></div></div><div className="settlement-transfer"><span className="settlement-arrow" aria-hidden="true">↓</span><strong>{selected.settlement.amountYen.toLocaleString("ja-JP")}<small>円</small></strong></div><div className="settlement-person"><span className="settlement-avatar payee" aria-hidden="true">{Array.from(selected.settlement.payeeName)[0]}</span><div><small>受け取る人</small><b>{selected.settlement.payeeName}</b></div></div></div> : <><strong>清算なし</strong><small>現在差額はありません</small></>}
        <div className="unsettled-summary">
          <span>未清算の共有収支</span>
          <strong className={cashflowClass(shared.balanceYen)}>{formatCashflow(shared.balanceYen)}</strong>
          <small>{unsettledShared.length.toLocaleString("ja-JP")}件が対象</small>
        </div>
      </article>
    </div>
    <div className="content-grid">
      <section className="panel recent"><div className="panel-head"><div><span>RECENT</span><h2>最近の取引</h2></div><button className="text-button" onClick={() => setTab("transactions")}>すべて見る →</button></div>
        <div className="recent-list">{selected.transactions.slice(0, 6).map((item) => <div className="recent-row" key={item.id}><span className="recent-name"><b>{item.merchant}</b><small>{formatJstDateTime(item.occurredAt)} · {item.actorName}</small></span><span className="recent-class">{commonExpenseClassLabels[item.expenseClass]}</span><strong className={item.type === "RECEIPT" ? "positive" : "negative"}>{formatTransactionAmount(item.type, item.amountYen)}</strong></div>)}{selected.transactions.length === 0 && <Empty text="まだ取引がありません" />}</div>
      </section>
      <section className="panel quick"><div className="panel-head"><div><span>QUICK ACTIONS</span><h2>すぐにできること</h2></div></div>
        <button disabled={refreshing} onClick={add}><i>＋</i><span><b>明細を追加</b><small>支払いや収入を手動登録</small></span></button>
        <button onClick={() => setTab("import")}><i>⇩</i><span><b>PayPay CSVを取込</b><small>支払い明細をまとめて登録</small></span></button>
        <button onClick={() => setTab("analytics")}><i>▥</i><span><b>集計を見る</b><small>支出の内訳と月別の推移</small></span></button>
        <button onClick={() => setTab("settlement")}><i>↔</i><span><b>清算を確認</b><small>ふたりの差額を計算</small></span></button>
      </section>
    </div>
  </>;
}

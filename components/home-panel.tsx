"use client";

import { useEffect, useRef, useState, type TouchEvent } from "react";
import { cashflowClass, formatCashflow, formatYen, formatJstDateTime } from "@/lib/shared/display-formatters";
import { homeMonth, isHomeMonth } from "@/lib/shared/home-summary";
import { addMonths } from "@/lib/shared/recurring-payment-calendar";
import type { RunAppAction } from "@/lib/shared/schemas/app-input";
import type { DashboardTab as Tab, WorkspaceMetadata } from "@/lib/shared/types";
import { useHomeData } from "./use-home-data";

export function HomePanel({ selected, pending, setTab, add, run, refreshAction, refreshing, revision = 0, suspended = false, registerRefresh }: {
  selected: WorkspaceMetadata; userId: string; pending: number; setTab: (tab: Tab) => void; add: () => void;
  run: RunAppAction; refreshAction: React.ReactNode; refreshing: boolean; revision?: number; suspended?: boolean;
  registerRefresh?: (refresh: (() => Promise<void>) | null) => void;
}) {
  const [selectedMonth, setSelectedMonth] = useState(() => homeMonth());
  const swipe = useRef<{ x: number; y: number; axis: "horizontal" | "vertical" | null } | null>(null);
  const currentMonth = homeMonth();
  const monthLabel = `${Number(selectedMonth.slice(0, 4))}年${Number(selectedMonth.slice(5))}月`;
  const { data, loading, error, refresh } = useHomeData(selected.workspace.id, selectedMonth, revision, !suspended);
  useEffect(() => {
    registerRefresh?.(refresh);
    return () => registerRefresh?.(null);
  }, [registerRefresh, refresh]);
  const members = data?.members ?? selected.members;
  const columns = [...members.map(member => {
    const summary = data?.monthly.people.find(person => person.userId === member.id);
    return { id: member.id, name: member.name, summary };
  }), { id: "total", name: "合計", summary: data?.monthly.total }];
  const shared = data?.unsettled;
  const result = data?.settlement;
  const settlementUnavailable = selected.workspace.type === "PERSONAL"
    ? "清算は共有ワークスペースで利用できます"
    : members.length < 2
      ? "相手を招待すると清算計算を利用できます"
      : data && !result ? "現在、清算対象の共有の支払い・収入はありません" : null;
  function changeMonth(offset: -1 | 1) {
    setSelectedMonth(value => {
      if ((value === "0001-01" && offset < 0) || (value === "9999-12" && offset > 0)) return value;
      return addMonths(`${value}-01`, offset).slice(0, 7);
    });
  }
  function touchStart(event: TouchEvent<HTMLElement>) {
    swipe.current = event.touches.length === 1 && !(event.target as Element).closest("button, input, label, select, a")
      ? { x: event.touches[0].clientX, y: event.touches[0].clientY, axis: null } : null;
  }
  function touchMove(event: TouchEvent<HTMLElement>) {
    if (event.touches.length !== 1) { swipe.current = null; return; }
    const start = swipe.current;
    if (!start || start.axis) return;
    const dx = Math.abs(event.touches[0].clientX - start.x), dy = Math.abs(event.touches[0].clientY - start.y);
    if (Math.max(dx, dy) >= 10) start.axis = dx > dy * 1.5 ? "horizontal" : "vertical";
  }
  function touchEnd(event: TouchEvent<HTMLElement>) {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.axis !== "horizontal" || event.touches.length || event.changedTouches.length !== 1) return;
    const dx = event.changedTouches[0].clientX - start.x, dy = event.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) changeMonth(dx < 0 ? 1 : -1);
  }
  async function complete() {
    if (confirm("全期間の未清算の共有明細を清算済みにしますか？ 実際の送金は別途行ってください。")) {
      await run({ action: "completeSettlement", workspaceId: selected.workspace.id }, "清算を完了しました。");
    }
  }
  return <>
    <div className="home-actions page-actions">{refreshAction}<button className="primary" disabled={refreshing} onClick={add}>＋ 明細を追加</button></div>
    {error && <div className="notice" role="alert">{error}<button type="button" disabled={refreshing} onClick={() => { void refresh().catch(() => {}); }}>再試行</button></div>}
    {pending > 0 && <button className="invite-alert" onClick={() => setTab("settings")}>あなた宛ての招待が{pending}件あります <span>確認する →</span></button>}
    <div className="kpi-grid">
      <article className="kpi home-month-summary" aria-busy={loading || suspended} onTouchStart={touchStart} onTouchMove={touchMove} onTouchEnd={touchEnd} onTouchCancel={() => { swipe.current = null; }}>
        <div className="home-month-navigation" role="group" aria-label="収支の対象月">
          <button type="button" className="secondary" aria-label="前の月" disabled={selectedMonth === "0001-01"} onClick={() => changeMonth(-1)}>‹</button>
          <label className="home-month-field">対象年月<input type="month" aria-label="収支の対象年月" min="0001-01" max="9999-12" required value={selectedMonth} onChange={event => {
            if (isHomeMonth(event.target.value)) setSelectedMonth(event.target.value);
          }} /></label>
          <button type="button" className="secondary" aria-label="次の月" disabled={selectedMonth === "9999-12"} onClick={() => changeMonth(1)}>›</button>
          <button type="button" className="secondary home-month-reset" aria-label="今月に戻る" disabled={selectedMonth === currentMonth} onClick={() => setSelectedMonth(homeMonth())}>今月</button>
        </div>
        <table className="home-summary-table">
          <caption aria-live="polite" aria-atomic="true">{monthLabel}の収支</caption>
          <thead><tr><td />{columns.map(column => <th scope="col" key={column.id}>{column.name}</th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">収入</th>{columns.map(column => <td key={column.id} className={column.summary ? cashflowClass(BigInt(column.summary.receiptTotal)) : undefined}>{column.summary ? formatCashflow(BigInt(column.summary.receiptTotal)) : "—"}</td>)}</tr>
            <tr><th scope="row">支出</th>{columns.map(column => <td key={column.id} className={column.summary ? cashflowClass(-BigInt(column.summary.paymentTotal)) : undefined}>{column.summary ? formatCashflow(-BigInt(column.summary.paymentTotal)) : "—"}</td>)}</tr>
            <tr><th scope="row">収支</th>{columns.map(column => <td key={column.id} className={column.summary ? cashflowClass(BigInt(column.summary.balanceYen)) : undefined}>{column.summary ? formatCashflow(BigInt(column.summary.balanceYen)) : "—"}</td>)}</tr>
          </tbody>
        </table>
        {loading && <p className="section-note" role="status">収支を読み込んでいます。</p>}
        <p className="section-note">各ユーザーの個人収支と、共有の収支を配分した金額です。清算済み・対象月の未来日付を含みます。</p>
        <p className="section-note home-month-hint">左右にスワイプして月を切り替えられます。</p>
      </article>
      <section className="settlement-hero">
        <span>次の清算</span>
        {settlementUnavailable ? <p>{settlementUnavailable}</p> : result && <>
          {result.amountYen > 0 ? <>
            <div className="people-flow"><b>{result.payerName}</b><i>→</i><b>{result.payeeName}</b></div>
            <strong>{formatYen(result.amountYen)}</strong>
            <p>{result.payerName}さんが{result.payeeName}さんへ支払うと、差額が解消されます。</p>
          </> : <><strong>清算不要</strong><p>現在の負担額に差はありません。</p></>}
          <button className="light-button" disabled={refreshing || loading || suspended} onClick={complete}>清算を完了する</button>
        </>}
        {!data && !settlementUnavailable && <p>{error ? "清算情報を取得できませんでした。" : "清算情報を読み込んでいます。"}</p>}
        <div className="unsettled-summary">
          <span>未清算の共有収支</span>
          <strong className={shared ? cashflowClass(BigInt(shared.balanceYen)) : undefined}>{shared ? formatCashflow(BigInt(shared.balanceYen)) : "—"}</strong>
          {shared && <small>{shared.count.toLocaleString("ja-JP")}件が対象</small>}
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
    {data && data.settlementHistory.length > 0 && <section className="panel history"><div className="panel-head"><div><span>HISTORY</span><h2>清算履歴</h2></div></div>{data.settlementHistory.map((item) => <div key={item.id}><span>{formatJstDateTime(item.completedAt)}</span><b>{item.payerName && item.payeeName ? `${item.payerName} → ${item.payeeName}` : "清算不要"}</b><strong>{formatYen(item.amountYen)}</strong></div>)}</section>}
  </>;
}

"use client";

import { formatYen, formatJstDateTime } from "@/lib/display-formatters";
import type { RunAppAction } from "@/lib/app-input";
import type { WorkspaceData } from "@/lib/types";
import { PageHeading, Empty } from "./dashboard-ui";

export function SettlementPanel({ selected, run, refreshAction, refreshing }: { selected: WorkspaceData; run: RunAppAction; refreshAction: React.ReactNode; refreshing: boolean }) {
  const result = selected.settlement;
  async function complete() { if (confirm("表示中の明細を清算済みにしますか？ 実際の送金は別途行ってください。")) await run({ action: "completeSettlement", workspaceId: selected.workspace.id }, "清算を完了しました。"); }
  return <>
    <PageHeading eyebrow="SETTLEMENT" title="共通費を清算" description="未清算の共通費から、ふたりの差額を計算します。" action={<div className="page-actions">{refreshAction}</div>} />
    {selected.workspace.type === "PERSONAL" ? <section className="panel"><Empty text="清算は共有ワークスペースで利用できます" /></section> : selected.members.length < 2 ? <section className="panel"><Empty text="相手を招待すると清算計算を利用できます" /></section> : !result ? <section className="panel"><Empty text="現在、清算対象の共通費はありません" /></section> : <>
      <section className="settlement-hero"><span>今回の清算</span>{result.amountYen > 0 ? <><div className="people-flow"><b>{result.payerName}</b><i>→</i><b>{result.payeeName}</b></div><strong>{formatYen(result.amountYen)}</strong><p>{result.payerName}さんが{result.payeeName}さんへ支払うと、差額が解消されます。</p></> : <><strong>清算不要</strong><p>現在の負担額に差はありません。</p></>}<button className="light-button" disabled={refreshing} onClick={complete}>清算を完了する</button></section>
      <div className="settlement-grid"><section className="panel"><div className="panel-head"><div><span>CALCULATION</span><h2>計算の内訳</h2></div></div><dl className="summary-list"><div><dt>共通支払い</dt><dd>{formatYen(result.paymentTotal)}</dd></div><div><dt>共通収入</dt><dd>− {formatYen(result.receiptTotal)}</dd></div><div className="total"><dt>正味共通費</dt><dd>{formatYen(result.netTotal)}</dd></div></dl></section><section className="panel"><div className="panel-head"><div><span>ALLOCATION</span><h2>ふたりの負担</h2></div></div>{result.people.map((person) => <div className="person-calc" key={person.userId}><div><b>{person.name}</b><span>明細ごとの割合で計算</span></div><p>実質負担 <b>{formatYen(person.actual)}</b></p><p>目標負担 <b>{formatYen(person.target)}</b></p><p className={person.balance >= 0 ? "positive" : "negative"}>差額 <b>{person.balance >= 0 ? "+" : ""}{formatYen(person.balance)}</b></p></div>)}</section></div>
    </>}
    {selected.settlementHistory.length > 0 && <section className="panel history"><div className="panel-head"><div><span>HISTORY</span><h2>清算履歴</h2></div></div>{selected.settlementHistory.map((item) => <div key={item.id}><span>{formatJstDateTime(item.completedAt)}</span><b>{item.payerName && item.payeeName ? `${item.payerName} → ${item.payeeName}` : "清算不要"}</b><strong>{formatYen(item.amountYen)}</strong></div>)}</section>}
  </>;
}

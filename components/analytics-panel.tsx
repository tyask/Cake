"use client";

import { lazy, Suspense, useId, useMemo, useState } from "react";
import { analyticsQuerySchema, analyticsToday, type AnalyticsQuery, type AnalyticsRange } from "@/lib/shared/analytics";
import { buildAnalyticsView, prepareAnalyticsDataset } from "@/lib/shared/analytics-view";
import { formatYen, formatJstDateTime } from "@/lib/shared/display-formatters";
import { PageHeading } from "./dashboard-ui";
import { useAnalytics } from "./use-analytics";
import styles from "./analytics-panel.module.css";

const AnalyticsCharts = lazy(() => import("./analytics-charts"));

export function analyticsRangeLabel(range: AnalyticsRange) {
  return `${range.from.replaceAll("-", "/")} ～ ${range.to.replaceAll("-", "/")}`;
}

export function AnalyticsPanel({ workspaceId, currentUserId, revision, active }: { workspaceId: string; currentUserId: string; revision: number; active: boolean }) {
  const modeName = useId();
  const today = analyticsToday();
  const currentMonth = today.slice(0, 7);
  const [periodMode, setPeriodMode] = useState<"month" | "range">("month");
  const [query, setQuery] = useState<AnalyticsQuery>(() => ({ workspaceId, period: "month", month: currentMonth }));
  const [draftMonth, setDraftMonth] = useState(currentMonth);
  const [draftFrom, setDraftFrom] = useState(`${currentMonth}-01`);
  const [draftTo, setDraftTo] = useState(today);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"self" | "shared">("self");
  const [depth, setDepth] = useState<number | "all">(1);
  const { data, loading, error, refresh } = useAnalytics(query, revision, active);
  const prepared = useMemo(() => data ? prepareAnalyticsDataset(data) : null, [data]);
  const view = useMemo(() => prepared && data ? buildAnalyticsView(prepared, {
    memberIds: viewMode === "self" ? [currentUserId] : data.members.map(member => member.id),
    expenseClasses: viewMode === "self" ? ["SHARED", "PERSONAL"] : ["SHARED"], depth,
  }) : null, [prepared, data, viewMode, currentUserId, depth]);
  const viewLabel = viewMode === "self" ? "自分の支出" : "共有費全体";
  const viewDescription = viewMode === "self"
    ? "共有費の自分の負担額と、自分の個人費を合計します。"
    : "共有費を支払者にかかわらず全額で集計します。個人費は含めません。";

  function applyPeriod(next: AnalyticsQuery) {
    const parsed = analyticsQuerySchema.safeParse(next);
    if (!parsed.success) { setPeriodError(parsed.error.issues[0]?.message ?? "期間を確認してください。"); return; }
    setPeriodError(null);
    setQuery(parsed.data);
  }

  return <div hidden={!active} className={styles.analytics}>
    <PageHeading eyebrow="ANALYTICS" title="支出の集計" description="家計の使いみちと、配分後の支出額の変化を確認します。"
      action={<button type="button" className={`refresh-button ${styles.refresh}`} disabled={loading} onClick={refresh}>↻ 更新</button>} />
    <section className={styles.conditions} aria-label="集計の表示条件">
      <div className={styles.periodGroup}>
        <label className={styles.field}>集計する期間<select aria-label="集計する期間" value={periodMode} onChange={event => {
          const mode = event.target.value as "month" | "range";
          setPeriodMode(mode);
          setPeriodError(null);
          if (mode === "month") applyPeriod({ workspaceId, period: "month", month: draftMonth });
        }}><option value="month">月を選択</option><option value="range">期間を指定</option></select></label>
        {periodMode === "month" && <label className={styles.field}>集計する月<input type="month" max={currentMonth} value={draftMonth} onChange={event => {
          setDraftMonth(event.target.value);
          applyPeriod({ workspaceId, period: "month", month: event.target.value });
        }} /></label>}
      </div>
      <label className={styles.field}>カテゴリの細かさ<select aria-label="カテゴリの細かさ" value={depth} onChange={event => setDepth(event.target.value === "all" ? "all" : Number(event.target.value))}>
        <option value="1">大分類</option>{Array.from({ length: Math.max(0, Math.max(prepared?.maxDepth ?? 1, depth === "all" ? 1 : depth) - 1) }, (_, index) => index + 2).map(level => <option key={level} value={level}>{level}階層まで</option>)}<option value="all">全階層</option>
      </select></label>
      <fieldset className={styles.checkGroup}><legend>表示対象</legend><div className={styles.checks}>
        <label><input type="radio" name={modeName} value="self" checked={viewMode === "self"} onChange={() => setViewMode("self")} />自分の支出</label>
        <label><input type="radio" name={modeName} value="shared" checked={viewMode === "shared"} onChange={() => setViewMode("shared")} />共有費全体</label>
      </div></fieldset>
      {periodMode === "range" && <form className={styles.customDates} onSubmit={event => { event.preventDefault(); applyPeriod({ workspaceId, period: "range", from: draftFrom, to: draftTo }); }}>
        <label className={styles.field}>開始日<input type="date" max={today} value={draftFrom} onChange={event => setDraftFrom(event.target.value)} required /></label>
        <span aria-hidden="true">～</span><label className={styles.field}>終了日<input type="date" max={today} value={draftTo} onChange={event => setDraftTo(event.target.value)} required /></label>
        <button type="submit">この期間で表示</button>
      </form>}
      {periodError && <p className={styles.periodError} role="alert">{periodError}</p>}
    </section>
    <p className={styles.scopeNote}>{viewDescription} 清算済みの明細を含みます。収入は集計対象外です。</p>
    {loading && <div role="status" className={styles.empty}>集計を読み込んでいます…</div>}
    {error && <div role="alert" className={styles.error}><p>{error}</p><button type="button" onClick={refresh}>再試行</button></div>}
    {view && data && !loading && !error && <>
      <div className={styles.selectionLine}><span>対象期間 <b>{analyticsRangeLabel(data.periods.current)}</b></span><span>比較期間 <b>{analyticsRangeLabel(data.periods.comparison)}</b></span></div>
      <div className={styles.stats} aria-label="支出額の概要">
        <article className={`${styles.stat} ${styles.primaryStat}`}><span>{viewLabel}</span><strong data-testid="analytics-total">{formatYen(view.totalYen)}</strong><small>{viewMode === "self" ? "共有費の自分の負担額＋自分の個人費" : "共有費のみ・全員分の全額"}</small></article>
        <article className={styles.stat}><span>比較期間の支出額</span><strong>{formatYen(view.comparisonYen)}</strong><small>{analyticsRangeLabel(data.periods.comparison)}</small></article>
        <article className={styles.stat}><span>比較期間との差額</span><strong data-testid="analytics-difference">{view.differenceYen > BigInt(0) ? "+" : ""}{formatYen(view.differenceYen)}</strong><small>{view.differenceYen > BigInt(0) ? "支出が増加" : view.differenceYen < BigInt(0) ? "支出が減少" : "支出の増減なし"} · {view.rate ? `支出の増減率 ${view.rate}` : view.totalYen > BigInt(0) ? "比較期間は0円" : "比較期間も0円"}</small></article>
      </div>
      <Suspense fallback={<div role="status" className={styles.empty}>グラフを準備しています…</div>}><AnalyticsCharts view={view} periods={data.periods} /></Suspense>
      <p className={styles.snapshot}>取得日時 {formatJstDateTime(data.snapshotAt)}（日本時間）</p>
    </>}
  </div>;
}

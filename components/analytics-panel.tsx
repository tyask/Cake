"use client";

import { lazy, Suspense, useMemo, useState } from "react";
import { analyticsQuerySchema, analyticsToday, type AnalyticsDataset, type AnalyticsQuery, type AnalyticsRange, type AnalyticsRow, type AnalyticsView } from "@/lib/shared/analytics";
import { ANALYTICS_UNCLASSIFIED_ID, buildAnalyticsView, prepareAnalyticsDataset } from "@/lib/shared/analytics-view";
import { cashflowClass, formatCashflow, formatYen, formatJstDateTime } from "@/lib/shared/display-formatters";
import type { ExpenseClass } from "@/lib/shared/types";
import { PageHeading } from "./dashboard-ui";
import { AnalyticsCategoryFilter } from "./analytics-category-filter";
import { AnalyticsTransactionsDialog } from "./analytics-transactions-dialog";
import { useAnalytics } from "./use-analytics";
import { useAnalyticsFilters } from "./use-analytics-filters";
import styles from "./analytics-panel.module.css";

const AnalyticsCharts = lazy(() => import("./analytics-charts"));

export function analyticsRangeLabel(range: AnalyticsRange) {
  return `${range.from.replaceAll("-", "/")} ～ ${range.to.replaceAll("-", "/")}`;
}

export function AnalyticsPanel({ workspaceId, currentUserId, revision, active }: { workspaceId: string; currentUserId: string; revision: number; active: boolean }) {
  const today = analyticsToday();
  const currentMonth = today.slice(0, 7);
  const [filters, setFilters, ready] = useAnalyticsFilters(currentUserId, workspaceId);
  const { includeIncome, expenseClasses, categoryIds, depth } = filters;
  const query: AnalyticsQuery = { workspaceId, ...(filters.period ?? { period: "month", month: currentMonth }) };
  const periodKey = JSON.stringify([currentUserId, query]);
  const [previousPeriodKey, setPreviousPeriodKey] = useState(periodKey);
  const [periodMode, setPeriodMode] = useState(query.period);
  const [draftMonth, setDraftMonth] = useState(query.period === "month" ? query.month : currentMonth);
  const [draftFrom, setDraftFrom] = useState(query.period === "range" ? query.from : `${currentMonth}-01`);
  const [draftTo, setDraftTo] = useState(query.period === "range" ? query.to : today);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [categoryFilterOpen, setCategoryFilterOpen] = useState(false);
  const [details, setDetails] = useState<{ row: AnalyticsRow; data: AnalyticsDataset; view: AnalyticsView } | null>(null);
  // Restore committed dates after hydration or another tab's update, keeping drafts local.
  if (previousPeriodKey !== periodKey) {
    setPreviousPeriodKey(periodKey);
    setPeriodMode(query.period);
    if (query.period === "month") setDraftMonth(query.month);
    else { setDraftFrom(query.from); setDraftTo(query.to); }
    setPeriodError(null);
  }
  const { data, loading, error, refresh } = useAnalytics(query, revision, active && ready);
  const prepared = useMemo(() => data ? prepareAnalyticsDataset(data) : null, [data]);
  const memberIds = useMemo(() => filters.memberIds ?? data?.members.map(member => member.id) ?? [], [filters.memberIds, data?.members]);
  const classSelectionEmpty = expenseClasses.length === 0 && !includeIncome;
  const memberSelectionEmpty = data !== null && !data.members.some(member => memberIds.includes(member.id));
  const categorySelectionEmpty = prepared !== null && categoryIds !== null
    && !categoryIds.some(id => id === ANALYTICS_UNCLASSIFIED_ID || prepared.categories.has(id));
  const view = useMemo(() => prepared && data && !classSelectionEmpty && !memberSelectionEmpty && !categorySelectionEmpty ? buildAnalyticsView(prepared, {
    memberIds, expenseClasses: expenseClasses, incomeExpenseClasses: includeIncome ? ["SHARED", "PERSONAL"] : [], depth, categoryIds: categoryIds ?? undefined,
  }) : null, [prepared, data, memberIds, expenseClasses, includeIncome, depth, categoryIds, classSelectionEmpty, memberSelectionEmpty, categorySelectionEmpty]);
  const viewDescription = "選択したユーザーについて、チェックした内容を集計します。共有費は配分後の金額、個人費は本人の全額が対象です。";
  // A changed view or snapshot invalidates both the dialog and its pending request.
  if (details && (details.data !== data || details.view !== view || !active || loading || error)) setDetails(null);
  const detailSelection = useMemo(() => details ? ({ rowId: details.row.id, depth, categoryIds, memberIds, expenseClasses: expenseClasses }) : null,
    [details, depth, categoryIds, memberIds, expenseClasses]);

  function toggleClass(expenseClass: ExpenseClass, checked: boolean) {
    setFilters(current => ({ ...current, expenseClasses: checked ? [...current.expenseClasses, expenseClass] : current.expenseClasses.filter(value => value !== expenseClass) }));
  }

  function applyPeriod(next: AnalyticsQuery) {
    const parsed = analyticsQuerySchema.safeParse(next);
    if (!parsed.success) { setPeriodError(parsed.error.issues[0]?.message ?? "期間を確認してください。"); return; }
    setPeriodError(null);
    const period = parsed.data.period === "month" ? { period: "month" as const, month: parsed.data.month }
      : { period: "range" as const, from: parsed.data.from, to: parsed.data.to };
    setFilters(current => ({ ...current, period }));
  }

  return <div hidden={!active} className={styles.analytics}>
    <PageHeading eyebrow="ANALYTICS" title="収支の集計" description="ユーザーを選んで、収入・支出と使いみちを確認します。"
      action={<button type="button" className={`refresh-button ${styles.refresh}`} disabled={loading} onClick={() => { setDetails(null); refresh(); }}>↻ 更新</button>} />
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
      <label className={styles.field}>カテゴリの細かさ<select aria-label="カテゴリの細かさ" value={depth} onChange={event => {
        const nextDepth = event.target.value === "all" ? "all" : Number(event.target.value);
        setFilters(current => ({ ...current, depth: nextDepth }));
      }}>
        <option value="1">大分類</option>{Array.from({ length: Math.max(0, (prepared?.maxDepth ?? 1) - 1) }, (_, index) => index + 2).map(level => <option key={level} value={level}>{level}階層まで</option>)}
        {depth !== "all" && depth > (prepared?.maxDepth ?? 1) && <option value={depth}>{depth}階層まで</option>}<option value="all">全階層</option>
      </select></label>
      <fieldset className={styles.checkGroup}><legend>表示対象</legend><div className={styles.checks}>
        {data?.members.map(member => <label key={member.id}><input type="checkbox" checked={memberIds.includes(member.id)} onChange={event => {
          const checked = event.target.checked;
          setFilters(current => {
            const ids = current.memberIds ?? data.members.map(value => value.id);
            return { ...current, memberIds: checked ? [...ids, member.id] : ids.filter(id => id !== member.id) };
          });
        }} />{member.name}</label>)}
      </div></fieldset>
      <fieldset className={styles.checkGroup}><legend>収支に含める内容</legend><div className={styles.checks}>
        <label><input type="checkbox" checked={includeIncome} onChange={event => {
          const checked = event.target.checked;
          setFilters(current => ({ ...current, includeIncome: checked }));
        }} />収入</label>
        <label><input type="checkbox" checked={expenseClasses.includes("SHARED")} onChange={event => toggleClass("SHARED", event.target.checked)} />共有費</label>
        <label><input type="checkbox" checked={expenseClasses.includes("PERSONAL")} onChange={event => toggleClass("PERSONAL", event.target.checked)} />個人費</label>
      </div></fieldset>
      {prepared && <AnalyticsCategoryFilter prepared={prepared} selectedIds={categoryIds} onChange={ids => setFilters(current => ({ ...current, categoryIds: ids }))} open={categoryFilterOpen} onOpenChange={setCategoryFilterOpen} />}
      {periodMode === "range" && <form className={styles.customDates} onSubmit={event => { event.preventDefault(); applyPeriod({ workspaceId, period: "range", from: draftFrom, to: draftTo }); }}>
        <label className={styles.field}>開始日<input type="date" max={today} value={draftFrom} onChange={event => setDraftFrom(event.target.value)} required /></label>
        <span aria-hidden="true">～</span><label className={styles.field}>終了日<input type="date" max={today} value={draftTo} onChange={event => setDraftTo(event.target.value)} required /></label>
        <button type="submit">この期間で表示</button>
      </form>}
      {periodError && <p className={styles.periodError} role="alert">{periodError}</p>}
    </section>
    <p className={styles.scopeNote}>{viewDescription} 選択したカテゴリの金額が対象です。清算済みの明細を含みます。</p>
    {loading && <div role="status" className={styles.empty}>集計を読み込んでいます…</div>}
    {error && <div role="alert" className={styles.error}><p>{error}</p><button type="button" onClick={refresh}>再試行</button></div>}
    {memberSelectionEmpty && data && !loading && !error && <div role="status" className={styles.empty}>表示対象のユーザーを1人以上選んでください。</div>}
    {classSelectionEmpty && data && !loading && !error && <div role="status" className={styles.empty}>収支に含める内容を1つ以上選んでください。</div>}
    {categorySelectionEmpty && data && !loading && !error && <div role="status" className={styles.empty}>集計に含めるカテゴリを1つ以上選んでください。</div>}
    {view && data && !loading && !error && <>
      <div className={styles.selectionLine}><span>対象期間 <b>{analyticsRangeLabel(data.periods.current)}</b></span><span>比較期間 <b>{analyticsRangeLabel(data.periods.comparison)}</b></span></div>
      <section className={styles.summary} aria-label="収支の概要">
        <table className={styles.summaryTable}><caption>対象期間の収支</caption><tbody>
          {includeIncome && <tr><th scope="row">収入</th><td><span data-testid="analytics-income" className={cashflowClass(view.cashflow.incomeYen) || undefined}>{formatCashflow(view.cashflow.incomeYen)}</span></td></tr>}
          <tr><th scope="row">支出</th><td><span data-testid="analytics-total" className={cashflowClass(-view.cashflow.expenseYen) || undefined}>{formatCashflow(-view.cashflow.expenseYen)}</span></td></tr>
          {includeIncome && <tr><th scope="row">収支</th><td><span data-testid="analytics-balance" className={cashflowClass(view.cashflow.balanceYen) || undefined}>{formatCashflow(view.cashflow.balanceYen)}</span></td></tr>}
        </tbody></table>
        <p className={styles.summaryNote}>支出の前期間差額 <b data-testid="analytics-difference">{view.differenceYen > BigInt(0) ? "+" : ""}{formatYen(view.differenceYen)}</b>（{view.differenceYen > BigInt(0) ? "支出が増加" : view.differenceYen < BigInt(0) ? "支出が減少" : "支出の増減なし"} · {view.rate ? `支出の増減率 ${view.rate}` : view.totalYen > BigInt(0) ? "比較期間は0円" : "比較期間も0円"}）</p>
      </section>
      <p className={styles.scopeNote}>{includeIncome ? "月次は収入・支出・収支を" : "月次は支出を"}、カテゴリ別の内訳と前期間差分は支出を表示します。</p>
      <Suspense fallback={<div role="status" className={styles.empty}>グラフを準備しています…</div>}><AnalyticsCharts view={view} periods={data.periods} includeIncome={includeIncome}
        onCategoryClick={row => setDetails({ row, data, view })} /></Suspense>
      <p className={styles.snapshot}>取得日時 {formatJstDateTime(data.snapshotAt)}（日本時間）</p>
    </>}
    {details && detailSelection && prepared && <AnalyticsTransactionsDialog data={details.data} prepared={prepared} row={details.row}
      selection={detailSelection} close={() => setDetails(null)} />}
  </div>;
}

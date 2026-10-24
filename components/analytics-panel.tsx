"use client";

import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { analyticsQuerySchema, analyticsToday, type AnalyticsQuery, type AnalyticsRange } from "@/lib/shared/analytics";
import { buildAnalyticsView, prepareAnalyticsDataset } from "@/lib/shared/analytics-view";
import { formatYen, formatJstDateTime } from "@/lib/shared/display-formatters";
import { expenseClassLabels, expenseClasses } from "@/lib/shared/domain-values";
import type { ExpenseClass } from "@/lib/shared/types";
import { PageHeading } from "./dashboard-ui";
import { useAnalytics } from "./use-analytics";
import styles from "./analytics-panel.module.css";

const AnalyticsCharts = lazy(() => import("./analytics-charts"));
const burdenDescription = "選んだ人の、明細ごとに割り当てられた支出額を合計します";
const displayedExpenseClasses = [...expenseClasses].reverse();

export function analyticsRangeLabel(range: AnalyticsRange) {
  return `${range.from.replaceAll("-", "/")} ～ ${range.to.replaceAll("-", "/")}`;
}

function MemberHelp() {
  const id = useId();
  const container = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const keepInViewport = () => {
      const element = tooltip.current;
      if (!element) return;
      element.style.transform = "";
      const bounds = element.getBoundingClientRect();
      const left = Math.max(16, Math.min(bounds.left, document.documentElement.clientWidth - 16 - bounds.width));
      element.style.transform = `translateX(${left - bounds.left}px)`;
    };
    keepInViewport();
    window.addEventListener("resize", keepInViewport);
    return () => { window.removeEventListener("resize", keepInViewport); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return <span ref={container} className={styles.memberHelp}
    onPointerEnter={event => { if (event.pointerType === "mouse") setOpen(true); }}
    onPointerLeave={event => { if (event.pointerType === "mouse" && !event.currentTarget.contains(document.activeElement)) setOpen(false); }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <span tabIndex={0} className={styles.helpLabel} aria-describedby={open ? id : undefined}
      onFocus={event => { if (event.currentTarget.matches(":focus-visible")) setOpen(true); }}>対象者</span>
    <button type="button" className={styles.helpInfo} aria-label="対象者の説明" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>ⓘ</button>
    {open && <span ref={tooltip} id={id} role="tooltip" className={styles.helpTooltip}>{burdenDescription}</span>}
  </span>;
}

export function AnalyticsPanel({ workspaceId, revision, active }: { workspaceId: string; revision: number; active: boolean }) {
  const today = analyticsToday();
  const currentMonth = today.slice(0, 7);
  const [periodMode, setPeriodMode] = useState<"month" | "range">("month");
  const [query, setQuery] = useState<AnalyticsQuery>(() => ({ workspaceId, period: "month", month: currentMonth }));
  const [draftMonth, setDraftMonth] = useState(currentMonth);
  const [draftFrom, setDraftFrom] = useState(`${currentMonth}-01`);
  const [draftTo, setDraftTo] = useState(today);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState<string[] | null>(null);
  const [classes, setClasses] = useState<ExpenseClass[]>([...expenseClasses]);
  const [depth, setDepth] = useState<number | "all">(1);
  const { data, loading, error, refresh } = useAnalytics(query, revision, active);
  const prepared = useMemo(() => data ? prepareAnalyticsDataset(data) : null, [data]);
  const selectedMembers = useMemo(() => data?.members.filter(member => memberIds === null || memberIds.includes(member.id)).map(member => member.id) ?? [], [data, memberIds]);
  const selectionEmpty = data !== null && (selectedMembers.length === 0 || classes.length === 0);
  const view = useMemo(() => prepared && !selectionEmpty ? buildAnalyticsView(prepared, {
    memberIds: selectedMembers, expenseClasses: classes, depth,
  }) : null, [prepared, selectedMembers, classes, depth, selectionEmpty]);

  function applyPeriod(next: AnalyticsQuery) {
    const parsed = analyticsQuerySchema.safeParse(next);
    if (!parsed.success) { setPeriodError(parsed.error.issues[0]?.message ?? "期間を確認してください。"); return; }
    setPeriodError(null);
    setQuery(parsed.data);
  }
  function toggleMember(id: string, checked: boolean) {
    const current = memberIds ?? data?.members.map(member => member.id) ?? [];
    setMemberIds(checked ? [...new Set([...current, id])] : current.filter(member => member !== id));
  }
  function toggleClass(expenseClass: ExpenseClass, checked: boolean) {
    setClasses(current => checked ? [...current, expenseClass] : current.filter(value => value !== expenseClass));
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
      <fieldset className={styles.checkGroup}><legend><MemberHelp /></legend><div className={styles.checks}>
        {data?.members.map(member => <label key={member.id}><input type="checkbox" checked={memberIds === null || memberIds.includes(member.id)} onChange={event => toggleMember(member.id, event.target.checked)} />{member.name}</label>)}
        {!data && <span className={styles.muted}>読込後に表示</span>}
      </div></fieldset>
      <fieldset className={styles.checkGroup}><legend>集計対象</legend><div className={styles.checks}>
        {displayedExpenseClasses.map(expenseClass => <label key={expenseClass}><input type="checkbox" checked={classes.includes(expenseClass)} onChange={event => toggleClass(expenseClass, event.target.checked)} />{expenseClassLabels[expenseClass]}</label>)}
      </div></fieldset>
      {periodMode === "range" && <form className={styles.customDates} onSubmit={event => { event.preventDefault(); applyPeriod({ workspaceId, period: "range", from: draftFrom, to: draftTo }); }}>
        <label className={styles.field}>開始日<input type="date" max={today} value={draftFrom} onChange={event => setDraftFrom(event.target.value)} required /></label>
        <span aria-hidden="true">～</span><label className={styles.field}>終了日<input type="date" max={today} value={draftTo} onChange={event => setDraftTo(event.target.value)} required /></label>
        <button type="submit">この期間で表示</button>
      </form>}
      {periodError && <p className={styles.periodError} role="alert">{periodError}</p>}
    </section>
    <p className={styles.scopeNote}>支払いを配分割合で分けた支出額を集計します。清算済みの明細を含みます。収入は集計対象外です。</p>
    {loading && <div role="status" className={styles.empty}>集計を読み込んでいます…</div>}
    {error && <div role="alert" className={styles.error}><p>{error}</p><button type="button" onClick={refresh}>再試行</button></div>}
    {selectionEmpty && !loading && !error && <div role="status" className={styles.empty}>対象者と集計対象をそれぞれ1つ以上選んでください。</div>}
    {view && data && !loading && !error && <>
      <div className={styles.selectionLine}><span>対象期間 <b>{analyticsRangeLabel(data.periods.current)}</b></span><span>比較期間 <b>{analyticsRangeLabel(data.periods.comparison)}</b></span></div>
      <div className={styles.stats} aria-label="支出額の概要">
        <article className={`${styles.stat} ${styles.primaryStat}`}><span>支出額</span><strong data-testid="analytics-total">{formatYen(view.totalYen)}</strong><small>{data.members.filter(member => selectedMembers.includes(member.id)).map(member => member.name).join("・")}の合計</small></article>
        <article className={styles.stat}><span>比較期間の支出額</span><strong>{formatYen(view.comparisonYen)}</strong><small>{analyticsRangeLabel(data.periods.comparison)}</small></article>
        <article className={styles.stat}><span>比較期間との差額</span><strong data-testid="analytics-difference">{view.differenceYen > BigInt(0) ? "+" : ""}{formatYen(view.differenceYen)}</strong><small>{view.differenceYen > BigInt(0) ? "支出が増加" : view.differenceYen < BigInt(0) ? "支出が減少" : "支出の増減なし"} · {view.rate ? `支出の増減率 ${view.rate}` : view.totalYen > BigInt(0) ? "比較期間は0円" : "比較期間も0円"}</small></article>
      </div>
      <Suspense fallback={<div role="status" className={styles.empty}>グラフを準備しています…</div>}><AnalyticsCharts view={view} periods={data.periods} /></Suspense>
      <p className={styles.snapshot}>取得日時 {formatJstDateTime(data.snapshotAt)}（日本時間）</p>
    </>}
  </div>;
}

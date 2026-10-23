"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type LabelProps } from "recharts";
import { barAmountPosition, CHART_AMOUNT_FONT_FAMILY, CHART_AMOUNT_FONT_SIZE, CHART_AMOUNT_FONT_WEIGHT, CHART_CALLOUT_GAP, createChartAmountMeasurer, type ChartAmountLabel, type ChartAmountPosition } from "@/lib/client/analytics-chart-labels";
import { analyticsChangeRate, type AnalyticsDataset, type AnalyticsRow, type AnalyticsView } from "@/lib/shared/analytics";
import { formatYen } from "@/lib/shared/display-formatters";
import { CategoryPie, prepareTrendCallouts, TrendCallouts } from "./analytics-chart-callouts";
import styles from "./analytics-panel.module.css";

const compactYen = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 });
const chartStyle = { fontSize: 11, fontFamily: "inherit", fill: "var(--muted)" };
function analyticsRangeLabel(range: { from: string; to: string }) { return `${range.from.replaceAll("-", "/")} ～ ${range.to.replaceAll("-", "/")}`; }

function share(value: bigint, total: bigint) {
  if (total === BigInt(0)) return "0.0%";
  const tenths = (value * BigInt(1000) * BigInt(2) + total) / (total * BigInt(2));
  return `${tenths / BigInt(10)}.${tenths % BigInt(10)}%`;
}
function signed(value: bigint) { return `${value > BigInt(0) ? "+" : ""}${formatYen(value)}`; }
function monthLabel(month: string) { return `${Number(month.slice(5))}月`; }
function CategoryName({ row }: { row: AnalyticsRow }) {
  return <span className={styles.categoryName}><i style={{ backgroundColor: row.colorHex }} aria-hidden="true" /><span>{row.label}</span></span>;
}

function DifferenceAmountLabel({ label, position, categoryId }: {
  label: ChartAmountLabel | null; position: ChartAmountPosition | null; categoryId: string;
}) {
  if (!label || !position) return null;
  return <text x={position.x} y={position.y} textAnchor="middle" dominantBaseline="central"
    fill={label.color} fontSize={CHART_AMOUNT_FONT_SIZE} fontFamily={CHART_AMOUNT_FONT_FAMILY} fontWeight={CHART_AMOUNT_FONT_WEIGHT}
    aria-hidden="true" pointerEvents="none" data-analytics-amount="difference" data-category-id={categoryId}>{label.text}</text>;
}

function donutCenterLayout(totalText: string, innerRadius: number) {
  const measure = createChartAmountMeasurer();
  // A square inscribed in the inner circle keeps every corner away from the ring.
  const side = Math.max(0, (innerRadius - 6) * Math.SQRT2);
  const titleHeight = 14, gap = 6;
  const groups = totalText.match(/[^,]+,?/g) ?? [totalText];
  for (const wrap of [false, true]) for (let fontSize = 24; fontSize >= 12; fontSize--) {
    const lineHeight = Math.ceil(fontSize * 1.2);
    const lines: string[] = [];
    let line = "";
    let fits = true;
    for (const group of wrap ? groups : [totalText]) {
      const size = measure(line + group, "#fffef8", fontSize);
      if (!size || size.width > side) {
        if (!wrap || !line) { fits = false; break; }
        lines.push(line);
        line = group;
        if ((measure(line, "#fffef8", fontSize)?.width ?? Infinity) > side
          || titleHeight + gap + (lines.length + 1) * lineHeight > side) { fits = false; break; }
      } else line += group;
    }
    if (!fits) continue;
    if (line) lines.push(line);
    const height = titleHeight + gap + lines.length * lineHeight;
    if (height <= side) return { fontSize, lineHeight, lines, height, titleHeight, gap };
  }
  // The full amount remains available in the summary and table above the 12px floor.
  return { fontSize: 12, lineHeight: 15, lines: [], height: titleHeight, titleHeight, gap };
}

function DonutCenter({ viewBox, totalText }: LabelProps & { totalText: string }) {
  const polar = viewBox && "cx" in viewBox && "innerRadius" in viewBox ? viewBox : null;
  const innerRadius = polar?.innerRadius ?? 0;
  const layout = useMemo(() => donutCenterLayout(totalText, innerRadius), [innerRadius, totalText]);
  if (!polar || innerRadius < 20) return null;
  const { cx, cy } = polar;
  const top = cy - layout.height / 2;
  return <g data-analytics-center="total" data-inner-radius={innerRadius} data-outer-radius={polar.outerRadius} data-center-x={cx} data-center-y={cy}
    aria-hidden="true" pointerEvents="none" fill="var(--ink)" fontFamily={CHART_AMOUNT_FONT_FAMILY} fontWeight={CHART_AMOUNT_FONT_WEIGHT} textAnchor="middle">
    <text x={cx} y={top + layout.titleHeight / 2} dominantBaseline="central" fontSize={10} fill="var(--muted)">合計</text>
    {layout.lines.length > 0 && <text data-analytics-center-amount="true" dominantBaseline="central" fontSize={layout.fontSize}>
      {layout.lines.map((line, index) => <tspan key={index} x={cx} y={top + layout.titleHeight + layout.gap + layout.lineHeight * (index + .5)}>{line}</tspan>)}
    </text>}
  </g>;
}

type TipItem = { name?: string | number; dataKey?: string | number; payload?: { row?: AnalyticsRow; monthIndex?: number } };
function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: readonly TipItem[]; label?: string | number }) {
  if (!active || !payload?.length) return null;
  return <div className={styles.chartTooltip}>{label !== undefined && <b>{label}</b>}{payload.map((item, index) => {
    const row = item.payload?.row;
    if (!row) return null;
    const monthIndex = item.payload?.monthIndex;
    const value = item.dataKey === "difference" ? row.currentYen - row.comparisonYen
      : monthIndex === undefined ? row.currentYen : row.monthlyYen[monthIndex];
    return <p key={index}><span>{row.label}</span><strong>{item.dataKey === "difference" ? signed(value) : formatYen(value)}</strong></p>;
  })}</div>;
}

export default function AnalyticsCharts({ view, periods }: { view: AnalyticsView; periods: AnalyticsDataset["periods"] }) {
  // Floating point values are graph coordinates only; every amount and ratio label uses bigint.
  const labels = useMemo(() => {
    const measure = createChartAmountMeasurer();
    return new Map(view.chartRows.map(row => [row.id, measure(signed(row.currentYen - row.comparisonYen), row.colorHex)]));
  }, [view]);
  // Keep the shared ranking of the other charts and tables; only the pie follows current amounts.
  const composition = useMemo(() => view.chartRows.filter(row => row.currentYen > BigInt(0))
    .sort((a, b) => a.currentYen === b.currentYen ? 0 : a.currentYen > b.currentYen ? -1 : 1), [view]);
  const trend = useMemo(() => view.months.map((month, monthIndex) => {
    const point: Record<string, string | number | AnalyticsRow> = { month, monthIndex };
    view.chartRows.forEach((row, index) => { point[`category${index}`] = Number(row.monthlyYen[monthIndex]); });
    return point;
  }), [view]);
  const differences = useMemo(() => view.chartRows.map(row => ({ row, label: row.label, difference: Number(row.currentYen - row.comparisonYen) })), [view]);
  const monthlyTotals = useMemo(() => view.months.map((_, index) => view.rows.reduce((sum, row) => sum + row.monthlyYen[index], BigInt(0))), [view]);
  const hasTrend = monthlyTotals.some(value => value > BigInt(0));
  const trendCallouts = useMemo(() => prepareTrendCallouts(view), [view]);
  const trendScroll = useRef<HTMLDivElement>(null);
  const trendPeriod = view.months.join(",");
  useLayoutEffect(() => {
    const container = trendScroll.current;
    if (container) container.scrollLeft = container.scrollWidth;
  }, [trendPeriod, hasTrend]);
  const trendHeight = Math.max(300, ...trendCallouts.map(month => month.entries.reduce((sum, entry) => sum + entry.text.height + CHART_CALLOUT_GAP, 0) + 64));
  const trendKey = view.months.join(",") + view.chartRows.map(row => `${row.id}:${row.label}:${row.colorHex}:${row.monthlyYen.join(",")}`).join("|");

  return <>
    <div className={styles.chartGrid}>
      <section className={styles.card} aria-labelledby="analytics-composition-heading"><div className={styles.cardHeading}><h2 id="analytics-composition-heading">カテゴリ別の内訳</h2><span>負担額</span></div>
        <p className={styles.cardSubtitle}>{analyticsRangeLabel(periods.current)}</p>
        <div className={styles.compositionBody}>
          {view.totalYen > BigInt(0) ? <CategoryPie rows={composition} center={<DonutCenter totalText={formatYen(view.totalYen)} />} /> : <p className={styles.chartEmpty}>この期間の負担額はありません。</p>}
          <ul className={styles.categoryList} aria-label="全カテゴリの負担額と割合">{view.rows.map(row => <li key={row.id}><CategoryName row={row} /><strong>{formatYen(row.currentYen)}</strong><span>{share(row.currentYen, view.totalYen)}</span></li>)}</ul>
        </div>
        <p className={styles.miniNote}>グラフは主な8カテゴリを表示し、残りは「その他」にまとめます。未分類は別に表示します。</p>
      </section>
      <section className={styles.card} aria-labelledby="analytics-trend-heading"><div className={styles.cardHeading}><h2 id="analytics-trend-heading">月ごとの推移</h2><span>直近6か月</span></div>
        <p className={styles.cardSubtitle}>{analyticsRangeLabel(periods.trend)}<br />終了月までの6か月を表示します。</p>
        {hasTrend ? <div ref={trendScroll} className={styles.trendScroll} tabIndex={0} role="group" aria-label="月ごとのグラフ（横スクロールで各月のカテゴリ名と金額を確認できます）"><div className={styles.trendChart} style={{ width: Math.max(1, view.months.length) * 240 + 44, height: trendHeight }} role="group" aria-label="月ごとのカテゴリ別負担額。下の表でも確認できます。">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart key={trendKey} data={trend} accessibilityLayer margin={{ top: 16, right: 8, bottom: 8, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="3 4" />
            <XAxis dataKey="month" scale="point" padding={{ left: 20, right: 176 }} interval={0} tickFormatter={monthLabel} axisLine={false} tickLine={false} tick={chartStyle} />
            <YAxis width={44} axisLine={false} tickLine={false} tick={chartStyle} tickFormatter={value => compactYen.format(Number(value))} />
            <Tooltip content={({ active, payload, label }) => active && payload?.length ? <div className={styles.chartTooltip}><b>{label}</b>{payload.map(item => {
              const index = Number(String(item.dataKey).replace("category", "")), row = view.chartRows[index];
              const monthIndex = (item.payload as { monthIndex: number }).monthIndex;
              return <p key={row.id}><span>{row.label}</span><strong>{formatYen(row.monthlyYen[monthIndex])}</strong></p>;
            })}</div> : null} />
            {view.chartRows.map((row, index) => <Bar key={row.id} name={row.label} dataKey={`category${index}`} stackId="burden" fill={row.colorHex} barSize={26} maxBarSize={26} isAnimationActive={false} />)}
            <TrendCallouts prepared={trendCallouts} scrollRef={trendScroll} />
          </BarChart></ResponsiveContainer>
        </div></div> : <p className={styles.chartEmpty}>この6か月の負担額はありません。</p>}
        {hasTrend && <p className={styles.scrollHint}>横にスクロールすると、各月のカテゴリ名と金額を確認できます。</p>}
        <ul className={styles.legend} aria-label="グラフのカテゴリ">{view.chartRows.map(row => <li key={row.id}><CategoryName row={row} /></li>)}</ul>
        <details className={styles.tableDetails}><summary>月ごとの金額を表で見る</summary><div className={styles.tableScroll} tabIndex={0} aria-label="月ごとの負担額の表（横スクロール可能）"><table>
          <caption>月ごとの負担額（円）</caption><thead><tr><th scope="col">カテゴリ</th>{view.months.map(month => <th scope="col" key={month}>{month.replace("-", "/")}</th>)}</tr></thead>
          <tbody>{view.rows.map(row => <tr key={row.id}><th scope="row"><CategoryName row={row} /></th>{row.monthlyYen.map((value, index) => <td key={view.months[index]}>{formatYen(value)}</td>)}</tr>)}</tbody>
          <tfoot><tr><th scope="row">合計</th>{monthlyTotals.map((value, index) => <td key={view.months[index]}>{formatYen(value)}</td>)}</tr></tfoot>
        </table></div></details>
      </section>
    </div>
    <section className={`${styles.card} ${styles.comparison}`} aria-labelledby="analytics-comparison-heading"><div className={styles.cardHeading}><h2 id="analytics-comparison-heading">カテゴリ別の増減</h2><span>同じ条件で比較</span></div>
      <p className={styles.cardSubtitle}>対象：{analyticsRangeLabel(periods.current)} ／ 比較：{analyticsRangeLabel(periods.comparison)}</p>
      <div className={styles.comparisonBody}>
        {view.rows.length > 0 ? <div className={styles.differenceChart} style={{ height: Math.max(180, differences.length * 43 + 32) }} role="group" aria-label="カテゴリ別の負担額の増減。正は増加、負は減少。全カテゴリの金額は次の表に表示します。">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart data={differences} layout="vertical" accessibilityLayer margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid horizontal={false} stroke="var(--line)" strokeDasharray="3 4" />
            <XAxis type="number" axisLine={false} tickLine={false} tick={chartStyle} tickFormatter={value => compactYen.format(Number(value))} />
            <YAxis dataKey="label" type="category" width={96} axisLine={false} tickLine={false} tick={chartStyle} tickFormatter={(value: string) => value.length > 9 ? `${value.slice(0, 8)}…` : value} />
            <ReferenceLine x={0} stroke="var(--muted)" /><Tooltip content={<ChartTooltip />} />
            <Bar dataKey="difference" name="差額" isAnimationActive={false} maxBarSize={19}>
              {differences.map(entry => <Cell key={entry.row.id} fill={entry.row.colorHex} />)}
              <LabelList dataKey="row.id" content={geometry => {
                const row = differences.find(entry => entry.row.id === geometry.value)?.row;
                if (!row || row.currentYen === row.comparisonYen) return null;
                const label = labels.get(row.id) ?? null;
                return <DifferenceAmountLabel label={label} position={barAmountPosition(geometry.viewBox, label)} categoryId={row.id} />;
              }} />
            </Bar>
          </BarChart></ResponsiveContainer>
        </div> : <p className={styles.chartEmpty}>比較できる負担額はありません。</p>}
        <div className={styles.tableScroll} tabIndex={0} aria-label="カテゴリ別の増減の表（横スクロール可能）"><table className={styles.differenceTable}>
          <caption>全カテゴリの増減（円）</caption><thead><tr><th scope="col">カテゴリ</th><th scope="col">対象期間</th><th scope="col">比較期間</th><th scope="col">差額</th><th scope="col">増減率</th></tr></thead>
          <tbody>{view.rows.map(row => <tr key={row.id}><th scope="row"><CategoryName row={row} /></th><td>{formatYen(row.currentYen)}</td><td>{formatYen(row.comparisonYen)}</td><td>{signed(row.currentYen - row.comparisonYen)}</td><td>{analyticsChangeRate(row.currentYen, row.comparisonYen) ?? (row.currentYen > BigInt(0) ? "比較元0円" : "—")}</td></tr>)}</tbody>
          <tfoot><tr><th scope="row">合計</th><td>{formatYen(view.totalYen)}</td><td>{formatYen(view.comparisonYen)}</td><td>{signed(view.differenceYen)}</td><td>{view.rate ?? "—"}</td></tr></tfoot>
        </table></div>
      </div>
      <p className={styles.comparisonNote}>「＋」は負担額の増加、「−」は減少です。比較期間が0円の場合、増減率は表示しません。</p>
    </section>
  </>;
}

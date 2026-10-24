"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Label, LabelList, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type LabelProps } from "recharts";
import { barAmountPosition, CHART_AMOUNT_FONT_FAMILY, CHART_AMOUNT_FONT_SIZE, CHART_AMOUNT_FONT_WEIGHT, createChartAmountMeasurer, pieAmountPosition, type ChartAmountLabel, type ChartAmountPosition } from "@/lib/client/analytics-chart-labels";
import { analyticsChangeRate, type AnalyticsDataset, type AnalyticsRow, type AnalyticsView } from "@/lib/shared/analytics";
import { cashflowClass, formatCashflow } from "@/lib/shared/display-formatters";
import styles from "./analytics-panel.module.css";

const compactYen = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 });
const chartStyle = { fontSize: 11, fontFamily: "inherit", fill: "var(--muted)" };
function analyticsRangeLabel(range: { from: string; to: string }) { return `${range.from.replaceAll("-", "/")} ～ ${range.to.replaceAll("-", "/")}`; }

function share(value: bigint, total: bigint) {
  if (total === BigInt(0)) return "0.0%";
  const tenths = (value * BigInt(1000) * BigInt(2) + total) / (total * BigInt(2));
  return `${tenths / BigInt(10)}.${tenths % BigInt(10)}%`;
}
function monthLabel(month: string) { return `${Number(month.slice(5))}月`; }
function CategoryName({ row }: { row: AnalyticsRow }) {
  return <span className={styles.categoryName}><i style={{ backgroundColor: row.colorHex }} aria-hidden="true" /><span>{row.label}</span></span>;
}

function AmountLabel({ label, position, kind, categoryId, month, amount }: {
  label: ChartAmountLabel | null; position: ChartAmountPosition | null;
  kind: "pie" | "trend" | "difference"; categoryId: string; month?: string; amount: bigint;
}) {
  if (!label || !position) return null;
  return <text x={position.x} y={position.y} textAnchor="middle" dominantBaseline="central"
    transform={position.rotation ? `rotate(${position.rotation} ${position.x} ${position.y})` : undefined}
    fill={amount > BigInt(0) ? "var(--success)" : amount < BigInt(0) ? "var(--red)" : "var(--ink)"}
    stroke="var(--paper)" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke"
    fontSize={CHART_AMOUNT_FONT_SIZE} fontFamily={CHART_AMOUNT_FONT_FAMILY} fontWeight={CHART_AMOUNT_FONT_WEIGHT}
    aria-hidden="true" pointerEvents="none" data-analytics-amount={kind} data-category-id={categoryId} data-month={month}>{label.text}</text>;
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
  return <g data-analytics-center="total" data-inner-radius={innerRadius} data-center-x={cx} data-center-y={cy}
    aria-hidden="true" pointerEvents="none" fill="var(--red)" fontFamily={CHART_AMOUNT_FONT_FAMILY} fontWeight={CHART_AMOUNT_FONT_WEIGHT} textAnchor="middle">
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
    const value = item.dataKey === "difference" ? row.comparisonYen - row.currentYen
      : -(monthIndex === undefined ? row.currentYen : row.monthlyYen[monthIndex]);
    return <p key={index}><span>{row.label}</span><strong className={cashflowClass(value)}>{formatCashflow(value)}</strong></p>;
  })}</div>;
}

export default function AnalyticsCharts({ view, periods }: { view: AnalyticsView; periods: AnalyticsDataset["periods"] }) {
  // Floating point values are graph coordinates only; every amount and ratio label uses bigint.
  const labels = useMemo(() => {
    const measure = createChartAmountMeasurer();
    return new Map(view.chartRows.map(row => [row.id, {
      current: measure(formatCashflow(-row.currentYen), row.colorHex),
      difference: measure(formatCashflow(row.comparisonYen - row.currentYen), row.colorHex),
      months: row.monthlyYen.map(value => measure(formatCashflow(-value), row.colorHex)),
    }]));
  }, [view]);
  // Keep the shared ranking of the other charts and tables; only the pie follows current amounts.
  const composition = useMemo(() => view.chartRows.filter(row => row.currentYen > BigInt(0))
    .map(row => ({ row, value: Number(row.currentYen) }))
    .sort((a, b) => a.row.currentYen === b.row.currentYen ? 0 : a.row.currentYen > b.row.currentYen ? -1 : 1), [view]);
  const trend = useMemo(() => view.months.map((month, monthIndex) => {
    const point: Record<string, string | number | AnalyticsRow> = { month, monthIndex };
    view.chartRows.forEach((row, index) => { point[`category${index}`] = Number(row.monthlyYen[monthIndex]); });
    return point;
  }), [view]);
  const differences = useMemo(() => view.chartRows.map(row => ({ row, label: row.label, difference: Number(row.comparisonYen - row.currentYen) })), [view]);
  const monthlyTotals = useMemo(() => view.months.map((_, index) => view.rows.reduce((sum, row) => sum + row.monthlyYen[index], BigInt(0))), [view]);
  const hasTrend = monthlyTotals.some(value => value > BigInt(0));

  return <>
    <div className={styles.chartGrid}>
      <section className={styles.card} aria-labelledby="analytics-composition-heading"><div className={styles.cardHeading}><h2 id="analytics-composition-heading">カテゴリ別の内訳</h2><span>支出額</span></div>
        <p className={styles.cardSubtitle}>{analyticsRangeLabel(periods.current)}</p>
        <div className={styles.compositionBody}>
          {view.totalYen > BigInt(0) ? <div className={styles.donutChart} role="group" aria-label="カテゴリ別の支出額。金額と割合は次の一覧でも確認できます。">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}><PieChart accessibilityLayer>
              <Pie data={composition} dataKey="value" nameKey={entry => entry.row.label} innerRadius="50%" outerRadius="88%"
                startAngle={90} endAngle={-270} paddingAngle={2} isAnimationActive={false} stroke="var(--paper)" labelLine={false}
                label={geometry => {
                  // Sector payload and geometry belong to the same Recharts snapshot.
                  const row = geometry.payload?.row as AnalyticsRow | undefined;
                  const label = row ? labels.get(row.id)?.current ?? null : null;
                  if (!row || label?.text !== formatCashflow(-row.currentYen)) return null;
                  return <AmountLabel label={label} position={pieAmountPosition(geometry, label)} kind="pie" categoryId={row.id} amount={-row.currentYen} />;
                }}>
                {composition.map(entry => <Cell key={entry.row.id} fill={entry.row.colorHex} />)}
                <Label content={<DonutCenter totalText={formatCashflow(-view.totalYen)} />} />
              </Pie><Tooltip content={<ChartTooltip />} />
            </PieChart></ResponsiveContainer>
          </div> : <p className={styles.chartEmpty}>この期間の支出額はありません。</p>}
          <ul className={styles.categoryList} aria-label="全カテゴリの支出額と割合">{view.rows.map(row => <li key={row.id}><CategoryName row={row} /><strong className={cashflowClass(-row.currentYen)}>{formatCashflow(-row.currentYen)}</strong><span>{share(row.currentYen, view.totalYen)}</span></li>)}</ul>
        </div>
        <p className={styles.miniNote}>構成比と月ごとの棒の大きさは、支出額の絶対値で表示します。グラフは主な8カテゴリを表示し、残りは「その他」にまとめます。未分類は別に表示します。</p>
      </section>
      <section className={styles.card} aria-labelledby="analytics-trend-heading"><div className={styles.cardHeading}><h2 id="analytics-trend-heading">月ごとの推移</h2><span>直近6か月</span></div>
        <p className={styles.cardSubtitle}>{analyticsRangeLabel(periods.trend)}<br />終了月までの6か月を表示します。</p>
        {hasTrend ? <div className={styles.trendChart} role="group" aria-label="月ごとのカテゴリ別支出額。下の表でも確認できます。">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart data={trend} accessibilityLayer margin={{ top: 12, right: 2, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="3 4" />
            <XAxis dataKey="month" tickFormatter={monthLabel} axisLine={false} tickLine={false} tick={chartStyle} />
            <YAxis width={52} axisLine={false} tickLine={false} tick={chartStyle} tickFormatter={value => compactYen.format(-Number(value))} />
            <Tooltip content={({ active, payload, label }) => active && payload?.length ? <div className={styles.chartTooltip}><b>{label}</b>{payload.map(item => {
              const index = Number(String(item.dataKey).replace("category", "")), row = view.chartRows[index];
              const monthIndex = (item.payload as { monthIndex: number }).monthIndex;
              return <p key={row.id}><span>{row.label}</span><strong className={cashflowClass(-row.monthlyYen[monthIndex])}>{formatCashflow(-row.monthlyYen[monthIndex])}</strong></p>;
            })}</div> : null} />
            {view.chartRows.map((row, index) => <Bar key={row.id} name={row.label} dataKey={`category${index}`} stackId="burden" fill={row.colorHex} maxBarSize={38} isAnimationActive={false}>
              <LabelList dataKey="month" content={geometry => {
                // Recharts omits zero-size bars before numbering labels, so use the source month.
                const monthIndex = view.months.indexOf(String(geometry.value));
                if (!row.monthlyYen[monthIndex]) return null;
                const label = labels.get(row.id)!.months[monthIndex] ?? null;
                return <AmountLabel label={label} position={barAmountPosition(geometry.viewBox, label, true)} kind="trend" categoryId={row.id} month={view.months[monthIndex]} amount={-row.monthlyYen[monthIndex]} />;
              }} />
            </Bar>)}
          </BarChart></ResponsiveContainer>
        </div> : <p className={styles.chartEmpty}>この6か月の支出額はありません。</p>}
        <ul className={styles.legend} aria-label="グラフのカテゴリ">{view.chartRows.map(row => <li key={row.id}><CategoryName row={row} /></li>)}</ul>
        <details className={styles.tableDetails}><summary>月ごとの金額を表で見る</summary><div className={styles.tableScroll} tabIndex={0} aria-label="月ごとの支出額の表（横スクロール可能）"><table>
          <caption>月ごとの支出額（円）</caption><thead><tr><th scope="col">カテゴリ</th>{view.months.map(month => <th scope="col" key={month}>{month.replace("-", "/")}</th>)}</tr></thead>
          <tbody>{view.rows.map(row => <tr key={row.id}><th scope="row"><CategoryName row={row} /></th>{row.monthlyYen.map((value, index) => <td key={view.months[index]} className={cashflowClass(-value)}>{formatCashflow(-value)}</td>)}</tr>)}</tbody>
          <tfoot><tr><th scope="row">合計</th>{monthlyTotals.map((value, index) => <td key={view.months[index]} className={cashflowClass(-value)}>{formatCashflow(-value)}</td>)}</tr></tfoot>
        </table></div></details>
      </section>
    </div>
    <section className={`${styles.card} ${styles.comparison}`} aria-labelledby="analytics-comparison-heading"><div className={styles.cardHeading}><h2 id="analytics-comparison-heading">カテゴリ別の増減</h2><span>同じ条件で比較</span></div>
      <p className={styles.cardSubtitle}>対象：{analyticsRangeLabel(periods.current)} ／ 比較：{analyticsRangeLabel(periods.comparison)}</p>
      <div className={styles.comparisonBody}>
        {view.rows.length > 0 ? <div className={styles.differenceChart} style={{ height: Math.max(180, differences.length * 43 + 32) }} role="group" aria-label="カテゴリ別の支出額の増減。正は支出の減少、負は支出の増加。全カテゴリの金額は次の表に表示します。">
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
                const label = labels.get(row.id)!.difference;
                return <AmountLabel label={label} position={barAmountPosition(geometry.viewBox, label, false)} kind="difference" categoryId={row.id} amount={row.comparisonYen - row.currentYen} />;
              }} />
            </Bar>
          </BarChart></ResponsiveContainer>
        </div> : <p className={styles.chartEmpty}>比較できる支出額はありません。</p>}
        <div className={styles.tableScroll} tabIndex={0} aria-label="カテゴリ別の増減の表（横スクロール可能）"><table className={styles.differenceTable}>
          <caption>全カテゴリの増減（円）</caption><thead><tr><th scope="col">カテゴリ</th><th scope="col">対象期間</th><th scope="col">比較期間</th><th scope="col">差額</th><th scope="col">支出の増減率</th></tr></thead>
          <tbody>{view.rows.map(row => <tr key={row.id}><th scope="row"><CategoryName row={row} /></th><td className={cashflowClass(-row.currentYen)}>{formatCashflow(-row.currentYen)}</td><td className={cashflowClass(-row.comparisonYen)}>{formatCashflow(-row.comparisonYen)}</td><td className={cashflowClass(row.comparisonYen - row.currentYen)}>{formatCashflow(row.comparisonYen - row.currentYen)}</td><td>{analyticsChangeRate(row.currentYen, row.comparisonYen) ?? (row.currentYen > BigInt(0) ? "比較元0円" : "—")}</td></tr>)}</tbody>
          <tfoot><tr><th scope="row">合計</th><td className={cashflowClass(-view.totalYen)}>{formatCashflow(-view.totalYen)}</td><td className={cashflowClass(-view.comparisonYen)}>{formatCashflow(-view.comparisonYen)}</td><td className={cashflowClass(-view.differenceYen)}>{formatCashflow(-view.differenceYen)}</td><td>{view.rate ?? "—"}</td></tr></tfoot>
        </table></div>
      </div>
      <p className={styles.comparisonNote}>金額の「＋」は支出の減少、「−」は支出の増加です。増減率は支出額から算出し、比較期間が0円の場合は表示しません。</p>
    </section>
  </>;
}

"use client";

import { useEffect, useMemo, useState, type ReactElement, type RefObject } from "react";
import { Cell, Label, Pie, PieChart, ResponsiveContainer, Tooltip, useActiveTooltipCoordinate, usePlotArea, useXAxisScale, useYAxisScale, type LabelProps } from "recharts";
import { chartCalloutText, CHART_AMOUNT_FONT_FAMILY, CHART_AMOUNT_FONT_SIZE, CHART_AMOUNT_FONT_WEIGHT, CHART_CALLOUT_GAP, CHART_CALLOUT_LINE_HEIGHT, createChartAmountMeasurer, spreadChartCallouts, type ChartCalloutText } from "@/lib/client/analytics-chart-labels";
import type { AnalyticsRow, AnalyticsView } from "@/lib/shared/analytics";
import { formatYen } from "@/lib/shared/display-formatters";
import styles from "./analytics-panel.module.css";

const radians = (angle: number) => angle * Math.PI / 180;
type Callout = { row: AnalyticsRow; text: ChartCalloutText; x: number; y: number; month?: string };

function CalloutText({ row, text, x, y, month, kind }: Callout & { kind: "pie" | "trend" }) {
  const amountY = y + text.names.length * CHART_CALLOUT_LINE_HEIGHT + 4;
  return <g data-analytics-label={kind} data-category-id={row.id} data-month={month}
    aria-hidden="true" pointerEvents="none" fontFamily={CHART_AMOUNT_FONT_FAMILY} fontSize={CHART_AMOUNT_FONT_SIZE} fontWeight={CHART_AMOUNT_FONT_WEIGHT} fill="var(--ink)">
    <title>{row.label}</title>
    <text data-analytics-category={kind} x={x} y={y + 11}>{text.names.map((line, index) => <tspan x={x} dy={index === 0 ? 0 : CHART_CALLOUT_LINE_HEIGHT} key={index}>{line}</tspan>)}</text>
    <text data-analytics-amount={kind} data-category-id={row.id} data-month={month} x={x} y={amountY + 11}>{text.amounts.map((line, index) => <tspan x={x} dy={index === 0 ? 0 : CHART_CALLOUT_LINE_HEIGHT} key={index}>{line}</tspan>)}</text>
  </g>;
}

type PieEntry = { row: AnalyticsRow; text: ChartCalloutText; angle: number; left: boolean; top: boolean };
function columnHeight(entries: readonly PieEntry[]) { return entries.reduce((sum, entry) => sum + entry.text.height + CHART_CALLOUT_GAP, 0); }

function pieLayout(rows: AnalyticsRow[], availableWidth: number) {
  const width = Math.max(200, availableWidth || 256);
  const narrow = width < 400;
  const radius = narrow ? 80 : 90;
  const textWidth = narrow ? (width - 28) / 2 : (width - radius * 2 - 56) / 2;
  const measure = createChartAmountMeasurer();
  const sum = rows.reduce((total, row) => total + Number(row.currentYen), 0);
  let angle = 90;
  const entries: PieEntry[] = rows.map(row => {
    const sweep = Number(row.currentYen) / sum * 360;
    const mid = angle - sweep / 2;
    angle -= sweep;
    return { row, text: chartCalloutText(row.label, formatYen(row.currentYen), textWidth, measure), angle: mid,
      left: Math.cos(radians(mid)) < 0, top: Math.sin(radians(mid)) >= 0 };
  });
  const cx = width / 2;
  let cy: number, height: number;
  let callouts: (PieEntry & { x: number; y: number })[];
  if (narrow) {
    const quadrants = [entries.filter(entry => entry.left && entry.top), entries.filter(entry => !entry.left && entry.top),
      entries.filter(entry => entry.left && !entry.top), entries.filter(entry => !entry.left && !entry.top)];
    const topHeight = Math.max(columnHeight(quadrants[0]), columnHeight(quadrants[1]));
    const bottomHeight = Math.max(columnHeight(quadrants[2]), columnHeight(quadrants[3]));
    cy = 12 + topHeight + 20 + radius;
    height = cy + radius + 20 + bottomHeight + 12;
    callouts = quadrants.flatMap((group, quadrant) => {
      let y = quadrant < 2 ? 12 : cy + radius + 20;
      return group.slice().sort((a, b) => a.angle - b.angle).map(entry => {
        const result = { ...entry, x: entry.left ? 4 : width - textWidth + 4, y };
        y += entry.text.height + CHART_CALLOUT_GAP;
        return result;
      });
    });
  } else {
    const left = entries.filter(entry => entry.left), right = entries.filter(entry => !entry.left);
    height = Math.max(radius * 2 + 32, columnHeight(left) + 24, columnHeight(right) + 24);
    cy = height / 2;
    callouts = [left, right].flatMap(group => spreadChartCallouts(group.map(entry => ({ ...entry,
      desiredY: cy - Math.sin(radians(entry.angle)) * radius })), 12, height - 12)
      .map(entry => ({ ...entry, x: entry.left ? 4 : width - textWidth + 4 })));
  }
  return { width, height, cx, cy, radius, narrow, callouts };
}

function PieCallouts({ viewBox, layout }: LabelProps & { layout: ReturnType<typeof pieLayout> }) {
  if (!viewBox || !("cx" in viewBox) || !("outerRadius" in viewBox)
    || Math.abs(viewBox.cx - layout.cx) > .5 || Math.abs(viewBox.cy - layout.cy) > .5 || Math.abs(viewBox.outerRadius - layout.radius) > .5) return null;
  return <g aria-hidden="true" pointerEvents="none">{layout.callouts.map(entry => {
    const cosine = Math.cos(radians(entry.angle)), sine = Math.sin(radians(entry.angle));
    const anchor = [layout.cx + cosine * layout.radius, layout.cy - sine * layout.radius];
    const outer = [layout.cx + cosine * (layout.radius + 8), layout.cy - sine * (layout.radius + 8)];
    const targetY = entry.y + entry.text.height / 2;
    const targetX = entry.left ? entry.x + entry.text.width : entry.x - 4;
    let points: number[][];
    if (layout.narrow) {
      const sideX = layout.cx + (entry.left ? -1 : 1) * (layout.radius + 12);
      const boundaryY = layout.cy + (entry.top ? -1 : 1) * (layout.radius + 12);
      const railX = layout.cx + (entry.left ? -8 : 8);
      points = [anchor, outer, [sideX, outer[1]], [sideX, boundaryY], [railX, boundaryY], [railX, targetY], [targetX, targetY]];
    } else points = [anchor, outer, [targetX + (entry.left ? 6 : -6), targetY], [targetX, targetY]];
    return <g key={entry.row.id}><polyline data-analytics-leader="pie" data-category-id={entry.row.id} points={points.map(point => point.join(",")).join(" ")} fill="none" stroke={entry.row.colorHex} strokeWidth={1.2} />
      <CalloutText {...entry} kind="pie" />
    </g>;
  })}</g>;
}

export function CategoryPie({ rows, center }: { rows: AnalyticsRow[]; center: ReactElement }) {
  const [width, setWidth] = useState(0);
  const layout = useMemo(() => pieLayout(rows, width), [rows, width]);
  const key = rows.map(row => `${row.id}:${row.currentYen}:${row.label}:${row.colorHex}`).join("|");
  return <div className={styles.donutChart} style={{ height: layout.height }} role="group" aria-label="カテゴリ別の負担額。金額と割合は次の一覧でも確認できます。">
    <ResponsiveContainer width="100%" height="100%" minWidth={0} onResize={nextWidth => setWidth(nextWidth)}><PieChart accessibilityLayer margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
      <Pie key={key} data={rows.map(row => ({ row, value: Number(row.currentYen) }))} dataKey="value" nameKey={entry => entry.row.label}
        cx={layout.cx} cy={layout.cy} innerRadius={layout.radius * .68} outerRadius={layout.radius} startAngle={90} endAngle={-270}
        paddingAngle={0} isAnimationActive={false} stroke="var(--paper)">
        {rows.map(row => <Cell key={row.id} fill={row.colorHex} />)}
        <Label content={center} /><Label content={<PieCallouts layout={layout} />} />
      </Pie>
      <Tooltip content={({ active, payload }) => {
        const row = payload?.[0]?.payload?.row as AnalyticsRow | undefined;
        return active && row ? <div className={styles.chartTooltip}><p><span>{row.label}</span><strong>{formatYen(row.currentYen)}</strong></p></div> : null;
      }} />
    </PieChart></ResponsiveContainer>
  </div>;
}

export const TREND_CALLOUT_WIDTH = 156;
export function prepareTrendCallouts(view: AnalyticsView) {
  const measure = createChartAmountMeasurer();
  return view.months.map((month, index) => ({ month, entries: view.chartRows.filter(row => row.monthlyYen[index] > BigInt(0))
    .map(row => ({ row, text: chartCalloutText(row.label, formatYen(row.monthlyYen[index]), TREND_CALLOUT_WIDTH, measure) })) }));
}

export function TrendCallouts({ prepared, scrollRef }: { prepared: ReturnType<typeof prepareTrendCallouts>; scrollRef: RefObject<HTMLDivElement | null> }) {
  const area = usePlotArea(), xScale = useXAxisScale(), yScale = useYAxisScale();
  const activeX = useActiveTooltipCoordinate()?.x;
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || activeX === undefined) return;
    const left = activeX - 20, right = activeX + 22 + TREND_CALLOUT_WIDTH;
    if (left < container.scrollLeft) container.scrollLeft = Math.max(0, left);
    else if (right > container.scrollLeft + container.clientWidth) container.scrollLeft = right - container.clientWidth;
  }, [activeX, scrollRef]);
  if (!area || !xScale || !yScale) return null;
  return <g aria-hidden="true" pointerEvents="none">{prepared.map((month, monthIndex) => {
    const x = xScale(month.month, { position: "middle" });
    if (x === undefined) return null;
    let total = BigInt(0);
    const entries = month.entries.map(entry => {
      const start = yScale(Number(total));
      total += entry.row.monthlyYen[monthIndex];
      const end = yScale(Number(total));
      return { ...entry, desiredY: start === undefined || end === undefined ? area.y : (start + end) / 2 };
    });
    return spreadChartCallouts(entries, area.y + 4, area.y + area.height - 4).map(entry => {
      const labelX = x + 22;
      const targetY = entry.y + entry.text.height / 2;
      return <g key={`${month.month}:${entry.row.id}`}>
        <polyline data-analytics-leader="trend" data-category-id={entry.row.id} data-month={month.month}
          points={`${x + 13},${entry.desiredY} ${x + 17},${entry.desiredY} ${labelX - 4},${targetY} ${labelX},${targetY}`} fill="none" stroke={entry.row.colorHex} strokeWidth={1.2} />
        <CalloutText row={entry.row} text={entry.text} x={labelX} y={entry.y} month={month.month} kind="trend" />
      </g>;
    });
  })}</g>;
}

export const CHART_AMOUNT_FONT_SIZE = 11;
export const CHART_AMOUNT_FONT_FAMILY = "Arial, sans-serif";
export const CHART_AMOUNT_FONT_WEIGHT = 600;

export type ChartAmountLabel = { text: string; width: number; height: number; color: string };
export type ChartAmountPosition = { x: number; y: number };
const LABEL_PADDING = 2;

function contrastingColor(background: string): string {
  const channels = background.slice(1).match(/.{2}/g)?.map(channel => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  if (channels?.length !== 3 || channels.some(value => !Number.isFinite(value))) return "#000000";
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? "#000000" : "#ffffff";
}

/** Share one canvas for the prepared labels and use the same fixed font as the SVG text. */
export function createChartAmountMeasurer() {
  const context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  return (text: string, colorHex: string, fontSize = CHART_AMOUNT_FONT_SIZE): ChartAmountLabel | null => {
    if (!context) return null;
    context.font = `${CHART_AMOUNT_FONT_WEIGHT} ${fontSize}px ${CHART_AMOUNT_FONT_FAMILY}`;
    const metrics = context.measureText(text);
    return {
      text, color: contrastingColor(colorHex),
      width: Math.ceil(Math.max(metrics.width, metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight)) + 2,
      height: Math.ceil(Math.max(fontSize * 1.2, metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent)),
    };
  };
}

/** Rectangles may have negative width/height for negative bars. */
export function barAmountPosition(geometry: unknown, label: ChartAmountLabel | null): ChartAmountPosition | null {
  if (!label || !geometry || typeof geometry !== "object") return null;
  const box = geometry as Record<string, unknown>;
  if (![box.x, box.y, box.width, box.height].every(value => typeof value === "number" && Number.isFinite(value))) return null;
  const { x, y, width, height } = box as { x: number; y: number; width: number; height: number };
  const availableWidth = Math.abs(width) - LABEL_PADDING * 2;
  const availableHeight = Math.abs(height) - LABEL_PADDING * 2;
  const center = { x: x + width / 2, y: y + height / 2 };
  if (label.width <= availableWidth && label.height <= availableHeight) return center;
  return null;
}

export const CHART_CALLOUT_LINE_HEIGHT = 14;
export const CHART_CALLOUT_GAP = 8;
export type ChartCalloutText = { names: string[]; amounts: string[]; width: number; height: number };

/** Names have a two-line preview; the exact amount is wrapped without deleting characters. */
export function chartCalloutText(name: string, amount: string, width: number, measure: ReturnType<typeof createChartAmountMeasurer>): ChartCalloutText {
  const available = width - 8;
  function wrap(parts: string[]) {
    const lines: string[] = [];
    let line = "";
    for (const part of parts) {
      const size = measure(line + part, "#fffef8");
      if (line && (size?.width ?? (line.length + part.length) * 11) > available) { lines.push(line); line = part; }
      else line += part;
    }
    if (line) lines.push(line);
    return lines;
  }
  const names = wrap(Array.from(name));
  if (names.length > 2) {
    names.length = 2;
    while (names[1] && (measure(`${names[1]}…`, "#fffef8")?.width ?? names[1].length * 11) > available) names[1] = Array.from(names[1]).slice(0, -1).join("");
    names[1] += "…";
  }
  const amounts = wrap(amount.match(/[^,]+,?/g) ?? [amount]);
  return { names, amounts, width, height: (names.length + amounts.length) * CHART_CALLOUT_LINE_HEIGHT + 4 };
}

/** Pack one ordered column without changing the order of its connectors. */
export function spreadChartCallouts<T extends { desiredY: number; text: ChartCalloutText }>(items: readonly T[], top: number, bottom: number): (T & { y: number })[] {
  const result = items.slice().sort((a, b) => a.desiredY - b.desiredY).map(item => ({ ...item, y: 0 }));
  let next = top;
  for (const item of result) { item.y = Math.max(next, item.desiredY - item.text.height / 2); next = item.y + item.text.height + CHART_CALLOUT_GAP; }
  next = bottom;
  for (let index = result.length - 1; index >= 0; index--) { const item = result[index]; item.y = Math.min(item.y, next - item.text.height); next = item.y - CHART_CALLOUT_GAP; }
  return result;
}

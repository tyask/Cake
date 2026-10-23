export const CHART_AMOUNT_FONT_SIZE = 11;
export const CHART_AMOUNT_FONT_FAMILY = "Arial, sans-serif";
export const CHART_AMOUNT_FONT_WEIGHT = 600;

export type ChartAmountLabel = { text: string; width: number; height: number; color: string };
export type ChartAmountPosition = { x: number; y: number; rotation: number };
type PieGeometry = { cx: number; cy: number; innerRadius: number; outerRadius: number; startAngle: number; endAngle: number };
const LABEL_PADDING = 2;
const radians = (degrees: number) => degrees * Math.PI / 180;

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
export function barAmountPosition(geometry: unknown, label: ChartAmountLabel | null, allowRotation: boolean): ChartAmountPosition | null {
  if (!label || !geometry || typeof geometry !== "object") return null;
  const box = geometry as Record<string, unknown>;
  if (![box.x, box.y, box.width, box.height].every(value => typeof value === "number" && Number.isFinite(value))) return null;
  const { x, y, width, height } = box as { x: number; y: number; width: number; height: number };
  const availableWidth = Math.abs(width) - LABEL_PADDING * 2;
  const availableHeight = Math.abs(height) - LABEL_PADDING * 2;
  const center = { x: x + width / 2, y: y + height / 2 };
  if (label.width <= availableWidth && label.height <= availableHeight) return { ...center, rotation: 0 };
  if (allowRotation && label.height <= availableWidth && label.width <= availableHeight) return { ...center, rotation: -90 };
  return null;
}

/** The complete padded label must stay inside both the annulus and the sector angles. */
export function pieAmountPosition(geometry: PieGeometry, label: ChartAmountLabel | null): ChartAmountPosition | null {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle } = geometry;
  if (!label || ![cx, cy, innerRadius, outerRadius, startAngle, endAngle].every(Number.isFinite)) return null;
  const sweep = Math.abs(endAngle - startAngle);
  if (sweep === 0 || outerRadius <= innerRadius) return null;
  const midAngle = (startAngle + endAngle) / 2;
  const radius = (innerRadius + outerRadius) / 2;
  const halfWidth = label.width / 2 + LABEL_PADDING;
  const halfHeight = label.height / 2 + LABEL_PADDING;
  // Prefer the middle; a horizontal label can fit better away from a sector's horizontal radius.
  for (const offset of [0, 10, -10, 20, -20, 30, -30, 40, -40, 50, -50, 60, -60, 70, -70, 80, -80]) {
    if (Math.abs(offset) >= sweep / 2) continue;
    const x = cx + radius * Math.cos(radians(-midAngle - offset));
    const y = cy + radius * Math.sin(radians(-midAngle - offset));
    const left = x - halfWidth, right = x + halfWidth, top = y - halfHeight, bottom = y + halfHeight;
    // Corners alone cannot detect an edge crossing the inner hole.
    const nearestX = Math.max(left, Math.min(cx, right));
    const nearestY = Math.max(top, Math.min(cy, bottom));
    if (Math.hypot(nearestX - cx, nearestY - cy) < innerRadius + LABEL_PADDING) continue;
    const fits = [[left, top], [left, bottom], [right, top], [right, bottom]].every(([cornerX, cornerY]) => {
      if (Math.hypot(cornerX - cx, cornerY - cy) > outerRadius - LABEL_PADDING) return false;
      const angle = Math.atan2(cy - cornerY, cornerX - cx) * 180 / Math.PI;
      const difference = Math.atan2(Math.sin(radians(angle - midAngle)), Math.cos(radians(angle - midAngle))) * 180 / Math.PI;
      return Math.abs(difference) <= sweep / 2 - .5;
    });
    if (fits) return { x, y, rotation: 0 };
  }
  return null;
}

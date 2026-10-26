import assert from "node:assert/strict";
import test from "node:test";
import { barAmountPosition, type ChartAmountLabel } from "../../lib/client/analytics-chart-labels";

const label: ChartAmountLabel = { text: "+￥100,000", width: 72, height: 14, color: "#ffffff" };

test("棒の端数ピクセルはちょうど収まる金額を消さず、実際にはみ出す金額は省略する", () => {
  const horizontal = barAmountPosition({ x: 0, y: 0, width: 76 - 1e-10, height: 18 }, label, false);
  assert.equal(horizontal?.rotation, 0);
  assert.equal(horizontal?.y, 9);
  const rotated = barAmountPosition({ x: 0, y: 0, width: 18, height: -76 + 1e-10 }, label, true);
  assert.equal(rotated?.rotation, -90);
  assert.equal(rotated?.x, 9);
  assert.equal(barAmountPosition({ x: 0, y: 0, width: 75.99, height: 18 }, label, false), null);
  assert.equal(barAmountPosition({ x: 0, y: 0, width: 18, height: 75.99 }, label, true), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { cashflowClass, formatCashflow, formatTransactionAmount, formatYen } from "../../lib/shared/display-formatters";

test("支払いは負、収入は正で表示し、元の正額を変えない", () => {
  const amount = 1234;
  assert.equal(formatTransactionAmount("PAYMENT", amount), "−" + formatYen(amount));
  assert.equal(formatTransactionAmount("RECEIPT", amount), "+" + formatYen(amount));
  assert.equal(amount, 1234);
  assert.equal(cashflowClass(-amount), "negative");
  assert.equal(cashflowClass(amount), "positive");
});

test("0と負の0は無符号・中立色にし、BigIntの大きな収支も精度を保つ", () => {
  for (const zero of [0, -0, BigInt(0)]) {
    assert.equal(formatCashflow(zero), formatYen(0));
    assert.equal(cashflowClass(zero), "");
  }
  const large = BigInt("9007199254740993");
  assert.equal(formatCashflow(large), "+" + formatYen(large));
  assert.equal(formatCashflow(-large), "−" + formatYen(large));
  assert.equal(cashflowClass(-large), "negative");
});

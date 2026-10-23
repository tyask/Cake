import { MAX_AMOUNT_YEN, MAX_SPLIT_WEIGHT } from "../../../lib/shared/domain-values";

/** The same cases exercise the TypeScript allocator and the SQL aggregate. */
export const analyticsAllocationCases = [
  { name: "1円の同率", amount: 1, weights: [1, 1] },
  { name: "奇数の同率", amount: 101, weights: [1, 1] },
  { name: "1対2", amount: 100, weights: [1, 2] },
  { name: "最大剰余が後の参加者", amount: 1, weights: [1, 2] },
  { name: "片方0", amount: 101, weights: [0, 1] },
  { name: "もう片方0", amount: 101, weights: [1, 0] },
  { name: "最大金額・最大割合", amount: MAX_AMOUNT_YEN, weights: [MAX_SPLIT_WEIGHT, MAX_SPLIT_WEIGHT - 1] },
  { name: "割合の整数小数表記", amount: 3, weights: [1.0, 2.0] },
  { name: "一人の家計", amount: MAX_AMOUNT_YEN, weights: [MAX_SPLIT_WEIGHT] },
] as const;

import { validateSplitWeights } from "./expense-splits";
import type { SplitWeights } from "./types";

type Member = { id: string };

/** Allocate whole yen while keeping the total exact, with stable ties in member order. */
export function splitAmounts(amountYen: number, weights: SplitWeights, members: readonly Member[]): SplitWeights {
  if (!Number.isInteger(amountYen) || amountYen < 0 || amountYen > 2_147_483_647) {
    throw new Error("金額は0から2147483647円までの整数で設定してください。");
  }
  const valid = validateSplitWeights(weights, members);
  const total = members.reduce((sum, member) => sum + BigInt(valid[member.id]), BigInt(0));
  const shares = members.map((member, index) => {
    const numerator = BigInt(amountYen) * BigInt(valid[member.id]);
    return { id: member.id, index, amount: Number(numerator / total), remainder: numerator % total };
  });
  const remaining = amountYen - shares.reduce((sum, share) => sum + share.amount, 0);
  const priority = [...shares].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; index < remaining; index++) priority[index].amount += 1;
  return Object.fromEntries(shares.map((share) => [share.id, share.amount]));
}

/** Editing one share distributes the remaining amount among the other members. */
export function changeSplitAmount(total: number, amount: number, memberId: string, weights: SplitWeights, members: readonly Member[]): SplitWeights {
  if (!Number.isInteger(total) || total < 1 || total > 2_147_483_647
    || !Number.isInteger(amount) || amount < 0 || amount > total) {
    throw new Error("支払い分は0から合計金額までの整数で設定してください。");
  }
  const valid = validateSplitWeights(weights, members);
  if (!members.some((member) => member.id === memberId)) throw new Error("支払い割合の参加者が不正です。");
  const others = members.filter((member) => member.id !== memberId);
  if (others.length === 0) {
    if (amount !== total) throw new Error("参加者が一人の場合は全額を負担します。");
    return { [memberId]: total };
  }
  let remainingWeights = Object.fromEntries(others.map((member) => [member.id, valid[member.id]]));
  if (others.every((member) => remainingWeights[member.id] === 0)) {
    remainingWeights = Object.fromEntries(others.map((member) => [member.id, 1]));
  }
  const remainingAmounts = splitAmounts(total - amount, remainingWeights, others);
  return Object.fromEntries(members.map((member) => [member.id,
    member.id === memberId ? amount : remainingAmounts[member.id],
  ]));
}

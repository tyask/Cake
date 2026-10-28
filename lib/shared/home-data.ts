import { z } from "zod";
import { isHomeMonth } from "./home-summary";
import { workspaceIdSchema } from "./schemas/domain-schemas";
import type { SettlementHistory, SettlementResult } from "./types";

export const homeQuerySchema = z.object({
  workspaceId: workspaceIdSchema,
  month: z.string().refine(isHomeMonth, "対象年月が不正です。"),
}).strict();

export type HomeQuery = z.infer<typeof homeQuerySchema>;

/** Decimal strings preserve whole-yen totals beyond JavaScript's safe integer range. */
export interface HomeCashflowTotals {
  paymentTotal: string;
  receiptTotal: string;
  balanceYen: string;
}

export interface HomeMonthlyPerson extends HomeCashflowTotals {
  userId: string;
}

/** Home never receives transaction rows or a settlement's transaction ID list. */
export interface HomeData {
  workspaceId: string;
  month: string;
  members: { id: string; name: string }[];
  monthly: { people: HomeMonthlyPerson[]; total: HomeCashflowTotals };
  unsettled: HomeCashflowTotals & { count: number };
  settlement: Omit<SettlementResult, "transactionIds"> | null;
  settlementHistory: SettlementHistory[];
}

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HomePanel } from "../../../components/home-panel";
import { TransactionsPanel } from "../../../components/transactions-panel";
import { postAction } from "../../../lib/client/app-client";
import { calculateSettlement } from "../../../lib/shared/settlement";
import { cashflowSummary, transactionsInMonth, workspaceCashflowSummary } from "../../../lib/shared/home-summary";
import type { RunAppAction } from "../../../lib/shared/schemas/app-input";
import type { TransactionRecord, WorkspaceData } from "../../../lib/shared/types";
import "../../../app/globals.css";

function transaction(id: string, overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id, merchant: id, type: "PAYMENT", amountYen: 10_000, occurredAt: "2026-10-10T03:00:00.000Z",
    method: "現金", memo: "", actorUserId: "a", actorName: "A", expenseClass: "SHARED", splitWeights: { a: 1, b: 1 },
    settledAt: null, externalId: id, source: "MANUAL", categoryId: null, categoryConfirmed: false, categoryRevision: 0,
    ...overrides,
  };
}

const mode = new URLSearchParams(location.search).get("balance");
const workspace: WorkspaceData = {
  workspace: { id: "cashflow-workspace", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
  members: [
    { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 1, role: "OWNER" },
    { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 1, role: "MEMBER" },
  ],
  categories: [], rules: [],
  transactions: mode === "empty" ? [] : mode === "balanced" ? [
    transaction("balanced-a", { amountYen: 1_000 }),
    transaction("balanced-b", { amountYen: 1_000, actorUserId: "b", actorName: "B" }),
  ] : [
    transaction("payment"),
    transaction("receipt", { type: "RECEIPT", amountYen: 2_000, actorUserId: "b", actorName: "B" }),
    transaction("settled-receipt", { type: "RECEIPT", amountYen: 5_000, settledAt: "2026-10-11T03:00:00.000Z" }),
    transaction("past", { amountYen: 9_000, occurredAt: "2026-09-30T14:59:59.000Z", expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } }),
    transaction("future", { amountYen: mode === "negative" ? 9_500 : mode === "zero" ? 8_500 : 2_500,
      occurredAt: "2026-10-31T03:00:00.000Z", expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } }),
    transaction("same-amount-receipt", { type: "RECEIPT", expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } }),
  ],
  settlement: null, settlementHistory: [{ id: "history", payerName: "B", payeeName: "A", amountYen: 600,
    completedAt: "2026-10-01T03:00:00.000Z" }],
};

if (mode === "partner") workspace.transactions.push(
  transaction("partner-payment", { amountYen: 400, expenseClass: "PERSONAL", actorUserId: "b", actorName: "B", splitWeights: { a: 0, b: 1 } }),
  transaction("partner-income", { type: "RECEIPT", amountYen: 1_200, expenseClass: "PERSONAL", actorUserId: "b", actorName: "B", splitWeights: { a: 0, b: 1 } }),
);

if (mode === "personal" || mode === "single") {
  workspace.workspace.type = mode === "personal" ? "PERSONAL" : "SHARED";
  workspace.members = workspace.members.slice(0, 1);
  workspace.workspace.memberCount = 1;
  workspace.transactions = workspace.transactions.map(item => ({ ...item, actorUserId: "a", actorName: "A",
    splitWeights: { a: 1 }, expenseClass: mode === "personal" ? "PERSONAL" : "SHARED" }));
}
if (mode === "overflow") {
  workspace.members[0].name = "長い名前のユーザーＡ".repeat(6);
  workspace.members[1].name = "長い名前のユーザーＢ".repeat(6);
  workspace.transactions = Array.from({ length: 3 }, (_, i) => transaction(`limit-${i}`, { amountYen: 2147483647 }));
}

let confirmedTransactions = workspace.transactions;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.pathname !== "/api/home") return realFetch(input, init);
  const month = url.searchParams.get("month")!;
  const monthly = workspaceCashflowSummary(transactionsInMonth(confirmedTransactions, month), workspace.members);
  const unsettled = confirmedTransactions.filter(item => item.expenseClass === "SHARED" && !item.settledAt);
  const result = workspace.workspace.type === "SHARED" ? calculateSettlement(workspace.members, confirmedTransactions) : null;
  return new Response(JSON.stringify({
    workspaceId: workspace.workspace.id, month,
    members: workspace.members.map(({ id, name }) => ({ id, name })),
    monthly: { people: [...monthly.people].map(([userId, totals]) => ({ userId, ...totals })), total: monthly.total },
    unsettled: { count: unsettled.length, ...cashflowSummary(unsettled) },
    settlement: result, settlementHistory: workspace.settlementHistory,
  }, (key, value) => key === "transactionIds" ? undefined : typeof value === "bigint" ? value.toString() : value), {
    headers: { "Content-Type": "application/json" },
  });
};

function Harness() {
  const [transactions, setTransactions] = useState(workspace.transactions);
  const [revision, setRevision] = useState(0);
  const selected = { ...workspace, transactions, settlement: calculateSettlement(workspace.members, transactions) };
  const run: RunAppAction = async payload => {
    const result = await postAction(payload);
    if (payload.action === "saveTransaction") {
      confirmedTransactions = confirmedTransactions.map(row => row.id === payload.transactionId
        ? { ...row, ...result.transaction } : row);
      setTransactions(confirmedTransactions);
      setRevision(current => current + 1);
    }
    return result;
  };
  return <main style={{ padding: 12, maxWidth: 1600 }}>
    <section id="home"><HomePanel selected={selected} userId="a" pending={0} setTab={() => {}} add={() => {}}
      run={run} revision={revision} refreshAction={null} refreshing={mode === "refreshing"} /></section>
    <section id="transactions"><TransactionsPanel selected={selected} userId="a" add={() => {}} run={run}
      onRefresh={async prepare => { await prepare(); }} refreshing={false} /></section>
    <output id="saved-transactions" hidden>{JSON.stringify(transactions)}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);

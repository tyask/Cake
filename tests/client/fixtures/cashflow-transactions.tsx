import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HomePanel } from "../../../components/home-panel";
import { TransactionsPanel } from "../../../components/transactions-panel";
import { SettlementPanel } from "../../../components/settlement-panel";
import { postAction } from "../../../lib/client/app-client";
import { calculateSettlement } from "../../../lib/shared/settlement";
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
  transactions: [
    transaction("payment"),
    transaction("receipt", { type: "RECEIPT", amountYen: 2_000, actorUserId: "b", actorName: "B" }),
    transaction("settled-receipt", { type: "RECEIPT", amountYen: 5_000, settledAt: "2026-10-11T03:00:00.000Z" }),
    transaction("past", { amountYen: 9_000, occurredAt: "2026-09-30T14:59:59.000Z", expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } }),
    transaction("future", { amountYen: mode === "negative" ? 8_000 : mode === "zero" ? 7_000 : 1_000,
      occurredAt: "2026-10-31T03:00:00.000Z", expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } }),
    transaction("same-amount-receipt", { type: "RECEIPT", expenseClass: "PERSONAL", splitWeights: { a: 1, b: 0 } }),
  ],
  settlement: null, settlementHistory: [{ id: "history", payerName: "B", payeeName: "A", amountYen: 600,
    completedAt: "2026-10-01T03:00:00.000Z" }],
};

function Harness() {
  const [transactions, setTransactions] = useState(workspace.transactions);
  const selected = { ...workspace, transactions, settlement: calculateSettlement(workspace.members, transactions) };
  const run: RunAppAction = async payload => {
    const result = await postAction(payload);
    if (payload.action === "saveTransaction") setTransactions(current => current.map(row => row.id === payload.transactionId
      ? { ...row, ...result.transaction } : row));
    return result;
  };
  return <main style={{ padding: 12, maxWidth: 1600 }}>
    <section id="home"><HomePanel selected={selected} pending={0} setTab={() => {}} add={() => {}}
      refreshAction={null} refreshing={false} /></section>
    <section id="transactions"><TransactionsPanel selected={selected} userId="a" add={() => {}} run={run}
      onRefresh={async prepare => { await prepare(); }} refreshing={false} /></section>
    <section id="settlement"><SettlementPanel selected={selected} run={run} refreshAction={null} refreshing={false} /></section>
    <output id="saved-transactions" hidden>{JSON.stringify(transactions)}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);

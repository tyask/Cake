import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TransactionsPanel } from "../../../components/transactions-panel";
import { NewTransactionModal } from "../../../components/new-transaction-modal";
import { postAction } from "../../../lib/client/app-client";
import type { RunAppAction } from "../../../lib/shared/schemas/app-input";
import type { WorkspaceData } from "../../../lib/shared/types";
import "../../../app/globals.css";

const longMemberName = new URLSearchParams(location.search).has("longNames") ? "W".repeat(120) : null;

const workspace: WorkspaceData = {
  workspace: { id: "workspace", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
  members: [
    { id: "a", name: longMemberName ?? "A", email: "a@example.test", imageUrl: null, weight: 1, role: "OWNER" },
    { id: "b", name: longMemberName ?? "B", email: "b@example.test", imageUrl: null, weight: 1, role: "MEMBER" },
  ],
  categories: [
    { id: "food", name: "食費", parentId: null, revision: 1, colorHex: "#f97316", sortOrder: 0, archivedAt: null },
    { id: "fresh", name: "生鮮食品", parentId: "food", revision: 1, colorHex: "#fb923c", sortOrder: 0, archivedAt: null },
    { id: "leaf", name: "野菜", parentId: "fresh", revision: 1, colorHex: "#fdba74", sortOrder: 0, archivedAt: null },
    { id: "old", name: "以前のカテゴリ", parentId: null, revision: 1, colorHex: "#3b82f6", sortOrder: 1, archivedAt: "2026-10-20T00:00:00Z" },
  ],
  rules: [],
  transactions: ["first", "settled"].map(id => ({
    id, merchant: id, amountYen: 100, occurredAt: "2026-10-20T03:00:00.000Z", method: "現金", memo: "", type: "PAYMENT", actorUserId: "a", actorName: "A", expenseClass: "SHARED", splitWeights: { a: 1, b: 1 }, settledAt: id === "settled" ? "2026-10-20T04:00:00Z" : null, externalId: id, source: "MANUAL", categoryId: id === "settled" ? "old" : null, categoryConfirmed: id === "settled", categoryRevision: id === "settled" ? 1 : 0,
  })),
  settlement: null, settlementHistory: [],
};

function Harness() {
  const [selected, setSelected] = useState(workspace);
  const [modal, setModal] = useState(false);
  const run: RunAppAction = async payload => {
    const result = await postAction(payload);
    if (payload.action === "saveTransactionCategory") setSelected(current => ({ ...current, transactions: current.transactions.map(row => {
      const revision = result.categoryRevision ?? row.categoryRevision + 1;
      return row.id === payload.transactionId && revision > row.categoryRevision
        ? { ...row, categoryId: result.categoryId, categoryConfirmed: result.categoryConfirmed, categoryRevision: revision } : row;
    }) }));
    if (payload.action === "saveTransaction" && payload.transactionId) setSelected(current => ({ ...current, transactions: current.transactions.map(row => row.id === payload.transactionId ? { ...row, ...result.transaction, categoryId: row.categoryId, categoryConfirmed: row.categoryConfirmed, categoryRevision: row.categoryRevision } : row) }));
    return result;
  };
  return <main style={{ padding: 12, maxWidth: 1600 }}>
    <TransactionsPanel selected={selected} userId="a" add={() => setModal(true)} run={run} onRefresh={async prepare => {
      try { await prepare(); await fetch("/api/test-refresh"); } catch { /* The real controller also keeps the editor on prepare failure. */ }
    }} refreshing={false} />
    {modal && <NewTransactionModal selected={selected} currentUserId="a" close={() => setModal(false)} run={run} />}
    <button onClick={() => setSelected(current => ({ ...current, transactions: current.transactions.map(row => row.id === "first"
      ? { ...row, categoryId: "fresh", categoryConfirmed: true, categoryRevision: 10 } : row) }))}>外部のカテゴリ更新を受信</button>
    <output id="saved-transactions" hidden>{JSON.stringify(selected.transactions)}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);

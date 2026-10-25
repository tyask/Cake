import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TransactionsPanel } from "../../../components/transactions-panel";
import { WorkspaceRules } from "../../../components/workspace-rules";
import { ImportPanel } from "../../../components/import-panel";
import { RecurringPaymentsPanel } from "../../../components/recurring-payments-panel";
import { postAction } from "../../../lib/client/app-client";
import type { RunAppAction } from "../../../lib/shared/schemas/app-input";
import type { WorkspaceData } from "../../../lib/shared/types";
import "../../../app/globals.css";

export const swipeWorkspace: WorkspaceData = {
  workspace: { id: "workspace", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
  members: [
    { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 6, role: "OWNER" },
    { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 4, role: "MEMBER" },
  ],
  categories: [], rules: ["rule1", "rule2"].map((id, sortOrder) => ({ id, merchantContains: id, expenseClass: "SHARED", sortOrder, splitWeights: null, enabled: true })),
  transactions: ["first", "second", "settled"].map(id => ({ id, merchant: id, amountYen: 100, occurredAt: "2026-10-18T03:00:00.000Z", method: "現金", memo: "", type: "PAYMENT", actorUserId: "a", actorName: "A", expenseClass: "SHARED", splitWeights: { a: 6, b: 4 }, settledAt: id === "settled" ? "2026-10-18T03:00:00.000Z" : null, externalId: id, source: "MANUAL", categoryId: null, categoryConfirmed: false, categoryRevision: 0 })),
  settlement: null, settlementHistory: [],
};

function Harness() {
  const [selected, setSelected] = useState(swipeWorkspace);
  const view = new URLSearchParams(location.search).get("view");
  const run: RunAppAction = async payload => {
    const result = await postAction(payload);
    if (payload.action === "deleteTransactions") setSelected(current => ({ ...current, transactions: current.transactions.filter(row => !payload.transactionIds.includes(row.id)) }));
    if (payload.action === "saveTransaction") setSelected(current => ({ ...current, transactions: current.transactions.map(row => row.id === payload.transactionId ? result.transaction : row) }));
    if (payload.action === "deleteRules") setSelected(current => ({ ...current, rules: current.rules.filter(row => !payload.ruleIds.includes(row.id)) }));
    return result;
  };
  return <main style={{ padding: 12, maxWidth: 1600 }}>
    {view === "import" ? <ImportPanel importHistoryRevision={0} selected={selected} currentUserId="a" run={run} />
      : view === "rules" ? <WorkspaceRules selected={selected} run={run} />
      : view === "recurring" ? <RecurringPaymentsPanel selected={selected} currentUserId="a" />
      : <TransactionsPanel selected={selected} userId="a" add={() => undefined} run={run} onRefresh={async prepare => { await prepare(); }} refreshing={false} />}
    <button type="button">一覧の外</button><div style={{ height: 1200 }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);

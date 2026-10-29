import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TransactionsPanel } from "../../../components/transactions-panel";
import { NewTransactionModal } from "../../../components/new-transaction-modal";
import { postAction } from "../../../lib/client/app-client";
import type { RunAppAction } from "../../../lib/shared/schemas/app-input";
import type { TransactionRecord, WorkspaceData } from "../../../lib/shared/types";
import type { TransactionViewSelection } from "../../../lib/shared/transaction-view";
import "../../../app/globals.css";

declare global {
  interface Window { sortSummaryInitial: WorkspaceData; }
}

function Harness() {
  const [selected, setSelected] = useState(window.sortSummaryInitial);
  const [selection, setSelection] = useState<TransactionViewSelection>({ mode: "month", month: "2026-10" });
  const [modal, setModal] = useState(false);
  const run: RunAppAction = async payload => {
    const result = await postAction(payload);
    if (payload.action === "saveTransaction") {
      const saved: TransactionRecord = result.transaction;
      setSelected(current => ({ ...current, transactions: current.transactions.some(row => row.id === saved.id)
        ? current.transactions.map(row => row.id === saved.id ? saved : row) : [saved, ...current.transactions] }));
    } else if (payload.action === "deleteTransactions") {
      const deleted = new Set<string>(result.deletedTransactionIds);
      setSelected(current => ({ ...current, transactions: current.transactions.filter(row => !deleted.has(row.id)) }));
    }
    return result;
  };
  return <main style={{ padding: 12, maxWidth: 1800, margin: "auto" }}>
    <TransactionsPanel selected={selected} userId="a" add={() => setModal(true)} run={run}
      onRefresh={async prepare => {
        await prepare();
        const response = await fetch("/api/test-transactions");
        const transactions: TransactionRecord[] = await response.json();
        setSelected(current => ({ ...current, transactions }));
      }} refreshing={false}
      view={{ selection, loading: false, error: null, onChange: async (next, prepare) => {
        await prepare();
        setSelection(next);
        return true;
      } }} />
    {modal && <NewTransactionModal selected={selected} currentUserId="a" close={() => setModal(false)} run={run} />}
    <output id="confirmed-transactions" hidden>{JSON.stringify(selected.transactions)}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);

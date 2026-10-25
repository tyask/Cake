import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportHistoryPanel } from "../../../components/import-history-panel";
import { ImportPanel } from "../../../components/import-panel";
import { postAction } from "../../../lib/client/app-client";
import { useDashboardController } from "../../../components/use-dashboard-controller";
import { TransactionListDialog } from "../../../components/transaction-list-dialog";
import type { TransactionRecord, WorkspaceData } from "../../../lib/shared/types";
import "../../../app/globals.css";

declare global {
  interface Window { importHistoryWorkspace: WorkspaceData; importHistoryTransactions: TransactionRecord[] }
}

function Fixture() {
  const [workspaceId, setWorkspaceId] = useState("workspace");
  const [revision, setRevision] = useState(0);
  const fullImport = new URLSearchParams(window.location.search).has("import");
  return <main style={{ padding: "16px", maxWidth: "1100px", margin: "auto" }}>
    <button onClick={() => setWorkspaceId(id => id === "workspace" ? "other-workspace" : "workspace")}>家計を切り替える</button>
    <button onClick={() => setRevision(value => value + 1)}>履歴を更新する</button>
    {fullImport ? <ImportPanel selected={window.importHistoryWorkspace} currentUserId="a" importHistoryRevision={revision} run={async payload => {
      const result = await postAction(payload);
      if (payload.action === "bulkImport") setRevision(value => value + 1);
      return result;
    }} />
      : <ImportHistoryPanel workspaceId={workspaceId} format="PAYPAY" refreshKey={revision} />}
  </main>;
}

function ControlledFixture() {
  const initialWorkspace = window.importHistoryWorkspace;
  const { selected, tab, notice, run, openTab, importHistoryRevision } = useDashboardController({
    user: initialWorkspace.members[0], workspaces: [initialWorkspace.workspace], selected: initialWorkspace, pendingInvitations: [],
  }, "import");
  return <main style={{ padding: "16px", maxWidth: "1100px", margin: "auto" }}>
    <nav><button onClick={() => openTab("import")}>取込へ移動</button><button onClick={() => openTab("home")}>ホームへ移動</button></nav>
    {notice && <p role="status">{notice}</p>}
    {selected && tab === "import" ? <ImportPanel selected={selected} currentUserId="a" run={run} importHistoryRevision={importHistoryRevision} /> : <h1>ホーム</h1>}
  </main>;
}

function ReusableDialogFixture() {
  const [open, setOpen] = useState(false);
  return <main style={{ padding: "16px" }}>
    <h1>別画面の明細</h1>
    <button onClick={() => setOpen(true)}>取得済み明細を表示</button>
    {open && <TransactionListDialog title="共有用の明細" description={<p>別画面で取得済みの明細を表示しています。</p>}
      state={{ status: "success", transactions: window.importHistoryTransactions, categories: window.importHistoryWorkspace.categories }}
      onClose={() => setOpen(false)} />}
  </main>;
}

const parameters = new URLSearchParams(window.location.search);
createRoot(document.getElementById("root")!).render(parameters.has("controller") ? <ControlledFixture /> : parameters.has("generic") ? <ReusableDialogFixture /> : <Fixture />);

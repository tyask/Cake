import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportHistoryPanel } from "../../../components/import-history-panel";
import { ImportPanel } from "../../../components/import-panel";
import { postAction } from "../../../lib/client/app-client";
import { useDashboardController } from "../../../components/use-dashboard-controller";
import type { WorkspaceData } from "../../../lib/shared/types";
import "../../../app/globals.css";

declare global {
  interface Window { importHistoryWorkspace: WorkspaceData }
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

createRoot(document.getElementById("root")!).render(new URLSearchParams(window.location.search).has("controller") ? <ControlledFixture /> : <Fixture />);

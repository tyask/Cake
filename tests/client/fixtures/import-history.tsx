import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportHistoryPanel } from "../../../components/import-history-panel";
import { ImportPanel } from "../../../components/import-panel";
import { postAction } from "../../../lib/client/app-client";
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
    {fullImport ? <ImportPanel selected={window.importHistoryWorkspace} currentUserId="a" run={payload => postAction(payload)} />
      : <ImportHistoryPanel workspaceId={workspaceId} format="PAYPAY" refreshKey={revision} />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);

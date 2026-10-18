import { createRoot } from "react-dom/client";
import { ImportPanel } from "../../components/import-panel";
import { postAction } from "../../lib/app-client";
import type { WorkspaceData } from "../../lib/types";
import "../../app/globals.css";

declare global {
  interface Window { importWorkspace: WorkspaceData }
}

createRoot(document.getElementById("root")!).render(<ImportPanel selected={window.importWorkspace}
  currentUserId="a" run={payload => postAction(payload)} />);

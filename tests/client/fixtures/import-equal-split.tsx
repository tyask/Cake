import { createRoot } from "react-dom/client";
import { RecurringPaymentsPanel } from "../../../components/recurring-payments-panel";
import { ImportPanel } from "../../../components/import-panel";
import { postAction } from "../../../lib/client/app-client";
import type { WorkspaceData } from "../../../lib/shared/types";
import "../../../app/globals.css";

declare global {
  interface Window { importWorkspace: WorkspaceData }
}

createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).get("view") === "recurring"
  ? <RecurringPaymentsPanel selected={window.importWorkspace} currentUserId="a" />
  : <ImportPanel selected={window.importWorkspace} currentUserId="a" run={payload => postAction(payload)} />);

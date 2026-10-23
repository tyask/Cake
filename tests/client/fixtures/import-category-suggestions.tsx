import { createRoot } from "react-dom/client";
import { ImportPanel } from "../../../components/import-panel";
import { postAction } from "../../../lib/client/app-client";
import type { WorkspaceData } from "../../../lib/shared/types";
import "../../../app/globals.css";

declare global {
  interface Window {
    importSuggestionWorkspace: WorkspaceData;
    updateImportSuggestionWorkspace: (workspace: WorkspaceData) => void;
    unmountImportSuggestions: () => void;
  }
}

const root = createRoot(document.getElementById("root")!);
function render(workspace: WorkspaceData) {
  root.render(<ImportPanel key={workspace.workspace.id} selected={workspace} currentUserId="a" run={payload => postAction(payload)} />);
}
window.updateImportSuggestionWorkspace = render;
window.unmountImportSuggestions = () => root.unmount();
render(window.importSuggestionWorkspace);

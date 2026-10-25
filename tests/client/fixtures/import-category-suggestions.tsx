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
  const panel = <ImportPanel key={workspace.workspace.id} selected={workspace} currentUserId="a" run={payload => postAction(payload)} />;
  root.render(new URLSearchParams(location.search).has("shell") ? <div className="app-shell">
    <main className="app-main">
      <header className="mobile-header"><b>Cake</b><select aria-label="家計" defaultValue={workspace.workspace.id}><option value={workspace.workspace.id}>{workspace.workspace.name}</option></select></header>
      <div className="demo-banner">テストログインで使用中です（A）</div>
      {panel}
    </main>
    <nav className="bottom-nav">{["ホーム", "取引明細", "取込", "集計", "設定"].map(label => <button type="button" key={label}><i>⌂</i><span>{label}</span></button>)}</nav>
  </div> : panel);
}
window.updateImportSuggestionWorkspace = render;
window.unmountImportSuggestions = () => root.unmount();
render(window.importSuggestionWorkspace);

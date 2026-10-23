import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportPanel } from "../../../components/import-panel";
import { postAction } from "../../../lib/client/app-client";
import type { WorkspaceData } from "../../../lib/shared/types";
import "../../../app/globals.css";

declare global {
  interface Window {
    importPasteWorkspace: WorkspaceData;
    importPasteClipboardReads: number;
    importPasteClipboardWrites: string[];
    importPasteClipboardWriteMode: "success" | "reject";
    importPasteClipboardActivations: boolean[];
    importPasteClipboardMode: "success" | "reject" | "pending" | "unsupported";
    importPasteClipboardText: string;
    importPasteResolveClipboard: ((text: string) => void) | null;
  }
}

function Fixture() {
  const [selected, setSelected] = useState(window.importPasteWorkspace);
  return <>
    <button onClick={() => setSelected(current => ({ ...current, workspace: { ...current.workspace, id: "other-workspace", name: "切替後の家計" } }))}>家計を切り替える</button>
    <ImportPanel key={selected.workspace.id} selected={selected} currentUserId="a" run={payload => postAction(payload)} />
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);

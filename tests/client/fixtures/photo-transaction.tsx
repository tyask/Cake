import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NewTransactionModal } from "../../../components/new-transaction-modal";
import { postAction } from "../../../lib/client/app-client";
import type { RunAppAction } from "../../../lib/shared/schemas/app-input";
import type { WorkspaceMetadata } from "../../../lib/shared/types";
import "../../../app/globals.css";

const workspace: WorkspaceMetadata = {
  workspace: { id: "10000000-0000-4000-8000-000000000001", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
  members: [
    { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 6, role: "OWNER" },
    { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 4, role: "MEMBER" },
  ],
  categories: [
    { id: "20000000-0000-4000-8000-000000000001", name: "食費", parentId: null, revision: 1, colorHex: "#16a34a", sortOrder: 0, archivedAt: null },
    { id: "20000000-0000-4000-8000-000000000002", name: "日用品", parentId: null, revision: 1, colorHex: "#2563eb", sortOrder: 1, archivedAt: null },
  ],
  rules: [{ id: "rule", merchantContains: "ルール店", expenseClass: "SHARED", splitWeights: { a: 3, b: 1 }, enabled: true, sortOrder: 0 }],
};

function Harness() {
  const [open, setOpen] = useState(true);
  const [workspaceId, setWorkspaceId] = useState(workspace.workspace.id);
  const run: RunAppAction = async payload => postAction(payload);
  return <>
    <button onClick={() => setWorkspaceId("10000000-0000-4000-8000-000000000002")}>家計を切り替える</button>
    <button onClick={() => setOpen(true)}>明細を開く</button>
    {open ? <NewTransactionModal key={workspaceId} selected={{ ...workspace, workspace: { ...workspace.workspace, id: workspaceId } }} currentUserId="a" close={() => setOpen(false)} run={run} /> : <p>明細を閉じました</p>}
  </>;
}

createRoot(document.getElementById("root")!).render(<Harness />);

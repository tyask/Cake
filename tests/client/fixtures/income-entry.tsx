import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NewTransactionModal } from "../../../components/new-transaction-modal";
import { postAction } from "../../../lib/client/app-client";
import type { RunAppAction } from "../../../lib/shared/schemas/app-input";
import type { WorkspaceData } from "../../../lib/shared/types";
import "../../../app/globals.css";

const workspace: WorkspaceData = {
  workspace: { id: "workspace", name: "家計", type: "SHARED", ownerUserId: "a", memberCount: 2 },
  members: [
    { id: "a", name: "A", email: "a@example.test", imageUrl: null, weight: 6, role: "OWNER" },
    { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 4, role: "MEMBER" },
  ],
  categories: [{ id: "income", name: "収入", parentId: null, revision: 1, colorHex: "#16a34a", sortOrder: 0, archivedAt: null }],
  rules: [
    { id: "rule", merchantContains: "ルール店", expenseClass: "SHARED", splitWeights: { a: 3, b: 1 }, enabled: true, sortOrder: 0 },
    { id: "personal", merchantContains: "個人専用", expenseClass: "PERSONAL", splitWeights: null, enabled: true, sortOrder: 1 },
  ],
  transactions: [], settlement: null, settlementHistory: [],
};

function Harness() {
  const [open, setOpen] = useState(true);
  const run: RunAppAction = async payload => postAction(payload);
  return open ? <NewTransactionModal selected={workspace} currentUserId="a" close={() => setOpen(false)} run={run} /> : <p>保存完了</p>;
}

createRoot(document.getElementById("root")!).render(<Harness />);

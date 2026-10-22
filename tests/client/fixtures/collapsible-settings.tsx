import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PersonalSettings } from "../../../components/personal-settings";
import { SettingsPanel } from "../../../components/workspace-settings-panel";
import { postAction } from "../../../lib/client/app-client";
import type { AppUser, WorkspaceData } from "../../../lib/shared/types";
import "../../../app/globals.css";

const user: AppUser = { id: "a", name: "A", email: "long-personal-account-address@example.test", imageUrl: null };
const singleMember = new URLSearchParams(location.search).get("members") === "1";
const selected: WorkspaceData = {
  workspace: { id: "workspace", name: "ふたりの家計", type: "SHARED", ownerUserId: "a", memberCount: singleMember ? 1 : 2 },
  members: [
    { ...user, weight: 6, role: "OWNER" as const },
    { id: "b", name: "B", email: "b@example.test", imageUrl: null, weight: 4, role: "MEMBER" as const },
  ].slice(0, singleMember ? 1 : 2),
  categories: [{ id: "food", name: "食費", colorHex: "#f97316", parentId: null, sortOrder: 0, revision: 1, archivedAt: null }],
  rules: [{ id: "rule", merchantContains: "スーパー", expenseClass: "SHARED", sortOrder: 0, splitWeights: null, enabled: true }],
  transactions: [], settlement: null, settlementHistory: [],
};

function Harness() {
  const [settings, setSettings] = useState(true);
  return <main style={{ padding: 12, maxWidth: 1200, margin: "auto" }}>
    <button type="button" className="secondary" onClick={() => setSettings(current => !current)}>{settings ? "設定画面を離れる" : "設定画面に戻る"}</button>
    {settings && <>
      <PersonalSettings user={user} run={postAction} />
      <section className="settings-group" aria-labelledby="workspace-settings-title">
        <div className="settings-group-heading"><h2 id="workspace-settings-title">ワークスペース設定</h2><p>{selected.workspace.name}の設定です。</p></div>
        <SettingsPanel selected={selected} currentUserId={user.id} run={postAction} afterDelete={async () => undefined} />
      </section>
    </>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);

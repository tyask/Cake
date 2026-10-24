"use client";

import { useState } from "react";
import type { RunAppAction } from "@/lib/shared/schemas/app-input";
import { postAction } from "@/lib/client/app-client";
import { defaultSplitWeights, validateSplitWeights } from "@/lib/shared/expense-splits";
import type { SplitWeights, WorkspaceData } from "@/lib/shared/types";
import { SplitEditor } from "./split-editor";
import { RecurringPaymentsPanel } from "./recurring-payments-panel";
import { WorkspaceRules } from "./workspace-rules";
import { CategorySettings } from "./category-settings";
import { SettingsSection } from "./settings-section";

export function SettingsPanel({ selected, currentUserId, run, afterDelete }: { selected: WorkspaceData; currentUserId: string; run: RunAppAction; afterDelete: () => Promise<void> }) {
  const [name, setName] = useState(selected.workspace.name);
  const [email, setEmail] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [weights, setWeights] = useState<SplitWeights>(() => defaultSplitWeights(selected.members));
  const [deleteName, setDeleteName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savingWeights, setSavingWeights] = useState(false);

  async function invite() {
    setError(null);
    try {
      const result = await run({ action: "createInvite", workspaceId: selected.workspace.id, email }, "招待リンクを作成しました。") as { invitePath: string };
      setInviteLink(`${location.origin}${result.invitePath}`);
      setEmail("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "招待できませんでした。"); }
  }

  async function saveWeights() {
    setError(null);
    setSavingWeights(true);
    try {
      const validWeights = validateSplitWeights(weights, selected.members);
      await run({ action: "updateWeights", workspaceId: selected.workspace.id,
        weights: selected.members.map((member) => ({ userId: member.id, weight: validWeights[member.id] })) }, "共有のデフォルト割合を保存しました。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "割合を保存できませんでした。"); }
    finally { setSavingWeights(false); }
  }

  async function removeWorkspace() {
    if (deleteName !== selected.workspace.name) return;
    if (!confirm("関連する明細・ルール・清算履歴もすべて削除されます。続けますか？")) return;
    await postAction({ action: "deleteWorkspace", workspaceId: selected.workspace.id, confirmationName: deleteName });
    await afterDelete();
  }

  return <>
    <SettingsSection title="基本情報" contentClassName="settings-section">
      <label>ワークスペース名<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>種類<input value={selected.workspace.type === "SHARED" ? "共有用" : "個人用"} disabled /></label>
      <button className="secondary" onClick={() => run({ action: "updateWorkspace", workspaceId: selected.workspace.id, name }, "名前を変更しました。")}>変更を保存</button>
    </SettingsSection>
    <SettingsSection title="ワークスペースのデフォルト割合" contentClassName="settings-section">
      {selected.members.map((member) => <div className="member-row" key={member.id}>
        <span className="avatar">{member.name.slice(0, 1)}</span>
        <span><b>{member.name}{member.id === currentUserId && "（あなた）"}</b><small>{member.email}</small></span>
      </div>)}
      {selected.workspace.type === "SHARED" && <div className="default-split-settings">
        <SplitEditor members={selected.members} value={weights} onChange={setWeights} disabled={savingWeights || selected.members.length < 2} label="デフォルト割合" />
        <p className="ratio-note">区分が「共有」の新しい明細の初期値に使います。保存済みの明細は、それぞれの割合で清算します。</p>
        {selected.members.length === 2 && <button className="secondary" disabled={savingWeights} onClick={saveWeights}>{savingWeights ? "保存中…" : "割合を保存"}</button>}
      </div>}
      {selected.workspace.type === "SHARED" && selected.members.length < 2 && <div className="invite-form">
        <label>相手のGoogleアカウントのメール<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="partner@example.com" /></label>
        <button className="secondary" onClick={invite}>招待リンクを作成</button>
        {inviteLink && <div className="copy-box"><input readOnly value={inviteLink} /><button onClick={() => navigator.clipboard.writeText(inviteLink)}>コピー</button></div>}
      </div>}
      {error && <p className="settings-error form-error" role="alert">{error}</p>}
    </SettingsSection>
    <CategorySettings categories={selected.categories} workspaceId={selected.workspace.id} run={run} />
    <RecurringPaymentsPanel selected={selected} currentUserId={currentUserId} />
    <WorkspaceRules selected={selected} run={run} />
    <SettingsSection title="ワークスペースを削除" className="danger-settings-panel" contentClassName="danger-zone">
      <p>関連する明細、招待、ルール、清算履歴がすべて削除され、元に戻せません。</p>
      <label>確認のため「{selected.workspace.name}」と入力<input value={deleteName} onChange={(event) => setDeleteName(event.target.value)} /></label>
      <button disabled={deleteName !== selected.workspace.name} onClick={removeWorkspace}>完全に削除</button>
    </SettingsSection>
  </>;
}

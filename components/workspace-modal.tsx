"use client";

import { useState } from "react";
import type { RunAppAction } from "@/lib/shared/schemas/app-input";
import { MAX_WORKSPACE_NAME_LENGTH, workspaceTypeLabels } from "@/lib/shared/domain-values";
import type { WorkspaceType } from "@/lib/shared/types";
import { Modal } from "./dashboard-ui";

export function WorkspaceModal({ close, run }: { close: () => void; run: RunAppAction }) {
  const [name, setName] = useState(""); const [type, setType] = useState<WorkspaceType>("PERSONAL");
  return <Modal title="ワークスペースを作成" close={close}><form onSubmit={async (event) => { event.preventDefault(); await run({ action: "createWorkspace", name, type }, "ワークスペースを作成しました。"); close(); }}><label>名前<input required maxLength={MAX_WORKSPACE_NAME_LENGTH} value={name} onChange={(event) => setName(event.target.value)} placeholder="例: ふたりの家計" /></label><fieldset><legend>種類</legend><label className={`choice ${type === "PERSONAL" ? "selected" : ""}`}><input type="radio" checked={type === "PERSONAL"} onChange={() => setType("PERSONAL")} /><span><b>{workspaceTypeLabels.PERSONAL}</b><small>自分だけで管理する家計</small></span></label><label className={`choice ${type === "SHARED" ? "selected" : ""}`}><input type="radio" checked={type === "SHARED"} onChange={() => setType("SHARED")} /><span><b>{workspaceTypeLabels.SHARED}</b><small>もう一人を招待して清算</small></span></label></fieldset><div className="modal-actions"><button type="button" className="secondary" onClick={close}>キャンセル</button><button className="primary">作成する</button></div></form></Modal>;
}

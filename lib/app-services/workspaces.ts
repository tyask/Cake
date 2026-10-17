import { createHash, randomBytes, randomUUID } from "node:crypto";
import { validateSplitWeights } from "../expense-splits";
import type { AppStore } from "../app-store";
import type { AppUser } from "../types";
import type { Action } from "./types";

export async function workspacesService(store: AppStore, user: AppUser, input: Action<"updateProfile" | "createWorkspace" | "updateWorkspace" | "deleteWorkspace" | "createInvite" | "acceptInvite" | "updateWeights">) {
  if (input.action === "updateProfile") {
    return { ok: true, user: await store.updateDisplayName(user, input.name) };
  }

  if (input.action === "createWorkspace") {
    const workspaceId = randomUUID();
    await store.createWorkspace(workspaceId, input, user);
    return { ok: true, workspaceId };
  }

  if (input.action === "updateWorkspace") {
    await store.requireWorkspaceMember(input.workspaceId, user.id);
    await store.updateWorkspace(input);
    return { ok: true };
  }

  if (input.action === "deleteWorkspace") {
    const workspace = await store.requireWorkspaceMember(input.workspaceId, user.id);
    if (String(workspace.name) !== input.confirmationName) throw new Error("ワークスペース名が一致しません。");
    await store.deleteWorkspace(input);
    return { ok: true };
  }

  if (input.action === "createInvite") {
    const workspace = await store.requireWorkspaceMember(input.workspaceId, user.id);
    if (workspace.type !== "SHARED") throw new Error("共有ワークスペースでのみ招待できます。");
    if (input.email.toLowerCase() === user.email.toLowerCase()) throw new Error("自分自身は招待できません。");
    const countRows = await store.memberCount(input.workspaceId);
    if (Number(countRows[0].count) >= 2) throw new Error("共有ワークスペースは二人までです。");
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await store.createInvite(input, user, tokenHash);
    return { ok: true, invitePath: `/invite/${token}` };
  }

  if (input.action === "acceptInvite") {
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    const invites = await store.findInvite(tokenHash);
    const invite = invites[0];
    if (!invite || String(invite.email).toLowerCase() !== user.email.toLowerCase()) {
      throw new Error("この招待は無効、期限切れ、または別のメールアドレス宛てです。");
    }
    const countRows = await store.memberCount(String(invite.workspace_id));
    if (Number(countRows[0].count) >= 2) throw new Error("このワークスペースにはすでに二人参加しています。");
    await store.acceptInvite(invite, user);
    return { ok: true, workspaceId: String(invite.workspace_id) };
  }

  if (input.action === "updateWeights") {
    const workspace = await store.requireWorkspaceMember(input.workspaceId, user.id);
    if (workspace.type !== "SHARED") throw new Error("共有ワークスペースのみデフォルト割合を設定できます。");
    const memberRows = await store.memberIds(input.workspaceId);
    const memberIds = memberRows.map((row) => String(row.user_id));
    if (new Set(input.weights.map((item) => item.userId)).size !== input.weights.length) throw new Error("参加者が重複しています。");
    validateSplitWeights(Object.fromEntries(input.weights.map((item) => [item.userId, item.weight])), memberIds);
    await store.updateWeights(input);
    return { ok: true };
  }

  const unhandled: never = input;
  throw new Error(`未対応の操作です: ${unhandled}`);
}

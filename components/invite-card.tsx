"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { TestLoginButtons } from "./test-login-buttons";

export function InviteCard({ token, signedIn, testAuth = false }: { token: string; signedIn: boolean; testAuth?: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function accept() {
    setLoading(true); setMessage(null);
    try {
      const response = await fetch("/api/app", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "acceptInvite", token }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "招待を承認できませんでした。");
      location.href = `/?workspaceId=${result.workspaceId}`;
    } catch (error) { setMessage(error instanceof Error ? error.message : "招待を承認できませんでした。"); setLoading(false); }
  }
  return <main className="invite-page"><section className="invite-card"><div className="app-logo"><span>C</span><b>Cake</b></div><div className="invite-symbol">♧</div><p className="kicker">WORKSPACE INVITATION</p><h1>ふたりの家計に<br />招待されています</h1><p>{testAuth ? "招待先に対応するテストユーザーでログインし、ワークスペースへの参加を承認してください。" : "招待されたGoogleアカウントでログインし、ワークスペースへの参加を承認してください。"}</p>{message && <p className="form-error">{message}</p>}{signedIn ? <button className="primary" disabled={loading} onClick={accept}>{loading ? "確認中…" : "招待を承認する"}</button> : testAuth ? <TestLoginButtons redirectTo={`/invite/${token}`} /> : <button className="google-button" onClick={() => signIn("google", { redirectTo: location.href })}><span className="google-mark">G</span>Googleでログインして続ける</button>}</section></main>;
}

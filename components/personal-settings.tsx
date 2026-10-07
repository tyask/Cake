"use client";

import { signOut } from "next-auth/react";
import { useState } from "react";
import { PROFILE_NAME_MAX_LENGTH } from "@/lib/user-profile";
import type { AppUser } from "@/lib/types";

export function PersonalSettings({ user, run }: {
  user: AppUser;
  run: (payload: Record<string, unknown>, success: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  return <section className="settings-group" aria-labelledby="personal-settings-title">
    <div className="settings-group-heading"><h2 id="personal-settings-title">個人設定</h2><p>あなたのプロフィールを設定します。</p></div>
    <section className="panel personal-settings-panel">
      <form onSubmit={async event => {
        event.preventDefault();
        setError(null);
        setSaving(true);
        try { await run({ action: "updateProfile", name }, "ユーザー名を変更しました。"); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "ユーザー名を保存できませんでした。"); }
        finally { setSaving(false); }
      }}>
        <label htmlFor="profile-name">ユーザー名<input id="profile-name" required maxLength={PROFILE_NAME_MAX_LENGTH} value={name} disabled={saving || loggingOut} onChange={event => setName(event.target.value)} autoComplete="nickname" /></label>
        <p>支払者や清算画面に表示する名前です。</p>
        <div className="personal-account-email"><span>メールアドレス</span><b>{user.email}</b></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="secondary" disabled={saving || loggingOut || !name.trim() || name.trim() === user.name}>{saving ? "保存中…" : "変更を保存"}</button>
      </form>
      <div className="personal-session">
        <button type="button" className="secondary" disabled={saving || loggingOut} onClick={async () => {
          setLogoutError(null);
          setLoggingOut(true);
          try { await signOut({ redirectTo: "/" }); }
          catch { setLogoutError("ログアウトできませんでした。もう一度お試しください。"); setLoggingOut(false); }
        }}>{loggingOut ? "ログアウト中…" : "ログアウト"}</button>
        {logoutError && <p className="form-error" role="alert">{logoutError}</p>}
      </div>
    </section>
  </section>;
}

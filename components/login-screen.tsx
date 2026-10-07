"use client";

import Image from "next/image";
import { signIn } from "next-auth/react";
import { useState } from "react";
import { TestLoginButtons } from "./test-login-buttons";

export function LoginScreen({ testAuth = false, error }: { testAuth?: boolean; error?: string }) {
  const [signingIn, setSigningIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const errorMessage = loginError ?? (error === "AccessDenied"
    ? "このGoogleアカウントはCakeに登録されていません。管理者に登録を依頼してください。"
    : error ? "ログインできませんでした。もう一度お試しください。" : null);

  async function login() {
    if (signingIn) return;
    setSigningIn(true);
    setLoginError(null);
    try {
      await signIn("google", { redirectTo: "/" });
    } catch {
      setLoginError("ログインできませんでした。もう一度お試しください。");
      setSigningIn(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-label="Cakeにログイン">
        <header className="login-brand">
          <h1><Image src="/brand/cake-logo.svg" alt="Cake" width={260} height={210} className="login-logo" priority /></h1>
        </header>
        <div className="login-actions">
          {errorMessage && <p className="form-error login-error" role="alert">{errorMessage}</p>}
          {testAuth ? <TestLoginButtons /> : <>
            <button className="google-button" disabled={signingIn} onClick={login}>
              <span className="google-mark">G</span>{signingIn ? "ログイン画面へ移動中…" : "Googleでログイン"}
            </button>
            <p className="login-note">ログインすると、利用規約とプライバシーポリシーに同意したものとみなされます。</p>
          </>}
        </div>
      </section>
      <p className="login-caption">家計管理アプリ</p>
    </main>
  );
}

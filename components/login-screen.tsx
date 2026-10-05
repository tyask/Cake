"use client";

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
      <section className="login-panel">
        <div className="login-copy">
          <div className="logo"><span>C</span>Cake</div>
          <p className="kicker">SHARED HOUSEHOLD BUDGET</p>
          <h1>ふたりのお金を、<br />ひとつの景色に。</h1>
          <p className="login-lead">支払いを取り込み、負担を整え、清算まで迷わず。個人の家計も、ふたりの家計も、同じ場所で管理できます。</p>
          {errorMessage && <p className="form-error login-error" role="alert">{errorMessage}</p>}
          {testAuth ? <TestLoginButtons /> : <>
            <button className="google-button" disabled={signingIn} onClick={login}>
              <span className="google-mark">G</span>{signingIn ? "ログイン画面へ移動中…" : "Googleでログイン"}
            </button>
            <p className="login-note">ログインすると、利用規約とプライバシーポリシーに同意したものとみなされます。</p>
          </>}
        </div>
        <div className="login-visual" aria-hidden="true">
          <div className="balance-card">
            <span>今月の共通費</span><strong>¥84,320</strong>
            <div className="balance-row"><span>あなた</span><b>60%</b></div>
            <div className="bar"><i /></div>
            <div className="settlement-pill">B → A　¥5,200</div>
          </div>
          <div className="orb orb-one" /><div className="orb orb-two" />
        </div>
      </section>
    </main>
  );
}

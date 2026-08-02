"use client";

import { signIn } from "next-auth/react";
import { TestLoginButtons } from "./test-login-buttons";

export function LoginScreen({ testAuth = false }: { testAuth?: boolean }) {
  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-copy">
          <div className="logo"><span>C</span>Cake</div>
          <p className="kicker">SHARED HOUSEHOLD BUDGET</p>
          <h1>ふたりのお金を、<br />ひとつの景色に。</h1>
          <p className="login-lead">支払いを取り込み、負担を整え、清算まで迷わず。個人の家計も、ふたりの家計も、同じ場所で管理できます。</p>
          {testAuth ? <TestLoginButtons /> : <>
            <button className="google-button" onClick={() => signIn("google")}>
              <span className="google-mark">G</span>Googleでログイン
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

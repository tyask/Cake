"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { TEST_USERS } from "@/lib/test-users";

export function TestLoginButtons({ redirectTo = "/" }: { redirectTo?: string }) {
  const [pending, setPending] = useState<string | null>(null);

  async function login(key: string) {
    setPending(key);
    await signIn("test-login", { testUserKey: key, redirectTo });
    setPending(null);
  }

  return (
    <div className="test-login">
      <p className="test-login-label">テストするユーザーを選択</p>
      {TEST_USERS.map((user) => (
        <button key={user.key} disabled={pending !== null} onClick={() => login(user.key)}>
          <span>{user.name.slice(-1)}</span>
          <span><b>{user.name}</b><small>{user.email}</small></span>
          <i>{pending === user.key ? "ログイン中…" : "ログイン →"}</i>
        </button>
      ))}
      <p className="test-login-note">開発・Preview環境専用のログインです</p>
    </div>
  );
}

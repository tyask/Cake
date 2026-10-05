"use client";

import { useEffect, useState, type FormEvent } from "react";

type ApprovedUser = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  isEnabled: boolean;
};

class UserManagementError extends Error {}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof UserManagementError ? error.message : fallback;
}

async function readUsers(response: Response): Promise<ApprovedUser[]> {
  const result = await response.json();
  if (!response.ok) {
    if (typeof result.error === "string" && result.error.trim()) throw new UserManagementError(result.error);
    throw new Error("Request failed");
  }
  if (!Array.isArray(result.users)) throw new Error("Invalid response");
  return result.users;
}

export function UserManagement() {
  const [users, setUsers] = useState<ApprovedUser[] | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const activeUsers = users?.filter((user) => user.isEnabled) ?? [];
  const atCapacity = activeUsers.length >= 2;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/admin/users", { cache: "no-store", signal: controller.signal });
        const nextUsers = await readUsers(response);
        if (!controller.signal.aborted) setUsers(nextUsers);
      } catch (reason) {
        if (!controller.signal.aborted) setError(errorMessage(reason, "利用者を読み込めませんでした。もう一度お試しください。"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  async function retry() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      setUsers(await readUsers(await fetch("/api/admin/users", { cache: "no-store" })));
    } catch (reason) {
      setError(errorMessage(reason, "利用者を読み込めませんでした。もう一度お試しください。"));
    } finally {
      setLoading(false);
    }
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || users === null || atCapacity) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}) }),
      });
      setUsers(await readUsers(response));
      setEmail("");
      setName("");
      setMessage("利用者を登録しました。登録したGoogleアカウントでログインできます。");
    } catch (reason) {
      setError(errorMessage(reason, "利用者を登録できませんでした。メールアドレスと登録人数を確認し、もう一度お試しください。"));
    } finally {
      setLoading(false);
    }
  }

  async function disable(user: ApprovedUser) {
    if (loading || user.isAdmin || !user.isEnabled) return;
    if (!confirm("この利用者のログインを無効にします。家計データは残ります。続けますか？")) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      setUsers(await readUsers(response));
      setMessage("利用者のログインを無効にしました。");
    } catch (reason) {
      setError(errorMessage(reason, "利用者のログインを無効にできませんでした。もう一度お試しください。"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel user-management" aria-labelledby="user-management-title" aria-busy={loading}>
      <div className="panel-head">
        <div><span>USERS</span><h2 id="user-management-title">利用者管理</h2></div>
        {users !== null && <span className="user-capacity">{activeUsers.length} / 2人</span>}
      </div>
      <p className="section-note">利用できるのは管理者を含めて2人までです。登録後、共有家計への招待ができます。</p>
      {loading && <p className="user-management-feedback" role="status">確認中…</p>}
      {error && <p className="user-management-feedback form-error" role="alert">{error}</p>}
      {message && <p className="user-management-feedback user-management-success" role="status">{message}</p>}
      {users === null && !loading && <button type="button" className="secondary user-management-retry" onClick={retry}>もう一度読み込む</button>}
      {users !== null && <>
        <ul className="approved-user-list">
          {activeUsers.map((user) => (
            <li className="approved-user" key={user.id}>
              <span className="avatar" aria-hidden="true">{user.name.slice(0, 1)}</span>
              <span className="approved-user-name"><b>{user.name}</b><small>{user.email}</small></span>
              {user.isAdmin ? <span className="success-tag">管理者</span> : <button type="button" className="danger-text" disabled={loading} onClick={() => disable(user)} aria-label={`${user.name}のログインを無効にする`}>無効にする</button>}
            </li>
          ))}
        </ul>
        {atCapacity ? <p className="user-management-feedback">利用者は2人登録されています。</p> : (
          <form className="user-registration-form" onSubmit={register}>
            <fieldset disabled={loading}>
              <label>利用者のGoogleアカウントのメール<input type="email" name="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="partner@example.com" /></label>
              <label>名前（任意）<input type="text" name="name" maxLength={80} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="名前" /></label>
              <button type="submit" className="primary" disabled={!email.trim()}>登録する</button>
            </fieldset>
          </form>
        )}
      </>}
    </section>
  );
}

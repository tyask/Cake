import test from "node:test";
import assert from "node:assert/strict";
import type { Profile } from "next-auth";
import { createAuthCallbacks, resolveSessionUser, type UserAccessStore } from "../lib/auth-callbacks";
import { normalizeEmail } from "../lib/user-access";
import type { AppUser, RegisteredUser } from "../lib/types";

const admin: RegisteredUser = {
  id: "internal-admin-id", email: "t.yasu417@gmail.com", name: "管理者", imageUrl: null,
  isAdmin: true, isEnabled: true,
};

function fixture(initial: RegisteredUser | null = admin) {
  const state = { user: initial ? { ...initial } : null, reads: 0, updates: [] as AppUser[], testRegistrations: 0 };
  const store: UserAccessStore = {
    async findRegisteredUser(email) {
      state.reads++;
      return state.user?.email === normalizeEmail(email) ? state.user : null;
    },
    async updateRegisteredProfile(user) {
      state.updates.push(user);
      return state.user?.id === user.id && state.user.isEnabled;
    },
    async ensureTestUser() { state.testRegistrations++; return true; },
  };
  return { state, callbacks: createAuthCallbacks(store) };
}

function googleInput(email = admin.email) {
  return {
    user: { id: "google-subject", email, name: "Googleの名前", image: null },
    account: { provider: "google", type: "oidc" as const, providerAccountId: "google-subject" },
    profile: { email, email_verified: true },
  };
}

async function withAuthMode(mode: string, vercelEnvironment: string, run: () => Promise<void>) {
  const previousMode = process.env.AUTH_MODE;
  const previousVercel = process.env.VERCEL_ENV;
  process.env.AUTH_MODE = mode;
  process.env.VERCEL_ENV = vercelEnvironment;
  try { await run(); } finally {
    if (previousMode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previousMode;
    if (previousVercel === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previousVercel;
  }
}

test("登録済みGoogle利用者だけを許可し、プロフィール更新に内部IDを使う", async () => {
  await withAuthMode("google", "production", async () => {
    const { callbacks, state } = fixture();
    assert.equal(await callbacks.signIn!(googleInput()), true);
    assert.equal(state.updates.length, 1);
    assert.equal(state.updates[0].id, admin.id);
    assert.equal(state.updates[0].isAdmin, undefined);
    assert.equal(state.user?.isAdmin, true);
  });
});

test("未確認・確認フラグ欠落・異なるメールではDB照合や登録を行わない", async () => {
  await withAuthMode("google", "production", async () => {
    for (const profile of [
      { email: admin.email, email_verified: false },
      { email: admin.email, email_verified: "true" },
      { email: admin.email },
      { email: "other@example.com", email_verified: true },
    ]) {
      const { callbacks, state } = fixture();
      assert.equal(await callbacks.signIn!({ ...googleInput(), profile: profile as unknown as Profile }), false);
      assert.equal(state.reads, 0);
      assert.equal(state.updates.length, 0);
    }
  });
});

test("未登録または無効なGoogle利用者を自動登録しない", async () => {
  await withAuthMode("google", "production", async () => {
    for (const user of [null, { ...admin, isEnabled: false }]) {
      const { callbacks, state } = fixture(user);
      assert.equal(await callbacks.signIn!(googleInput()), false);
      assert.equal(state.updates.length, 0);
      assert.equal(state.testRegistrations, 0);
    }
  });
});

test("Google以外のプロバイダーを本番で許可しない", async () => {
  await withAuthMode("google", "production", async () => {
    const { callbacks, state } = fixture();
    const input = googleInput();
    assert.equal(await callbacks.signIn!({ ...input, account: { ...input.account, provider: "other" } }), false);
    assert.equal(state.reads, 0);
  });
});

test("GoogleログインのJWTは事前登録IDを使い、ログイン途中の無効化も拒否する", async () => {
  await withAuthMode("google", "production", async () => {
    const { callbacks, state } = fixture();
    const input = { ...googleInput(), token: { sub: "google-subject" }, trigger: "signIn" as const };
    const token = await callbacks.jwt!(input);
    assert.equal(token?.sub, admin.id);
    assert.equal(token?.email, admin.email);
    state.user!.isEnabled = false;
    assert.equal(await callbacks.jwt!(input), null);
  });
});

test("有効なJWTでもDBで無効化・削除された利用者はアクセスできない", async () => {
  await withAuthMode("google", "production", async () => {
    const identity = { id: admin.id, email: admin.email };
    assert.equal(await resolveSessionUser(identity, async () => null), null);
    assert.equal(await resolveSessionUser(identity, async () => ({ ...admin, isEnabled: false })), null);
  });
});

test("管理者権限はセッションの値ではなく現在のDBレコードを使う", async () => {
  await withAuthMode("google", "production", async () => {
    const oldIdentity = { id: admin.id, email: admin.email, isAdmin: true };
    const current = await resolveSessionUser(oldIdentity, async () => ({ ...admin, isAdmin: false }));
    assert.equal(current?.isAdmin, false);
  });
});

test("テスト認証は固定のIDとメールが一致する場合だけ許可し、本番では拒否する", async () => {
  const input = {
    user: { id: "test-user-a", email: "test-a@cake.local", name: "テストユーザーA" },
    account: { provider: "test-login", type: "credentials" as const, providerAccountId: "test-user-a" },
  };
  await withAuthMode("test", "preview", async () => {
    const { callbacks, state } = fixture();
    assert.equal(await callbacks.signIn!(input), true);
    assert.equal(state.testRegistrations, 1);
    assert.equal(await callbacks.signIn!({ ...input, user: { ...input.user, email: admin.email } }), false);
    assert.equal(await callbacks.signIn!(googleInput()), false);
    const current = await resolveSessionUser(input.user, async () => ({ ...admin, ...input.user, isAdmin: true }));
    assert.equal(current?.isAdmin, false);
  });
  await withAuthMode("test", "production", async () => {
    const { callbacks, state } = fixture();
    assert.equal(await callbacks.signIn!(input), false);
    assert.equal(state.testRegistrations, 0);
    let reads = 0;
    assert.equal(await resolveSessionUser(input.user, async () => { reads++; return admin; }), null);
    assert.equal(reads, 0);
  });
});

test("メールは前後空白と大小文字だけを正規化し、別名を同一視しない", () => {
  assert.equal(normalizeEmail(" T.YASU417@GMAIL.COM "), admin.email);
  assert.equal(normalizeEmail("t.yasu417+cake@gmail.com"), "t.yasu417+cake@gmail.com");
  assert.equal(normalizeEmail("bad-email"), null);
  assert.equal(normalizeEmail(undefined), null);
});

import { createHash } from 'node:crypto';
import test, { type TestContext } from "node:test";
import { neonConfig } from "@neondatabase/serverless";
import assert from "node:assert/strict";
import type { Profile } from "next-auth";
import { createAuthCallbacks, resolveSessionUser, type UserAccessStore } from "../../lib/server/auth/auth-callbacks";
import {
  disableUser, ensureTestUser, listRegisteredUsers, normalizeEmail, registerUser,
  requireAdministrator, updateDisplayName, type UserAccessError,
} from "../../lib/server/auth/user-access";
import { QA_TEST_USERS, TEST_USERS } from "../../lib/shared/test-users";
import type { AppUser, RegisteredUser } from "../../lib/shared/types";

const admin: RegisteredUser = {
  id: "internal-admin-id", email: "admin@example.com", name: "管理者", imageUrl: null,
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

const qaEnvironment = {
  VERCEL_GIT_COMMIT_REF: "codex/fixed-qa-pool", VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  CAKE_PREVIEW_REPOSITORY: "tyask/Cake", CAKE_PREVIEW_PHASE: "application", CAKE_PREVIEW_DATABASE_BRANCH_ID: "br-preview", CAKE_PREVIEW_PR: "34", CAKE_PREVIEW_GENERATION: "00000000-0000-4000-8000-000000000001",
  CAKE_PREVIEW_SOURCE_BRANCH: "codex/fixed-qa-pool", CAKE_PREVIEW_SOURCE_SHA: "a".repeat(40),
  CAKE_TEST_DATABASE_URL: "postgresql://fixture:dummy@ep-qa.ap-southeast-1.aws.neon.tech/cake",
  CAKE_PREVIEW_DATABASE_HOST_SHA256: createHash('sha256').update('ep-qa.ap-southeast-1.aws.neon.tech').digest('hex'),
  CAKE_PREVIEW_PRODUCTION_HOST_SHA256: createHash('sha256').update('ep-production.ap-southeast-1.aws.neon.tech').digest('hex'),
};

async function withAuthMode(
  mode: string, vercelEnvironment: string, run: () => Promise<void>,
  overrides: Record<string, string | undefined> = {},
) {
  const environment: Record<string, string | undefined> = {
    AUTH_MODE: mode, VERCEL_ENV: vercelEnvironment,
    DATABASE_URL: "postgresql://fixture:dummy@ep-local.ap-southeast-1.aws.neon.tech/cake",
    DB_QUERY_LOG: "off",
    ...overrides,
  };
  const keys = [...new Set(["AUTH_MODE", "VERCEL_ENV", "DATABASE_URL", "DB_QUERY_LOG", ...Object.keys(qaEnvironment), ...Object.keys(overrides)])];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
  }
  try { await run(); } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function registeredFixture(user: (typeof QA_TEST_USERS)[number] | (typeof TEST_USERS)[number]): RegisteredUser {
  return { ...user, imageUrl: null, isEnabled: true, isAdmin: "isAdmin" in user && user.isAdmin };
}

function testLoginInput(user: AppUser) {
  return {
    user: { ...user },
    account: { provider: "test-login", type: "credentials" as const, providerAccountId: user.id },
  };
}

// Every query is intercepted locally. No real connection or database row is read.
function databaseFixture(t: TestContext, initial: RegisteredUser | null, listedUsers: RegisteredUser[] = []) {
  const previousFetch = neonConfig.fetchFunction;
  const state = { user: initial ? { ...initial } : null, queries: [] as { query: string; params: unknown[] }[] };
  neonConfig.fetchFunction = async (_input: RequestInfo | URL, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as { query: string; params: unknown[] };
    state.queries.push(payload);
    let user = state.user;
    if (user) {
      const email = payload.params.find((value) => typeof value === "string" && value.includes("@"));
      const adminParameter = payload.query.match(/is_admin = \$(\d+)/)?.[1];
      const expectedAdmin = adminParameter ? payload.params[Number(adminParameter) - 1] : undefined;
      if (payload.params.includes(user.id) === false || email !== user.email || !user.isEnabled
        || (expectedAdmin !== undefined && String(user.isAdmin) !== expectedAdmin)) user = null;
    }
    const columns = ["id", "email", "name", "image_url", "is_admin", "is_enabled"];
    if (payload.query.includes("UPDATE app_users SET name") && user) {
      user.name = String(payload.params[0]);
    }
    const records = payload.query.includes("ORDER BY is_admin DESC")
      ? user?.isAdmin ? listedUsers.filter((record) => payload.params.at(-1) === "true"
        || !TEST_USERS.some((fixture) => fixture.id === record.id && fixture.email === record.email)) : []
      : user ? [user] : [];
    const result = {
      fields: columns.map((name) => ({ name, dataTypeID: name.startsWith("is_") ? 16 : 25 })),
      rows: records.map((record) => [record.id, record.email, record.name, record.imageUrl,
        record.isAdmin ? "t" : "f", record.isEnabled ? "t" : "f"]),
      rowCount: records.length, command: "SELECT",
    };
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { neonConfig.fetchFunction = previousFetch; });
  return state;
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

test("Cakeで設定したユーザー名はGoogle再ログイン後もセッションで使う", async () => {
  await withAuthMode("google", "production", async () => {
    const saved = { ...admin, name: "Cakeで決めた名前" };
    const { callbacks, state } = fixture(saved);
    const google = googleInput();
    const input = { ...google, user: { ...google.user, image: "google-photo.png" } };
    assert.equal(await callbacks.signIn!(input), true);
    assert.equal(state.updates[0].name, saved.name);
    assert.equal(state.updates[0].imageUrl, input.user.image);
    const sessionUser = await resolveSessionUser(saved, async () => state.user);
    assert.equal(sessionUser?.name, saved.name);
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
  await withAuthMode("test", "development", async () => {
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
  assert.equal(normalizeEmail(" ADMIN@example.com "), admin.email);
  assert.equal(normalizeEmail("admin+other@example.com"), "admin+other@example.com");
  assert.equal(normalizeEmail("bad-email"), null);
  assert.equal(normalizeEmail(undefined), null);
});

test("guard済みQAは固定fixtureでログインし、異なるID/メールを拒否する", async () => {
  await withAuthMode("test", "preview", async () => {
    for (const user of QA_TEST_USERS) {
      const { callbacks, state } = fixture();
      const input = testLoginInput(registeredFixture(user));
      assert.equal(await callbacks.signIn!(input), true);
      assert.equal(state.testRegistrations, 1);
      const token = await callbacks.jwt!({ ...input, token: {}, trigger: "signIn" });
      assert.equal(token?.sub, user.id);
      assert.equal(token?.email, user.email);
    }
    for (const user of [
      { ...registeredFixture(QA_TEST_USERS[0]), email: "different-a@example.com" },
      { ...registeredFixture(QA_TEST_USERS[0]), email: QA_TEST_USERS[1].email },
      { ...registeredFixture(QA_TEST_USERS[1]), id: "unregistered-id" },
    ]) {
      const { callbacks, state } = fixture();
      const input = testLoginInput(user);
      assert.equal(await callbacks.signIn!(input), false);
      assert.equal(await callbacks.jwt!({ ...input, token: {}, trigger: "signIn" }), null);
      assert.equal(state.testRegistrations, 0);
    }
  }, qaEnvironment);
});

test("QA guard欠落時は新・legacy両profileのログインとセッションを拒否する", async () => {
  await withAuthMode("test", "preview", async () => {
    for (const user of [...TEST_USERS, ...QA_TEST_USERS]) {
      const { callbacks, state } = fixture();
      const input = testLoginInput(registeredFixture(user));
      assert.equal(await callbacks.signIn!(input), false);
      assert.equal(await callbacks.jwt!({ ...input, token: {}, trigger: "signIn" }), null);
      let reads = 0;
      assert.equal(await resolveSessionUser(user, async () => { reads++; return registeredFixture(user); }), null);
      assert.equal(reads, 0);
      assert.equal(state.testRegistrations, 0);
    }
  });
});

test("固定fixtureと異なるdummyメールは拒否し、Productionでは固定pairも拒否する", async () => {
  for (const environment of ["development", "production"]) {
    await withAuthMode("test", environment, async () => {
      const users = environment === "production" ? [...TEST_USERS, ...QA_TEST_USERS] : QA_TEST_USERS;
      for (const user of users) {
        const { callbacks, state } = fixture();
        const identity = registeredFixture(user);
        if (environment === "development") identity.email = "different@example.com";
        const input = testLoginInput(identity);
        assert.equal(await callbacks.signIn!(input), false);
        assert.equal(await callbacks.jwt!({ ...input, token: {}, trigger: "signIn" }), null);
        assert.equal(state.testRegistrations, 0);
        let reads = 0;
        assert.equal(await resolveSessionUser(identity, async () => { reads++; return registeredFixture(user); }), null);
        assert.equal(reads, 0);
      }
    });
  }
});

test("Google認証では新・legacy fixtureを事前登録済みでも拒否する", async () => {
  await withAuthMode("google", "production", async () => {
    for (const user of [...TEST_USERS, ...QA_TEST_USERS]) {
      const { callbacks, state } = fixture(registeredFixture(user));
      const input = googleInput(user.email);
      assert.equal(await callbacks.signIn!(input), false);
      assert.equal(await callbacks.jwt!({ ...input, token: {}, trigger: "signIn" }), null);
      assert.equal(state.updates.length, 0);
    }
  });
});

test("QAセッションの管理者権限は現在DBのAだけで決まり、token偽造・降格・無効化を反映する", async () => {
  await withAuthMode("test", "preview", async () => {
    const a = registeredFixture(QA_TEST_USERS[0]);
    const b = registeredFixture(QA_TEST_USERS[1]);
    const aWithoutTokenRole = { ...a, isAdmin: false };
    const aWithTokenRole = { ...a, isAdmin: true };
    const bWithForgedTokenRole = { ...b, isAdmin: true };
    assert.equal((await resolveSessionUser(aWithoutTokenRole, async () => a))?.isAdmin, true);
    assert.equal((await resolveSessionUser(aWithTokenRole, async () => ({ ...a, isAdmin: false })))?.isAdmin, false);
    assert.equal((await resolveSessionUser(bWithForgedTokenRole, async () => b))?.isAdmin, false);
    assert.equal((await resolveSessionUser(b, async () => ({ ...b, isAdmin: true })))?.isAdmin, false);
    for (const changed of [null, { ...a, isEnabled: false }, { ...a, id: b.id }, { ...a, email: b.email }]) {
      assert.equal(await resolveSessionUser(a, async () => changed), null);
    }
  }, qaEnvironment);
});

test("QAログインはseed済みfixtureのSELECT照合のみで、無効化・role変更を修復しない", async (t) => {
  await withAuthMode("test", "preview", async () => {
    for (const fixtureUser of QA_TEST_USERS) {
      const user = registeredFixture(fixtureUser);
      for (const stored of [user, null, { ...user, isEnabled: false }, { ...user, isAdmin: !user.isAdmin },
        { ...user, id: "other-id" }, { ...user, email: "other@example.com" }]) {
        const state = databaseFixture(t, stored);
        assert.equal(await ensureTestUser(user), stored === user);
        assert.equal(state.queries.length, 1);
        assert.match(state.queries[0].query, /SELECT id FROM app_users/);
        assert.match(state.queries[0].query, /is_enabled = true AND is_admin = \$3/);
        assert.deepEqual(state.queries[0].params, [user.id, user.email, String(fixtureUser.isAdmin)]);
        assert.doesNotMatch(state.queries[0].query, /INSERT|UPDATE|DELETE/);
        assert.deepEqual(state.user, stored);
      }
    }
  }, qaEnvironment);
});

test("legacy fixtureの登録は従来どおり非管理者upsertに限定する", async (t) => {
  await withAuthMode("test", "development", async () => {
    const user = registeredFixture(TEST_USERS[0]);
    const state = databaseFixture(t, user);
    assert.equal(await ensureTestUser(user), true);
    assert.equal(state.queries.length, 1);
    assert.match(state.queries[0].query, /INSERT INTO app_users/);
    assert.match(state.queries[0].query, /is_admin = false, is_enabled = true/);
  });
});

test("Production・未guarded・profile不一致ではensureTestUserがDB問い合わせ前に拒否する", async (t) => {
  for (const [environment, overrides, users] of [
    ["preview", {}, [...TEST_USERS, ...QA_TEST_USERS]],
    ["preview", { ...qaEnvironment, CAKE_PREVIEW_GENERATION: undefined }, [...TEST_USERS, ...QA_TEST_USERS]],
    ["development", {}, QA_TEST_USERS],
    ["production", {}, [...TEST_USERS, ...QA_TEST_USERS]],
  ] as const) {
    await withAuthMode("test", environment, async () => {
      for (const fixtureUser of users) {
        const user = registeredFixture(fixtureUser);
        if (environment === "development") user.email = "different@example.com";
        const state = databaseFixture(t, user);
        assert.equal(await ensureTestUser(user), false);
        assert.equal(state.queries.length, 0);
      }
    }, overrides);
  }
});

test("requireAdministratorはtoken値を使わずQA Aの現在DBを読み直す", async (t) => {
  await withAuthMode("test", "preview", async () => {
    const a = registeredFixture(QA_TEST_USERS[0]);
    const state = databaseFixture(t, a);
    assert.equal((await requireAdministrator({ ...a, isAdmin: false })).id, a.id);
    assert.equal(state.queries.length, 1);
    state.user!.isAdmin = false;
    await assert.rejects(requireAdministrator({ ...a, isAdmin: true }), (error: UserAccessError) => error.status === 403);
    state.user!.isAdmin = true;
    state.user!.isEnabled = false;
    await assert.rejects(requireAdministrator(a), (error: UserAccessError) => error.status === 403);
  }, qaEnvironment);
});

test("DBの誤設定やtoken偽造があってもQA B・legacy・Productionをtest管理者にしない", async (t) => {
  for (const [environment, overrides, users] of [
    ["preview", qaEnvironment, [QA_TEST_USERS[1]]],
    ["development", {}, [...QA_TEST_USERS, ...TEST_USERS]],
    ["production", {}, [...QA_TEST_USERS, ...TEST_USERS]],
  ] as const) {
    await withAuthMode("test", environment, async () => {
      for (const fixtureUser of users) {
        const user = { ...registeredFixture(fixtureUser), isAdmin: true };
        databaseFixture(t, user);
        await assert.rejects(requireAdministrator(user), (error: UserAccessError) => error.status === 403);
      }
    }, overrides);
  }
});

test("利用者管理の直接呼び出しもDB roleとQA admin条件を照合し、拒否時は更新しない", async (t) => {
  for (const [environment, overrides, fixtureUser] of [
    ["preview", qaEnvironment, QA_TEST_USERS[1]],
    ["development", {}, TEST_USERS[0]],
    ["production", {}, QA_TEST_USERS[0]],
  ] as const) {
    await withAuthMode("test", environment, async () => {
      const user = { ...registeredFixture(fixtureUser), isAdmin: true };
      const state = databaseFixture(t, user);
      const calls = [
        () => listRegisteredUsers(user),
        () => registerUser(user, "new-user@example.com"),
        () => disableUser(user, "other-user-id"),
      ];
      for (const run of calls) {
        await assert.rejects(run(), (error: UserAccessError) => error.status === 403);
      }
      assert.equal(state.queries.length, calls.length);
      assert.ok(state.queries.every(({ query }) => /^\s*SELECT/.test(query)));
    }, overrides);
  }
});

test("QA Aの利用者一覧は現在DBの管理者照合後に固定A/Bの二人を表示する", async (t) => {
  await withAuthMode("test", "preview", async () => {
    const users = QA_TEST_USERS.map(registeredFixture);
    const state = databaseFixture(t, users[0], users);
    const listed = await listRegisteredUsers({ ...users[0], isAdmin: false });
    assert.deepEqual(listed, users.map(({ id, email, name, imageUrl, isAdmin, isEnabled }) => ({
      id, email, name, imageUrl, isAdmin, isEnabled,
    })));
    assert.equal(state.queries.length, 2);
    assert.equal(state.queries[1].params.at(-1), "true");
    assert.match(state.queries[1].query, /AND \(\$3 OR NOT \(\(id = 'test-user-a'/);
  }, qaEnvironment);
});

test("通常の本番・legacy環境の管理者一覧は固定A/Bを引き続き除外する", async (t) => {
  for (const environment of ["production", "development"]) {
    await withAuthMode("google", environment, async () => {
      const state = databaseFixture(t, admin, [admin, ...QA_TEST_USERS.map(registeredFixture)]);
      assert.deepEqual(await listRegisteredUsers(admin), [admin]);
      assert.equal(state.queries.length, 2);
      assert.equal(state.queries[1].params.at(-1), "false");
      assert.match(state.queries[1].query, /AND \(\$3 OR NOT \(\(id = 'test-user-a'/);
    });
  }
});

test("表示名変更後もQA A/Bの管理者表示は現在DBとguardで決まる", async (t) => {
  await withAuthMode("test", "preview", async () => {
    for (const fixtureUser of QA_TEST_USERS) {
      const user = registeredFixture(fixtureUser);
      databaseFixture(t, user);
      const saved = await updateDisplayName({ ...user, isAdmin: !user.isAdmin }, "更新した名前");
      assert.equal(saved.name, "更新した名前");
      assert.equal(saved.isAdmin, fixtureUser.isAdmin);
    }
  }, qaEnvironment);
});

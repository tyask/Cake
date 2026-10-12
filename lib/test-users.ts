export const TEST_USERS = [
  {
    key: "user-a",
    id: "test-user-a",
    email: "test-a@cake.local",
    name: "テストユーザーA",
  },
  {
    key: "user-b",
    id: "test-user-b",
    email: "test-b@cake.local",
    name: "テストユーザーB",
  },
] as const;

export type TestUser = {
  readonly key: string;
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly isAdmin?: boolean;
};

// QA fixtures are selected only after validating the Preview lease identity.
// The local test profile above remains unchanged.
export const QA_TEST_USERS = [
  {
    ...TEST_USERS[0],
    isAdmin: true,
  },
  {
    ...TEST_USERS[1],
    isAdmin: false,
  },
] as const satisfies readonly TestUser[];

export function findTestUser(key: unknown, users: readonly TestUser[] = TEST_USERS) {
  return users.find((user) => user.key === key) ?? null;
}

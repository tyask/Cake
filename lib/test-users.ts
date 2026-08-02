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

export function findTestUser(key: unknown) {
  return TEST_USERS.find((user) => user.key === key) ?? null;
}

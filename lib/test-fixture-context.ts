import { previewDatabaseIdentity } from "./database-environment";
import { QA_TEST_USERS, TEST_USERS } from "./test-users";
import type { RegisteredUser } from "./types";

type FixtureEnvironment = Readonly<Record<string, string | undefined>>;
type Identity = { id?: string; email?: string | null };

function matches(user: Identity, fixture: Identity) {
  return typeof user.email === "string" && user.id === fixture.id
    && user.email.trim().toLowerCase() === fixture.email;
}

// Invalid QA metadata must throw, so an incomplete Preview never uses legacy users.
export function activeTestUsers(environment: FixtureEnvironment = process.env) {
  return previewDatabaseIdentity(environment) ? QA_TEST_USERS : TEST_USERS;
}

// Retain both profiles here so neither can be accepted as a Google/Production user.
export function isKnownTestIdentity(user: Identity) {
  return [...TEST_USERS, ...QA_TEST_USERS].some((fixture) => matches(user, fixture));
}

export function isActiveTestIdentity(user: Identity, environment: FixtureEnvironment = process.env) {
  try {
    return activeTestUsers(environment).some((fixture) => matches(user, fixture));
  } catch {
    return false;
  }
}

// Call only with a freshly read DB record. The fixture/token cannot grant a role.
export function canUseAdministratorRole(user: RegisteredUser, environment: FixtureEnvironment = process.env) {
  if (!user.isEnabled || !user.isAdmin) return false;
  if (!isKnownTestIdentity(user)) return true;
  if (environment.AUTH_MODE !== "test" || environment.VERCEL_ENV === "production") return false;
  try {
    return activeTestUsers(environment) === QA_TEST_USERS
      && QA_TEST_USERS.some((fixture) => fixture.isAdmin && matches(user, fixture));
  } catch {
    return false;
  }
}

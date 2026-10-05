import type { NextAuthConfig } from "next-auth";
import { isTestAuthEnabled } from "./auth-mode";
import { isTestIdentity, normalizeEmail } from "./user-access";
import type { AppUser, RegisteredUser } from "./types";

export async function resolveSessionUser(
  identity: { id?: string; email?: string | null } | undefined,
  findUser: (id: string, email: string) => Promise<RegisteredUser | null>,
): Promise<AppUser | null> {
  if (!identity?.id || !identity.email) return null;
  const testIdentity = isTestIdentity(identity);
  if (isTestAuthEnabled() !== testIdentity) return null;
  const registered = await findUser(identity.id, identity.email);
  if (!registered?.isEnabled) return null;
  return { ...registered, isAdmin: testIdentity ? false : registered.isAdmin };
}

export interface UserAccessStore {
  findRegisteredUser(email: unknown): Promise<RegisteredUser | null>;
  updateRegisteredProfile(user: AppUser): Promise<boolean>;
  ensureTestUser(user: AppUser): Promise<boolean>;
}

export function createAuthCallbacks(store: UserAccessStore): NonNullable<NextAuthConfig["callbacks"]> {
  return {
    async signIn({ user, account, profile }) {
      if (account?.provider === "test-login") {
        if (!isTestAuthEnabled() || !isTestIdentity(user) || !user.id || !user.email) return false;
        return store.ensureTestUser({ id: user.id, email: normalizeEmail(user.email)!, name: user.name ?? user.email, imageUrl: null });
      }
      const email = normalizeEmail(profile?.email);
      if (isTestAuthEnabled() || account?.provider !== "google" || profile?.email_verified !== true
        || !email || normalizeEmail(user.email) !== email) return false;

      const registered = await store.findRegisteredUser(email);
      if (!registered?.isEnabled || isTestIdentity(registered)) return false;
      return store.updateRegisteredProfile({
        id: registered.id, email, name: user.name ?? registered.name, imageUrl: user.image ?? null,
      });
    },
    async jwt({ token, account, user, profile }) {
      if (account?.provider === "google") {
        const email = normalizeEmail(profile?.email);
        if (isTestAuthEnabled() || profile?.email_verified !== true || !email || normalizeEmail(user?.email) !== email) return null;
        const registered = await store.findRegisteredUser(email);
        if (!registered?.isEnabled || isTestIdentity(registered)) return null;
        // Pre-registered users have an internal ID; retain it instead of Google's subject ID.
        token.sub = registered.id;
        token.email = registered.email;
      } else if (account?.provider === "test-login") {
        if (!isTestAuthEnabled() || !isTestIdentity(user)) return null;
        token.sub = user.id;
        token.email = normalizeEmail(user.email);
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  };
}

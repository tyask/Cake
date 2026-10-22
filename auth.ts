import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { isTestAuthEnabled } from "@/lib/server/auth/auth-mode";
import { findTestUser } from "@/lib/shared/test-users";
import { activeTestUsers } from "@/lib/server/auth/test-fixture-context";
import { createAuthCallbacks } from "@/lib/server/auth/auth-callbacks";
import { ensureTestUser, findRegisteredUser, updateRegisteredProfile } from "@/lib/server/auth/user-access";

const testAuthEnabled = isTestAuthEnabled();

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: testAuthEnabled
    ? [
        Credentials({
          id: "test-login",
          name: "テストユーザー",
          credentials: {
            testUserKey: { label: "テストユーザー", type: "text" },
          },
          authorize(credentials) {
            if (!isTestAuthEnabled()) return null;
            let user;
            try { user = findTestUser(credentials?.testUserKey, activeTestUsers()); } catch { return null; }
            if (!user) return null;
            return { id: user.id, email: user.email, name: user.name, image: null };
          },
        }),
      ]
    : [Google],
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/", error: "/" },
  callbacks: createAuthCallbacks({ ensureTestUser, findRegisteredUser, updateRegisteredProfile }),
});

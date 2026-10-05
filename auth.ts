import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { isTestAuthEnabled } from "@/lib/auth-mode";
import { findTestUser } from "@/lib/test-users";
import { createAuthCallbacks } from "@/lib/auth-callbacks";
import { ensureTestUser, findRegisteredUser, updateRegisteredProfile } from "@/lib/user-access";

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
            const user = findTestUser(credentials?.testUserKey);
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

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { db } from "@/lib/db";
import { isTestAuthEnabled } from "@/lib/auth-mode";
import { findTestUser } from "@/lib/test-users";

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
  pages: { signIn: "/" },
  callbacks: {
    session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      if (!user.id || !user.email) return;
      const sql = db();
      await sql`
        INSERT INTO app_users (id, email, name, image_url)
        VALUES (${user.id}, ${user.email.toLowerCase()}, ${user.name ?? user.email}, ${user.image ?? null})
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          name = EXCLUDED.name,
          image_url = EXCLUDED.image_url,
          updated_at = now()
      `;
    },
  },
});

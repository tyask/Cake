import { auth } from "@/auth";
import type { AppUser } from "./types";
import { findSessionUser } from "./user-access";
import { resolveSessionUser } from "./auth-callbacks";

export async function getCurrentUser(): Promise<AppUser | null> {
  const session = await auth();
  return resolveSessionUser(session?.user, findSessionUser);
}

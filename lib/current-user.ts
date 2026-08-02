import { auth } from "@/auth";
import type { AppUser } from "./types";

export async function getCurrentUser(): Promise<AppUser | null> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? session.user.email,
    imageUrl: session.user.image ?? null,
  };
}

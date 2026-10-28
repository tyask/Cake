import { getCurrentUser } from "@/lib/server/auth/current-user";
import { homeHandler } from "@/lib/server/handlers/home-handler";
import { findHome } from "@/lib/server/stores/home-store";

export const runtime = "nodejs";

export const GET = homeHandler({ currentUser: getCurrentUser, findHome });

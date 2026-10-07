import { z } from "zod";
import { getCurrentUser } from "@/lib/current-user";
import { disableUser, listRegisteredUsers, normalizeEmail, registerUser, requireAdministrator, UserAccessError } from "@/lib/user-access";
import type { AppUser } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function administrator() {
  const user = await getCurrentUser();
  if (!user) throw new UserAccessError("ログインが必要です。", 401);
  return requireAdministrator(user);
}

function checkMutationRequest(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new UserAccessError("このリクエストは許可されていません。", 403);
  }
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new UserAccessError("リクエストの形式が不正です。", 400);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof UserAccessError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return Response.json({ error: "入力内容を確認してください。" }, { status: 400 });
  }
  if (error instanceof Error && error.message.includes("Cakeを利用できるアカウントは二人までです")) {
    return Response.json({ error: "利用できるのは管理者を含めて2人までです。" }, { status: 409 });
  }
  return Response.json({ error: "利用者の管理に失敗しました。" }, { status: 500 });
}

async function usersResponse(actor: AppUser) {
  return Response.json({ users: await listRegisteredUsers(actor) }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  try {
    const actor = await administrator();
    return await usersResponse(actor);
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    checkMutationRequest(request);
    const actor = await administrator();
    const input = z.strictObject({
      email: z.string().transform((value) => normalizeEmail(value)).pipe(z.string()),
      name: z.string().trim().min(1).max(120).optional(),
    }).parse(await request.json());
    await registerUser(actor, input.email, input.name);
    return await usersResponse(actor);
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    checkMutationRequest(request);
    const actor = await administrator();
    const input = z.strictObject({ userId: z.string().min(1).max(200) }).parse(await request.json());
    await disableUser(actor, input.userId);
    return await usersResponse(actor);
  } catch (error) { return errorResponse(error); }
}

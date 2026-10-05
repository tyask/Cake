import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { TEST_USERS } from "./test-users";
import type { AppUser, RegisteredUser } from "./types";

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return z.email().safeParse(email).success ? email : null;
}

export function isTestIdentity(user: { id?: string; email?: string | null }) {
  return TEST_USERS.some((testUser) => testUser.id === user.id && testUser.email === normalizeEmail(user.email));
}

function registeredUser(row: Record<string, unknown>): RegisteredUser {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    imageUrl: row.image_url == null ? null : String(row.image_url),
    isAdmin: row.is_admin === true,
    isEnabled: row.is_enabled === true,
  };
}

export async function findRegisteredUser(email: unknown): Promise<RegisteredUser | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const rows = await db()`SELECT * FROM app_users WHERE email = ${normalized} LIMIT 1`;
  return rows[0] ? registeredUser(rows[0]) : null;
}

export async function findSessionUser(id: string, email: string): Promise<RegisteredUser | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const rows = await db()`
    SELECT * FROM app_users
    WHERE id = ${id} AND email = ${normalized} AND is_enabled = true
    LIMIT 1
  `;
  return rows[0] ? registeredUser(rows[0]) : null;
}

export async function updateRegisteredProfile(user: AppUser): Promise<boolean> {
  const email = normalizeEmail(user.email);
  if (!email) return false;
  const rows = await db()`
    UPDATE app_users SET name = ${user.name}, image_url = ${user.imageUrl}, updated_at = now()
    WHERE id = ${user.id} AND email = ${email} AND is_enabled = true
    RETURNING id
  `;
  return rows.length === 1;
}

export async function ensureTestUser(user: AppUser): Promise<boolean> {
  if (!isTestIdentity(user)) return false;
  const rows = await db()`
    INSERT INTO app_users (id, email, name, image_url, is_admin, is_enabled)
    VALUES (${user.id}, ${user.email}, ${user.name}, NULL, false, true)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, is_admin = false, is_enabled = true, updated_at = now()
    WHERE app_users.email = EXCLUDED.email
    RETURNING id
  `;
  return rows.length === 1;
}

export class UserAccessError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

// Read the role again for management requests; a session never grants administrator privileges.
export async function requireAdministrator(user: AppUser): Promise<RegisteredUser> {
  const current = await findSessionUser(user.id, user.email);
  if (!current?.isAdmin || isTestIdentity(current)) {
    throw new UserAccessError("利用者を管理する権限がありません。", 403);
  }
  return current;
}

export async function listRegisteredUsers(actor: AppUser): Promise<RegisteredUser[]> {
  const rows = await db()`
    SELECT * FROM app_users
    WHERE EXISTS (
      SELECT 1 FROM app_users administrator
      WHERE administrator.id = ${actor.id} AND administrator.email = ${actor.email}
        AND administrator.is_admin = true AND administrator.is_enabled = true
    ) AND NOT ((id = 'test-user-a' AND email = 'test-a@cake.local')
      OR (id = 'test-user-b' AND email = 'test-b@cake.local'))
    ORDER BY is_admin DESC, is_enabled DESC, created_at ASC
  `;
  return rows.map(registeredUser);
}

export async function registerUser(actor: AppUser, email: string, name?: string): Promise<void> {
  const sql = db();
  const rows = await sql`
    INSERT INTO app_users (id, email, name, is_admin, is_enabled)
    SELECT ${randomUUID()}, ${email}, ${name || email}, false, true
    FROM app_users administrator
    WHERE administrator.id = ${actor.id} AND administrator.email = ${actor.email}
      AND administrator.is_admin = true AND administrator.is_enabled = true
    ON CONFLICT (email) DO UPDATE SET
      is_enabled = true, name = COALESCE(${name ?? null}, app_users.name), updated_at = now()
    WHERE app_users.is_admin = false AND app_users.is_enabled = false
    RETURNING id
  `;
  if (!rows[0]) throw new UserAccessError("すでに登録されているか、登録する権限がありません。", 409);
}

export async function disableUser(actor: AppUser, userId: string): Promise<void> {
  const rows = await db()`
    UPDATE app_users target SET is_enabled = false, updated_at = now()
    WHERE target.id = ${userId} AND target.is_admin = false AND target.is_enabled = true
      AND EXISTS (
        SELECT 1 FROM app_users administrator
        WHERE administrator.id = ${actor.id} AND administrator.email = ${actor.email}
          AND administrator.is_admin = true AND administrator.is_enabled = true
      )
    RETURNING target.id
  `;
  if (!rows[0]) throw new UserAccessError("この利用者を無効にすることはできません。", 409);
}

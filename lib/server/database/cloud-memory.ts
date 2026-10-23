import type { NeonQueryFunction } from "@neondatabase/serverless";
import { neon, neonConfig } from "@neondatabase/serverless";

export const CLOUD_DATABASE_CONNECTION_STRING = "postgresql://cake:memory@cloud.cake.local/cake";
type Environment = Readonly<Record<string, string | undefined>>;

/** An explicit, development-only connection. Invalid configuration never falls back to Neon. */
export function cloudMemoryDatabaseUrl(environment: Environment): string | null {
  if (environment.CAKE_CLOUD_MODE === undefined && environment.CAKE_MEMORY_DATABASE_URL === undefined) return null;
  const fail = () => new Error("CloudオンメモリDBの設定が不正です。dev:cloudから起動してください。");
  if (environment.CAKE_CLOUD_MODE !== "memory" || environment.NODE_ENV !== "development"
    || environment.AUTH_MODE !== "test" || environment.VERCEL !== undefined || environment.VERCEL_ENV !== undefined
    || environment.DATABASE_URL !== CLOUD_DATABASE_CONNECTION_STRING || environment.CAKE_TEST_DATABASE_URL
    || Object.keys(environment).some(key => key.startsWith("CAKE_PREVIEW_") && environment[key] !== undefined)) throw fail();
  try {
    const url = new URL(environment.CAKE_MEMORY_DATABASE_URL ?? "");
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password || url.search || url.hash || !/^\/sql\/[a-f0-9]{48}$/.test(url.pathname)) throw fail();
    return url.href;
  } catch { throw fail(); }
}

export function cloudMemoryDatabase(environment: Environment): NeonQueryFunction<false, false> | null {
  const endpoint = cloudMemoryDatabaseUrl(environment);
  if (!endpoint) return null;
  // Keep Neon's parameter encoding, lazy queries, transaction API and result parsers.
  // This process is exclusively a disposable Cloud development server.
  neonConfig.fetchFunction = async (_input: unknown, init: RequestInit) => {
    const headers = new Headers(init.headers);
    if (headers.get("Neon-Connection-String") !== CLOUD_DATABASE_CONNECTION_STRING) {
      throw new Error("Cloud開発サーバーから外部DBへの接続はできません。");
    }
    headers.set("Content-Type", "application/json");
    return fetch(endpoint, { ...init, headers, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30_000) });
  };
  return neon(CLOUD_DATABASE_CONNECTION_STRING);
}

export type AuthMode = "google" | "test";

export function isTestAuthEnabled() {
  const requested = process.env.AUTH_MODE === "test";
  const isVercelProduction = process.env.VERCEL_ENV === "production";

  // Vercel productionでは、誤ってAUTH_MODE=testを設定しても必ず無効にする。
  return requested && !isVercelProduction;
}

export function getAuthMode(): AuthMode {
  return isTestAuthEnabled() ? "test" : "google";
}

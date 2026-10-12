/** Select the DB before constructing any client. Never include URLs in errors. */
export function databaseVariable(environment) {
  return environment.VERCEL_ENV === "preview" ? "CAKE_TEST_DATABASE_URL" : "DATABASE_URL";
}

function endpoint(value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname)) throw new Error();
  return url.hostname.replace(/-pooler(?=\.)/, "");
}

export function databaseConnectionString(environment) {
  const variable = databaseVariable(environment);
  const value = environment[variable]?.trim();
  if (!value || value === "[SENSITIVE]") throw new Error(`${variable} が設定されていません。`);
  const branch = environment.VERCEL_GIT_COMMIT_REF;
  const slot = environment.CAKE_QA_SLOT;
  const qa = environment.VERCEL_ENV === "preview" && /^qa[123]$/.test(branch ?? "");
  if (qa || slot !== undefined) {
    try {
      if (environment.VERCEL_ENV === "production" || (slot !== undefined && !/^qa[123]$/.test(slot))
        || (qa && slot !== undefined && slot !== branch)) throw new Error();
      const expected = environment.CAKE_QA_DATABASE_HOST;
      if (!expected || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(expected)) throw new Error();
      const actual = endpoint(value);
      if (actual !== endpoint(`postgresql://guard@${expected}/guard`)) throw new Error();
      if (environment.VERCEL_ENV === "preview" && environment.DATABASE_URL
        && actual === endpoint(environment.DATABASE_URL)) throw new Error();
    } catch {
      throw new Error("QA枠のDB照合に失敗しました。確認済みの専用Neon endpointと枠名を設定してください。DB操作は開始しません。");
    }
  }
  return value;
}

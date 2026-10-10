type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;

export function databaseVariable(environment: DatabaseEnvironment): "CAKE_TEST_DATABASE_URL" | "DATABASE_URL" {
  return environment.VERCEL_ENV === "preview" ? "CAKE_TEST_DATABASE_URL" : "DATABASE_URL";
}

export function databaseConnectionString(environment: DatabaseEnvironment): string {
  const variable = databaseVariable(environment);
  const value = environment[variable]?.trim();
  if (!value || value === "[SENSITIVE]") throw new Error(`${variable} が設定されていません。`);
  return value;
}

type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;
export function databaseVariable(environment: DatabaseEnvironment): "CAKE_TEST_DATABASE_URL" | "DATABASE_URL";
export function databaseConnectionString(environment: DatabaseEnvironment): string;

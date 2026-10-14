type Environment = Readonly<Record<string, string | undefined>>;

// Match only Neon endpoint hostnames. IDs alone remain useful public evidence.
const neonHost = /\bep-[a-z0-9-]+\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+neon\.tech\b/gi;
const privateField = /^(?:host|hostname|url|uri|password|token|secret|api[_-]?key|authorization|credentials|connection[_-]?(?:string|url|uri)|(?:database|postgres)[_-]?(?:url|uri)|body|rawBody|providerBody|headers|request|response)$/i;
const privateEnvironmentKeys = ["GITHUB_TOKEN", "GH_TOKEN", "VERCEL_TOKEN", "NEON_API_KEY",
  "CAKE_QA_PRODUCTION_DATABASE_HOST", "DATABASE_URL", "CAKE_TEST_DATABASE_URL"] as const;

/** Register hosts before any later Actions output. A local inspection emits no commands. */
export function maskQaHosts(value: unknown, env: Environment = process.env,
  emit: (command: string) => void = console.log): void {
  if (env.GITHUB_ACTIONS !== "true") return;
  const hosts = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(neonHost)) {
        hosts.add(match[0]);
        const direct = match[0].replace(/-pooler(?=\.)/i, "");
        hosts.add(direct);
        hosts.add(direct.replace(/(?=\.)/, "-pooler"));
      }
    } else if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item);
      for (const nested of Object.values(item)) visit(nested);
    }
  };
  visit(value);
  for (const host of hosts) emit(`::add-mask::${host}`);
}

/** Curated QA output never needs a connection destination or an opaque provider body. */
export function publicQaOutput(value: unknown, env: Environment = process.env): unknown {
  const privateValues = privateEnvironmentKeys.map((key) => env[key]).filter((v): v is string => Boolean(v));
  const redact = (text: string): string => {
    let result = text;
    for (const privateValue of privateValues) result = result.split(privateValue).join("[redacted]");
    return result.replace(neonHost, "[redacted]")
      .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/gi, "[redacted]");
  };
  const ancestors = new WeakSet<object>();
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return redact(item);
    if (!item || typeof item !== "object") return item;
    if (ancestors.has(item)) return "[redacted]";
    ancestors.add(item);
    const result = Array.isArray(item) ? item.map(visit) : Object.fromEntries(Object.entries(item)
      .filter(([key, nested]) => !privateField.test(key)
        && (key.toLowerCase() !== "credential" || privateEnvironmentKeys.includes(nested as typeof privateEnvironmentKeys[number])))
      .map(([key, nested]) => [redact(key), visit(nested)]));
    ancestors.delete(item);
    return result;
  };
  return visit(value);
}

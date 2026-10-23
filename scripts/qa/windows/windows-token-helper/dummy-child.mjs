// Offline launcher check only. This public dummy is never a real credential.
// No imports, network calls, subprocesses, or filesystem operations are used.
const EXPECTED_DUMMY = "vcp_cake_dummy_only_not_a_real_token";
const sensitiveEnvironmentKey = /^(?:DATABASE(?:_|$)|DIRECT_URL$|POSTGRES(?:_|$)|PG(?:HOST|HOSTADDR|PORT|USER|PASSWORD|DATABASE|SERVICE|SERVICEFILE|PASSFILE|SSLMODE|SSLKEY|SSLCERT|SSLROOTCERT|OPTIONS)$|NEON(?:_|$)|NEXTAUTH(?:_|$)|AUTH(?:_|$)|QA(?:_|$)|OPENAI(?:_|$)|ANTHROPIC(?:_|$)|AZURE(?:_|$)|AWS(?:_|$)|GOOGLE(?:_|$)|GCP(?:_|$)|GEMINI(?:_|$)|MISTRAL(?:_|$)|COHERE(?:_|$)|GROQ(?:_|$)|HUGGINGFACE(?:_|$)|HF_TOKEN$|SUPABASE(?:_|$)|FIREBASE(?:_|$)|CLERK(?:_|$)|AUTH0(?:_|$)|STRIPE(?:_|$)|RESEND(?:_|$)|SENDGRID(?:_|$)|SLACK(?:_|$)|GITHUB_TOKEN$|GH_TOKEN$|NPM_TOKEN$|NODE_AUTH_TOKEN$|VERCEL_OIDC_TOKEN$)/i;

const dummyMatched = process.env.VERCEL_TOKEN === EXPECTED_DUMMY;
const unwantedEnvironmentAbsent = !Object.keys(process.env)
  .some((key) => sensitiveEnvironmentKey.test(key));
delete process.env.VERCEL_TOKEN;

const summary = {
  protocol: "cake-token-dummy/v1",
  success: dummyMatched && unwantedEnvironmentAbsent,
  dummyMatched,
  unwantedEnvironmentAbsent,
  networkRequests: 0,
};

process.exitCode = summary.success ? 0 : 1;
try {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch {
  process.exitCode = 1;
}

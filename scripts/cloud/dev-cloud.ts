import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { checkNodeVersion } from "../tooling/check-node-version.mjs";

type Environment = Readonly<Record<string, string | undefined>>;
type MemoryDatabase = { url: string; connectionString: string; close(): Promise<void> };
export type CloudServer = { url: string; close(): Promise<void> };
export class CloudStartupError extends Error {
  constructor(message: string, readonly cleanupSucceeded: boolean) { super(message); }
}
const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const environmentFiles = [".env", ".env.local", ".env.development", ".env.development.local"];

/** Refuse Next's automatic credential loading before starting either process. */
export function assertCloudStartupAllowed(environment: Environment, directory = rootDirectory): void {
  if (environment.VERCEL !== undefined || environment.VERCEL_ENV !== undefined || environment.NODE_ENV === "production") {
    throw new Error("Cake CloudはVercel・Production環境では起動できません。");
  }
  for (const filename of environmentFiles) {
    try { lstatSync(join(directory, filename)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Cake Cloudの環境ファイルを確認できません。Cloud専用worktreeを使ってください。");
    }
    throw new Error(`${filename} があるためCake Cloudを起動しません。環境ファイルを持たないCloud専用worktreeを使ってください。`);
  }
}

/** Keep networking/CA/cache settings, without inheriting application/provider credentials. */
export function cloudChildEnvironment(environment: Environment, database: Pick<MemoryDatabase, "url" | "connectionString">): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { NODE_ENV: "development" };
  for (const key of [
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "PLAYWRIGHT_BROWSERS_PATH", "npm_config_cache", "NPM_CONFIG_CACHE",
    "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM", "FORCE_COLOR", "NO_COLOR",
  ]) {
    if (environment[key] !== undefined) child[key] = environment[key];
  }
  for (const key of ["NODE_USE_SYSTEM_CA", "NODE_USE_ENV_PROXY"]) {
    if (environment[key] === "1") child[key] = "1";
  }
  return Object.assign(child, {
    CAKE_CLOUD_MODE: "memory", CAKE_MEMORY_DATABASE_URL: database.url, DATABASE_URL: database.connectionString,
    AUTH_MODE: "test", AUTH_SECRET: randomBytes(32).toString("hex"),
    NODE_ENV: "development", DB_QUERY_LOG: "off", NEXT_TELEMETRY_DISABLED: "1",
  });
}

function cloudPort(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number") || !/^[1-9]\d*$/.test(String(value))) {
    throw new Error("Cake Cloudのportは1〜65535の整数で指定してください。");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) throw new Error("Cake Cloudのportは1〜65535の整数で指定してください。");
  return port;
}

export async function assertCloudPortAvailable(port: number, hostname: string): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`Cake Cloudのport ${port} を使えません。占有を解消するか別のportを明示してください。`)));
    probe.listen({ port, host: hostname, exclusive: true }, () => probe.close(error => error ? reject(error) : accept()));
  });
}

function terminateNext(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

/** Buffer whole lines so a capability/secret split across chunks cannot escape redaction. */
function forwardLogs(stream: NodeJS.ReadableStream, target: NodeJS.WritableStream, secrets: string[]): void {
  let pending = "", dropping = false;
  const write = (line: string) => {
    for (const secret of secrets) line = line.replaceAll(secret, "[redacted]");
    target.write(line);
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!dropping) pending += part;
      if (pending.length > 65_536) { pending = ""; dropping = true; }
      if (part.endsWith("\n")) {
        if (!dropping) write(pending);
        pending = ""; dropping = false;
      }
    }
  });
  stream.once("end", () => { if (!dropping && pending) write(pending); });
}

/** One parent-owned PGlite survives Next workers/HMR and is destroyed with this server. */
export async function startCloudServer({ port: requestedPort, hostname = "0.0.0.0", quiet = false }: { port?: number; hostname?: string; quiet?: boolean } = {}): Promise<CloudServer> {
  let port: number;
  try {
    assertCloudStartupAllowed(process.env);
    checkNodeVersion();
    if (process.platform === "win32") throw new Error("Cake CloudはCloudのLinux環境で実行してください。");
    if (!["0.0.0.0", "127.0.0.1"].includes(hostname)) throw new Error("Cake Cloudのhostnameは0.0.0.0または127.0.0.1を指定してください。");
    port = cloudPort(requestedPort ?? process.env.PORT ?? 3000);
    await assertCloudPortAvailable(port, hostname);
  } catch (error) {
    throw new CloudStartupError(error instanceof Error ? error.message : "Cake Cloudの起動条件を確認できませんでした。", true);
  }
  // NextRequest canonicalizes loopback IPs to localhost during Auth.js redirects.
  const url = `http://localhost:${port}`;
  let databasePromise: Promise<MemoryDatabase> | undefined;
  let child: ChildProcess | undefined;
  let childExited = false, closing = false;
  let childDone = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  const exitCleanup = () => terminateNext(child, "SIGKILL");
  const interrupt = () => { process.exitCode = 130; void close().catch(() => { process.exitCode = 1; }); };
  const terminate = () => { process.exitCode = 143; void close().catch(() => { process.exitCode = 1; }); };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    closePromise = (async () => {
      terminateNext(child, "SIGTERM");
      if (child && !childExited) {
        await Promise.race([childDone, delay(5_000, undefined, { ref: false })]);
      }
      // Kill remaining workers too, including when Next's immediate child exited first.
      terminateNext(child, "SIGKILL");
      if (child) await childDone;
      try { await (await databasePromise)?.close(); }
      finally { process.removeListener("exit", exitCleanup); }
    })();
    return closePromise;
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  process.once("exit", exitCleanup);
  try {
    const { startMemoryDatabase } = await import("./memory-database");
    if (closing) throw new Error("CLOUD_STARTUP_INTERRUPTED");
    databasePromise = startMemoryDatabase();
    const database = await databasePromise;
    if (closing) throw new Error("CLOUD_STARTUP_INTERRUPTED");
    // Check again after migration/seed, before Next can load any environment file.
    assertCloudStartupAllowed(process.env);
    const environment = cloudChildEnvironment(process.env, database);
    const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
    child = spawn(process.execPath, [next, "dev", "--hostname", hostname, "--port", String(port)], {
      cwd: rootDirectory, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    if (quiet) { child.stdout!.resume(); child.stderr!.resume(); }
    else {
      const secrets = [database.url, new URL(database.url).pathname.split("/").at(-1)!, environment.AUTH_SECRET!];
      forwardLogs(child.stdout!, process.stdout, secrets);
      forwardLogs(child.stderr!, process.stderr, secrets);
    }
    childDone = new Promise<void>(accept => {
      const stopped = () => {
        childExited = true; accept();
        if (!closing) { process.exitCode = 1; void close().catch(() => { process.exitCode = 1; }); }
      };
      child!.once("error", stopped);
      child!.once("exit", stopped);
    });
    const deadline = Date.now() + 240_000;
    while (!closing && !childExited && Date.now() < deadline) {
      try {
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
        const html = await response.text();
        if (response.status === 200 && html.includes('aria-label="Cakeにログイン"') && html.includes('class="test-login"')) {
          if (closing || childExited) break;
          return { url, close };
        }
      } catch { /* Next may still be compiling the initial page. */ }
      await delay(250);
    }
    throw new Error("CLOUD_STARTUP_FAILED");
  } catch {
    let cleanupSucceeded = true;
    await close().catch(() => { cleanupSucceeded = false; });
    throw new CloudStartupError("Cake Cloudを起動できませんでした。起動ログ・port・Cloud専用worktreeを確認してください。", cleanupSucceeded);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--port")) throw new Error("使い方: npm run dev:cloud -- [--port 3000]");
  const server = await startCloudServer({ port: args.length ? cloudPort(args[1]) : undefined });
  console.log(`Cake Cloud: ${server.url}（終了するとメモリDBを破棄します）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : "Cake Cloudを起動できませんでした。");
    process.exitCode = 1;
  });
}

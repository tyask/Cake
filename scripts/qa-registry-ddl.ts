import type { NeonQueryFunction } from "@neondatabase/serverless";

const FORMAT_ERROR = "QA registry repository DDL is incomplete or has unsupported transaction boundaries.";
const APPLY_ERROR = "QA registry initialization transaction failed; database error details suppressed.";
type Statement = { sql: string; executable: string };

/** PostgreSQL lexical boundaries, rather than splitting function bodies at ';'. */
function statements(input: string): Statement[] {
  const result: Statement[] = [];
  let start = 0;
  let executable = "";
  let index = 0;
  while (index < input.length) {
    if (input.startsWith("--", index)) {
      const newline = input.indexOf("\n", index + 2);
      index = newline === -1 ? input.length : newline + 1;
      executable += "\n";
      continue;
    }
    if (input.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < input.length && depth > 0) {
        if (input.startsWith("/*", index)) { depth++; index += 2; }
        else if (input.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth !== 0) throw new Error(FORMAT_ERROR);
      executable += " ";
      continue;
    }
    const character = input[index];
    if (character === "'" || character === '"') {
      const quote = character;
      const escaped = quote === "'" && /^[Ee]$/.test(input[index - 1] ?? "")
        && !/[a-zA-Z0-9_$]/.test(input[index - 2] ?? "");
      const opening = index++;
      let closed = false;
      while (index < input.length) {
        if (escaped && input[index] === "\\") { index += 2; continue; }
        if (input[index] === quote) {
          if (input[index + 1] === quote) { index += 2; continue; }
          index++; closed = true; break;
        }
        index++;
      }
      if (!closed) throw new Error(FORMAT_ERROR);
      executable += input.slice(opening, index);
      continue;
    }
    if (character === "$" && !/[a-zA-Z0-9_$]/.test(input[index - 1] ?? "")) {
      const delimiter = input.slice(index).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const closing = input.indexOf(delimiter, index + delimiter.length);
        if (closing === -1) throw new Error(FORMAT_ERROR);
        const end = closing + delimiter.length;
        executable += input.slice(index, end);
        index = end;
        continue;
      }
    }
    executable += character;
    index++;
    if (character === ";") {
      if (executable.trim() !== ";") result.push({ sql: input.slice(start, index).trim(), executable: executable.trim() });
      start = index;
      executable = "";
    }
  }
  // Complete statements must have their terminator. Trailing comments are OK.
  if (executable.trim()) throw new Error(FORMAT_ERROR);
  return result;
}

export function splitSqlStatements(input: string): string[] {
  return statements(input).map(statement => statement.sql);
}

/** The driver supplies one transaction; the repository's outer wrapper is omitted. */
export function registryDdlStatements(input: string): string[] {
  const parsed = statements(input);
  if (parsed.length < 3 || !/^BEGIN\s*;$/i.test(parsed[0].executable)
    || !/^COMMIT\s*;$/i.test(parsed[parsed.length - 1].executable)) throw new Error(FORMAT_ERROR);
  const body = parsed.slice(1, -1);
  if (body.some(statement => /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|SET\s+TRANSACTION)\b/i.test(statement.executable))) throw new Error(FORMAT_ERROR);
  return body.map(statement => statement.sql);
}

/** Neon HTTPS accepts a batch of separate prepared statements in one transaction. */
export async function applyRegistryDdl(client: Pick<NeonQueryFunction<false, false>, "transaction">, input: string): Promise<void> {
  const batch = registryDdlStatements(input);
  try { await client.transaction(transaction => batch.map(statement => transaction.query(statement, []))); }
  catch { throw new Error(APPLY_ERROR); }
}

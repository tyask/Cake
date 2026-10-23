import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DocumentationFile = { path: string; content: string };
export type DocumentationIssue = {
  file: string;
  line: number;
  target: string;
  kind: "missing-file" | "missing-anchor" | "invalid-link" | "missing-reference";
};
type Reference = { target: string; offset: number; rootRelative?: boolean; label?: boolean };

const repositoryRoot = /^(?:app|components|lib|scripts|tests|db|docs|public|\.github)[/\\]/;
const rootFile = /^(?:AGENTS\.md|README\.md|auth\.ts|package(?:-lock)?\.json|tsconfig\.json|vercel\.json|preview(?:-verify)?\.config\.json|next\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|\.node-version|\.nvmrc)$/;
const generatedDirectories = new Set([".git", "node_modules", ".cake", ".next", ".vercel", "out", "build", "coverage"]);

function blank(value: string): string {
  return value.replace(/[^\n]/g, " ");
}

function htmlEntities(value: string): string {
  return value.replace(/&(?:#(x[\da-f]+|\d+)|([a-z]+));/gi, (original, numeric: string | undefined, named: string | undefined) => {
    if (numeric) {
      const code = numeric[0].toLowerCase() === "x" ? parseInt(numeric.slice(1), 16) : Number(numeric);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[named!.toLowerCase()] ?? original;
  });
}

function withoutComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
      (_match, opening: string, _name: string, body: string, closing: string) => opening + blank(body) + closing);
}

function markdownParts(content: string): { prose: string; headings: string; code: { content: string; offset: number }[] } {
  const code: { content: string; offset: number }[] = [];
  let fence: { marker: string; length: number } | undefined;
  let offset = 0;
  let prose = content.split(/(?<=\n)/).map((line) => {
    const start = offset;
    offset += line.length;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) {
        fence = undefined;
      } else {
        code.push({ content: line, offset: start });
      }
      return blank(line);
    }
    if (marker) {
      fence = { marker: marker[1][0], length: marker[1].length };
      return blank(line);
    }
    return line;
  }).join("");
  const headings = prose;
  const ticks = /`+/g;
  let opening: RegExpExecArray | null;
  while ((opening = ticks.exec(prose))) {
    const start = opening.index;
    let closing: RegExpExecArray | null;
    while ((closing = ticks.exec(prose))) {
      if (closing[0].length !== opening[0].length) continue;
      const end = closing.index + closing[0].length;
      code.push({ content: prose.slice(start + opening[0].length, closing.index), offset: start + opening[0].length });
      prose = prose.slice(0, start) + blank(prose.slice(start, end)) + prose.slice(end);
      break;
    }
    if (!closing) break;
  }
  return { prose, headings, code };
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function linkDestination(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("<")) return /^<([^>]*)>/.exec(trimmed)?.[1];
  // Quoted titles follow the destination; escaped spaces and parentheses belong to it.
  return /^(?:\\.|[^\s])*/.exec(trimmed)?.[0].replace(/\\([\\ ()])/g, "$1");
}

function markdownReferences(content: string): Reference[] {
  const references: Reference[] = [];
  const definitions = new Map<string, string>();
  const prose = content.replace(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>]*>|\S+)(?:[^\n]*)/gm, (whole, label: string, target: string) => {
    if (!definitions.has(normalizeLabel(label))) definitions.set(normalizeLabel(label), linkDestination(target)!);
    return blank(whole);
  });
  // Balanced destination parentheses cover paths such as design(v2).md.
  const links = /!?\[([^\]\n]*(?:\[[^\]\n]*\][^\]\n]*)*)\](?:\(((?:\\.|[^()\\]|\((?:\\.|[^()\\])*\))*)\)|\[([^\]\n]*)\])?/g;
  for (const match of prose.matchAll(links)) {
    if (match[2] !== undefined) {
      const target = linkDestination(match[2]);
      if (target !== undefined) references.push({ target, offset: match.index });
    } else {
      const label = normalizeLabel(match[3] || match[1]);
      const target = definitions.get(label);
      if (target !== undefined) references.push({ target, offset: match.index });
      else if (match[3] !== undefined) references.push({ target: label, offset: match.index, label: true });
    }
  }
  return references;
}

function htmlReferences(content: string): Reference[] {
  const references: Reference[] = [];
  for (const tag of content.matchAll(/<[a-z][^>]*>/gi)) {
    for (const attribute of tag[0].matchAll(/\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      references.push({ target: htmlEntities(attribute[1] ?? attribute[2] ?? attribute[3]), offset: tag.index + attribute.index });
    }
  }
  return references;
}

function codeReferences(content: string, offset: number): Reference[] {
  const references: Reference[] = [];
  const decoded = htmlEntities(content);
  for (const token of decoded.matchAll(/"([^"\n]*)"|'([^'\n]*)'|[^\s"'`]+/g)) {
    const target = (token[1] ?? token[2] ?? token[0]).replace(/[.,;:、。]+$/, "").replace(/:\d+(?::\d+)?$/, "");
    const normalized = target.replaceAll("\\", "/").replace(/^\.\//, "");
    // Check explicit repository paths only. Globs, templates and OS paths are examples,
    // and generated files (.cake, .next, etc.) are outside this static source check.
    if (/[?*{}<>$%]/.test(normalized) || normalized.includes("...")) continue;
    if (repositoryRoot.test(normalized) || rootFile.test(normalized)) {
      references.push({ target: normalized, offset: offset + token.index, rootRelative: true });
    }
  }
  return references;
}

function anchors(document: DocumentationFile): Set<string> {
  const content = withoutComments(document.content);
  const prose = /\.md$/i.test(document.path) ? markdownParts(content).prose : content;
  const result = new Set<string>();
  for (const tag of prose.matchAll(/<[a-z][^>]*>/gi)) {
    for (const attribute of tag[0].matchAll(/\s(id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      if (attribute[1].toLowerCase() === "id" || /^<a\s/i.test(tag[0])) result.add(htmlEntities(attribute[2] ?? attribute[3] ?? attribute[4]));
    }
  }
  if (/\.md$/i.test(document.path)) {
    // Preserve inline code's text in headings while excluding fenced examples.
    const headings = markdownParts(content).headings;
    const used = new Set<string>();
    for (const heading of headings.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$|^([^\n]+)\n {0,3}(?:=+|-+)[ \t]*$/gm)) {
      const slug = htmlEntities((heading[1] ?? heading[2]).replace(/<[^>]*>/g, "")
        .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1").replace(/(?<!\w)_{1,2}(.+?)_{1,2}(?!\w)/g, "$1"))
        .toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
      let unique = slug;
      for (let suffix = 1; used.has(unique); suffix++) unique = `${slug}-${suffix}`;
      used.add(unique);
      result.add(unique);
    }
  }
  return result;
}

/** Pure static check; documents are source pages, anchorDocuments may include linked pages outside docs/. */
export function checkDocumentation(
  documents: readonly DocumentationFile[],
  repositoryPaths: ReadonlySet<string>,
  anchorDocuments: readonly DocumentationFile[] = documents,
): DocumentationIssue[] {
  const pages = new Map(anchorDocuments.map((document) => [document.path, document]));
  const anchorCache = new Map<string, Set<string>>();
  const issues: DocumentationIssue[] = [];
  for (const document of documents) {
    const content = withoutComments(document.content);
    const { prose, code } = /\.md$/i.test(document.path) ? markdownParts(content) : { prose: content, code: [] as { content: string; offset: number }[] };
    const references = [...htmlReferences(prose), ...(/\.md$/i.test(document.path) ? markdownReferences(prose) : [])];
    for (const match of content.matchAll(/<(?:code|pre)\b[^>]*>([\s\S]*?)<\/(?:code|pre)\s*>/gi)) {
      code.push({ content: match[1].replace(/<[^>]*>/g, blank), offset: match.index + match[0].indexOf(">") + 1 });
    }
    for (const part of code) references.push(...codeReferences(part.content, part.offset));
    const reported = new Set<string>();
    for (const reference of references) {
      const target = htmlEntities(reference.target).trim();
      if (!reference.label && (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/|\\\\)/i.test(target) || /[<>${}*]/.test(target))) continue;
      let kind: DocumentationIssue["kind"] | undefined;
      if (reference.label) kind = "missing-reference";
      else {
        const hash = target.indexOf("#");
        const filePart = (hash < 0 ? target : target.slice(0, hash)).split("?")[0];
        try {
          const decodedFile = decodeURIComponent(filePart).replaceAll("\\", "/");
          const destination = decodedFile ? posix.normalize(posix.join(reference.rootRelative ? "" : posix.dirname(document.path), decodedFile)).replace(/\/$/, "") : document.path;
          if (!repositoryPaths.has(destination)) kind = "missing-file";
          else if (hash >= 0 && target.slice(hash + 1) && /\.(?:md|html?)$/i.test(destination)) {
            const page = pages.get(destination);
            if (page) {
              if (!anchorCache.has(destination)) anchorCache.set(destination, anchors(page));
              if (!anchorCache.get(destination)!.has(decodeURIComponent(target.slice(hash + 1)))) kind = "missing-anchor";
            } else kind = "missing-anchor";
          }
        } catch { kind = "invalid-link"; }
      }
      if (kind) {
        const line = document.content.slice(0, reference.offset).split("\n").length;
        const key = `${line}:${target}:${kind}`;
        if (!reported.has(key)) issues.push({ file: document.path, line, target, kind });
        reported.add(key);
      }
    }
  }
  return issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.target.localeCompare(b.target));
}

export function inspectDocumentation(cwd: string): { documents: number; issues: DocumentationIssue[] } {
  const paths = new Set<string>(["."]);
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(cwd, directory), { withFileTypes: true })) {
      if (!directory && generatedDirectories.has(entry.name)) continue;
      const path = posix.join(directory, entry.name);
      paths.add(path);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk("");
  const pages = [...paths].filter((path) => /\.(?:md|html?)$/i.test(path))
    .map((path) => ({ path, content: readFileSync(join(cwd, path), "utf8") }));
  const documents = pages.filter(({ path }) => ["AGENTS.md", "README.md"].includes(path) || path.startsWith("docs/"));
  return { documents: documents.length, issues: checkDocumentation(documents, paths, pages) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("check:docs は引数を取りません。");
    const result = inspectDocumentation(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
    for (const issue of result.issues) console.error(`${issue.file}:${issue.line}: ${issue.kind}: ${issue.target}`);
    console.log(`文書検査: ${result.documents}ファイル、問題${result.issues.length}件`);
    if (result.issues.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "文書検査に失敗しました。");
    process.exitCode = 1;
  }
}

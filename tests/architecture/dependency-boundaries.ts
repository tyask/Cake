import { readdir, readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, posix, relative, sep } from "node:path";
import ts from "typescript";

export type SourceFiles = ReadonlyMap<string, string>;
export type BoundaryViolation = { rule: string; path: string[]; message: string };
type Dependency = { specifier: string | null; position: number };
type Module = { client: boolean; dependencies: Dependency[] };

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const declarationExtension = /\.d\.[cm]?ts$/;
const assetExtension = /\.(?:css|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/;
const ignoredDirectories = new Set([".git", ".cake", ".next", "node_modules"]);
const sharedPackages = new Set(["zod", "papaparse"]);
// Package entry points are deliberate: next-auth/react is a browser entry; next-auth is not.
const browserPackages = new Set([
  ...sharedPackages, "react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client",
  "next/image", "next/link", "next/navigation", "next/dynamic", "next/script", "next-auth/react",
  "@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities", "qrcode.react", "recharts",
]);
const databasePackages = new Set([
  "@neondatabase/serverless", "@electric-sql/pglite", "pg", "postgres", "@prisma/client", "prisma",
  "drizzle-orm", "kysely", "knex", "mysql2", "better-sqlite3", "sqlite3",
]);

const within = (path: string, directory: string) => path.startsWith(directory + "/");
const productFile = (path: string) => !["scripts", "tests", "docs"].some(directory => within(path, directory));
const databaseFile = (path: string) => within(path, "lib/server/stores") || within(path, "lib/server/database") ||
  (within(path, "lib/server") && /(?:^|\/)(?:db|repository)(?:[./-]|$)/.test(path));
const databasePackage = (specifier: string) => [...databasePackages].some(name => specifier === name || specifier.startsWith(name + "/"));

export async function readProjectSources(root: string): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const generatedOutput = directory === root && (entry.name === "out" || entry.name === "build");
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name) && !generatedOutput) await visit(path);
      else if (entry.isFile() && sourceExtension.test(entry.name) && !declarationExtension.test(entry.name)) {
        sources.set(relative(root, path).split(sep).join("/"), await readFile(path, "utf8"));
      }
    }
  }
  await visit(root);
  return sources;
}

function inspectModule(path: string, source: string): Module {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const dependencies: Dependency[] = [];
  let client = false;
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use client") client = true;
  }
  function add(node: ts.Node, expression: ts.Expression | undefined) {
    dependencies.push({
      specifier: expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) ? expression.text : null,
      position: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    });
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly));
      if (!onlyTypes) add(node, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const bindings = node.exportClause;
      const onlyTypes = node.isTypeOnly || (bindings && ts.isNamedExports(bindings) &&
        bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly));
      if (!onlyTypes) add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node, node.arguments.length === 1 || node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { client, dependencies };
}

function resolveLocal(source: string, specifier: string, sources: SourceFiles): string | null {
  const base = posix.normalize(specifier.startsWith("@/") ? specifier.slice(2) : posix.join(posix.dirname(source), specifier));
  if (base === ".." || base.startsWith("../") || posix.isAbsolute(base)) return null;
  const candidates = [base];
  if (/\.[cm]?js$/.test(base)) {
    const stem = base.replace(/\.[cm]?js$/, "");
    candidates.push(stem + ".ts", stem + ".tsx", stem + ".mts", stem + ".cts");
  }
  for (const extension of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
    candidates.push(base + extension, posix.join(base, "index" + extension));
  }
  return candidates.find(candidate => sources.has(candidate)) ?? (assetExtension.test(base) ? base : null);
}

export function checkDependencyBoundaries(sources: SourceFiles): BoundaryViolation[] {
  const modules = new Map([...sources].map(([path, source]) => [path, inspectModule(path, source)]));
  const violations: BoundaryViolation[] = [];
  for (const path of sources.keys()) {
    if (within(path, "lib") && !["client", "server", "shared"].some(directory => within(path, "lib/" + directory))) {
      violations.push({ rule: "lib-placement", path: [path], message: "libのモジュールはclient/server/sharedへ配置する" });
    }
  }
  function check(rule: string, roots: string[], forbidden: (path: string) => boolean, packages?: ReadonlySet<string>, forbidDatabase = false) {
    const visited = new Set<string>();
    const queue = roots.sort().map(path => [path]);
    for (let index = 0; index < queue.length; index++) {
      const path = queue[index];
      const current = path[path.length - 1];
      if (visited.has(current)) continue;
      visited.add(current);
      for (const dependency of modules.get(current)?.dependencies ?? []) {
        const specifier = dependency.specifier;
        const report = (message: string, target: string) => violations.push({ rule, path: [...path, target], message });
        if (specifier === null) {
          report("実行時依存を静的に解決できない動的import/require", `${current}:${dependency.position}`);
        } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
          const target = resolveLocal(current, specifier, sources);
          if (!target) report("ローカル依存を解決できない", specifier);
          else if (forbidden(target)) report("禁止された領域への実行時依存", target);
          else queue.push([...path, target]);
        } else if (packages && !packages.has(specifier)) {
          report(isBuiltin(specifier) || specifier.startsWith("node:") ? "Node専用モジュールはブラウザで実行できない" : "ブラウザ実行を許可していない外部依存", specifier);
        } else if (forbidDatabase && databasePackage(specifier)) {
          report("DB実装への実行時依存", specifier);
        }
      }
    }
  }
  const paths = [...sources.keys()];
  const client = (path: string) => within(path, "lib/client") || modules.get(path)?.client === true;
  // Product-wide checks also reject unresolved loads, so a new dynamic path cannot hide a forbidden edge.
  check("product", paths.filter(productFile), path => within(path, "scripts") || within(path, "tests"));
  check("client", paths.filter(client), path => within(path, "lib/server"), browserPackages);
  check("shared", paths.filter(path => within(path, "lib/shared")), path => !within(path, "lib/shared"), sharedPackages);
  check("server", paths.filter(path => within(path, "lib/server")), client);
  check("service-store", paths.filter(path => within(path, "lib/server/services")), databaseFile, undefined, true);
  check("handler-db", paths.filter(path => within(path, "lib/server/handlers")), databaseFile, undefined, true);
  return violations;
}

export function formatBoundaryViolations(violations: BoundaryViolation[]): string {
  return violations.map(violation => `${violation.rule}: ${violation.message}\n  ${violation.path.join(" -> ")}`).join("\n");
}

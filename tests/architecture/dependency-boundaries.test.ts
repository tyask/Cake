import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDependencyBoundaries, formatBoundaryViolations, readProjectSources } from "./dependency-boundaries";

const check = (sources: Record<string, string>) => checkDependencyBoundaries(new Map(Object.entries(sources)));
const rules = (sources: Record<string, string>, rule: string) => check(sources).filter(violation => violation.rule === rule);

test("製品コードの実行場所と推移的な依存境界を維持する", async () => {
  const violations = checkDependencyBoundaries(await readProjectSources(process.cwd()));
  assert.equal(violations.length, 0, formatBoundaryViolations(violations));
});

test("下位build/outのソースを収集し、root生成物と実行されない型宣言を除外する", async t => {
  const root = await mkdtemp(join(tmpdir(), "cake-boundary-sources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    "app/build/page.tsx": '"use client"; import "@/lib/server/database/db";',
    "app/out/page.tsx": '"use client"; import "@/lib/server/database/db";',
    "scripts/build/vercel-build.ts": "export const build = true;",
    "lib/server/database/db.ts": "export const database = true;",
    "build/generated.ts": "export const output = true;",
    "out/generated.ts": "export const output = true;",
    "node_modules/package/index.ts": "export const dependency = true;",
    "next-env.d.ts": 'import "./.next/types/routes.d.ts";',
    "types/auth.d.ts": 'import "next-auth";',
    "lib/server/ports.d.mts": 'import "node:fs";',
    "lib/server/ports.d.cts": 'import "node:fs";',
  };
  for (const [path, source] of Object.entries(files)) {
    const parts = path.split("/");
    await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...parts), source);
  }
  const sources = await readProjectSources(root);
  assert.deepEqual([...sources.keys()].sort(), [
    "app/build/page.tsx", "app/out/page.tsx", "lib/server/database/db.ts", "scripts/build/vercel-build.ts",
  ]);
  assert.deepEqual(checkDependencyBoundaries(sources).filter(violation => violation.rule === "client").map(violation => violation.path), [
    ["app/build/page.tsx", "lib/server/database/db.ts"], ["app/out/page.tsx", "lib/server/database/db.ts"],
  ]);
});

test("型専用import・再exportを除き、混在する実行時importは追跡する", () => {
  const sources = {
    "lib/shared/types.ts": `import type { Store } from "../server/stores/store";
      import { type Client } from "../client/controller";
      export type * from "@/lib/server/database/db";
      export { type User } from "@/lib/server/auth";
      export type Node = typeof import("node:fs");
      import { type Schema, value } from "./value"; export { type Schema, value } from "./value";`,
    "lib/shared/value.ts": `import { z } from "zod"; import Papa from "papaparse"; export const value = z.string();`,
    "lib/server/services/service.ts": `import type { Store } from "../stores/store"; export type { Store } from "../stores/store";`,
  };
  assert.deepEqual(check(sources), []);
  const mixed = rules({ ...sources, "lib/shared/types.ts": `import { type Store, connect } from "../server/stores/store";`, "lib/server/stores/store.ts": "" }, "shared");
  assert.equal(mixed.length, 1);
  assert.deepEqual(mixed[0].path, ["lib/shared/types.ts", "lib/server/stores/store.ts"]);
});

test("lib直下や未分類ディレクトリへのモジュール追加を拒否する", () => {
  const violations = rules({ "lib/legacy.ts": "", "lib/utils/value.mjs": "", "lib/shared/value.ts": "" }, "lib-placement");
  assert.deepEqual(violations.map(violation => violation.path), [["lib/legacy.ts"], ["lib/utils/value.mjs"]]);
});

test("alias・index.tsx・再export・mjsを経由するclientからserverへの経路を表示する", () => {
  const violations = rules({
    "lib/client/entry.ts": `export * from "@/components/bridge";`,
    "components/bridge/index.tsx": `export * as server from "@/lib/server/secret.mjs";`,
    "lib/server/secret.mjs": `export const secret = "server";`,
  }, "client");
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0].path, ["lib/client/entry.ts", "components/bridge/index.tsx", "lib/server/secret.mjs"]);
  assert.match(formatBoundaryViolations(violations), /lib\/client\/entry.ts -> components\/bridge\/index.tsx -> lib\/server\/secret.mjs/);
});

test("lib外のuse client入口からも文字列dynamic import・require・import equalsを追跡する", () => {
  for (const load of [
    `import("@/lib/server/database/db")`, `import(\`@/lib/server/database/db\`)`, `require("@/lib/server/database/db")`,
    `import db = require("@/lib/server/database/db");`,
  ]) {
    const violations = rules({ "components/entry.tsx": `"use strict"; "use client"; ${load}`, "lib/server/database/db.ts": "" }, "client");
    assert.equal(violations.length, 1, load);
    assert.deepEqual(violations[0].path, ["components/entry.tsx", "lib/server/database/db.ts"]);
  }
});

test("sharedからclient・server・画面・運用・テストへの実行時参照を拒否する", () => {
  for (const target of ["lib/client/controller.ts", "lib/server/database/db.ts", "components/view.tsx", "app/page.tsx", "scripts/task/run.mjs", "tests/shared/case.ts"]) {
    const violations = rules({ "lib/shared/input.ts": `export * from "@/${target}";`, [target]: "" }, "shared");
    assert.equal(violations.length, 1, target);
    assert.deepEqual(violations[0].path, ["lib/shared/input.ts", target]);
  }
});

test("serverから中間モジュールを介したclient処理・use client入口への参照を拒否する", () => {
  for (const target of ["lib/client/controller.ts", "components/view.tsx"]) {
    const violations = rules({
      "lib/server/entry.ts": `export * from "@/bridge";`,
      "bridge.ts": `export * from "@/${target}";`,
      [target]: `"use client";`,
    }, "server");
    assert.equal(violations.length, 1);
    assert.deepEqual(violations[0].path, ["lib/server/entry.ts", "bridge.ts", target]);
  }
});

test("画面・API・root moduleからscripts/testsを製品へ取り込まない", () => {
  for (const source of ["app/api/route.ts", "components/view.tsx", "auth.ts", "lib/server/helper.ts"]) {
    for (const target of ["scripts/db/setup.mjs", "tests/shared/fixture.ts"]) {
      const violations = rules({ [source]: `import "@/${target}";`, [target]: "" }, "product");
      assert.equal(violations.length, 1, `${source} -> ${target}`);
    }
  }
});

test("用途別サービス・HTTP handlerから具体store・DB・repositoryへの推移参照を拒否する", () => {
  for (const [source, rule] of [["lib/server/services/operation.ts", "service-store"], ["lib/server/handlers/http.ts", "handler-db"]]) {
    for (const target of ["lib/server/stores/app-store.ts", "lib/server/stores/recurring-payment-store.ts", "lib/server/database/db.ts",
      "lib/server/database/database-environment.ts", "lib/server/database/database-connection.mjs",
      "lib/server/database/production-database-hosts.mjs", "lib/server/database/preview-fixture-base.mjs", "lib/server/repository.ts"]) {
      const violations = rules({
        [source]: `import "../bridge";`,
        "lib/server/bridge.ts": `export * from "@/${target}";`,
        [target]: "",
      }, rule);
      assert.equal(violations.length, 1, `${source} -> ${target}`);
      assert.deepEqual(violations[0].path, [source, "lib/server/bridge.ts", target]);
    }
    for (const dependency of ["@neondatabase/serverless", "pg", "drizzle-orm/neon-http"]) {
      assert.equal(rules({ [source]: `import "${dependency}";` }, rule).length, 1, dependency);
    }
  }
});

test("APIのcomposition rootはstoreを組み立て、サービスとhandlerは注入した型を使える", () => {
  assert.deepEqual(check({
    "app/api/app/route.ts": `import "@/lib/server/stores/store"; import "@/lib/server/services/service"; import "@/lib/server/handlers/http";`,
    "lib/server/stores/store.ts": `import "../database/db";`,
    "lib/server/database/db.ts": `import "@neondatabase/serverless";`,
    "lib/server/services/service.ts": `import type { Store } from "../stores/store"; import type { DatabaseQueryExecutor } from "../database/database-connection.mjs"; import { randomUUID } from "node:crypto";`,
    "lib/server/handlers/http.ts": `import { UserAccessError } from "../errors"; import type { Operation } from "../services/service";`,
    "lib/server/errors.ts": `export class UserAccessError extends Error {}`,
  }), []);
});

test("sharedとclientでは外部packageのbrowser入口を区別してNode・サーバーSDKを拒否する", () => {
  assert.deepEqual(check({
    "components/view.tsx": `"use client"; import "react"; import "next/image"; import "next-auth/react"; import "@dnd-kit/core"; import "./view.module.css";`,
    "lib/shared/input.ts": `import "zod"; import "papaparse";`,
  }), []);
  for (const dependency of ["node:fs", "fs/promises", "@neondatabase/serverless", "next-auth", "next/headers", "next/server", "server-only", "unknown-package"]) {
    assert.equal(rules({ "lib/client/entry.ts": `import "${dependency}";` }, "client").length, 1, dependency);
    assert.equal(rules({ "lib/shared/input.ts": `import "${dependency}";` }, "shared").length, 1, dependency);
  }
  assert.equal(rules({ "lib/shared/input.ts": `import "next-auth/react";` }, "shared").length, 1);
});

test("非literalの動的依存と未解決のlocal依存を黙って無視しない", () => {
  for (const expression of [`import(name)`, `require(name)`, `import(\`./${"${name}"}\`)`, `import("./" + name)`]) {
    for (const source of ["lib/shared/input.ts", "lib/client/entry.ts", "lib/server/services/service.ts", "lib/server/handlers/http.ts", "app/api/route.ts"]) {
      const violations = rules({ [source]: expression }, "product");
      assert.equal(violations.length, 1, `${source}: ${expression}`);
      assert.match(violations[0].message, /静的に解決できない/);
    }
  }
  for (const specifier of ["./missing", "@/lib/shared/missing", "../../outside"]) {
    assert.match(rules({ "lib/client/entry.ts": `import "${specifier}";` }, "client")[0].message, /解決できない/);
  }
});

test("js拡張子のTS参照・相対ディレクトリ・循環依存を解決し、型だけの不存在参照は除外する", () => {
  assert.deepEqual(check({
    "lib/client/entry.ts": `export * from "../shared/format.js"; import type { Future } from "./not-runtime";`,
    "lib/shared/format.ts": `export * from "./values";`,
    "lib/shared/values/index.ts": `export * from "../format.js";`,
  }), []);
});

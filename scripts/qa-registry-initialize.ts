import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
import { SLOTS } from "../lib/qa-pool";
import { registryConnectionString } from "./qa-registry-store";
import { HttpQaGateway } from "./qa-pool-writer";
import type { RegistryGateway } from "./qa-registry-manager";
import { applyRegistryDdl } from "./qa-registry-ddl";

/** Separate administrative initialization; never runs as an application migration. */
export async function initializeRegistry(gateway: RegistryGateway, environment: Readonly<Record<string, string | undefined>>): Promise<void> {
  console.log("Cake: QA registry initialize stage=owner");
  await gateway.assertDispatchOwner();
  if (environment.CAKE_QA_REGISTRY_ENABLED === "true") throw new Error("QA registry is already enabled; do not initialize again.");
  if (environment.CAKE_QA_POOL_ENABLED === "true") throw new Error("Disable legacy QA generation before initializing the registry.");
  console.log("Cake: QA registry initialize stage=legacy-runs");
  await gateway.assertLegacyRunsIdle();
  const legacy = new HttpQaGateway({ ...environment, QA_OWNER_FLOW: "false" });
  console.log("Cake: QA registry initialize stage=legacy-ledger");
  const pool = await legacy.pool();
  if (Object.values(pool).some(value => value && value.payload.state !== "free")) throw new Error("Release every legacy QA lease before initializing the registry.");
  console.log("Cake: QA registry initialize stage=aliases");
  for (const slot of SLOTS) if (await legacy.alias(slot)) throw new Error("Legacy QA alias is still assigned.");
  console.log("Cake: QA registry initialize stage=deployments");
  for (const saved of Object.values(pool)) {
    if (!saved) continue;
    for (const deployment of saved.payload.deployments) if (await legacy.deployment(deployment.id)) throw new Error("Legacy QA Deployment is still present.");
  }
  console.log("Cake: QA registry initialize stage=databases");
  for (const saved of Object.values(pool)) {
    if (!saved) continue;
    const databases = [...saved.payload.retiredDatabases, ...(saved.payload.database ? [saved.payload.database] : [])];
    for (const database of databases) if (!await legacy.databaseGone(database)) throw new Error("Legacy QA database is still present.");
  }
  const connection = registryConnectionString({ ...environment });
  const sql = await readFile(new URL("../db/qa-registry/001_registry.sql", import.meta.url), "utf8");
  console.log("Cake: QA registry initialize stage=ddl");
  await applyRegistryDdl(neon(connection), sql);
  console.log("Cake: QA registry initialize stage=readback");
  await gateway.store.read();
  console.log("Cake: initialized the dedicated QA registry from repository DDL. All three slots are free; enable the cutover only after this run succeeds.");
}

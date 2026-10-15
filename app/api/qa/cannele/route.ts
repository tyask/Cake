import { db } from "@/lib/db";
import { canneleRuntimeProofHandler } from "@/lib/cannele-runtime-proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// Non-secret QA-only connection proof. Application authentication and Vercel
// Deployment Protection keep their existing settings.
export const GET = canneleRuntimeProofHandler({ environment: () => process.env, database: db });

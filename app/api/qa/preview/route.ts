import { db } from '@/lib/server/db';
import { previewRuntimeProofHandler } from '@/lib/server/preview-runtime-proof';
export const dynamic = 'force-dynamic';
export const GET = previewRuntimeProofHandler({ environment: () => process.env, database: () => db() });

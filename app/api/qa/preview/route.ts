import { db } from '@/lib/server/database/db';
import { previewRuntimeProofHandler } from '@/lib/server/preview/preview-runtime-proof';
export const dynamic = 'force-dynamic';
export const GET = previewRuntimeProofHandler({ environment: () => process.env, database: () => db() });

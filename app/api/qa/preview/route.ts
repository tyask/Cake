import { db } from '@/lib/db';
import { previewRuntimeProofHandler } from '@/lib/preview-runtime-proof';
export const dynamic = 'force-dynamic';
export const GET = previewRuntimeProofHandler({ environment: () => process.env, database: () => db() });

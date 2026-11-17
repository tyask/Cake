import { MAX_PHOTO_UPLOAD_BYTES, PHOTO_MIME_TYPES, photoTransactionExtractionSchema, photoTransactionResponseSchema, type PhotoMimeType, type PhotoTransactionExtraction } from "../../shared/photo-transaction";
import { workspaceIdSchema } from "../../shared/schemas/domain-schemas";
import type { ImportCategorySuggestionsResponse } from "../../shared/import-category-suggestions";
import { PhotoTransactionError, readBoundedPhotoBody, type PhotoTransactionImage } from "../photo-transaction";

type Dependencies = {
  currentUser: () => Promise<{ id: string } | null>;
  requireMember: (workspaceId: string, userId: string) => Promise<unknown>;
  extract: (image: PhotoTransactionImage, signal: AbortSignal) => Promise<PhotoTransactionExtraction>;
  findSuggestions: (workspaceId: string, userId: string, merchants: readonly string[]) => Promise<ImportCategorySuggestionsResponse>;
};

function hasImageSignature(bytes: Uint8Array, mimeType: PhotoMimeType): boolean {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  return bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
}

export function photoTransactionHandler(dependencies: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    const headers = { "Cache-Control": "no-store" };
    try {
      const user = await dependencies.currentUser();
      if (!user) throw new PhotoTransactionError("ログインが必要です。", 401);
      request.signal.throwIfAborted();
      if (!request.headers.get("content-type")?.startsWith("multipart/form-data;")) {
        throw new PhotoTransactionError("写真の送信形式を確認してください。", 400);
      }
      const bytes = await readBoundedPhotoBody(request, MAX_PHOTO_UPLOAD_BYTES + 64 * 1024);
      let form: FormData;
      try {
        form = await new Request(request.url, { method: "POST", headers: { "Content-Type": request.headers.get("content-type")! }, body: bytes }).formData();
      } catch { throw new PhotoTransactionError("写真の送信形式を確認してください。", 400); }
      if ([...form.keys()].some(key => key !== "workspaceId" && key !== "image")
        || form.getAll("workspaceId").length !== 1 || form.getAll("image").length !== 1) {
        throw new PhotoTransactionError("写真と家計を確認してください。", 400);
      }
      const workspace = workspaceIdSchema.safeParse(form.get("workspaceId"));
      if (!workspace.success) throw new PhotoTransactionError("家計を選び直してください。", 400);
      try { await dependencies.requireMember(workspace.data, user.id); }
      catch { throw new PhotoTransactionError("このワークスペースを操作する権限がありません。", 403); }
      const image = form.get("image");
      if (!(image instanceof File) || image.size === 0) throw new PhotoTransactionError("写真を選んでください。", 400);
      if (image.size > MAX_PHOTO_UPLOAD_BYTES) throw new PhotoTransactionError("写真は3MB以下にして送信してください。", 413);
      if (!(PHOTO_MIME_TYPES as readonly string[]).includes(image.type)) throw new PhotoTransactionError("JPEG・PNG・WebPの写真を選んでください。", 415);
      const mimeType = image.type as PhotoMimeType;
      const imageBytes = new Uint8Array(await image.arrayBuffer());
      if (!hasImageSignature(imageBytes, mimeType)) throw new PhotoTransactionError("写真の形式が正しくありません。別の写真を選んでください。", 415);
      request.signal.throwIfAborted();
      const extraction = photoTransactionExtractionSchema.parse(await dependencies.extract({ bytes: imageBytes, mimeType }, request.signal));
      request.signal.throwIfAborted();
      let categoryId: string | null = null;
      let categorySuggestionFailed = false;
      if (extraction.merchant !== null) {
        try {
          const result = await dependencies.findSuggestions(workspace.data, user.id, [extraction.merchant]);
          categoryId = result.suggestions.find(item => item.merchant === extraction.merchant)?.categoryId ?? null;
        } catch { categorySuggestionFailed = true; }
      }
      request.signal.throwIfAborted();
      return Response.json(photoTransactionResponseSchema.parse({ ...extraction, categoryId, categorySuggestionFailed }), { headers });
    } catch (error) {
      if (error instanceof PhotoTransactionError) return Response.json({ error: error.message }, { status: error.status, headers });
      if (request.signal.aborted) return Response.json({ error: "写真の解析を中止しました。" }, { status: 408, headers });
      return Response.json({ error: "写真を解析できませんでした。もう一度お試しください。" }, { status: 502, headers });
    }
  };
}

import {
  MAX_PHOTO_DIMENSION, MAX_PHOTO_SOURCE_BYTES, MAX_PHOTO_UPLOAD_BYTES, PHOTO_MIME_TYPES,
  photoTransactionResponseSchema, type PhotoTransactionResponse,
} from "../shared/photo-transaction";

function loadPhoto(file: File, signal: AbortSignal): Promise<HTMLImageElement> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
      URL.revokeObjectURL(url);
    };
    const abort = () => {
      cleanup();
      image.src = "";
      reject(signal.reason);
    };
    // Modern image decoding applies EXIF orientation before natural dimensions
    // and drawImage, including portrait photos from mobile cameras.
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error("写真を開けませんでした。JPEG・PNG・WebPの画像を選び直してください。")); };
    signal.addEventListener("abort", abort, { once: true });
    image.src = url;
  });
}

/** Decode locally, discard metadata and send only a bounded JPEG. */
export async function prepareTransactionPhoto(file: File, signal: AbortSignal): Promise<Blob> {
  if (!(PHOTO_MIME_TYPES as readonly string[]).includes(file.type)) {
    throw new Error("JPEG・PNG・WebPの写真を選んでください。HEICの場合はJPEGに変換してください。");
  }
  if (file.size === 0 || file.size > MAX_PHOTO_SOURCE_BYTES) throw new Error("写真は20MB以下の画像を選んでください。");
  const image = await loadPhoto(file, signal);
  signal.throwIfAborted();
  const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("このブラウザでは写真を処理できません。別のブラウザをお試しください。");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  try {
    for (const quality of [0.86, 0.7, 0.55]) {
      signal.throwIfAborted();
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      signal.throwIfAborted();
      if (!blob) throw new Error("写真を処理できませんでした。写真を選び直してください。");
      if (blob.size <= MAX_PHOTO_UPLOAD_BYTES) return blob;
    }
    throw new Error("写真の容量を小さくできませんでした。レシートの部分を切り抜いて再試行してください。");
  } finally {
    // Release the decoded pixels as soon as the upload image is ready.
    canvas.width = 0;
    canvas.height = 0;
    image.src = "";
  }
}

export async function analyzeTransactionPhoto(workspaceId: string, file: File, signal: AbortSignal): Promise<PhotoTransactionResponse> {
  const image = await prepareTransactionPhoto(file, signal);
  const body = new FormData();
  body.append("workspaceId", workspaceId);
  body.append("image", image, "receipt.jpg");
  const response = await fetch("/api/transactions/photo", { method: "POST", body, signal, cache: "no-store" }).catch(() => {
    signal.throwIfAborted();
    throw new Error("写真を送信できませんでした。通信状態を確認して、もう一度お試しください。");
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : "写真を解析できませんでした。もう一度お試しください。";
    throw new Error(message);
  }
  const parsed = photoTransactionResponseSchema.safeParse(result);
  if (!parsed.success) throw new Error("写真の読み取り結果を確認できませんでした。もう一度お試しください。");
  return parsed.data;
}

export const MAX_PAYPAY_TRANSACTION_NUMBER_LENGTH = 160;
export const MAX_PAYPAY_EXTERNAL_ID_LENGTH = 22 + MAX_PAYPAY_TRANSACTION_NUMBER_LENGTH;

function payPayTimestamp(occurredAt: string) {
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) throw new Error("取引日時が不正です");
  // CSV dates are Japan time. Generate the same key regardless of the host timezone.
  date.setUTCHours(date.getUTCHours() + 9);
  const timestamp = date.toISOString().slice(0, 19).replace(/[-T:]/g, "");
  if (!/^\d{14}$/.test(timestamp)) throw new Error("取引日時が不正です");
  return timestamp;
}

export function payPayDateToIso(value: string) {
  const normalized = value.trim();
  const match = normalized.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2})$/);
  const invalid = () => new Error(`日時形式が不正です: ${normalized || "空欄"}`);
  if (!match) throw invalid();
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}+09:00`);
  if (!Number.isFinite(date.getTime())) throw invalid();
  const iso = date.toISOString();
  if (payPayTimestamp(iso) !== normalized.replace(/[/ :]/g, "")) throw invalid();
  return iso;
}

export function payPayExternalId(occurredAt: string, transactionNumber: string) {
  const number = transactionNumber.trim();
  if (!number) throw new Error("取引番号がありません");
  if (number.length > MAX_PAYPAY_TRANSACTION_NUMBER_LENGTH) {
    throw new Error(`取引番号は${MAX_PAYPAY_TRANSACTION_NUMBER_LENGTH}文字以内で指定してください`);
  }
  return `PayPay_${payPayTimestamp(occurredAt)}_${number}`;
}

export function normalizePayPayExternalId(occurredAt: string, externalId: string) {
  const id = externalId.trim();
  const match = id.match(/^PayPay_(\d{14})_(.+)$/);
  // Accept requests from an older client that still sends the raw transaction number.
  if (!match) return payPayExternalId(occurredAt, id);
  const canonical = payPayExternalId(occurredAt, match[2]);
  if (id !== canonical) throw new Error("取引日時と取引IDが一致しません");
  return canonical;
}

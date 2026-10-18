import type { AppActionInput } from "./app-input";

export async function postAction(payload: AppActionInput) {
  const response = await fetch("/api/app", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "処理に失敗しました。");
  return result;
}

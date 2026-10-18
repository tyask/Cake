export const DateTimePrecision = { Minute: "minute", Second: "second" } as const;
export type DateTimePrecision = typeof DateTimePrecision[keyof typeof DateTimePrecision];

const yenFormatter = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });
const dateTimeOptions: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
};
const minuteFormatter = new Intl.DateTimeFormat("ja-JP", dateTimeOptions);
const secondFormatter = new Intl.DateTimeFormat("ja-JP", { ...dateTimeOptions, second: "2-digit" });

export function formatYen(value: number): string {
  return yenFormatter.format(value);
}

/** Display only. datetime-local values must use the input conversion functions. */
export function formatJstDateTime(value: string, precision: DateTimePrecision = DateTimePrecision.Second): string {
  return (precision === DateTimePrecision.Minute ? minuteFormatter : secondFormatter).format(new Date(value));
}

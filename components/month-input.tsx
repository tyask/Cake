"use client";

import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { isHomeMonth } from "@/lib/shared/home-summary";

type MonthInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue"> & { value: string };

/** Keep the visible date independent of the native month control's locale and intrinsic size. */
export function MonthInput({ value, ...props }: MonthInputProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const [nativeMonth, setNativeMonth] = useState(true);
  useEffect(() => { setNativeMonth(input.current?.type === "month"); }, []);
  const label = isHomeMonth(value)
    ? `${Number(value.slice(0, 4))}年${Number(value.slice(5))}月`
    : value || "年月を選択";

  return <span className="month-input" data-native-month={nativeMonth}>
    <span className="month-input-value" aria-hidden="true">{label}</span>
    <input {...props} ref={input} type="month" value={value} />
  </span>;
}

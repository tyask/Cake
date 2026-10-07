"use client";

import { useLayoutEffect, useRef } from "react";
import styles from "./transactions-panel.module.css";

export function SelectionCheckbox({ label, checked, partial = false, disabled = false, onChange }: {
  label: string;
  checked: boolean;
  partial?: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <input ref={ref} className={styles.checkbox} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />;
}

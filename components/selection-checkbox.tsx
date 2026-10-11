"use client";

import { useLayoutEffect, useRef } from "react";
import styles from "./transactions-panel.module.css";

export function SelectionCheckbox({ label, checked, partial = false, disabled = false, mobileLabel, onChange }: {
  label: string;
  checked: boolean;
  partial?: boolean;
  disabled?: boolean;
  mobileLabel?: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  const checkbox = <input ref={ref} className={styles.checkbox} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />;
  return mobileLabel ? <label className={styles.selectAllLabel} data-disabled={disabled} title={label}>
    {checkbox}<span>{mobileLabel}</span>
  </label> : checkbox;
}

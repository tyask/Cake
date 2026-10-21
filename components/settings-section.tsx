import type { ReactNode } from "react";
import styles from "./settings-section.module.css";

export function SettingsSection({ title, children, className = "", contentClassName = "", busy }: {
  title: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  busy?: boolean;
}) {
  return <details className={`panel ${styles.section} ${className}`} aria-busy={busy}>
    <summary className={styles.summary}>
      <h3>{title}</h3><span className={styles.chevron} aria-hidden="true">⌄</span>
    </summary>
    <div className={`${styles.content} ${contentClassName}`}>{children}</div>
  </details>;
}

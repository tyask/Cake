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
      <h3>{title}</h3>
      <span className={styles.marker} aria-hidden="true">
        <svg className={styles.chevron} viewBox="0 0 24 24" width="20" height="20" focusable="false">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </span>
    </summary>
    <div className={`${styles.content} ${contentClassName}`}>{children}</div>
  </details>;
}

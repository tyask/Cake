"use client";

import { useEffect } from "react";

export function PageHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <span>{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

export function Modal({ title, close, children, className = "" }: { title: string; close: () => void; children: React.ReactNode; className?: string }) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={close}>×</button></header>{children}</section></div>; }
export function Empty({ text }: { text: string }) { return <div className="empty"><span>○</span><p>{text}</p></div>; }

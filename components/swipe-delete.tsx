"use client";

import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode, type PointerEvent } from "react";
import styles from "./swipe-delete.module.css";

/** Reveals an action only. Confirmation and persistence belong to the caller. */
export function SwipeDelete({ children, label, disabled = false, onDelete }: {
  children: ReactNode; label: string; disabled?: boolean; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const focusAfterChange = useRef<"action" | "toggle" | null>(null);
  const gesture = useRef<{ id: number; x: number; y: number; axis: "x" | "y" | null } | null>(null);
  const moved = useRef(false);
  const actionId = useId();
  const shown = open && !disabled;

  useLayoutEffect(() => {
    if (focusAfterChange.current === "action" && shown) action.current?.focus();
    if (focusAfterChange.current === "toggle" && !shown) toggle.current?.focus();
    focusAfterChange.current = null;
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { focusAfterChange.current = "toggle"; setOpen(false); } };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    const media = window.matchMedia("(max-width: 48rem)");
    const resize = () => { if (!media.matches) setOpen(false); };
    media.addEventListener("change", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      media.removeEventListener("change", resize);
    };
  }, [shown]);

  function start(event: PointerEvent<HTMLDivElement>) {
    moved.current = false;
    gesture.current = null;
    if (disabled || !event.isPrimary || event.pointerType === "mouse" || !window.matchMedia("(max-width: 48rem)").matches
      || (event.target instanceof Element && event.target.closest("input, select, textarea, [data-no-swipe]"))) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (!current.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 10) current.axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? "x" : "y";
    if (current.axis !== "x") return;
    moved.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (Math.abs(dx) >= 45) setOpen(dx < 0);
  }

  return <div ref={root} className={styles.root} data-swipe-open={shown}>
    <button ref={action} id={actionId} type="button" className={styles.remove} hidden={!shown} disabled={disabled}
      aria-label={`${label}を削除`} onClick={() => { if (!disabled) onDelete(); }}>削除</button>
    <div className={styles.content} onPointerDown={start} onPointerMove={move}
      onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }}
      onClickCapture={event => {
        if (moved.current || shown) { event.preventDefault(); event.stopPropagation(); if (!moved.current) setOpen(false); moved.current = false; }
      }}>
      <div className={styles.body}>{children}</div>
    </div>
    <button ref={toggle} type="button" className={styles.toggle} disabled={disabled} aria-label={`${label}の削除操作`}
      aria-expanded={shown} aria-controls={actionId} onClick={() => { focusAfterChange.current = shown ? "toggle" : "action"; setOpen(!shown); }}>⋯</button>
  </div>;
}

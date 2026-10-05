"use client";

import { useId } from "react";
import type { SplitWeights, WorkspaceMember } from "@/lib/types";

export function SplitEditor({ members, value, onChange, disabled = false, compact = false, label = "負担割合" }: {
  members: WorkspaceMember[];
  value: SplitWeights;
  onChange?: (value: SplitWeights) => void;
  disabled?: boolean;
  compact?: boolean;
  label?: string;
}) {
  const id = useId();
  const total = members.reduce((sum, member) => sum + (value[member.id] ?? 0), 0);
  return (
    <fieldset className={`split-editor${compact ? " split-editor-compact" : ""}`} disabled={disabled}>
      <legend>{label}</legend>
      <div className="split-editor-fields">
        {members.map((member) => (
          <label key={member.id} htmlFor={`${id}-${member.id}`}>
            <span>{member.name}</span>
            <input id={`${id}-${member.id}`} type="number" required min="0" max="2147483647" step="1"
              value={value[member.id] ?? 0} readOnly={!onChange}
              onChange={(event) => onChange?.({ ...value, [member.id]: Number(event.target.value) })} />
            <small>{total > 0 ? `${Math.round(((value[member.id] ?? 0) / total) * 1000) / 10}%` : "—"}</small>
          </label>
        ))}
      </div>
      {total <= 0 && <p className="form-error">どちらかの割合を1以上にしてください。</p>}
    </fieldset>
  );
}

/** Compare editor values, including unordered split-weight maps. */
export function fieldEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);
}

export function valuesEqual<T extends object>(left: T, right: T): boolean {
  return Object.keys(left).every(key => fieldEqual(left[key as keyof T], right[key as keyof T]));
}

/** Read at queue execution, and acknowledge before releasing the shared queue. */
export async function saveChanged<T extends object>(
  read: () => { values: T; base: T },
  send: (values: T) => Promise<T>,
  accept: (values: T) => void,
): Promise<void> {
  const { values, base } = read();
  const saved = valuesEqual(values, base) ? base : await send(values);
  accept(saved);
}

/** Multiple commit triggers share one operation; a later trigger rereads the draft. */
export function createAutosaveRequest() {
  let running: Promise<void> | null = null;
  let again = false;
  return (operation: () => Promise<void>): Promise<void> => {
    if (running) { again = true; return running; }
    running = Promise.resolve().then(async () => {
      do { again = false; await operation(); } while (again);
    }).finally(() => { running = null; });
    return running;
  };
}

export function acknowledge<T>(source: string, previous: { sources: string[]; values: T } | null, saved: T, signature: (value: T) => string) {
  const sources = [...new Set([source, ...(previous?.sources ?? []), ...(previous ? [signature(previous.values)] : [])])];
  return source === signature(saved) ? null : { sources, values: saved };
}

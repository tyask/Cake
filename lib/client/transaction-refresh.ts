export type TransactionRefreshEditor = {
  freeze: (value: boolean) => void;
  flush: () => Promise<void>;
};

/** Keep edits frozen until their saves and the following refresh have finished. */
export async function refreshTransactionEditors(
  editors: readonly TransactionRefreshEditor[],
  pendingSaves: () => Promise<void>,
  refresh: (prepare: () => Promise<void>) => Promise<void>,
): Promise<void> {
  for (const editor of editors) editor.freeze(true);
  try {
    await refresh(async () => {
      for (const editor of editors) await editor.flush();
      await pendingSaves();
    });
  } finally {
    for (const editor of editors) editor.freeze(false);
  }
}

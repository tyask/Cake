import assert from "node:assert/strict";
import test from "node:test";
import { refreshTransactionEditors, type TransactionRefreshEditor } from "../lib/transaction-refresh";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("入力とメモの保存・進行中の保存キューを待ち、再取得完了まで全行を固定する", async () => {
  const events: string[] = [];
  const saves = deferred();
  const fetched = deferred();
  const editors = ["明細", "清算済みのメモ"].map(name => ({
    freeze: (value: boolean) => { events.push(name + (value ? ":固定" : ":解除")); },
    flush: async () => { events.push(name + ":保存"); },
  }));
  const operation = refreshTransactionEditors(editors, () => saves.promise, async prepare => {
    await prepare();
    events.push("再取得");
    await fetched.promise;
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["明細:固定", "清算済みのメモ:固定", "明細:保存", "清算済みのメモ:保存"]);
  saves.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(events.at(-1), "再取得");
  assert.equal(events.some(event => event.endsWith(":解除")), false);
  fetched.resolve();
  await operation;
  assert.deepEqual(events.slice(-2), ["明細:解除", "清算済みのメモ:解除"]);
});

test("明細またはメモの保存失敗時は再取得せず、全行の固定を解除する", async () => {
  for (const failed of ["明細", "メモ"]) {
    const frozen = new Map<string, boolean>();
    let fetched = false;
    const editors: TransactionRefreshEditor[] = ["明細", "メモ"].map(name => ({
      freeze: value => { frozen.set(name, value); },
      flush: async () => { if (name === failed) throw new Error(name + "を保存できませんでした。"); },
    }));
    await assert.rejects(refreshTransactionEditors(editors, async () => {}, async prepare => {
      await prepare();
      fetched = true;
    }), new RegExp(failed + "を保存できませんでした"));
    assert.equal(fetched, false);
    assert.deepEqual([...frozen.values()], [false, false]);
  }
});

test("再取得の失敗後も編集と一括操作を再開できるよう固定を解除する", async () => {
  let frozen = false;
  await assert.rejects(refreshTransactionEditors([
    { freeze: value => { frozen = value; }, flush: async () => {} },
  ], async () => {}, async prepare => {
    await prepare();
    throw new Error("更新に失敗しました。");
  }), /更新に失敗しました/);
  assert.equal(frozen, false);
});

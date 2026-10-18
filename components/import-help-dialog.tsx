"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./import-help-dialog.module.css";

export function ImportHelpDialog({ importUrl, close }: { importUrl: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [copyNotice, setCopyNotice] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(importUrl);
      setCopyNotice("URLをコピーしました。");
    } catch {
      setCopyNotice("コピーできませんでした。URLを長押ししてコピーしてください。");
    }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={close}>
    <header className={styles.header}>
      <h2 id={titleId}>iPhoneでショートカットを設定</h2>
      <button type="button" className={styles.closeIcon} aria-label="ヘルプを閉じる" onClick={() => dialog.current?.close()}>×</button>
    </header>
    <div className={styles.body}>
      <p className={styles.intro}>一度設定すると、PayPayのCSVを共有してCakeへ取り込めます。ファイルに保存して選び直す操作を省けます。</p>
      <section>
        <h3>ショートカットを作る</h3>
        <ol className={styles.steps}>
          <li><strong>新規ショートカットを作成</strong><p>iPhoneの「ショートカット」アプリで新しく作り、名前を「Cakeに取り込む」にします。</p></li>
          <li><strong>共有シートに表示</strong><p>詳細設定の「共有シートに表示」をオンにし、受け取る入力を「ファイル」にします。</p></li>
          <li><strong>「入力からテキストを取得」を追加</strong><p>対象は「ショートカットの入力」にします。</p></li>
          <li><strong>「クリップボードにコピー」を追加</strong><p>前のアクションで取得したテキストを渡します。「ローカルのみ」をオンにし、「有効期限」は現在から5分後など短い時間にします。</p><p>日時を指定する場合は、「現在の日付」を5分進めた値を使います。</p></li>
          <li><strong>「URL」→「URLを開く」を追加</strong><p>「URL」に以下の設定用URLを指定し、「URLを開く」へ渡します。</p>
            <code className={styles.url}>{importUrl}</code>
            <button type="button" className={`secondary ${styles.copyButton}`} onClick={() => void copyUrl()}>URLをコピー</button>
            <p className={styles.copyNotice} role="status">{copyNotice}</p>
          </li>
        </ol>
        <p className={styles.note}>iOSのバージョンによって、アクション名や設定場所が異なる場合があります。</p>
      </section>
      <section className={styles.usage}>
        <h3>PayPayから取り込む</h3>
        <ol className={styles.steps}>
          <li>PayPayの「取引履歴」でCSVを開き、共有から「Cakeに取り込む」を選びます。</li>
          <li>Cakeが開いたら「貼り付け」を押します。Safariの確認が出た場合は「ペースト」を選びます。</li>
          <li>取込先の家計、支払者、明細を確認して登録します。</li>
        </ol>
      </section>
    </div>
    <footer className={styles.footer}>
      <button type="button" className="secondary" onClick={() => dialog.current?.close()}>閉じる</button>
    </footer>
  </dialog>;
}

# QA自動返却の確認手順

通常のタスク枝とdraft PRを作り、`deploy:preview`の計画を照合・承認して、固定QA URLとテストDBを用意します。

1. PR・コミット・QA枠・貸出ID・全Deployment ID・DB識別子を記録し、固定QA URLが最新のREADYを指すことを確認します。接続文字列や資格情報は記録しません。
2. 利用者がPRをmainへマージします。通常QAは追加のcleanup承認なしで返却され、登録テストデータも削除されます。
3. `QA pool`のclosed実行が固定alias解除・全Deployment削除・NeonのDB消失確認を完了し、台帳をfreeへ戻すことを確認します。
4. 待機上限や失敗でdeletingが残った場合は、現在のPR番号と貸出IDを指定したreleaseを再実行します。定期監視は使いません。

未マージcloseと限定probeは個別の削除承認が必要です。詳しい照合条件は[QA貸出枠の運用](qa-pool.md)を参照してください。

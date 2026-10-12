# qa1限定probeの準備確認

このPRは、[QA貸出運用](qa-pool.md)に従う限定検証の確認手順を記録する文書のみの変更です。今回の承認範囲はdraft OPEN PRの作成とGET専用診断までで、環境作成・probe・alias更新・削除・設定変更・mergeは含みません。

- 対象は同一repositoryのmain向けOPEN PRと、実行時に確認した現在の完全head SHAです。
- mainと対象SHAの`vercel.json`について、main-only Git設定とcommit/blob証跡を確認します。
- pool・Git確認・Native確認の3flagはfalseまたは未設定を維持し、通常運用を有効化しません。
- `preflight`と`plan-probe`はGET専用で、台帳・設定・資源・DBを変更しません。job成功と各チェック成功は区別します。
- 空のqa1への計画は、対象SHAについて初回最大2deploymentを想定します。承認後も各手動probeは最大1件の生成要求だけを送り、同じleaseを保持します。
- probe承認は`projectId`、`pr`、`sha`、`slot=qa1`、`expiresAt`の5項目だけとし、運用者がRepositoryとPreviewの実効scopeを確認します。
- 初回はhost未確認でDB接続前に停止します。Native所属・親・作成時刻・endpoint確認後、次の手動probeで子DBの空状態または承認済み2人fixtureとの厳密一致を検査します。
- probeはaliasを変更しません。未解決intentではheldを保持し、削除には別の全資源manifestと期限付き承認が必要です。

今回の読み取り確認は、Native生成・親選択・guard注入・cleanupのlive実証成功を意味しません。接続文字列・host・資格情報の実値は文書・PR本文・報告へ記載しません。

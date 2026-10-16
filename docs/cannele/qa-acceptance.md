# Cannele切替後のQA受入確認

この試験PRでは、Cloud・ローカルPC共通の通常コマンドを使い、Cannele切替後のQAフローを実環境で確認する。結果と対象のPR・SHA・貸出・DeploymentはPR本文へ記録する。

- draft PRを作成してから、QA配置の直前に空き枠を予約する。
- provisioningからNative DBを照合し、applicationを配置する。
- Deployment固有URLでPC/mobile・テストユーザーA/Bの画面操作とAPIを確認する。
- 同じDeploymentを固定QA URLへ公開し、同じ確認を行う。
- 現在HEADのCIと両URLの検証結果を確認してReadyへ進める。
- 利用者のマージ後、closed ActionsからのAPI呼出しで対象資源を削除し、枠の返却を確認する。

QA枠の一覧読取やAPIの起動確認とは別に、この一連の受入結果を記録する。定期監視は追加しない。

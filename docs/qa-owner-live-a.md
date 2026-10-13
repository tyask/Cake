# QA owner plan live test A

このdraft PRは、PR #41で導入した計画ID承認経路をqa1で検証するための非機能的な差分です。最新main `813bb83528a28ee298dc43c10f7f8e19acf5104c` から作成し、アプリ、DB migration、Git/Vercel設定を変更しません。mainへmergeしません。

現在の段階は **A/H2 更新**です。H1 は計画 `7040068120` のowner承認run `38406982486`、同leaseのapplication READY、固定aliasの一致を確認済みです。この文書だけを1回更新し、新HEADの計画・CI・owner承認を照合してから、追加application deployment 1件だけで保持を検証します。`vercel.json` の `git.deploymentEnabled` はmainから継承した `{"**": false, "main": true}` を保持します。

承認済み試験の全体上限は、新draft PR A/Bの2件、Vercel deployment 5件、Native子DB branch 2個、同時使用する試験DB 1個です。PR BはAの返却とqa1 free確認後に作成します。

| 段階 | 作成上限 | 確認内容 |
| --- | --- | --- |
| A/H1 | Deployment 2、DB 1 | 新lease、初期サンプル、最新READYと固定URL |
| A/H2 | Deployment 1、DB 0 | 同lease・DB identity・試験入力の保持、固定URLの更新 |
| A返却 | 作成0 | 全3 Deploymentとalias、Native branch／endpoint消失後にfree |

試験入力は固定サンプル環境の確認用データだけとし、本番データや個人情報を持ち込みません。削除はruntime確認後に実際の全resource IDを持つcleanup planを表示し、作成とは別に承認を受けます。識別不一致・不明な応答は停止し、盲目的な再作成や削除を行いません。

利用者が確認した3flagsの元状態はRepository／Previewとも未登録です。試験終了時には試験用に追加したRepositoryの3flagsを削除して復元します。旧承認は自動復元しません。新credential、権限拡張、ネットワーク制限変更、Production操作を行いません。

## H2前のruntime基準

2026-10-13、更新された保存済み環境から固定QA URLへのTLS接続とVercel protection到達を確認し、既存のprotection認証を使用してアプリAPIのHTTP 200を確認しました。credentialや保護設定は追加・変更していません。

- H1: `0d3eaecdb2ffda830c3ed029f78b9b5502665f15`、qa1はheld、lease `c5127386-a1d9-40b2-af29-4c1043328c4b`、台帳 `7040245232`。
- Native DB: project `misty-meadow-88903426`、子branch `br-long-surf-b39a7wf5`、endpoint `ep-delicate-paper-b378yx5j`。親branchは変更しません。
- 固定ユーザーA/Bのログイン成功。Aの管理者一覧は200、Bは403、未ログインは401。固定共有家計とA OWNER／B MEMBERを確認しました。
- 固定利用者 `qa-lifecycle-a@example.test` を1件登録し、ID `2e93a23d-3c49-4db8-b202-c961c59aeaab` をGETで確定しました。
- 共有明細 `QA-LIFECYCLE-A-FIXED-001`（2026-10-13、1,234円、A/B各weight 1）を1件登録し、ID `6aaf77d3-b9e6-4cb1-b71c-36c2027f54ce` をGETで確定しました。POSTの再送はありません。
- H2では保存済みのAPI全状態、同sessionと再ログイン、ユーザー・権限・所属・登録IDと内容を比較します。結果はPR本文の実測記録に追記し、この試験用HEADを追加更新しません。

削除、PR close、PR Bの作成、3flagsの復元はこのH2更新では行いません。A完了後にGET専用診断で正確な削除対象とデータ喪失を報告して停止します。

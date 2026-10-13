# QA owner plan live test A

このdraft PRは、PR #41で導入した計画ID承認経路をqa1で検証するための非機能的な差分です。最新main `813bb83528a28ee298dc43c10f7f8e19acf5104c` から作成し、アプリ、DB migration、Git/Vercel設定を変更しません。mainへmergeしません。

現在の段階は **A/H1 準備**です。旧承認の整理と3flagsの設定完了、現在HEADへのowner plan承認を確認するまでdeployment／DB作成を開始しません。`vercel.json` の `git.deploymentEnabled` はmainから継承した `{"**": false, "main": true}` を保持します。

承認済み試験の全体上限は、新draft PR A/Bの2件、Vercel deployment 5件、Native子DB branch 2個、同時使用する試験DB 1個です。PR BはAの返却とqa1 free確認後に作成します。

| 段階 | 作成上限 | 確認内容 |
| --- | --- | --- |
| A/H1 | Deployment 2、DB 1 | 新lease、初期サンプル、最新READYと固定URL |
| A/H2 | Deployment 1、DB 0 | 同lease・DB identity・試験入力の保持、固定URLの更新 |
| A返却 | 作成0 | 全3 Deploymentとalias、Native branch／endpoint消失後にfree |

試験入力は固定サンプル環境の確認用データだけとし、本番データや個人情報を持ち込みません。削除はruntime確認後に実際の全resource IDを持つcleanup planを表示し、作成とは別に承認を受けます。識別不一致・不明な応答は停止し、盲目的な再作成や削除を行いません。

利用者が確認した3flagsの元状態はRepository／Previewとも未登録です。試験終了時には試験用に追加したRepositoryの3flagsを削除して復元します。旧承認は自動復元しません。新credential、権限拡張、ネットワーク制限変更、Production操作を行いません。

# QA owner plan live test B

このdraft PRは、PR #41で導入した計画ID承認経路とqa1再貸出の実環境試験Bです。最新main `813bb83528a28ee298dc43c10f7f8e19acf5104c` から作成した文書のみの差分で、アプリ、migration、Git/Vercel設定を変更せず、mainへmergeしません。通常の文書変更ではPreview不要ですが、今回は承認済みQAライフサイクル試験として生成を行います。

試験AのPR #42は未マージでclose済みです。cleanup plan `7041580408`、owner承認run `38415894823`、対象限定release run `38416040891` により専用3deploymentとaliasを返却し、Native子branch／endpointの消失gate通過後にqa1のfree台帳 `7041644964` を確認してからBを開始します。親側でもjob `115360634989` の返却完了ログを確認済みです。古い返却診断のTarget PR GET504／plan未確認は削除の根拠に使っていません。

| 制約 | Bの範囲 |
| --- | --- |
| PR | 新しいdocsのみdraft PRを1件。mergeしない |
| 貸出枠 | qa1をAの返却・free確認後に順次使用 |
| 追加生成 | Vercel deployment最大2件、Native子DB branch最大1個 |
| 全試験の累計 | Aの3deployment／1DBと合わせ最大5deployment／2DB |
| 同時使用 | 試験DB最大1個 |
| 削除 | Bは未承認。実測対象とデータ喪失を報告して停止 |

Bの新計画は完全HEAD、main、qa1、free台帳世代、確認済み親branch、空の既存資源集合、上限2deployment／1DB、期限、digestを機械照合します。既存owner認証で承認workflowを代行し、初回attemptのactor／triggering_actorと計画の結合、成功を確認してから生成を進めます。本人のGitHub UI操作や新credential、権限拡張、設定変更を要求しません。

受入条件は次のとおりです。

- Aのlease `c5127386-a1d9-40b2-af29-4c1043328c4b`、子branch `br-long-surf-b39a7wf5`、endpoint `ep-delicate-paper-b378yx5j` を再利用しない。
- Native初回DB guardで現行schema、固定二人・共有家計・所属、空の業務7表を厳密受入し、runtimeでは固定A/B、管理者権限、APIで観測可能な初期状態を確認する。
- Aで登録した `qa-lifecycle-a@example.test` と、1,234円の明細 `QA-LIFECYCLE-A-FIXED-001` が存在しない。
- 固定alias `cake-qa1-fumin.vercel.app` がBの現在HEADのREADY applicationを指す。再ログイン後も初期状態を保持する。
- POSTの不確かな応答はまずGETで状態を確定し、追加生成を重複させない。未確認intent・対象変化・予算超過では停止する。

親DB、本番、main、PR #33、保護設定を変更しません。業務データを追加・消去して初期状態を作り直しません。試験用Repositoryの3flagsは保持し、Bの削除や全試験後の元状態への復元は別段階です。最新の実測結果と正確なB削除候補はPR本文へ記録し、このHEADを追加更新しません。

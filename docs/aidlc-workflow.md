# AI-DLC開発フロー

Cakeは、利用者の依頼から計画・実装・PR検証・merge後の確認までを一つの案件として追跡する。
AI-DLC Workflows v2の記録構成を使い、既存の別Agentレビュー・CI・Preview・Ready条件へ接続する。
ここで使う`task:intent`はCakeの運用コマンドであり、公式AI-DLCエンジンの導入・実行を示すものではない。
公式エンジンのstage runner・hook・承認receiptを生成したものとして扱わない。

## 依頼から完了まで

1. 利用者がチャットまたはIssueで依頼する。最初から技術項目をすべて埋める必要はない。
2. Agentが既存仕様・実装を調べ、目的・範囲・受入条件・実装方針・検証方法を含む具体的な開発計画をチャットに提示する。
3. 利用者が提示された計画を承認する。提示後の発言がその計画を承認対象としていることを確認する。
4. AgentがIssueを作成・更新し、承認した計画の要約を載せる。保存済み本文を再取得して書式・内容を確認し、本文とURLをチャットへ提示する。
5. 利用者が提示されたIssue本文を承認する。計画承認とは別に、提示後の発言で確認する。
6. Issue承認後に専用branch/worktreeを作り、Intentへ計画と両方の承認証拠を記録する。
7. 計画に沿って設計・実装・テスト・自己レビューを行う。
8. 案件記録をfreezeしてcommitし、別Agentレビュー・修正・必要な再レビューを行う。
9. 最終SHAをローカル検証し、draft PR・CI・自動Preview・必要な正式QAを揃える。
10. 条件を満たしたPRをReadyにし、利用者へ結果を報告する。
11. 利用者がmergeする。
12. Actionsがmain CI・Production・常設Preview・専用資源cleanupを確認し、Issueへ結果を記録する。
13. 案件の全確認が揃ったらIssueをcloseする。失敗や追加確認が残ればopenを維持する。

計画の承認前は、読み取り専用の調査とチャットでの計画提示までにとどめる。
Issueの作成・更新は計画提示後の承認を確認してから行う。
branch/worktree・Intentの作成、実装・PR作成は、さらに保存済みIssue本文の提示後の承認を確認してから行う。
計画承認を、まだ提示していないIssue本文の承認へ流用しない。
承認は発言が対象とする計画・Issue本文と提示順序から判断し、特定の定型句は求めない。
一般的な方針への同意・作業依頼・着手指示だけから、未提示の開発計画への承認を推定しない。

相談・調査・計画の提案だけを依頼された場合は、Issue・branch・PRを新しく作らない。
通常の変更依頼でも、対象外の変更や本番操作を承認済みとして扱わない。
PRのmerge・closeとProductionへの変更操作は、引き続き利用者の依頼範囲に従う。

## 工程の選び方

| フェーズ | Cakeで確認・記録すること |
| --- | --- |
| Initialization | 対象repository・Issue・branch・作業環境とIntentの対応 |
| Ideation | 解決する問題、利用者、成功条件、対象範囲と対象外 |
| Inception | 既存コード・慣行、詳細要件、設計、作業単位、検証計画 |
| Construction | 実装・テスト・自己レビュー・別Agentレビュー・最終検証 |
| Operation | PR・Preview・Ready・merge後の稼働確認・改善 |

軽微な修正は既知の問題・期待結果・最小の影響範囲から始める。
標準の機能変更は要件・設計・作業単位・検証計画を整理する。
大きな変更は目的や代替案、運用・互換性まで詳しく検討する。
どの工程を採用・省略するかと、その理由を計画に残す。
公式v2の全stageを毎回実行したり、公式profileがこの運用コマンドで実行できると仮定したりしない。
短縮時もCakeの別Agentレビュー・最終SHA検証・CI・Preview・Ready条件を省略しない。

## 記録の保存先

| 保存先 | 正本となる内容 | Git管理 |
| --- | --- | --- |
| Issue | 依頼・目的・範囲・受入条件の要約、進捗、Intent・PRへのリンク | GitHubで保持 |
| Intent | 詳細要件、計画、工程状態、計画承認・Issue承認それぞれの証拠と判断履歴 | 対象branchでcommit |
| PR本文・コメント | 実装の変更内容、現在HEADのレビュー・検証結果、受入条件との対応 | GitHubで保持 |
| 設計書・開発手順 | 現在の仕様・構成・運用ルール | commit |
| spaceのmemory・knowledge | 案件をまたぐルール・学び・参考資料 | commit |
| `.cake/` | 計画の下書き、投稿用本文、ローカルの検証証拠・一時ファイル | 対象外 |
| Actions | CI・Preview・merge後確認のrun、正式receipt、検証artifact | GitHubで保持 |

Issueは詳細記録への入口とし、長い検討経緯や監査ログを転載しない。
要件を変更した場合はIntentの計画を正本として更新し、Issueの要約と受入条件も揃える。
PRは最終的な変更と検証結果を説明する。
現在の仕様を説明する設計書へ、案件の履歴や過去の受入記録を混ぜない。
資格情報・接続文字列・Cookieなどは、いずれの記録先へも保存しない。

### 標準構成とCakeの記録

```text
aidlc/
└── spaces/
    └── default/
        ├── memory/
        ├── knowledge/
        ├── intents.json
        └── intents/
            └── <YYMMDD>-<label>/
                ├── cake-intent.json
                ├── plan.md
                ├── plans/
                │   └── <計画のSHA-256>.md
                ├── aidlc-state.md
                └── audit/
                    └── cake.md
```

`default`はCakeの共通ルール・知識を共有するspace、Intentは実現したい変更の単位である。
基本は1 Issue＝1 Intentとし、同じ案件を作り直さず既存記録を更新する。
分割PRを使う場合も同じIssue・Intentへ関連付け、案件を完了するPRを区別する。

`cake-intent.json`はCakeの機械可読な正本、`plan.md`は利用者が承認する計画本文である。
承認時の本文は`plans/`にも保存し、計画変更後も元の承認対象を確認できるようにする。
`aidlc-state.md`と`audit/cake.md`には状態と操作履歴を記録する。
これらは`task:intent`を使って更新する。
公式エンジンのreceiptや内部stateとして手作業で加工しない。
個人の選択位置・実行時ファイルはGitへ含めず、共有する記録と分ける。

## 計画・承認・受入条件

チャットに提示する計画は、Issue本文へそのまま記載できる具体性・情報量とする。
計画提示前に、[新機能・改善](../.github/ISSUE_TEMPLATE/feature.yml)、
[不具合](../.github/ISSUE_TEMPLATE/bug.yml)、[開発・運用・文書の作業](../.github/ISSUE_TEMPLATE/task.yml)から、
案件に対応するテンプレートを実際に読む。
必須項目と案件に該当する任意項目を踏まえ、次を記載する。

- 目的・背景、現在の問題と期待する挙動。不具合の場合は判明している再現手順・発生条件。
- 対象範囲・対象外と、維持すべき挙動・制約。
- `AC-01`等の識別子を付けた受入条件。
- 影響する機能・データ・互換性と、主な実装方針。
- 採用する工程・作業単位と、省略する工程の理由。
- テスト・CI・Preview・変更固有の検証方法。
- merge後の確認と、必要な手動確認。
- 未確定事項・前提と、該当する関連資料。

要件・受入条件などを省いた作業概要だけで承認を求めず、Issue化する前に利用者が判断できる内容を提示する。
未確定の事項はその旨を示し、作成前のIssue・PR番号や実施後の結果を埋める必要はない。
承認後のIssueには提示した内容を引き継ぎ、Issue化の際に初めて要件・受入条件を追加しない。
変更が必要になった場合は、変更後の計画をチャットに提示して再承認を得る。
その後にIssueへ反映し、保存済み本文とURLを提示してIssue承認を得てから開発を開始・再開する。

承認対象の本文は、先にチャットへ提示し利用者が承認した開発計画と一致させる。
承認記録にはその計画本文のhash、承認者、実際の承認文、記録日時を保存する。
入力ファイルのCRLFはrepositoryのLF規則へ揃えてから保存・hash計算し、WindowsとLinuxで共有できるようにする。
これはAgentが確認した発言を転記する記録であり、発言者の本人性を暗号学的に証明するものではない。
`--at`は記録日時であり、利用者が発言した日時を推測して指定するものではない。
同じ承認済み計画・Issueで再開する場合は、それぞれの対象の提示と、その提示後の承認発言の組を承認証拠として使える。
計画提示前の発言を、後から作成・追加した計画の承認へ流用しない。
Agentが承認文を作成したり、無回答や経過時間を承認と解釈したりしない。

計画本文を変更すると、それまでの承認とfreezeは無効になる。
目的・範囲・受入条件・重要な実装方針の変更を説明し、変更後の計画に対して承認を得る。
Issue承認は、GitHubに保存した本文を再取得し、本文とURLをチャットに提示した後の利用者の発言で確認する。
IssueのURL・承認対象本文・承認者・実際の承認発言・記録日時を、計画承認とは別にIntentの工程メモへ保存する。
`task:intent approve`は計画承認の記録に使い、Issue承認の記録で上書きしない。
具体的な記録方法は[案件記録の操作](development-commands.md#案件記録の操作)に従う。
CLIはチャット上の承認の有無や提示順序を自動検証しないため、Agentが実行前に両方の承認を照合する。

同じ承認済み計画・Issueの範囲で行う通常の実装・検証・修正について、既に得た承認を繰り返し求めない。
進捗・検証結果・関連リンクの追記や、検証済み受入条件のチェック更新ではIssue承認を求め直さない。

Issueの初期入力は新機能・不具合・作業のフォームから選べる。
Agentが作成・整理する本文は次の形に揃える。
5つの見出しを独立させ、受入条件は識別子付きのチェックリストとする。
テンプレートの該当内容を残し、既存の依頼・再現条件・制約を整理時に落とさない。
作成・本文更新前に該当内容・見出し・チェックリストを照合し、操作後に保存済み本文を再取得して確認する。
CLI・APIから作成・更新する場合も同じ手順を使う。

```markdown
## 目的・背景

## 対象範囲・対象外

## 受入条件

- [ ] AC-01: 操作したときに確認できる期待結果

## 関連記録

- 承認済み計画・Intent:
- PR:

## 進捗

- 状況: 未着手 / 実行中 / 阻害あり / 完了
- 現在の工程:
- 次の作業・阻害要因:
```

## 最終検証前の記録確定

1. 実装と計画・進捗・判断をIntentへ反映する。
2. `task:intent freeze`で承認と計画hashの一致を確認し、記録を凍結する。
3. アプリ・テスト・案件記録をcommitし、cleanな完全SHAを別Agentレビューへ渡す。
4. 以後のレビュー・検証結果は`.cake/`の下書きからPR・Issue・Actionsへ記録する。
5. 修正が必要ならIntentをreopenし、必要な記録を更新してfreeze・commitし直す。
6. 新しいHEADを再レビューし、必要なローカル検証・CI・Preview・正式QAを揃える。

freeze後はIntentの進捗を更新しない。
`aidlc-state.md`がfreeze時の状態でも、PR・Issueの最新結果を参照して実際の進捗を確認する。
Ready・merge・merge後確認のためだけに追跡ファイルを書き換え、検証SHAを進めない。
記録変更も含めてHEADを進めた場合は、過去SHAの証拠を今回の検証結果として流用しない。

Intentの計画・状態・監査記録だけの差分は、文書変更として内容・参照・整合性をレビューできる。
アプリ・script・workflow・依存・実行設定を含む変更はこの扱いに含めない。
文書変更でも現在HEADのCI・自動Preview/statusを確認し、正式ブラウザ再検証を省く理由をPRへ記録する。
CLIの正式ブラウザ証拠gateへ省略機能は追加しない。

## PRとmerge後の確認

PR本文の「変更内容」「Preview」「検証結果」の3章を維持する。
「変更内容」にIssue・Intentへのリンク、変更前後の挙動、実装理由、DB変更・互換性を記載する。
「検証結果」に受入条件ごとの証拠、完全SHA、別Agentレビューの要約・詳細リンク、未実施項目を記載する。
生成する関連情報を手編集したり、別案件のmetadataを本文へ埋めたりしない。

Issueを閉じる`Closes`・`Fixes`・`Resolves`等のキーワードは、PR本文・commit messageへ記載しない。
GitHubのDevelopment欄のmerge時にIssueを閉じる関連付けも使わず、通常の参照リンクを記載する。
mergeだけでIssueを閉じず、merge後の確認へ引き継ぐ。
案件を完了するPRには`--completes-issue`を指定する。
分割途中のPRでは指定せず、最後のPRだけで完了を申告する。
手動の本番確認などが必要なら`--manual-post-merge`を指定し、自動closeを保留する。
更新時にこれらの属性を省略すると既存値を維持する。
明示的に解除する場合は`--no-completes-issue`・`--no-manual-post-merge`を指定する。

Readyは開発・PR検証の完了を表す。
mergeは利用者が行い、既存の本番デプロイと専用資源cleanupを起動する。
mainへの`push`から対象merged PRをGitHub APIで照合し、信頼済みmainのコードでcleanup・案件確認を進める。
PR用Preview管理は`pull_request`の受付とmainの`workflow_run`へ分離し、
資格情報はmain限定Environment `cake-automation`へ置く。
設定と実行経路は[Actionsのイベントと資格情報](actions-event-migration.md)を参照する。
merge後のActionsは、PRのHEAD SHAとmerge SHAを区別して次を確認する。

- merge先のmain CI。
- 対象mergeのProduction Deploymentと本番alias。
- 常設Previewの正式receipt。
- PR専用Preview・DBのcleanupと資源の不在。

結果はActions artifactとIssueのbot所有の固定コメントへ記録する。
固定コメントにはPRごとの最新結果を保持し、先行分割PRの失敗・手動確認待ちを後続PRの成功で消さない。
案件完了が指定され、同じIssueに関連するすべてのmerge済みPRの結果が成功し、手動確認も未マージPRも残らない場合にIssueをcloseする。
過去のPRの結果を確認できない場合も、未確認としてopenを維持する。
PR番号や秒精度のmerge時刻だけで新旧を決めず、実際のmain SHAと各PRの実行世代を確認する。
Issueに関連付かないPRの不正metadataは当該Issueの判定に含めない。
既知の関連PRの対応が失われた場合は、保持した履歴との不一致として完了を保留する。
固定コメントは履歴50件・60KBを上限とし、超過時は既存の報告を壊さずActionsを失敗させる。
失敗・timeout・後続mergeによる対象変更は、その結果とrunへのリンクを残してopenを維持する。
既に閉じているIssueを勝手にreopenしない。
手動確認の完了は、利用者または権限を持つ担当者が証拠を追記して判断する。
再確認は対象PRを指定してActionsを手動実行し、本番への再deployや無関係な資源操作で代用しない。

## 再開・学びと関連手順

再開時はIntent・Issue・branch・PRの対応と、現在の完全SHA・draft/Ready/merged状態を確認する。
凍結前は`task:intent status`で進捗を読み、凍結後はPR・Issue・Actionsの結果も読む。
merge済みのbranchで新しい変更を始めず、必要な追加作業を別案件として計画する。

共有する学びはspaceのmemoryへ残す。
繰り返し適用する設計・運用の変更は、AGENTS・設計原則・開発手順の該当箇所へも反映する。
保存先ごとに矛盾する規則を残さず、案件内の一時的な判断と区別する。

- [開発ルール](../AGENTS.md)
- [開発・QA運用手順](development-workflow.md)
- [開発・PR操作のコマンド](development-commands.md)
- [AI-DLC Workflows v2の記録構成](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/03-spaces-and-intents.md)

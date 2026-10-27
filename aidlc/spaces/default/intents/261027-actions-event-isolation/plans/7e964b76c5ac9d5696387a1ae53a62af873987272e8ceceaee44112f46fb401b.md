# PR受付とmain管理処理の分離

## 目的と期待する挙動

公開repositoryに対するpull_request_targetの既定制限に備え、Cakeの自動Previewとmerge後の確認を継続する。
PRの作成・更新・終了の検知はpull_requestで行い、資格情報を使う管理処理はmainのコードで実行する。
利用者の開発依頼・計画承認・PR確認・mergeという手順を維持する。

## 承認済みの範囲と制約

- PR受付をpull_request、Preview管理をmainのworkflow_runへ分離する。
- merge後のcleanup・CI・Production・常設Preview確認・Issue更新をmain pushから起動する。
- provider資格情報をmain限定のGitHub Environmentへ移し、通常のPR実行から分離する。
- イベント・PR・SHA・実行元の再照合、正式receipt、関連テストと運用文書を更新する。
- Node.js 20非推奨のartifact ActionsをNode.js 24対応の公式完全SHAへ更新する。
- ubuntu-latestは利用者の指定どおり維持する。
- PRのmerge、Productionの手動操作、無関係な資源の変更は含めない。
- secret値をGit・チャット・ログ・artifactへ保存しない。

## 受入条件

- AC-01: pull_request_targetなしで同repo codex/* PRの作成・更新・再openから正式Previewを作成／更新できる。
- AC-02: PR受付でprovider資格情報を使わず、管理処理はmainのWorkflowとコードだけを実行する。
- AC-03: APIで受付run・repository・Workflow・PR・現在head SHA・状態を再照合し、古い通知や不明・不一致を安全に扱う。
- AC-04: mergeせずcloseしたPRも、資源の所有権を照合してcleanupし正式receiptを残す。
- AC-05: main pushに対応するmerged PRをAPI照合し、cleanupと4条件の確認・Issue履歴・完了判定を維持する。
- AC-06: main限定Environmentへ資格情報を分離し、dispatchによる正式QA・staging・retentionを維持する。移行設定の確認結果と未完了の作業を明示する。
- AC-07: artifact ActionsをNode.js 24対応版へ完全SHA固定で更新し、ubuntu-latestを維持する。
- AC-08: 関連fixture・別Agentレビュー・最終SHAのローカル検証・CI・正式Preview QAを完了する。新しい自動イベント経路の実機確認は初回merge後へ引き継ぐ。

## 主な実装方針

PR受付Workflowはcheckout・artifactの受渡し・provider資格情報を使用しない。
main側ではGitHubが記録したWorkflow runの識別情報とPRをAPIで再取得し、対象が一意で現在状態と一致することを確認する。
受け取ったPRコードやPR由来artifactを権限付き管理処理として実行しない。
pushではbefore/afterとcommit集合を照合し、そのpushでmergeされたPRを特定する。
PR head SHA、merge SHA、管理コードのcontrolShaを区別して正式receiptへ結び付ける。
複数PRを含むpush、古いrun、reopen、非merge close、失敗・再実行を安全に扱う。

GitHub Environmentはcake-automationとし、main branchだけを許可する。
資格情報の旧Repository Secretsが残っている間は、分離完了として扱わない。
Environment設定・Secrets管理に現在の連携権限が足りない場合も、コード・検証・PRを可能なところまで完了し、所有者向けの具体的な移行手順を提示する。
既存のReady gateや正式QAの証拠を省略する経路は追加しない。

## 工程と作業単位

Initialization・Ideation・Inceptionは、このチャットの調査・方針提示・承認とIssue #156へ対応する。
Constructionでは共有イベント照合、Preview管理、post-merge処理、資格情報分離と文書を並行して実装する。
通常の開発・レビュー・検証を行い、案件記録をfreezeした最終SHAで検証する。
OperationはPRのCI・Preview・正式QAと、利用者によるmerge後のActions確認へ引き継ぐ。
アプリの業務機能・DB schemaを変えないため、業務要件の再設計・データ移行は行わない。

## 検証計画

- イベント偽装・fork・別Workflow・古いSHA・不完全API・複数候補・再実行・複数mergeのfixture。
- Previewの自動deploy／非merge close cleanup／push cleanup／既存dispatch正式QAの契約検証。
- merge後の履歴・手動確認・失敗・旧結果の扱いを含むpost-mergeテスト。
- lint・型・文書・全自動テスト・build・CloudブラウザQAを最終SHAで実行。
- push/PR CI、専用Preview/status、PC/mobile×A/Bの正式ブラウザ検証。
- 実際の新workflow_runとpush経路は、Workflow定義がmainへ入る初回merge後にrun・receipt・provider不在・Issue更新まで確認する。

## 承認の根拠

利用者が、pull_request受付→main workflow_run管理、main pushでのmerge後確認、main限定Environment、イベント・receipt照合更新の説明に対し、
「ではその方針ですすめてください。`ubuntu-latest`  はそのままでいいです。」と承認した。
記録日時はIntentコマンドの実行日時であり、発言日時として推測しない。

# Cake の開発ルール

## 設計書と運用手順

- 基本設計: [docs/design.html](docs/design.html)
- 詳細設計: [docs/detail-design.html](docs/detail-design.html)
- セットアップ・コマンド・デプロイ手順: [README.md](README.md)
- 機能・UI・API・DBを変更する際は、関連する設計箇所を確認する。
- 設計書と実装に食い違いがあれば、関連する実装・テストを調べ、意図が不明な点はユーザーに確認する。
- 仕様や運用手順を変更した場合は、関連する設計書とREADMEも更新する。詳細な仕様は設計書で管理する。

## 作業の進め方

- 説明と作業結果の報告は日本語で行う。
- 既存の未コミット変更を保持する。
- 設計を合意したら、`npm run task:start -- <タスク名>`で最新の`origin/main`から`codex/<タスク名>`と専用worktreeを作成し、そのworktreeで開発する。
- 元の作業フォルダの未コミット変更、`.env.local`、`.vercel`、`node_modules`を新しいworktreeへコピーしない。ローカル検証には対象タスクのテストDBを設定する。
- DB変更は適用済みマイグレーションを書き換えず、`db/migrations/`に番号付きファイルを追加する。
- 本番DBは新しいアプリの公開前に更新されるため、マイグレーションは公開中の旧版との互換性を保つ。列・テーブルの削除や名前変更は段階的に行う。
- 接続文字列・認証情報をGit、検証報告、PR本文や作業ログへ保存・表示しない。

## 検証

- コード変更後は`npm run lint`、`npm test`、`npm run build`を実行する。
- 業務ロジックや認可を変更した場合は、変更した挙動を確認する回帰テストを追加・更新する。
- UI変更はPCとスマートフォンの表示・操作を確認する。
- 実行できなかった検証は、その理由とともに報告する。

## Preview検証とPR

- ソースコードの修正とローカル検証が完了したらcommitし、`npm run task:pr -- --draft --title '<PRタイトル>' --verification-file <報告ファイル>`で先にmain向けdraft PRを作る。通常のdraft入口は`CAKE_QA_GIT_GATE_CONFIRMED=true`に加え、同一repositoryのmainと対象HEADの完全SHAにある`vercel.json`の`git.deploymentEnabled`を照合し、必要な場合だけpushする。設定は`{"**": false, "main": true}`とし、main以外をtrueにする規則は禁止する。確認不能なら通常CLIのpushを停止する。QA poolの承認済み有効化後に`npm run deploy:preview`を実行し、同PR・同lease・現在HEADのREADY台帳記録を待つ。
- 設計書・README・作業ルールなど、文書のみの変更でソースコードを修正していない場合はPreviewへのデプロイは不要。文書のみのPRは理由を記載して作成する。
- 接続先や環境設定はREADMEの「Previewへデプロイ」に従う。
- Previewは本番と別のNeonプロジェクトから作るタスク専用DBを使う。`CAKE_TEST_DATABASE_URL`がない場合は停止し、本番用の`DATABASE_URL`を代用しない。
- デプロイの成功を確認し、Deployment固有のPreview URLで変更箇所の画面・APIを検証する。共有の固定URLは使わない。
- 検証結果をMarkdownファイルへ記載し、`npm run task:pr -- --title '<PRタイトル>' --verification-file <報告ファイル>`で同じPRの検証済み本文を更新する。Preview未実施は`--draft`で理由を明示する。検証後に変更した場合は、再コミット・再デプロイ・再検証する。draftからの公開はユーザーが判断する。
- CodexはPRのマージや自動マージの設定を行わない。ユーザーがPRと必須CIの成功を確認し、手動でマージする。
- 完了報告には変更内容と検証結果を含め、Previewへデプロイした場合はアクセス可能なPreview URL、PRを作成した場合はPR URLも含める。
- デプロイや動作確認に失敗した場合は、原因を調べて対応し、解消できない場合は失敗内容と理由を報告する。
- Productionへの手動デプロイは、ユーザーから明示的に依頼された場合に行う。Git連携によるProduction公開は、ユーザーがPRを`main`へマージした後、ビルドと本番DB更新が成功してから行う。

## QA貸出枠の段階適用

- `qa1` / `qa2` / `qa3` は貸出枠と候補aliasのみ。固定QA枝、台帳枝、DB保持parkingは作らない。各PRのfeature枝にNative DBを対応させ、新PRは承認済みQA初期fixtureの親から作る設計とする。lease marker未登録時だけ現行11migrationのschema・台帳、管理者A/一般Bの固定二人、固定共有家計・所属、空の業務7表を厳密照合する。空DBの初期化も維持し、同PR更新はidentityを照合して編集データ・名前・権限・停止状態を保持する。受入後はレビュー済みの後続migrationも適用できる。fixture混入や既知001〜011のsource/schemaと検証基準のずれはfail closedで停止し、検証定義や親の変更はレビュー・明示承認を要する。既存schemaやデータの自動消去・自動修復はしない。
- 予約・配置・返却は [docs/qa-pool.md](docs/qa-pool.md) に従う。既存Environment `Preview` のtask `cake-qa-lease`、payload protocol `cake-qa/v1` snapshotを正本とし、短い単一Actions writerが`queue: max`で書込みとalias mutationを直列化する。deployment statusのauto_inactiveやworkflow完了で解放しない。
- `held` / `deleting` は使用中。GET専用 `plan-release` は安全なIDだけの計画を返し、生成・削除・状態遷移をしない。表示計画はコピー可能な承認JSONではなく、削除にはprojectId/pr/slot/leaseId/headSha/deploymentIds/alias/database/expiresAtが完全一致するprivateな `CAKE_QA_DELETE_APPROVALS` を使う。全記録IDは消失後も保持し、probeのaliasは未記録ならnull、記録があればその候補名を保持する。closeは対象PRだけをcleanupし、他枠のclaim/global reconcile/生成へ広げない。pending aliasが未確認ならcleanupを止め、assigned aliasのGETがnullなら他の消失確認を続ける。全Vercel資源とNative branch/endpoint消失後だけfreeにする。
- claimとintentを先に保存し、REST Git sourceでNative DBをアプリbuild前に生成する。初回host不明のdeploymentはDBクライアント作成前guardで停止し、Neon APIでproject/feature枝/parent/branch作成時刻/一意の書込みendpointを確認してから同feature枝・同leaseのphaseがapplicationの次deploymentを作る。本番host比較には読取確認済みの非秘密`CAKE_QA_PRODUCTION_DATABASE_HOST`を使い、子DBの初回受入条件は実DBguardで確認する。metadataの親ID一致だけでfixture一致やNative親選択の実証完了と扱わない。
- 承認済みQA初期fixtureのNative親branch IDを `CAKE_QA_PARENT_BRANCH_ID` で確認する。Native親選択は設定名だけで保証しない。通常運用にはGit設定・pool/確認flag・PR番号→完全SHAの `CAKE_QA_APPROVED_HEADS` が必要。同PRの新headも承認する。APPROVED_HEADSのunset・空文字・空白だけは `{}` とし、不正な非空JSON、正の安全な整数でないPR key、完全SHAでない値は拒否する。
- `preflight`はGET以外を拒否するtransportで実行し、pool/確認flagの有効化を要求しない。不足する既存認証・scope・設定・未実証条件を報告し、台帳・deployment・alias・環境変数・DBを変更しない。読取成功と操作承認を混同しない。
- Native未実証の初回検証は確認flagを先にtrueへ変えず、mainと対象PRの完全SHAにあるmain-only Git設定を確認し、`CAKE_QA_PROBE_APPROVALS`の期限付きJSON配列（projectId/pr/sha/slot/expiresAtの5項目だけ）に一致する対象だけ手動`probe`で実施する。pool/Gitゲート確認/Native確認flagはfalseまたは未設定のまま、信頼済みmainの同じ単一queueを使う。snapshotの`purpose: probe`を通常運用と区別し、自動生成継続・候補alias自動更新・通常運用への自動切替はしない。追加pushも承認を更新し、同lease・同DBを保持する。
- Hobby運用はmainと稼働対象枝へ `git.deploymentEnabled: {"**": false, "main": true}` を入れ、今後の枝は更新済みmainから作る。古い枝・設定変更・直接REST/CLI・外部callerまで強制停止する保証はなく、Ignored Build StepはDB生成前ゲートにしない。有料policyや未検証API fieldを代替にせず、Vercel Proや新しい課金を条件にしない。既存Neon plan・無料枠や無課金は別条件として確認する。
- 既存PR #37のheadとqa1のlease・deployment・DBを保持する。既存READY probeの手動 `alias-only` は `CAKE_QA_ALIAS_APPROVALS` のprojectId/pr/headSha/slot/leaseId/deploymentId/database/alias/expiresAtの9項目だけの期限内承認を使う。purpose: probeと対象を保持し、追加claim・全OPEN PR列挙・global reconcile・deployment/DB作成を行わない。aliasAssignment {alias,deploymentId,sha,state:pending|assigned}を保存し、exact GET一致でassignedにする。再実行時のpending+GET nullは盲目的に再POSTせず保持する。main導入後の実alias割当とcleanupは別承認を必要とし、今回実行しない。mainへのmergeはユーザーだけが行い、自動Production deploymentと既存本番build・DB処理を起動し得るため今回mergeしない。
- poolはfalseまたは未設定で保持する。Git確認flagは全稼働枝の監査と実際のGit自動生成停止、Native確認flagはREST Nativeの実証後だけtrueにできる。REST Native、alias割当、queue、cleanupの実検証と明示承認が完了するまで通常運用を有効化しない。認証scope・生成承認・削除対象承認・cleanup実証結果は分ける。新Secret・権限・ネットワーク・Productionのremote設定変更は今回未許可。接続文字列・資格情報は出力せず、Actionsの非秘密host情報の扱いはQA運用の実装確認範囲に従う。
- Actionsの本番host・削除承認JSON・alias承認JSONは既存repository Variableをcallerのjobs.secretsから一時的なworkflow_call secretsへ渡す。remote Secretへの登録・移動をしない。callerにないPreview Environmentの同名Variable overrideを同じ実効値と推定しない。診断・CLI/console・報告はDB host、接続文字列、資格情報を出さず、安全なIDと判定だけを示す。完全DB hostはprivateな承認・内部照合で使い、表示計画はそのまま承認JSONにコピーできない。実Actionsのmask検証や過去ログ消去は完了扱いにしない。
- `deploy:preview`は有効化・ゲート・先行PR確認後にfeature枝をpushし、台帳を読むだけとする。CLIから直接Vercel/Neonを生成・削除しない。lease、完全SHA、生成Preview/DBの範囲と確認結果を記録し、接続文字列や資格情報は出力しない。
- cancel APIと実行中Function/transactionの監視・終了確認は現writerに未実装。deployment/Native資源消失を実処理の即停止保証として報告しない。PGlite実SQL検証は実環境の接続情報を使わないローカルWASM一時メモリDBで、検証データは永続化しない。承認済みNeon DBでのmigration/seed実測とは区別する。

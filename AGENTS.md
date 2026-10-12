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
- `held` / `deleting` は使用中。返却前の`plan-release`はGET専用でmanifestを返すだけとし、生成・削除・状態遷移をしない。JSON項目projectId/pr/slot/leaseId/headSha/deploymentIds/alias/databaseを完全一致させ、承認時だけ期限expiresAtを添えた`CAKE_QA_DELETE_APPROVALS`を使う。全記録IDは昇順配列、通常aliasは候補hostname、probeはnullとし、消失後も対象集合を縮めない。包括booleanで削除を許可しない。releaseはintent/orphanと全記録IDを検証して承認対象だけ削除し、Native branchと全endpointの消失確認後だけfreeにする。失敗は保持し、次leaseによる旧branch/endpointの再利用を拒否する。
- claimとintentを先に保存し、REST Git sourceでNative DBをアプリbuild前に生成する。初回host不明のdeploymentはDBクライアント作成前guardで停止し、Neon APIでproject/feature枝/parent/branch作成時刻/一意の書込みendpointを確認してから同feature枝・同leaseのphaseがapplicationの次deploymentを作る。本番host比較には読取確認済みの非秘密`CAKE_QA_PRODUCTION_DATABASE_HOST`を使い、子DBの初回受入条件は実DBguardで確認する。metadataの親ID一致だけでfixture一致やNative親選択の実証完了と扱わない。
- 承認済みQA初期fixtureのNative親branch IDを`CAKE_QA_PARENT_BRANCH_ID`で確認する。Nativeがこの親を選ぶことは未実証であり、設定名だけで保証しない。通常運用はmainと対象PRの完全SHAにあるmain-only Git設定、pool/Gitゲート確認/Native確認flag、`CAKE_QA_APPROVED_HEADS`のPR番号→完全SHA承認を必要とする。貸出取得前とREST POST直前にも設定を再照合する。同PR更新時も新headのレビュー・承認が必要。
- `preflight`はGET以外を拒否するtransportで実行し、pool/確認flagの有効化を要求しない。不足する既存認証・scope・設定・未実証条件を報告し、台帳・deployment・alias・環境変数・DBを変更しない。読取成功と操作承認を混同しない。
- Native未実証の初回検証は確認flagを先にtrueへ変えず、mainと対象PRの完全SHAにあるmain-only Git設定を確認し、`CAKE_QA_PROBE_APPROVALS`の期限付きJSON配列（projectId/pr/sha/slot/expiresAtの5項目だけ）に一致する対象だけ手動`probe`で実施する。pool/Gitゲート確認/Native確認flagはfalseまたは未設定のまま、信頼済みmainの同じ単一queueを使う。snapshotの`purpose: probe`を通常運用と区別し、自動生成継続・候補alias自動更新・通常運用への自動切替はしない。追加pushも承認を更新し、同lease・同DBを保持する。
- Hobby運用はmainと稼働対象枝へ [Git設定](https://vercel.com/docs/project-configuration/git-configuration) の`{"**": false, "main": true}`を入れ、今後の枝は更新済みmainから作る。全remote 14枝の読取監査ではPR #34の枝だけが適合し、main（`37a55b8`）・PR #33・他の枝は未導入で、古いPreview枝もremoteに残る。PR #33への将来の設定だけの変更にも別途承認が必要で、今回は変更しない。古い枝、設定変更、直接REST/CLI、first-party callerはこの運用を迂回し得るため、project全体の強制停止は保証しない。Ignored Build StepはDB生成前ゲートにしない。有料Deployment Policiesや未検証API fieldを代替として要求しない。Vercel Proへの変更・課金は不要だが、Native Neonの既存plan・無料枠は別条件で確認し、無課金を保証しない。
- 初回移行ではQAを無効・承認なし・空台帳のままPR #34をユーザーが手動mergeしてwriterとGit設定をmainへ導入する。mainの設定不足は生成・probe・通常CLIを止めるが、この無効状態での導入mergeを禁止しない。mainのProductionを維持するためmergeは自動Production deploymentを開始し、ユーザーの承認が必要。今回のPR #34へのcommit/push/本文更新はそのリスクを含め明示承認済みの限定作業であり、flagや抜道引数を追加して通常ゲートを通過したとは扱わない。merge後のPR #34はCLOSEDとなるため、生成実証には別の設定済みOPEN PRと個別承認が必要で、今回は作成しない。
- poolはfalseまたは未設定で保持する。Git確認flagは全稼働枝の監査と実際のGit自動生成停止、Native確認flagはREST Nativeの実証後だけtrueにできる。REST Native、alias割当、queue、cleanupの実検証と明示承認が完了するまで通常運用を有効化しない。認証scope・生成承認・削除対象承認・cleanup実証結果は分ける。新Secret・権限・ネットワーク・Productionのremote設定変更は今回未許可。接続文字列・資格情報は出力せず、Actionsの非秘密host情報の扱いはQA運用の実装確認範囲に従う。
- Actionsのhostは既存repository Variableをcallerの`jobs.secrets`から一時的な`workflow_call` secretへ渡すコード上のmask対象とする。remote Secretへの登録・移動はしない。Preview Environmentの同名Variable overrideはこのcallerから引き継げないため、以前と同じ実効値と推定しない。新workflowのmain導入前のログや既存ログはrawの非秘密hostを含み得る。過去ログを消した、実Actionsでmaskを検証済み、hostがログへ一切出ないとは報告しない。QA読取検査のJSON/CLIはdeployment URL・接続文字列・資格情報を省略するが、台帳と削除manifestの非秘密DB hostは識別情報として含まれ得る。Actions step envのmaskと区別し、raw値を報告へ転記しない。
- `deploy:preview`は有効化・ゲート・先行PR確認後にfeature枝をpushし、台帳を読むだけとする。CLIから直接Vercel/Neonを生成・削除しない。lease、完全SHA、生成Preview/DBの範囲と確認結果を記録し、接続文字列や資格情報は出力しない。
- cancel APIと実行中Function/transactionの監視・終了確認は現writerに未実装。deployment/Native資源消失を実処理の即停止保証として報告しない。PGlite実SQL検証は実環境の接続情報を使わないローカルWASM一時メモリDBで、検証データは永続化しない。承認済みNeon DBでのmigration/seed実測とは区別する。

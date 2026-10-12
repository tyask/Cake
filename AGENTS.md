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

- ソースコードの修正とローカル検証が完了したらcommitし、`npm run task:pr -- --draft --title '<PRタイトル>' --verification-file <報告ファイル>`で先にmain向けdraft PRを作る。draft入口は`CAKE_QA_GIT_GATE_CONFIRMED=true`とHEAD内のmain-only自動生成停止設定を照合し、必要な場合だけpushする。生成前ゲートを確認できなければpushも停止する。QA poolの承認済み有効化後に`npm run deploy:preview`を実行し、同PR・同lease・現在HEADのREADY台帳記録を待つ。
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

- `qa1` / `qa2` / `qa3` は貸出枠と候補aliasのみ。固定QA枝、台帳枝、DB保持parkingは作らない。各PRのfeature枝にNative DBを対応させ、同PR更新でデータを保持し、新PRは新しい空DBとmigration・固定サンプルを確認する。混入時はfail closedで停止し、既存schemaやデータを自動消去しない。
- 予約・配置・返却は [docs/qa-pool.md](docs/qa-pool.md) に従う。既存Environment `Preview` のtask `cake-qa-lease`、payload protocol `cake-qa/v1` snapshotを正本とし、短い単一Actions writerが`queue: max`で書込みとalias mutationを直列化する。deployment statusのauto_inactiveやworkflow完了で解放しない。
- `held` / `deleting` は使用中。releaseはintent/orphan照合後に記録済み全deployment IDを検証・削除し、Native branchと全endpointの消失確認後だけfreeにする。失敗は保持し、次leaseによる旧branch/endpointの再利用を拒否する。
- 初回host不明のdeploymentはDB接続前guardで停止し、Neon APIでproject/feature枝/parent/endpointを確認してから同feature枝の次deploymentを作る。本番host比較には読取確認済みの非秘密`CAKE_QA_PRODUCTION_DATABASE_HOST`を使い、Native親の空証明は実DBguardで確認する。
- 空のNative親branch IDを`CAKE_QA_PARENT_BRANCH_ID`で確認し、`CAKE_QA_APPROVED_HEADS`のPR番号→完全SHA承認に一致するheadだけ配置する。同PR更新時も新headのレビュー・承認が必要。
- poolはfalseまたは未設定で保持する。全既存PRをdeployment/Neon生成前に止めるremoteゲート、REST Native、alias割当、queue、cleanupの実検証と明示承認が完了するまで有効化しない。今回、新Secret・権限・ネットワーク・Productionのremote変更は許可されていない。`NEON_API_KEY`不足や未検証項目を明示してdraftでレビューし、適用とmainへのmergeはユーザーが行う。
- `deploy:preview`は有効化・ゲート・先行PR確認後にfeature枝をpushし、台帳を読むだけとする。CLIから直接Vercel/Neonを生成・削除しない。lease、完全SHA、生成Preview/DBの範囲と確認結果を記録し、接続文字列や資格情報は出力しない。

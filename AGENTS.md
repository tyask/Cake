# Cake の開発ルール

## 開始と実行環境

開発・PR操作・QAの前に[開発・QA運用手順](docs/development-workflow.md)を読む。ローカルとActionsのNode版は [.node-version](.node-version) を正本とし、`npm run check:node` で一致を確認する。WSL2ではLinux版Node.js・npm・Git・gh・Playwright Chromiumを使う。[WSL手順](docs/wsl-development.md)で実行環境と認証を確認する。Codex Cloudは[Cloud手順](docs/cloud-development.md)でsetup・オンメモリDB付きCake・ブラウザQAを行う。Windowsネイティブでも開発でき、PowerShellでは `npm.cmd` / `npx.cmd` を使う。

最新 `origin/main` から `npm run task:start -- <task-name>` で `codex/<task-name>` と専用worktreeを作る。既存の未コミット変更を保持し、worktreeごとに `node_modules`・`.next`・`.cake`・環境ファイルを分離する。WindowsとWSLで作業ディレクトリや資格情報を共有・コピーしない。npm/Playwrightのキャッシュは同じ実行環境内で共有できる。

Cloudの `setup:cloud` は依存・公式Chromiumの準備、`dev:cloud` はNode + PGliteによる外部DB不要のCake起動、`qa:cloud` はPC/mobile × 非管理者A/Bと取引CRUDのローカル検証に使う。同じCloud環境の並列タスクはworktreeとポートを分ける。外部DB・Google・Vercelの秘密値や他環境の資格情報を持ち込まない。Cloudの結果は `.cake/cloud/` に保存し、正式Preview証拠とReady条件は既存のものを維持する。

機能・UI・API・DBを変更する際は[基本設計](docs/design.html)と[詳細設計](docs/detail-design.html)を確認し、仕様・運用の変更を関連文書へ反映する。文書には現在の仕様・手順だけを残す。個別PRの経緯、日時付き受入記録、廃止済み方式の説明はPR本文・検証結果に記録する。

## 設計・実装の原則

新規機能・既存機能の変更では[設計・実装原則](docs/design-principles.md)を読み、変更に関係する観点を設計・自己レビュー・別Agentレビューで確認する。小さな変更へ一律に層・抽象化・キャッシュを追加せず、責務と副作用の境界を明確にする。

- 操作から入力・分岐・API・業務処理・DB・画面反映までのデータの流れと、入力中/確定データの所有者を決める。複数経路・非同期分岐は詳細設計に図示する。
- 有限値・入力schema・上限・純粋な業務計算は共通定義を使い、手入力・CSV・APIで同じ規則を適用する。サーバーでも検証・認可し、日時などの精度は通信で保持して表示境界で整える。
- 保存済み値との正規化後の比較、保存待ち更新、失敗時の入力保持、遅延応答の採用条件を設計する。共通UIの標準機能は共通部品に持たせ、各呼出元の指定漏れで選択肢を欠落させない。
- 反復処理の共通準備はデータ更新単位で一度行い、用途に必要なデータだけ取得する。SQL内部を含む件数依存の処理と通信回数を確認し、順序・優先順位・丸めを維持する。
- 複数対象の更新は最新権限・全対象・計算前提を確認し、必要なロックと同じTransactionで全体を確定する。適用済migrationは変更せず追加し、公開中の版との互換性を保つ。

## 言語と検証結果

PRのタイトル・本文・コメント・レビューコメント・検証報告は日本語で書く。コマンド、識別子、protocol名、エラーコード、引用するログは原文を保持できる。

PR本文の「変更内容」は、対象機能と解決する問題、変更前後の挙動、そのために行った主な修正と理由が対応するように書く。タイトルの繰り返しやファイル一覧だけにしない。リファクタリングでは処理方法の変化と維持する仕様を説明し、関連する互換性・影響範囲も記載する。変更規模に応じて具体例や小見出しを使い、検証結果は別章に分ける。`task:pr`の作成・更新では説明を `.cake/changes.md` に用意し、`--changes-file`で渡す。詳細な書式は開発手順に従う。

実装と関連テストを同じbranchにcommitし、最終SHAでlint・型チェック・自動テスト・buildを実行する。前後で完全SHA一致とclean状態を確認する。文書だけの変更ではリンク・コマンド・現行実装との整合性を確認し、機能テストの再実施は必要性に応じて判断する。

実装・関連テスト・自己レビューを終えてcommitした後、最終検証の前に別Agentによるレビューを必須とする。文書のみの変更も対象とし、モデル・推論強度は利用者の指定がなければ未指定で起動する。実装時の会話履歴を引き継がない新しい文脈で、元の要求・設計・適用する開発ルール・対象worktree・比較元・完全SHAを渡す。レビュー担当はファイル変更やPR操作をせず、具体的な指摘と根拠を親Agentへ返す。親Agentが指摘を確認し、修正または不採用の理由を記録する。修正・QA・競合解消などでHEADが進んだら変更部分と影響範囲を再レビューし、現在HEADを対象とする完了記録を揃える。レビュー担当に別Agentの再起動を求める必要はない。

レビュー結果は親Agentが日本語で公開する。PR本文には現在HEADの完全SHA・完了状況・指摘件数と対応結果・未解決事項・詳細コメントへのリンクを載せ、PRごとに1件の詳細コメントへ指摘箇所・発生条件・影響・根拠・対応をまとめる。再レビュー時は同じコメントを更新し、過去SHAの結果と現在の状態を区別する。PR本文の要約は `.cake/report.md` に含め、`task:pr`による本文更新でも保持する。レビュー未実施・未完了や未解決の指摘がある場合はdraftを維持する。この記録はGitHubの正式なApproveや必須レビューの代わりにはしない。具体的な手順は開発手順に従う。

報告は成功・失敗・未実施を分け、実行環境・版・完全SHA・所要時間・件数・残った資源を記録する。DB不要の自動テスト、ローカルCake、実Previewの画面移動、業務データの追加・編集・削除を区別する。件数や過去の成功を今回の検証結果として流用しない。

## PRと自動Preview

同一repositoryの `codex/*` からmainへのPR作成・更新・再openは、draftを含めて専用Preview・Neon Native DBの作成/更新とmigration/seedを自動起動する。PR未作成のpushだけではPreviewを作らない。Vercel Git連携の `**: false` / `main: true` は維持し、管理処理は信頼済みmainのActionsだけで実行する。

PR作成・更新前に、対象と自動資源操作の影響が依頼の承認範囲に含まれることを確認する。承認済みの操作は再確認せず進める。文書変更でも同じ自動化が起動する。main mergeはProduction deploy、PR merge/closeは専用Deployment・DBのcleanupを起動するため、対象と削除影響が承認されていない操作は行わない。

通常CI・Preview/DB管理・cleanupはActionsを使い、結果は標準noticeの正式receiptから受け取る。対象PR・完全SHA・Deployment・固有URL・DB branch/endpoint・generationを検証前後に照合する。欠落・重複・不一致・応答不明では停止し、盲目的な再deployや削除をしない。削除完了はcleanup成功だけで判断せず、対象IDの直接GETによる不在確認とprovider一覧の再照合で確認する。Neon資格情報がWSLにない場合は、資格情報をコピーせずActions内の直接照合と後続statusの正式receiptを使う。

## ブラウザと資格情報

WSLでは[WSL手順](docs/wsl-development.md)、Cloudでは[Cloud手順](docs/cloud-development.md)、Windowsでは[Windows QA資格情報・実行手順](docs/windows-qa-credentials.md)を使う。CloudのPR/Actions操作はCloudに連携されたGitHub権限を使う。既存本人認証を使い、未認証・失効時のログインは本人に依頼する。provider token・OIDC・Cookieをチャット・ログ・コマンド引数・Git・環境ファイル・検証artifactへ出さない。Vercel資格情報はQA処理のメモリ内で扱い、Git/gh子プロセスには渡さない。

OIDCは同一project/team・development・有効期限を確認し、redirectを含めて対象originだけへ付ける。TLS検証と保護設定を維持し、CA・proxy・権限・global PATH/Git設定は変更しない。WSLからWindowsの `qa:windows` やtoken受渡しexeを使わない。

通常の正式ブラウザ検証はPC/mobile × A/Bログインと画面移動・session/app GET・runtime proofを確認する。認証後のホーム/ `GET /api/app` はworkspaceが0件なら個人workspace・OWNER membershipをINSERTし得るため、GETだけを根拠にDB無変更と扱わない。明細追加などの業務更新は別途依頼された範囲で、識別できるテストデータだけを対象にし、削除と残存件数まで確認する。

Codexは現在HEADのCI、変更内容に必要な検証、差分の自己レビューと別Agentレビューを完了し、未解決の不具合・指摘・競合・検証不足がなくマージ可能と判断したら、追加確認を待たずPRをReadyにする。利用者がdraft維持を指定した場合は従う。Ready直前にHEADとレビュー記録・検証証拠を再照合し、完了後はこのチャットでPRリンク・判断理由・レビューと検証の結果・未実施項目・残る資源を日本語で通知し、PR本文も更新する。条件未達ならdraftを維持し、阻害要因を報告する。マージ・closeは依頼された範囲で別に判断する。

アプリ変更は現在HEADに対応する正式ブラウザ証拠を必要とする。Actions検証は `qa:verify:ci`、別checkoutからのReady管理は `task:pr --remote-proof ... --target-worktree ...` を使う。AGENTS.md・README.md・docs配下だけの文書変更は、差分・リンク・コマンド・現行実装との整合性をレビューし、現在HEADのCIと自動Preview/statusを確認したうえで、ブラウザ再検証を省略する理由を記録して `gh pr ready` を使える。CLIのブラウザ証拠チェックを省略するオプションは追加しない。詳細は開発手順を参照する。

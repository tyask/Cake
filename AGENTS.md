# Cake の開発ルール

## 開発依頼の完了条件

このrepositoryの機能追加・不具合修正・UI調整・文書更新などの通常の変更依頼は、次の工程を完了するまでを含む。

1. 既存仕様・実装を調べ、目的・範囲・受入条件・実装方針・検証方法を含む開発計画をチャットに提示し、提示後にその計画への利用者の承認を得る。
2. 承認された案件のIssueを作成・更新し、専用branch/worktreeでIntentに計画と承認を記録する。
3. 実装・関連テスト・自己レビューを終え、案件記録を凍結してcommitする。
4. 別Agentレビューと指摘への対応・必要な再レビューを終える。
5. 最終SHAで所定のローカル検証を行う。
6. 対象branchをpushし、PRを作成・更新する。
7. 現在HEADのCI・自動Previewと変更に必要な検証を確認する。
8. 条件を満たしたらPRをReadyにし、PRリンクと結果を報告する。

Readyは開発・PR検証の完了であり、Issueの完了とは区別する。
利用者がmergeした後、Actionsがmain CI・Production・常設Preview・専用資源cleanupを確認する。
案件を完了するPRで全確認が成功し、同じIssueの先行分割PRを含む手動確認・失敗・未確認・未マージPRが残らない場合にIssueをcloseする。
結果はIssueの固定コメントにPRごとの履歴として保持し、先行PRの未解決事項を後続PRの成功で消さない。
失敗・未完了はopenを維持する。

利用者による「PRを作成して」「Readyにして」という追加依頼を待たず、ローカル実装・commit・pushだけで完了と報告しない。

次の操作も既定の依頼範囲に含む。以下の資格情報・データ更新・資源照合の規則を守って進める。

- 当該PRの検証結果・レビューコメントの掲載。
- 承認された案件のIssue作成・更新と、対応するIntentの記録。
- 既存Actionsによる当該PR専用Preview・DBの作成/更新・migration/seed。

次の操作は既定範囲に含めず、対象と影響を含む利用者の依頼に従う。

- PRのmerge・close。
- Production操作。
- 無関係な資源の操作。

利用者が次のように指定した場合は、その制限を優先する。

- 調査のみ、または提案のみ。
- ローカル変更まで、またはPR不要。
- draft維持。

変更を求めていない質問や相談だけを根拠に、Issue作成・変更・PR作成を開始しない。

認証・権限・環境・検証失敗などの阻害要因がある場合は、実施可能な作業を進めたうえで未完了として報告し、次を明示する。

- PRの有無。作成済みならURLとdraft/Ready。
- 未完了の工程。
- 具体的な理由と必要な対応。

「PR作成を明示されていない」ことだけを停止理由にしない。

## AI-DLCと案件記録

[AI-DLC開発フロー](docs/aidlc-workflow.md)に従う。
CakeはAI-DLC Workflows v2の標準的な記録構成に合わせた運用層を使う。
公式エンジンとの接続・公式の承認gateの実行を完了したものとして扱わない。

- 基本は1 Issue・1 Intentとし、Issue・Intent・PRを相互に関連付ける。
- Issueは依頼・範囲・受入条件・進捗の要約、Intentは詳細要件・設計・計画・工程状態・判断履歴の正本とする。
- 受入条件は`AC-01`等の識別子を付け、PRの検証結果と対応付ける。
- 変更規模に応じて工程を選び、採用・省略理由を計画へ記録する。短縮時も既存のレビュー・CI・Preview・Ready条件を維持する。
- 開発計画は利用者が確認できる形でチャットに提示する。
  承認前は読み取り専用の調査と計画提示までとし、Issueの作成・更新、branch/worktree・Intentの作成、実装・PR作成へ進まない。
- 承認は、チャットに提示済みの具体的な開発計画を対象とする、提示後の利用者の発言で確認する。
  承認対象と提示順序から判断し、特定の定型句は求めない。
  一般的な方針への同意・作業依頼・着手指示を、未提示の計画の承認として扱わない。
- 計画のhash、承認者、実際の承認文、記録日時をIntentへ保存する。Agentが承認文を作ったり、日時を推測したりしない。
- Intentの承認対象本文は、チャットに提示し承認された開発計画と一致させる。
  計画提示前の発言を、後から作成・追加した計画の承認へ流用しない。
- チャットに提示・承認済みの同じ計画を再開する場合は、その計画の提示と承認発言の組を参照し、同じ範囲の承認を求め直さない。
- 目的・範囲・受入条件・重要な実装方針が変わる場合は計画を更新し、改めて承認を得る。変更後の計画へ過去の承認を流用しない。
- `aidlc/spaces/default/intents/`の案件記録と、同spaceの共通ルール・知識はGit管理する。`.cake/`はGit管理対象外の一時保存先とする。
- 再開時はIntent・対象branch・Issue・PR・現在HEADを照合し、記録と実際の状態を揃える。
- 共有する学びはmemoryへ記録し、現在の規約・設計・手順にも反映する。矛盾した規則を複数の保存先へ残さない。

最終レビュー・検証へ進む前にIntentをfreezeしてcommitし、追跡ファイルを更新しない。
以後のレビュー・検証・Ready・merge後の結果はPR・Issue・Actionsへ記録する。
修正が必要ならIntentをreopenし、記録も含めてcommitした新しいHEADで再レビューと必要な検証を行う。
未commitの記録変更や、過去SHAの証拠を残したままReadyにしない。

## 開始と実行環境

開発・PR操作・QAの前に[開発・QA運用手順](docs/development-workflow.md)を読む。
工程別の具体コマンド・実行場所・成功条件は[開発コマンド集](docs/development-commands.md)を参照する。
ローカルとActionsのNode版は [.node-version](.node-version) を正本とし、`npm run check:node` で一致を確認する。

WSL2ではLinux版Node.js・npm・Git・gh・Playwright Chromiumを使う。
[WSL手順](docs/wsl-development.md)で実行環境と認証を確認する。

Codex Cloudは[Cloud手順](docs/cloud-development.md)でsetup・オンメモリDB付きCake・ブラウザQAを行う。
Windowsネイティブでも開発でき、PowerShellでは `npm.cmd` / `npx.cmd` を使う。

最新 `origin/main` から `npm run task:start -- <task-name>` で `codex/<task-name>` と専用worktreeを作る。
既存の未コミット変更を保持し、worktreeごとに `node_modules`・`.next`・`.cake`・環境ファイルを分離する。
WindowsとWSLで作業ディレクトリや資格情報を共有・コピーしない。
npm/Playwrightのキャッシュは同じ実行環境内で共有できる。

Cloudでは目的に応じて次のコマンドを使う。

- `setup:cloud`：依存・公式Chromiumの準備。
- `dev:cloud`：Node + PGliteによる外部DB不要のCake起動。
- `qa:cloud`：PC/mobile × 非管理者A/Bと取引CRUDのローカル検証。

同じCloud環境の並列タスクはworktreeとポートを分ける。
外部DB・Google・Vercelの秘密値や他環境の資格情報を持ち込まない。
Cloudの結果は `.cake/cloud/` に保存し、正式Preview証拠とReady条件は既存のものを維持する。

機能・UI・API・DBを変更する際は[基本設計](docs/design.html)と[詳細設計](docs/detail-design.html)を確認し、
仕様・運用の変更を関連文書へ反映する。
設計書・開発手順には現在の仕様・手順を残す。
案件の経緯・判断・承認はIntentへ、最終SHAのレビュー・検証結果はPR・Actionsへ記録する。
Issueにはそれぞれの要約とリンクを残す。

## 設計・実装の原則

新規機能・既存機能の変更では[設計・実装原則](docs/design-principles.md)を読み、
変更に関係する観点を設計・自己レビュー・別Agentレビューで確認する。
小さな変更へ一律に層・抽象化・キャッシュを追加せず、責務と副作用の境界を明確にする。

- 操作から入力・分岐・API・業務処理・DB・画面反映までのデータの流れと、入力中/確定データの所有者を決める。複数経路・非同期分岐は詳細設計に図示する。
- 有限値・入力schema・上限・純粋な業務計算は共通定義を使い、手入力・CSV・APIで同じ規則を適用する。サーバーでも検証・認可し、日時などの精度は通信で保持して表示境界で整える。
- 保存済み値との正規化後の比較、保存待ち更新、失敗時の入力保持、遅延応答の採用条件を設計する。共通UIの標準機能は共通部品に持たせ、各呼出元の指定漏れで選択肢を欠落させない。
- 反復処理の共通準備はデータ更新単位で一度行い、用途に必要なデータだけ取得する。SQL内部を含む件数依存の処理と通信回数を確認し、順序・優先順位・丸めを維持する。
- 複数対象の更新は最新権限・全対象・計算前提を確認し、必要なロックと同じTransactionで全体を確定する。適用済migrationは変更せず追加し、公開中の版との互換性を保つ。

## 言語と検証結果

Issue・PRのタイトル・本文・コメント・レビューコメント・案件記録・検証報告は日本語で書く。
コマンド、識別子、protocol名、エラーコード、引用するログは原文を保持できる。

タスク・手順・確認項目の列挙は、文中に長く連結せずリスト形式で書く。

- 並列の項目は、1項目ずつ箇条書きにする。
- 実行順序がある手順は、番号付きリストにする。
- 進捗報告は「完了・実行中・未着手・阻害あり」を明記する。
- 残作業は、完了した内容と分けて列挙する。

チャット・PR・文書の文章は、長い一文や段落に詰め込まず、読みやすい長さに区切る。

- 長い文は、意味のまとまりに沿って短い文へ分ける。
- 話題・条件・操作が変わる位置で段落を区切る。
- Markdownの長い行は、文末や意味の切れ目で改行する。リストの継続行は字下げする。
- リンク・識別子・コマンド・コードは、途中で改行して壊さない。

PR本文の「変更内容」は、次の内容が対応するように書く。

- 対象機能と解決する問題。
- 変更前後の挙動。
- その挙動を実現する主な修正と理由。

タイトルの繰り返しやファイル一覧だけにしない。
リファクタリングでは処理方法の変化と維持する仕様を説明し、関連する互換性・影響範囲も記載する。
変更規模に応じて具体例や小見出しを使い、検証結果は別章に分ける。
`task:pr`の作成・更新では説明を `.cake/changes.md` に用意し、`--changes-file`で渡す。
対応するIntentを指定し、関連Issue・Intentへのリンクと受入条件ごとの検証結果を含める。
Issueを閉じる`Closes`・`Fixes`・`Resolves`等のキーワードをPR本文・commit messageへ書かず、merge後の確認へ引き継ぐ。
GitHubのDevelopment欄でもmerge時にIssueを閉じる関連付けを作らず、通常の参照リンクを使う。
詳細な書式は開発手順に従う。

実装と関連テストを同じbranchにcommitし、最終SHAでlint・型チェック・自動テスト・buildを実行する。
前後で完全SHA一致とclean状態を確認する。
文書だけの変更ではリンク・コマンド・現行実装との整合性を確認し、機能テストの再実施は必要性に応じて判断する。

別Agentレビューは、文書のみの変更も対象とし、次の順で行う。

1. 実装・関連テスト・自己レビューを終えてcommitする。
2. 最終検証の前に別Agentを起動する。モデル・推論強度は利用者の指定がなければ未指定とする。
3. 実装時の会話履歴を引き継がない新しい文脈で、元の要求・設計・適用する開発ルール・対象worktree・比較元・完全SHAを渡す。
4. レビュー担当はファイル変更やPR操作をせず、具体的な指摘と根拠を親Agentへ返す。
5. 親Agentが指摘を確認し、修正または不採用の理由を記録する。
6. 修正・QA・競合解消などでHEADが進んだら、変更部分と影響範囲を再レビューし、現在HEADを対象とする完了記録を揃える。レビュー担当に別Agentの再起動を求める必要はない。

レビュー結果は親Agentが日本語で公開する。PR本文には次を載せる。

- 現在HEADの完全SHA。
- 完了状況。
- 指摘件数と対応結果。
- 未解決事項。
- 詳細コメントへのリンク。

PRごとに1件の詳細コメントへ次をまとめる。

- 指摘箇所と発生条件。
- 影響と根拠。
- 対応。

再レビュー時は同じコメントを更新し、過去SHAの結果と現在の状態を区別する。
PR本文の要約は `.cake/report.md` に含め、`task:pr`による本文更新でも保持する。
レビュー未実施・未完了や未解決の指摘がある場合はdraftを維持する。
この記録はGitHubの正式なApproveや必須レビューの代わりにはしない。
具体的な手順は開発手順に従う。

報告は成功・失敗・未実施を分け、次を記録する。

- 実行環境と版。
- 完全SHA。
- 所要時間と件数。
- 残った資源。

次の検証結果は区別して報告し、件数や過去の成功を今回の検証結果として流用しない。

- DB不要の自動テスト。
- ローカルCake。
- 実Previewの画面移動。
- 業務データの追加・編集・削除。

## PRと自動Preview

同一repositoryの `codex/*` からmainへのPR作成・更新・再openは、
draftを含めて専用Preview・Neon Native DBの作成/更新とmigration/seedを自動起動する。
PR未作成のpushだけではPreviewを作らない。
Vercel Git連携の `**: false` / `main: true` は維持し、管理処理は信頼済みmainのActionsだけで実行する。

PRイベントは資格情報・checkout・artifactを持たない`pr-events.yml`が`pull_request`で受け付ける。
`preview.yml`は`workflow_run`から通知元run・Workflow・repository・対象PR・現在HEADをGitHub APIで再照合し、
mainのコードでPreview管理と未マージclose後のcleanupを行う。
merge後のcleanupと案件確認はmainへの`push`から対象merged PRを照合して実行する。
`pull_request_target`へ戻したり、PR由来のコード・artifactを管理資格情報付きで実行したりしない。

provider資格情報はmainだけを許可したEnvironment `cake-automation`へ置き、旧Repository Secretsには残さない。
手動QA・常設Preview・Deployment保持も同じEnvironmentを使う。
設定と切替時の確認は[Actionsのイベントと資格情報](docs/actions-event-migration.md)に従う。

PR作成・更新前に、上記の既定の依頼範囲と利用者の明示した制限に照らして対象と自動資源操作の影響を確認し、
範囲内の操作は追加確認せず進める。
文書変更でも同じ自動化が起動する。

main mergeはProduction deploy、PR merge/closeは専用Deployment・DBのcleanupを起動するため、
対象と削除影響が承認されていない操作は行わない。

通常CI・Preview/DB管理・cleanupはActionsを使い、結果は標準noticeの正式receiptから受け取る。
対象PR・完全SHA・Deployment・固有URL・DB branch/endpoint・generationを検証前後に照合する。
欠落・重複・不一致・応答不明では停止し、盲目的な再deployや削除をしない。

削除完了はcleanup成功だけで判断せず、対象IDの直接GETによる不在確認とprovider一覧の再照合で確認する。
Neon資格情報がWSLにない場合は、資格情報をコピーせずActions内の直接照合と後続statusの正式receiptを使う。

## ブラウザと資格情報

WSLでは[WSL手順](docs/wsl-development.md)、Cloudでは[Cloud手順](docs/cloud-development.md)、
Windowsでは[Windows QA資格情報・実行手順](docs/windows-qa-credentials.md)を使う。
CloudのPR/Actions操作はCloudに連携されたGitHub権限を使う。
既存本人認証を使い、未認証・失効時のログインは本人に依頼する。
provider token・OIDC・Cookieをチャット・ログ・コマンド引数・Git・環境ファイル・検証artifactへ出さない。
Vercel資格情報はQA処理のメモリ内で扱い、Git/gh子プロセスには渡さない。

OIDCは同一project/team・development・有効期限を確認し、redirectを含めて対象originだけへ付ける。
TLS検証と保護設定を維持し、CA・proxy・権限・global PATH/Git設定は変更しない。
WSLからWindowsの `qa:windows` やtoken受渡しexeを使わない。

通常の正式ブラウザ検証はPC/mobile × A/Bログインと画面移動・session/app GET・runtime proofを確認する。
認証後のホーム/ `GET /api/app` はworkspaceが0件なら個人workspace・OWNER membershipをINSERTし得るため、
GETだけを根拠にDB無変更と扱わない。
明細追加などの業務更新は別途依頼された範囲で、識別できるテストデータだけを対象にし、削除と残存件数まで確認する。

Codexは次の条件を満たし、マージ可能と判断したら、追加確認を待たずPRをReadyにする。

- 現在HEADのCIと、変更内容に必要な検証を完了している。
- 差分の自己レビューと別Agentレビューを完了している。
- 未解決の不具合・指摘・競合・検証不足がない。

利用者がdraft維持を指定した場合は従う。Readyへの変更と結果報告は次の順で行う。

1. Ready直前にHEADとレビュー記録・検証証拠を再照合する。
2. PR本文を更新し、PRをReadyにする。
3. このチャットで結果を日本語で通知する。

通知には次を含める。

- PRリンクと判断理由。
- レビューと検証の結果。
- 未実施項目と残る資源。

条件未達ならdraftを維持し、PRリンク・未完了の工程・阻害要因と必要な対応を報告する。マージ・closeは依頼された範囲で別に判断する。

アプリ変更は現在HEADに対応する正式ブラウザ証拠を必要とする。
Actions検証は `qa:verify:ci`、
別checkoutからのReady管理は `task:pr --remote-proof ... --target-worktree ...` を使う。
AGENTS.md・README.md・docs配下の文書、またはIntentの計画・状態・監査記録だけの変更は、
差分・リンク・コマンド・現行実装との整合性をレビューし、
現在HEADのCIと自動Preview/statusを確認したうえで、
ブラウザ再検証を省略する理由を記録して `gh pr ready` を使える。
実行設定・アプリ・script・workflow・依存の変更はこの例外へ含めない。
CLIのブラウザ証拠チェックを省略するオプションは追加しない。
詳細は開発手順を参照する。

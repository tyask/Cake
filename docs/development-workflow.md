# 開発・QA運用手順

CakeはPRごとのVercel Preview固有URLと専用Neon Native DBで検証する。
WSL2/Linux、Codex CloudまたはWindowsネイティブで開発し、
通常CI・Preview/DB管理・close時cleanupはmainのActionsで実行する。PRと検証報告は日本語で書く。

着手前に[AI-DLC開発フロー](aidlc-workflow.md)に従って調査・計画・利用者の承認を揃える。
承認後にIssueを作成・更新し、専用worktreeのIntentへ計画と実際の承認文を記録する。
具体的な計画が既に承認されていれば、その発言を参照して同じ承認を求め直さない。
目的・範囲・受入条件・重要な実装方針が変わる場合は、計画を更新して再承認を得る。
相談・調査だけを根拠にIssueやPRを作らない。

## 1. 環境と作業ディレクトリ

[.node-version](../.node-version) のNode.js・npm・Git・既存本人認証済みgh・公式Playwright Chromiumを使う。
ローカルと全Actionsがこの完全版を共用する。`npm run check:node` は依存導入前でも版を確認でき、`task:start` と高速確認の冒頭でも実行する。
ローカルの実行版を検証報告へ記録する。Vercelは `engines.node` の24系を選び、minor/patchを自動更新するため、
ローカル/Actionsの完全版確認をbuild時には適用しない。

GitHub CLIは`gh api --paginate --slurp`に対応する版を使う。
機能の事前確認とCI照合の実行例は、[対象PRとCIの確認](development-commands.md#対象prとciの確認)に従う。

- WSL2はLinux版ツールを使う。[WSL開発・ブラウザ検証](wsl-development.md)で環境・認証・実行方法を確認する。
- Codex Cloudは[Cloud開発・ブラウザ検証](cloud-development.md)の`setup:cloud`で依存・公式Chromiumを準備し、
  `dev:cloud` / `qa:cloud`で外部DBなしのCake起動・画面操作を確認する。GitHubはCloudに連携された権限を使う。
- WindowsはPowerShellで `npm.cmd` / `npx.cmd` を使い、
  [Windows QA手順](windows-qa-credentials.md)で保存済み資格情報を扱う。
- タスクごと、OSごとに独立したclone/worktreeを使う。既存変更を保持し、依存・build成果物・ `.cake` ・環境ファイルを分離する。資格情報を別環境からコピーしない。
- PATH補完は当該プロセスに限定する。globalのGit/PATH・CA・proxy・セキュリティ設定は変更しない。追跡テキストのLFは `.gitattributes` に従う。

元のCake checkoutで次を実行し、表示された作業先へ移動する。初回cloneで依存がなければ先に `npm ci` を行う。
Windowsでは `npm` を `npm.cmd` に読み替える。

```bash
npm run task:start -- feature-name
```

このコマンドは最新 `origin/main` から `codex/feature-name` と専用worktreeを作り、その中で `npm ci` を実行する。
作業先を変える場合は `CAKE_WORKTREE_ROOT` をそのプロセスだけに指定する。
対象worktreeで`task:intent`を使い、Issue・branch・承認済み計画を関連付ける。
作成・計画更新・承認・進捗・凍結・再開のコマンドは[案件記録の操作](development-commands.md#案件記録の操作)を参照する。

同じCloud環境内の並列タスクもworktree・ポートを分ける。
Cloud用CakeはNode + PGliteのオンメモリDBに全migration・非管理者A/B・共有workspace・架空サンプルを設定し、停止時にDBを破棄する。
Google/Vercelや外部DBの秘密値は不要で、他環境からコピーしない。CloudブラウザQAの結果は`.cake/cloud/`に保存し、正式Preview証拠とは区別する。

実装前に[設計・実装原則](design-principles.md)を読み、次の観点を確認する。

- 変更する操作のデータ経路。
- 共有する規則。
- 保存と取得の順序。
- 処理量。
- 更新の整合性。

関係する判断と分岐は基本/詳細設計へ反映し、同じ観点を自己レビュー・別Agentレビューでも確認する。

新しいライブラリは実行場所に応じて `lib/client/`・`lib/server/`・`lib/shared/` へ配置する。
スクリプトは `scripts/` の用途別ディレクトリ、テストは `tests/` の対象領域別ディレクトリへ追加する。
配置表、依存方向、既存サービスとDB storeの境界は[詳細設計の実装構成](detail-design.html#architecture)を参照する。
npmコマンドとworkflowからの正式な運用経路、receipt・資格情報・資源照合の契約は維持する。

## 2. ローカル検証と日本語のdraft PR

開発は次の順に進める。

1. 承認済み計画と受入条件に沿って実装・関連テスト・自己レビュー。
2. 案件記録を更新・freezeし、実装とともにcommit。
3. 別Agentレビュー。
4. 指摘への対応・必要な再レビュー。
5. 最終SHAでのローカル検証。
6. draft PR。
7. 現在HEADのCI・自動Preview・変更に必要な検証。
8. Ready。

文書のみの変更にも別Agentレビューを適用する。
freeze後は追跡ファイルを更新せず、最終SHAのレビュー・検証結果をPR・Issue・Actionsへ記録する。
修正時はIntentをreopenし、更新した記録を含めてfreeze・commitし直す。
新しいHEADに対して再レビュー・必要な検証を行い、過去SHAの成功を使い回さない。

各工程の実行場所・入力値の取得方法・成功条件は、[開発コマンド集](development-commands.md)にまとめる。

| 工程 | 具体的な操作 |
| --- | --- |
| 計画承認とIssue・Intentの対応 | [案件記録の操作](development-commands.md#案件記録の操作) |
| 比較元・完全SHA・clean状態の記録 | [レビュー対象の記録](development-commands.md#レビュー対象の記録) |
| PR・remote SHA・現在HEADの両CI照合 | [対象PRとCIの確認](development-commands.md#対象prとciの確認) |
| 信頼済みmainの別worktree準備 | [control checkoutの準備](development-commands.md#control-checkoutの準備) |
| レビューコメントのID保存・同一コメントの再更新 | [レビューコメントの作成と更新](development-commands.md#レビューコメントの作成と更新) |
| 文書のみのPR本文更新とReady | [文書のみのReady](development-commands.md#文書のみのready) |
| Ready後の追加修正と再検証 | [Ready後の追加修正](development-commands.md#ready後の追加修正) |
| merge後の確認とIssue完了 | [merge後の確認](development-commands.md#merge後の確認) |
| 変更ごとに決める検証・業務操作・マージ判断 | [固定コマンドにしない判断](development-commands.md#固定コマンドにしない判断) |

通常の変更依頼は、[AGENTS.mdの開発依頼の完了条件](../AGENTS.md#開発依頼の完了条件)に従い、
当該PRの作成・更新と専用Preview/DBの自動処理を含めて進める。利用者に「PR作成まで」と付け加えてもらう必要はない。
利用者が明示した範囲の制限を優先し、ローカル検証の成功やcommitだけで開発全体を完了扱いにしない。

利用者が範囲を限定していない通常の変更依頼では、最終報告の前に、現在HEADのPRがReadyであり、次を報告できることを確認する。

- PRリンク。
- レビューと検証結果。
- 未実施項目。
- 残る資源。

阻害時は次を記載する。

- PR未作成ならその事実、作成済みならURLとdraft/Ready。
- 未完了の工程。
- 具体的な理由と必要な対応。

Ready条件や利用者の制限を省略して進めない。

### 日常の高速確認と文書参照チェック

依存導入後、編集中は次を使う。`check:fast` はNode版・lint・型・依存境界・文書参照を順番に確認し、失敗した段階で停止する。Chromiumや実DBを使わない。
CIもこの確認を先に行い、その後に全自動テストとbuildを実行する。
通常CI・Previewの検証専用ジョブ・常設PreviewはPlaywright公式Dockerイメージ内で実行する。
通常CIでは全自動テスト・build・CloudブラウザQAを同じコンテナで実行する。
ブラウザーとOS依存ライブラリーは導入済みのものを使い、`PLAYWRIGHT_BROWSERS_PATH`は`/ms-playwright`を指定する。
コンテナはUID/GID 1001で実行し、GitHub-hosted runnerとcheckout先の所有UIDを揃える。
イメージのPlaywright版を`package-lock.json`と揃え、tagとdigestを一緒に更新する。
Nodeはイメージ同梱版に依存せず、`actions/setup-node`で`.node-version`へ揃える。
Previewのdeploy・status・cleanupはホスト上の`preview`ジョブ、verifyはコンテナ内の`preview-verify`ジョブで実行する。
PR単位のworkflow concurrencyを共用し、操作間の直列化を維持する。
正式noticeは実行したジョブ内の資格情報を持たない別stepで発行する。
受信側は操作に対応するジョブと非実行側のskippedを照合し、旧mainの単一`preview`ジョブの証拠も受理する。

```bash
npm run check:fast
npm run test:architecture
npm run test:shared
npm run test:client
npm run test:server
npm run test:tooling
```

領域別コマンドは対応する `tests/` 配下を再帰検出し、全体実行と同じプロセス分離・同時実行数2を維持する。
変更箇所の確認に使い、最終SHAの `npm test` とbuildは省略しない。
`npm run typecheck` は単独の型チェック、`npm run check:docs` は単独の文書参照チェックである。

`check:docs` は `AGENTS.md`・`README.md`・`docs/` 内のMarkdown/HTMLを読み、
ローカルリンク・HTMLのhref/src・参照先の見出し/HTML anchor・コード中の明示的なリポジトリpathを確認する。
不正な参照は文書名と行番号を表示し、終了コード1を返す。外部URLへの通信、記載されたコマンドの実行、一般的な文章の意味解析は行わない。
コード内の生成物・OSの絶対path・glob・説明用プレースホルダは参照検査から除き、アプリ内の絶対URLは文書リンクとして巡回しない。
詳細な認識規則は `scripts/tooling/check-docs.ts` と対応fixtureを正本とし、新しい書式を使う場合は必要な検出回帰とともに更新する。

### 別Agentレビュー

1. 親Agentは実装・関連テスト・自己レビューを終えてcommitし、cleanなworktree・完全HEAD SHAと比較元のSHAを記録する。
   通常の比較元は `origin/main` とのmerge-baseとし、差分全体を確認できるようにする。
2. 実装時の会話履歴を引き継がない別Agentを起動する。
   元の要求、Issue・Intentと受入条件、適用する `AGENTS.md` と開発手順、関連設計、対象worktree、比較元・対象の完全SHA、検証済み・未実施の範囲を渡す。
   利用者の指定がなければモデル・推論強度は未指定とし、別モデルの利用を前提にしない。
3. レビュー担当は対象SHAと差分・関連コード・テストを読み、仕様との不一致、不具合、既存機能への影響、権限・データ境界、検証不足を確認する。
   文書変更ではリンク・コマンド・現行実装・関連文書との整合性を確認する。ファイル変更やPR操作は行わず、日本語で指摘箇所・発生条件・影響・根拠と、確認範囲・限界を返す。
   根拠のない懸念や表記の好みだけを指摘にしない。レビュー担当自身による別Agentレビューは不要とする。
4. 親Agentが指摘の根拠を確認して修正する。不採用の場合も理由を残す。
   HEADが進んだ場合は、前回のレビュー対象SHAを明示して追加差分と影響範囲を再レビューし、元の差分全体のレビューと合わせて現在HEADを対象とする完了記録を残す。
   QA中の修正や競合解消も同じ扱いとし、その後に必要な検証を最終SHAで揃える。
5. レビューを起動できない、結果が返らない、対象が不一致、指摘が未解決の場合は未完了として報告し、draftを維持する。
   別Agentの「問題なし」だけで検証完了とは扱わず、所定のCI・Preview・必要なブラウザ検証を行う。

### 最終SHAの検証

機能変更は関連テストと同じbranchへcommitし、別Agentレビューと指摘への対応を終えた最終commitで以下を実行する。
WSL用の前後SHA・clean確認を含む例は[WSL手順](wsl-development.md#基本検証)を参照する。

```bash
npm run check:node
npm run lint
npm run typecheck
npm run check:docs
npm test
npm run build
```

`npm test` は Node.js 24 の
`node --no-wasm-code-gc --import tsx --test --test-concurrency=2 "tests/**/*.test.ts"` で
対象領域別のテストと `tests/architecture/` の依存境界検査を再帰的に実行する。
globは引用してNodeへ渡し、下位ディレクトリのテストを取りこぼさない。ファイルごとのプロセス分離を保ち、同時実行を2つまでに制限する。
fixture・PGlite・スタブ・ローカルChromiumを使い、実DBへ接続しない。ローカルCake全体の起動や実Previewでの操作とは区別する。

PGliteを実行するNode 24には、Wasm import wrapperの解放と参照取得の競合によって
`jit_page_->allocations_.erase(addr) == 1`で異常終了する上流不具合がある
（[Node #66366](https://github.com/nodejs/node/issues/66366)、
[V8の修正](https://github.com/v8/v8/commit/9b8ca54d5a6b6c615eb7ad6d9e2bdca7f8cb1a81)）。
全体・領域別テストとCloudのローカルCake／ブラウザQAは、Nodeの直接引数
`--no-wasm-code-gc`でWasmコードのGCを無効にして競合経路を避ける。
JavaScriptのGC、SQLの検証、ファイルごとのプロセス分離と並列数2は維持する。
未使用のWasm機械語コードはプロセス終了時に解放されるため、テストプロセスの寿命内はコードのメモリ使用量が増える場合がある。
PGliteを起動する検証用の子プロセスにも同じ直接引数を渡す。
この引数は`NODE_OPTIONS`に指定できない。
本番・Previewのアプリ起動やbuildコマンドへは追加しない。
ランタイムの修正版へ更新する際は、上流修正の取り込みと反復検証を確認して回避策を外す。


文書のみの変更はリンク、コマンド、現行実装との整合性を確認する。アプリテストを省略した場合は理由を報告する。

Cloudでは上記に加えて`npm run qa:cloud`を実行する。
コマンド自身がCakeと新しいオンメモリDBを起動し、PC/mobile × 非管理者A/Bの画面移動と取引CRUDを確認して、終了時にサーバー・DBを破棄する。
必要なら`-- --port 3001`で空いたポートを指定する。管理者機能・Google認証・provider固有の挙動は対象外で、必要な正式Preview検証は後段で行う。
実行例と報告範囲は[Cloud手順](cloud-development.md#4-自動テストとcloudブラウザqa)を参照する。

PRのタイトル・本文・コメント・レビューコメント・検証報告は日本語にする。コマンド、識別子、エラーコード、引用するログは原文のままでよい。
PR本文は最終的な問題・変更内容・検証結果を記載し、作業途中の経緯や過去の受入記録を混ぜない。
詳しい要件・計画・承認・判断履歴はIntentへ残し、PRとIssueからリンクする。
Issue・Intent・PRのフォーマットと役割は[AI-DLC開発フロー](aidlc-workflow.md)を参照する。

「変更内容」には、次を機能ごとに関連付けて記載する。小さな変更は数段落でよく、複数機能にまたがる場合は小見出しや具体例を使う。

- 対象機能・利用場面と、解決する問題。
- 変更前と変更後の挙動。リファクタリングでは、処理方法の変化と維持する仕様。
- その挙動を実現する主な修正と理由。ファイル名・関数名は説明を補うために添える。
- 関連する影響範囲・互換性・制約。効果を数値で示す場合は測定条件を検証結果へ記載する。

タイトルの繰り返し、ファイル一覧、検証結果だけを変更説明の代わりにしない。
たとえば一括処理の改善なら「明細ごとの参加者集約と更新を、共通データの一回取得と集合更新へまとめる」と書き、対象の操作・変更理由・維持する適用結果も説明する。

Git外の `.cake/changes.md` に「変更内容」の本文をMarkdownで保存する（`## 変更内容`自体はCLIが付ける）。
`task:pr`は必須の`--changes-file`でその内容を読み、タイトル・Preview証拠・検証結果と分けてPR本文へ反映する。
対応する`--intent`を指定する。省略した場合は現在branchに対応するIntentを検索する。
新規PRには、計画hashと一致する承認・freeze・対象branchの一致が必要である。
Intentを使っていない既存PRの更新だけは`--legacy`を使え、新規PR作成には使えない。
PRには関連Issue・Intentのリンクと機械可読な関連情報を生成する。生成blockを手編集・転載しない。
draft作成時だけでなく更新・Ready時にも同じ指定が必要で、最終実装に合わせて説明を書き直す。
空・不存在・NULを含むファイル、通常ファイル以外、1MBを超えるファイルはPR操作前に拒否する。
手動でPRを作る場合も[PRテンプレート](../.github/pull_request_template.md)と同じ記載方針に従う。

変更説明・検証結果・remote proofのpathはCLIを実行するCWD基準で、絶対pathを推奨する。
`--target-worktree`で別の対象を管理するときも、説明と報告はcontrol側で用意する。

報告をGit外の `.cake/report.md` に保存し、次を記載する。

- 環境・ツール版・完全SHA。
- コマンド別の成否/所要時間。
- 件数。
- 実画面で確認した内容。
- 未実施項目。
- 受入条件ごとの検証結果と証拠へのリンク。

受入条件と証拠は、例えば次の形で対応付ける。
未検証の項目を成功として記載せず、非該当・未実施・失敗の理由を分ける。

| 受入条件 | 結果 | 検証・証拠 |
| --- | --- | --- |
| AC-01 | 成功 / 失敗 / 未実施 / 非該当 | 対象SHA・テスト・画面操作・runへのリンクと理由 |

Issueをmerge時に閉じる`Closes`・`Fixes`・`Resolves`等のキーワードは使用しない。
案件を完了するPRは`--completes-issue`、手動の運用確認が必要なPRは`--manual-post-merge`を指定する。
分割途中のPRでは完了を申告しない。
既存PR更新時にこれらを省略すると既存値を保つ。
解除には`--no-completes-issue`・`--no-manual-post-merge`を使う。

既定の依頼範囲と利用者の明示した制限に照らして対象を確認し、次を実行する。通常の変更依頼では、当該PRの専用Preview/DB操作について追加確認を求めない。

```bash
npm run task:pr -- --draft --intent <Intent ID> --title '変更内容を日本語で記載' --changes-file /absolute/path/changes.md --verification-file /absolute/path/report.md --completes-issue
```

CLIがpushしてdraft PRを作成/更新する。remoteとPRの完全SHAが検証commitに一致すること、
現在HEADのpush/PR CIの最新attemptが成功したことを確認する。固定の過去テスト件数を報告へ流用しない。
PR番号・完全SHAの取得、remoteとの一致、両イベントの最新attemptの照合は、
[対象PRとCIの確認](development-commands.md#対象prとciの確認)のコマンドで行う。

### レビュー結果の掲載

別Agentの回答は親Agentが受け取り、当該PRの作成・更新と同じ依頼範囲でGitHubへ掲載する。
起動・掲載・Ready条件の確認は親Agentが行う運用であり、`task:pr`自体は別Agentの起動・レビュー結果の投稿・完了判定を行わない。
別AgentからGitHubへの自動投稿や、GitHubの正式なApprove・必須レビューの代用とは扱わない。

- **PR本文：** `.cake/report.md` に「別Agentレビュー」の要約を含め、現在HEADの完全SHA、完了状況、指摘件数、修正・不採用・未解決の内訳、
  詳細コメントへのリンクを記載する。`task:pr`は本文を置き換えるため、更新・Ready時にも要約を含む報告を渡す。未実施・未完了や指摘0件も明記する。
- **詳細コメント：** PRごとに1件へまとめ、レビュー対象・比較元の完全SHA、確認範囲・限界、各指摘の箇所・発生条件・影響・根拠、親Agentの対応・不採用理由、
  再レビュー結果を記載する。指摘0件でも確認範囲と限界を残す。各指摘の対象SHAと現在の対応状態を区別する。
- **更新と通知：** 初回投稿のURLとコメントIDを `.cake` に保存し、再レビュー時はそのIDの同じコメントを更新する。
  更新前に対象PR・コメントの投稿者・内容を確認し、無関係なコメントは上書きしない。PR本文は最新の要約へ更新し、このチャットにも要点とPRリンクを通知する。

初回は `.cake/review.md` に詳細を書き、次のように投稿する。
投稿後に詳細コメントのURLを `.cake/report.md` へ追記し、同じHEADのdraft PRを `task:pr` で更新する。
PR作成直後の本文には「詳細コメント掲載待ち」と記載できるが、Ready前にはリンクを揃える。

初回投稿からID保存・同じコメントの再更新までの一連の操作は、
[レビューコメントの作成と更新](development-commands.md#レビューコメントの作成と更新)に従う。
次のコマンドで初回投稿する場合も、返されたURLとコメントIDを保存し、同じ手順で対象を確認してから再更新する。

```bash
gh pr comment <PR番号> --repo tyask/Cake --body-file /absolute/path/review.md
```

PR本文の要約は次の形式を使う。各値は今回の実際のレビュー結果で埋める。

```markdown
### 別Agentレビュー

- 対象SHA：<現在HEADの完全SHA>
- 状況：<完了／未完了／未実施>
- 指摘：<件数>件（修正<件数>／不採用<件数>／未解決<件数>）
- 再レビュー：<対象SHA・結果、または追加修正なし>
- 詳細：<詳細コメントのURL>
```

## 3. 自動PreviewとDB書込

同一repositoryの `codex/*` からmainへのPRのopened・synchronize・reopenedで自動deploy、closedでcleanupを行う。
draftも対象。PR未作成のpush、fork、別base/branch、PR本文の編集は自動deployの対象外。
 `vercel.json` の `**: false` / `main: true` はVercel Git連携からの直接feature deployを止め、
mainのActionsにDB準備を任せる設定である。

| 対象 | 自動で行う操作 |
| --- | --- |
| 初回Deployment | provisioningとapplicationの最大2回の作成要求。provisioningはNative準備を起動し、DB接続・migration・seed・アプリのFunctionを持たない静的な準備中ページを生成してREADYになる。専用DB照合後のapplicationがREADYになった時点で検証可能とする |
| 専用DB | PR branchに対応するNative child branchとread-write endpointを準備。親・所属・作成時刻・世代・endpointを照合する |
| 初期化 | 専用DBの所有権marker、番号順migration・適用履歴、QAユーザーA/B・共有workspace・membership、カテゴリ10件・明細8件のseed |
| 同PRの更新 | 同じDB/endpoint/generationを維持し、未適用migrationとbuildを実行。初回seed済みのデータ・ユーザー名・権限を上書きしない |
| PR merge/close | 紐づく全Deployment（準備用・旧版・失敗したものを含む）と専用DB/endpointを削除 |

準備用のREADYだけではPreview完成とせず、statusは現在HEADのapplicationだけを返す。
準備用の対象・branch/SHA・世代・本番host digestが不明なら静的生成も停止し、準備用でDB接続ガードを緩めない。
準備用へ注入された本番digestは、対象コードの設定にある `productionHostDigests` のいずれかと厳密に一致させる。
現用PG18・保持旧PG17の両DBを同じ禁止集合に含め、アプリ接続・provider・Deployment metadata・正式receiptで全件を拒否する。

静的成果物は既存Next.js builderが受け取るBuild Output API v3形式で `.next/output` に生成し、
通常アプリのbuild前に `.next/output` と `.vercel/output` を除去する。
準備用はルートのGET/HEADだけを表示し、API・ログイン・他のパスやPOSTは404となる。準備用の生成自体が失敗した場合はエラーとして止める。

DB setupは台帳初期化後に履歴を一度取得し、未適用ファイルだけを本文読込・適用する。全適用済みの通常再実行は本文0読込・2往復となる。
Preview初回の所有権確保前は全原文のhash/bootstrap照合を維持し、空DBまたは承認済みfixture以外を受け入れない。
同一世代では既存markerを照合して適用済み本文の読込を省く。

各migrationの実行DO内でもadvisory lockと履歴再確認を行い、失敗時はそのSQLと履歴を一緒にrollbackする。
過去に適用したSQLの変更検知や再適用のための仕組みではなく、既存migrationの原文は変更せず番号付きファイルを追加する。

Native連携で生成される実資源数は作成後に照合する。初回のDB所有権確立では、
PR（常設はrepository）の作成時刻と最古Deploymentの要求時刻からDB作成時刻の下限を検査する。
既存applicationのmetadataでDB branch・endpoint・host digestと単一世代を照合できる更新では、
PR／repository作成時刻の下限を維持し、後から残ったDeploymentの時刻を既存DBへ再適用しない。
初回provisioningがprovider一覧から消えても、同じDBを継続利用する。

別PR・本番endpointとの一致、DB消失、複数世代、未管理の同名branchでは停止する。
空DBまたは承認済みの完全一致fixtureだけを初期化し、既存markerを別PRへ付け替えない。
本番接続文字列をPreviewへ渡さず、Previewは `CAKE_TEST_DATABASE_URL` を使う。

QAのAはテスト管理者・共有OWNER、Bは一般・MEMBER。正規QA用ログインは登録済みユーザーをSELECTし、自動作成・権限修復しない。
ただし認証後のホームや `GET /api/app` は所属workspaceが0件なら個人workspaceとOWNER membershipをINSERTし得る。
ローカルテスト認証のユーザー登録、Googleログイン時のプロフィール更新もDB書込として区別する。

Previewの「テスト共有家計」には食費・暮らし・交通・趣味・収入とその子孫のカテゴリ10件、初期化時の日本時間の当月1〜8日の架空明細8件を設定する。
明細は `[サンプル]` で識別し、A/Bの支払い、共通費・個人費、3:2の割合、受け取り、未分類を含める。全件未清算で編集・削除できる。
親DBの承認済みfixtureは変更せず、専用DBのmigration後に登録する。

ユーザー初期化の `seeded_at` と独立した `samples_seeded_at` により、継承fixtureにも一度だけ登録し、
再buildで編集値を上書きしたり削除済みデータを復活させたりしない。

既存Previewにも未処理なら同じ条件を適用する。固定ユーザーの名前・権限・利用可否、共有workspaceの名前・所有者、二人の所属・割合が初期状態と一致し、
対象workspaceに明細・カテゴリ・ルール・招待・取込履歴・定期支払い・清算履歴がない場合だけ追加する。
入力済み・変更済みなら追加を省略したことを完了markerへ記録し、後から空になっても再追加しない。

判定・登録・marker更新は所有権guardとtable lock下の同一Transactionで行い、失敗時は全体を取り消す。
従来ローカルのseedには業務サンプルを追加しない。常設Previewにも同じ初期化条件を適用する。

自動deployはActionsのSummaryとnoticeで結果を確認する。手動deployが必要な場合だけ `npm run deploy:preview` を使う。
手動の作成・状態照合・削除はnpmコマンドから `scripts/preview/preview-command.ts` を経由してmainのActionsへ要求し、
PR作成・Ready管理には `npm run task:pr` を使う。

自動runはrun ID由来の安定したoperation UUIDで再実行を照合し、不明なPOSTを盲目的に再発行しない。PRのHEADがイベントから進んだ場合もprovider書込前に停止する。

### PR Preview build内の実DB並行検証

CSVカテゴリの実DB並行検証は、対象DBへのテストデータ作成・削除が承認されたPRで明示的に有効にする。
対象commitのメッセージに独立した行で `[cake-db-qa:csv-categories]` を含める。
前後の空白を除いた行全体が一致したときだけ有効で、文中の記載や未知のmarkerは無視する。たとえば次のようにcommitメッセージの先頭行へ追加する。

```bash
git commit -m '[cake-db-qa:csv-categories]' -m 'CSVカテゴリの実DB並行検証を有効にする'
```

`build:vercel` はVercelの `VERCEL_GIT_COMMIT_MESSAGE` をそのbuildの完全SHA・branchと照合された環境で読み、
PR用のPreview/test/applicationに限って次の順に実行する。

1. `db:setup`。
2. `db:seed:test`。
3. `qa:db:csv-categories`。
4. Next build。

検証は `node --import tsx scripts/qa/db/verify-csv-category-concurrency.ts` を子プロセスとして起動し、
失敗時はbuildと公開を止める。次のcommitにmarkerがなければ検証しない。
Production・準備用・常設Preview・Development・ローカルではmarkerによる実DB検証を実行しない。

検証にはNative連携が当該buildへ供給した専用接続だけを使う。
子プロセスには `CAKE_TEST_DATABASE_URL`、
PR・完全SHA・Deployment・DB branch/endpoint・generationと本番分離の照合情報、
Node実行・TLSに必要な明示allowlistだけを渡し、provider token・アプリ認証secret・共通 `DATABASE_URL` は渡さない。
WSLへの資格情報コピーや環境ファイルの生成は行わない。接続前と各独立sessionで既存のDB所有権を照合し、
二つの実DB sessionと監視sessionでロック待機・確定結果・全体rollbackを確認する。

buildログの `cake-csv-category-db-qa/v1` 結果で次を確認し、前後の正式statusとも照合する。

- 対象identity。
- 検証成否。
- ロック待機。
- 後片付け件数と既存データ保持。

長い集約結果はVercelの1イベント4KiB制限を避け、`cake-csv-category-db-qa-result-part/v1`のbase64分割行で出す。
同一runId・SHAの全partを番号順に揃え、総数・総byte数・SHA-256一致を確認してから元のJSONを復元し、欠落・重複・順序不正・不一致では受理しない。
業務DTO・接続文字列・生例外はログやartifactへ保存しない。通常のmigration・初回seedによる更新と、検証用fixtureの残存0件は区別して報告する。

この実DB検証は `npm test`、Actionsのprovider照合receipt、現在HEADの正式ブラウザ証拠とはそれぞれ別の検証である。

取引先正規化の実DB検証は、現在commitの独立行 `[cake-db-qa:merchant-normalization]` で要求する。
同じ隔離環境・所有権・TLS検査を使い、`qa:db:merchant-normalization` として上記のCSVカテゴリ競合回帰に続けて、全保存経路の共通正規化、
2000行のCSV、旧版互換、完全一致Indexの利用可能性を確認する。正規化fixtureは専用workspaceだけに作成して削除する。

019のバックフィル・DDLの全体rollback・ACCESS EXCLUSIVEによる更新待機は、同じ専用DB内の新規scratch schemaで実SQLを適用して検証する。
既存public schemaの適用済みmigrationを戻さず、scratchのschema・table・function・Indexの残存0件を確認する。

両markerがある場合も正規化を含むQAを一度だけ実行し、
同じ`cake-csv-category-db-qa/v1`結果の`normalization`・`normalizationMigration`に追加結果を記録する。
通常migration/seed後のpublic各表を前後照合し、scratch検証と実public migrationの適用時間・影響を区別する。

### mainの常設Preview

`.github/workflows/staging.yml`はmainへのpushとmain上の手動dispatchを受け、
同じ完全SHAを予約branch `cake-main-preview`へfast-forward同期する。
Vercel Git連携の `**: false` / `main: true` は維持し、mainのProductionは従来どおり自動更新する。
常設Previewのデプロイは信頼済みmainのActionsが行い、Hobbyで利用できる標準Previewを使う。

常設Previewは `https://cake-main-preview-fumin1.vercel.app` を固定URLとし、
Neon Nativeの `preview/cake-main-preview` を継続利用する。PR closeによるcleanupの対象にはしない。

`CAKE_PREVIEW_KIND=main`・予約ID `CAKE_PREVIEW_PR=0`・固定branch・完全SHA・DB世代・endpoint・本番host分離を検査する。
DB markerのpr=0は常設専用で、通常PRは正整数のみを受け付ける。A/BはPRと同じ固定identityで、初回seed後のデータと名前・権限は更新時に上書きしない。

デプロイ前にVercel認証保護を確認し、PC/mobile × A/Bの正式ブラウザ検証と前後status照合に成功してから固定aliasを更新する。
成功結果は `cake-staging/v1` の標準noticeにmain SHA・Deployment・DB branch/endpoint・generation・ブラウザ観測を記録する。

古いmain、DB消失、main履歴から分岐したmirror/管理外alias、応答不明では停止し、盲目的な再作成・削除をしない。再runは同じoperationを照合する。
通常のPR用receipt・Ready証拠とは区別する。

固定URLはVercel認証で保護し、保護設定を解除しない。URLを知るだけでは閲覧できず、Vercelのアクセス権または共有の許可が必要となる。新しい共有リンクは自動発行しない。
Production用カスタムドメインは常設Previewへ付け替えない。

### 本番・常設PreviewのDeployment保持

`.github/workflows/deployment-retention.yml`の`Cake Deployment Retention`は、
信頼済みmain上で毎朝06:00 JST（前日21:00 UTC）に古いDeploymentを整理する。
手動実行の`mode`は、読取のみの`plan`を既定とし、`apply`で削除する。
実行中のmainとworkflowの完全SHAを照合し、専用の`cake-deployment-retention` concurrencyで整理処理を直列化する。
常設Previewの待機runを取り消さないよう、そのconcurrency groupは共有しない。
`apply`開始前と各DELETE直前に、`staging.yml`の未完了runをGitHub APIで確認する。
requested/queued/pending/in_progress/waitingのrunを1件でも検出したら、整理側を停止する。
これは完全排他の保証ではなく、main SHA・alias等の直前再照合も継続する。
読取だけの`plan`にはこの実行中判定を適用しない。

| 対象 | 保持するDeployment |
| --- | --- |
| 常設Preview | 最新のREADY application 1件 |
| mainのProduction | 最新のREADY 1件 |

現用alias・project target・Cronの参照先と、実行中のDeploymentは常に保持する。
他PR・他branch・管理外のDeploymentは削除しないため、残存件数は各環境1件を超える場合がある。
DB・Neon branch/endpoint・Git branch・aliasは変更せず、常設DBの所有権を証明する現用applicationも残す。
削除した過去Deploymentへのrollbackはできなくなる。

全ページの一覧、project/team/repositoryの所属、main SHA、常設Previewのstatus・DB世代と認証保護を確認して削除候補を選ぶ。
`apply`では各DELETEの直前にも参照先と対象identityを再照合し、削除後は対象IDの直接GET不在と一覧の再取得で確認する。
欠落・重複・不一致・応答不明では停止し、DELETEを盲目的に再試行しない。
staging runの取得失敗や不正応答でも停止し、次回の日次処理または手動`plan`で再照合する。
結果は独立した`cake-deployment-retention/v1` notice 1件で、run情報・mode・成否と件数を返す。
候補・削除要求対象（不在確認前）・削除確認済みの全IDは公開auditログとActions Summaryへ記録する。
失敗時も、それまでに削除要求または不在確認を行ったIDを残す。
手動のplan/applyと結果確認は[開発コマンド集](development-commands.md#deployment保持の確認と整理)を使い、ローカルから削除を実行する入口は設けない。

## 4. Previewの特定と認証

対象worktreeで次を実行する。statusはmainのActionsをdispatchし、provider管理APIをGETだけで照合する。SQLやアプリ操作はしない。

```bash
npm run qa:status
```

次の照合項目を揃える。

- OPEN PR。
- branch。
- 完全SHA。
- READY application Deployment ID。
- 固有URL。
- DB branch/endpoint。
- generation。

branch aliasや過去のURLから対象を推測しない。 `.cake/preview.json` は照合結果であり、資源の正本はVercel/Neonにある。

| 認証 | 使用先 |
| --- | --- |
| OS側の既存gh本人認証、Cloudでは連携されたGitHub権限 | PR/CI/Actions/Checksの管理・読取。 `GH_TOKEN` / `GITHUB_TOKEN` が設定されていればそちらが優先される |
| Actionsの `VERCEL_TOKEN` ・ `NEON_API_KEY` | mainのprovider管理。値をローカルへ移さない |
| WSL側の本人Vercel認証、またはWindowsの保存済み資格情報 | 同一project/teamのdevelopment OIDC取得。QA処理のメモリ内だけで扱う |
| PreviewのテストユーザーA/B | アプリへのログイン。Vercel保護の認証とは別 |

Vercelはproject読取とOIDC取得で確認し、 `whoami` の結果だけでprojectへのアクセス可否を判断しない。
401/403は未認証・期限・scope・対象の問題を値なしで切り分ける。本人ログインが必要なら停止して依頼する。
秘密値・Cookie・接続文字列・生のprovider/browser例外をログやartifactへ出さない。

## 5. 実Previewのブラウザ検証

WSLでは[WSL手順](wsl-development.md#実previewの正式ブラウザ検証)、
Windowsでは[Windows QA手順](windows-qa-credentials.md)を使う。
Cloudでは[Cloud手順](cloud-development.md#5-pr自動preview本人確認)から既存の`qa:verify:ci`とremote proofを使える。
公式Playwright Chromiumを一時プロファイルで起動し、終了時にセッションを破棄する。
OIDCは同一project/team・development・有効期限を確認し、redirect各hopを含めて対象originだけへ付ける。
TLS/CA/権限の問題を保護や証明書検証の無効化で回避しない。

標準helperはPC/mobile × A/Bで次を検証する。

- ログイン。
- ホーム・取引明細・設定への16クリック。
- session/app GETとruntime proofの12観測。

通常はGET/HEAD/OPTIONSとテスト認証callback POSTだけを許可する。
前後のstatusで同じPR/SHA/Deployment/DB/generationを確認し、 `.cake/verification.json` と画面画像を保存する。
検証実装のSHAとruntime対象のSHAも区別する。既存Chromeでの目視確認だけを正式証跡と扱わない。

### 明細の追加・編集・削除

標準helperは業務更新POSTを遮断するため、明細操作は許可されたテスト用Playwright手順で別に行う。

1. 前後statusの対象を固定し、専用テストworkspaceと既存明細のID一覧を記録する。
2. 一意の識別名を付けたテスト明細を画面から追加し、API成功・明細ID・表示金額を確認する。
3. 一覧から金額を編集し、自動保存、再読込後の保持、別ユーザーからの参照を確認する。PCとmobileの操作を区別する。
4. このテストで作ったIDだけを画面から削除し、再読込後の不在と既存明細ID一覧の維持を確認する。途中失敗時は残存IDを報告し、無関係な明細を削除しない。
5. 許可するPOSTは対象workspace・テスト識別名・作成済みIDで限定する。取引以外の更新や、全件削除・DBへの直接SQLで代用しない。

データを書いて消しても、workspaceの更新日時などは変化し得る。テスト明細の除去を「DB完全無変更」とは報告しない。成功・失敗・残存データを日本語で報告する。

## 6. Ready・merge・closeと削除確認

Codexは次の条件をすべて確認し、マージ可能と判断したら、追加のReady依頼を待たずPRをReadyにする。利用者がdraft維持を指定している場合は従う。

1. 対象worktreeがcleanで、ローカル・remote・PRの完全HEAD SHAが一致し、現在HEADのpush/PR CIの最新attemptが成功している。
2. 変更に必要な検証と差分の自己レビュー・現在HEADを対象とする別Agentレビューが完了し、未解決の不具合・指摘・競合・必要な検証の不足がない。
   アプリ変更は同じHEADの正式ブラウザ証拠と変更箇所固有の検証を確認する。業務更新テストは承認済みの範囲で行う。
3. 自動Previewが成功し、現在HEADのPR・Deployment・固有URL・DB branch/endpoint・generationが正式statusと一致している。
4. PR本文に最終変更内容と、今回の成功・失敗・未実施、根拠・制約・残る資源、最新の別Agentレビュー要約と詳細コメントへのリンクを日本語で記載している。
   詳細コメントの対象SHA・指摘への対応・再レビュー結果と本文が一致している。

条件未達ならdraftを維持し、次を報告する。

- PRリンク。
- 未完了の工程。
- 具体的な阻害要因と必要な対応。

Ready直前にもPRのHEADとレビュー記録・検証証拠の一致を再確認し、更新後に過去SHAの成功を再利用しない。
Ready後に追加修正する場合は、先に`gh pr ready <PR番号> --repo tyask/Cake --undo`でdraftへ戻す。
その後のcommit・再レビュー・再検証・再Readyは、[Ready後の追加修正](development-commands.md#ready後の追加修正)に従う。

`qa:cloud`のローカル結果・画像は正式Previewのブラウザ証拠を代替しない。Cloudで開発した場合も上記のReady条件と既存の証拠gateを維持する。

**アプリ変更のReady操作：** ローカル証拠は対象worktreeの `task:pr` で再照合する。
Actionsで検証する場合は、最新mainとHEADが一致するcleanなcontrol checkoutから既存対象を指定する。これはWSL上のブラウザ検証とは別の実行環境である。
作成・更新と完全SHA照合は、[control checkoutの準備](development-commands.md#control-checkoutの準備)に従う。
PR番号・完全SHA・Deployment IDは、対象worktreeで取得した正式statusから指定する。

```bash
npm run qa:verify:ci -- --pr <PR番号> --sha <完全SHA> --deployment <Deployment ID>
npm run task:pr -- --intent <Intent ID> --title '変更内容を日本語で記載' --changes-file /absolute/path/changes.md --verification-file /absolute/path/report.md --remote-proof /absolute/path/proof.json --target-worktree /absolute/path/target --completes-issue
```

controlの `preview-verify.config.json` capabilityを照合し、成功証拠は `.cake/verify-<PR>.json` に保存する。
検証CLI自体はReadyにしないため、Codexが上記条件を確認して `task:pr` まで続けて行う。
controlから別の対象worktreeを管理するときは、対象に管理CLIがあるかどうかにかかわらず、
`task:pr --remote-proof ... --target-worktree /absolute/path/target` を使う。
target指定はremote proof必須・非draft専用で、対象コードを管理資格情報付きで実行しない。

**文書のみのReady操作：** mainとの差分がAGENTS.md・README.md・docs配下の文書、
またはIntentの計画・状態・監査記録だけで、
アプリ・script・workflow・依存・設定を変更しない場合に限る。
リンク・コマンド例・現行実装との整合性と差分全体をレビューし、上記のCI・自動Preview/statusを確認する。
PR本文の変更説明・Preview欄・検証結果を現在HEADの内容へ更新し、ブラウザ再検証を省略する理由を記載する。
本文更新と最終照合の具体コマンドは、[文書のみのReady](development-commands.md#文書のみのready)に従う。
条件が揃ったら次を実行する。
この場合もブラウザ証拠の成功を作ったり、アプリ変更の`task:pr`の証拠チェックを弱めたりしない。

```bash
gh pr ready <PR番号> --repo tyask/Cake
```

Ready完了後、このチャットで「Codexとしてマージ可能と判断し、Readyにした」と日本語で通知し、次を添える。

- PRリンク。
- 判断理由。
- 検証の要点。
- 未実施項目と残る資源。

ReadyはCodex側の検証完了を示すもので、GitHubの必須レビュー・branch保護や利用者によるマージ判断は維持する。
Issueの完了とは区別し、merge後の確認が揃うまでIssueをopenで維持する。

main mergeはProduction deployと本番buildのDB更新を起動し得る。PR merge/closeは専用DBと入力データの削除を起動する。
実行前に対象と影響を提示し、既に承認された範囲なら再承認を求めず進める。

closeして削除確認を依頼された場合は次を行う。

1. 現在PR/SHA、generation、紐づく全Deployment ID、専用DB branch/endpoint IDをclose前に記録する。
2. `gh pr close <PR番号> --repo tyask/Cake` を実行し、自動 `Preview cleanup PR ...` runの成功と対象を確認する。
   Git branchの削除やmain mergeは別操作である。
3. 記録した全Deployment IDへの直接GETが404であることを確認する。401/403/timeoutは削除確認にならない。
4. cleanupは削除前の所有権照合後に、専用DB branch/endpointの直接GETと一覧の不在を検査する。
   Neon資格情報がローカルにない場合はActions内の照合結果を使い、資格情報をコピーしない。
5. closed状態のsourceを指定した `requestReceipt('status', source, cwd)` で後続statusを取得し、
   provider一覧にDeployment/DBがないことを再確認する。通常の `npm run qa:status` はOPEN PR用なので、closed後には使わない。
   WSLでの実行例は[WSL手順](wsl-development.md#close後のstatus再照合)を参照する。

失敗した場合は削除済み・残存・未確認のIDを分けて報告する。
cleanupを再実行する必要があり、その対象削除が承認済みの場合だけ `npm run qa:release -- --pr <閉じたPR番号>` を使う。再作成で復旧しない。
確認は既存資源の削除であり、開始済みFunction/transactionの即時停止を保証しない。

現用本番はPG18・UTF8で、旧PG17 DBと復旧用branchは保持する。
将来のmajor version更新・復旧は、[本番DB運用手順](production-database-upgrade.md)で
対象・バックアップ・同期・接続切替・新しいProduction Deployment・本人確認を確認する。
PR専用DBや常設Previewを本番用途へ流用しない。

### merge後の案件完了

利用者がmergeしたPRは`post-merge.yml`が確認する。
信頼済みmain上でPRのHEAD SHAとmerge SHAを分けて照合し、次の完了を待つ。

- 対象mergeのmain CI。
- 対象mergeのProduction Deploymentと本番alias。
- 常設Previewの正式receipt。
- PR専用資源cleanupの正式receiptと削除後の不在。

確認結果はActions artifactと、関連Issueのbot所有の固定コメントへ記録する。
案件を完了するPRで全確認が成功し、手動確認もほかの関連OPEN PRも残らない場合にIssueをcloseする。
失敗・timeout・対象変更・手動確認待ちは、その理由とrunへのリンクを記録し、openを維持する。
既にcloseされたIssueを勝手にreopenしない。
手動再確認は[merge後の確認](development-commands.md#merge後の確認)のdispatchを使う。
確認のために本番へ再deployしたり、無関係な資源を操作したりしない。

## 7. 管理側の契約と停止条件

- `preview.config.json` はrepository、Vercel project/team、Neon project/親branch、
  現用PG18本番の `productionHostDigest` と本番用途の禁止集合 `productionHostDigests`、
  `receiptTransport: github-actions-notice/v1` を固定する。
  禁止集合は現用値を含む非空・重複なしの64桁hexとし、不正なら停止する。配列を省略した設定は現用値1件として扱う。保持旧PG17の値も集合へ残す。
  provider protocolは `cake-preview/v1` 、DB markerはversion 2。
  Previewの具体IDと本番host digestの正本は設定ファイル、本番資源の識別情報は[本番DB運用手順](production-database-upgrade.md)を参照する。
- `.github/workflows/preview.yml` は信頼済みmainだけをcheckoutし、PR単位のconcurrencyで直列化する。
  PRコードはVercel側で対象SHAをbuildする。手動dispatchの `controlSha` は実行時main SHAと一致させる。
- Actions結果は標準noticeから受け取り、run/初回attempt/job/check/suite/repository/appと、
  PR/HEAD/operation/control SHA/時刻を照合する。receiptは公開項目だけ、4,096 UTF-8 bytes以下。Checks書込やartifact取得は使わない。
- 欠落・重複・不正JSON・切詰め・秘密mask・対象変更・応答不明では停止する。単なるrun成功や過去receiptで現在の資源照合を省略しない。
  自動runの成否と、CLIで再取得する正式statusを区別する。
- 必要なSecretが不足していれば名前だけを報告する。資格情報の新規発行・移動、保護設定変更、盲目的なdeploy/cleanup再試行で修復しない。

# Cake の開発ルール

開発・PR作成・QA操作の前に、[開発・QA運用手順](docs/development-workflow.md)を読む。標準の開発環境はWindowsネイティブの専用clone/worktreeとし、PowerShellでは `npm.cmd` / `npx.cmd` を使う。既存gh認証を再利用し、必要なPATHの補完は当該プロセスだけに限定する。

Windowsの保存済みVercel資格情報と正式QAは[Windows QA資格情報・実行手順](docs/windows-qa-credentials.md)を読む。`npm.cmd run qa:windows -- status` → `preflight` → 対象PR・完全SHA・Deployment・DB・generationを明示した `verify` の順で確認する。保存先はGit外の `%LOCALAPPDATA%\CakeQa\vercel-token.dpapi.json`。既存ファイルを変更せず、DPAPI CurrentUserと本人だけのACLを検査してQA専用子プロセスに限定供給する。未保存・失効時は停止し、トークン作成・伏字入力・保存確認は本人が行う。値をチャット・ログ・環境ファイルへ出さない。実QAにはテスト認証と、初回workspace・OWNER membership作成を含むDB書込範囲の承認が必要。

QAはCake単体で運用する。PRごとのVercel Deployment固有URLとNeon Native Preview DBを使う。Cannele、固定QA URL、QA枠、旧台帳・旧Actions方式へのfallbackは使わない。

Actionsの結果は専用stepの標準notice annotationから受け取り、artifact取得や外部relay、`checks: write`を必要としない。WindowsのCLIも既存gh本人認証でこの経路を使う。通常CI・Preview/DB管理・close時cleanupはActionsに残し、receiptの欠落・重複・不一致では停止する。

実装と追加テストを同じ開発ブランチへcommitし、その完全SHAの前後一致とclean状態を確認してWindowsでlint・型検査・回帰テスト・buildを行い、結果付きdraft PRを作る。テストを先にmainへmergeする必要はない。worktreeごとに `node_modules`・`.next`・`.cake`・環境ファイルを分離し、npm/Playwrightのキャッシュは共有できる。追跡テキストは `.gitattributes` のLFを維持し、globalのGit・PATH・セキュリティ設定やNodeを自動変更しない。

ローカルの `qa:verify` は維持する。Actionsで既存Previewを検証する `qa:verify:ci` は、最新mainとHEADが一致するcleanなcontrol checkoutから対象PR・完全SHA・Deployment IDを明示し、独立した `preview-verify.config.json` capabilityを照合して実行する。信頼済みmainだけをcheckoutし、provider管理APIはGETだけに制限する。ブラウザの `GET /api/app` は所属workspaceが0件なら初期workspace・membershipをINSERTし得るため、HTTP GETだけを根拠にDB無変更と扱わない。

Actions検証の成功だけではPRをReadyにしない。control側の `.cake/verify-<PR>.json` を `task:pr --remote-proof <path>` で再照合し、現在HEADのCIと検証証拠が一致することを確認する。新CLIを持たない古い対象PRには、最新mainのcleanなcontrol checkoutから任意の `--target-worktree <path>` を併用する。この指定はremote proof必須・非draft時だけ許可し、controlの最新main/capabilityと対象worktreeのcleanな専用branch/HEADを照合する。対象PRの旧コードは実行せず、Git/ghの管理操作だけを行う。既存のローカル証拠と `task:pr` の既定動作は変更しない。

機能・UI・API・DBを変更する際は、関連する[基本設計](docs/design.html)と[詳細設計](docs/detail-design.html)を確認する。仕様・運用の変更はこれらと運用手順へ反映する。

最新mainから `npm.cmd run task:start -- <task-name>` で専用worktreeを作る。利用者の依頼範囲を守り、未コミット変更を保持する。必要なPreviewは `deploy:preview` で明示作成し、Windowsでは共通ランチャー `qa:windows -- verify` から正式な `qa:verify` と同じブラウザ検証を行う。検証実装のSHAと対象runtimeのSHAを区別し、前後の対象照合を省略しない。既存Chromeの目視確認とPlaywrightの正式な検証証拠を区別し、Readyは現行の同SHA・CI・Preview/DB照合を満たして明示依頼時だけ進める。mainへのmergeとProductionの手動操作も利用者の明示依頼時だけ行う。

実Deployment・DBの作成/更新・資源削除は、対象と影響が利用者に承認されている範囲で行う。未承認なら実行前に確認する。draft PR作成の依頼を資源操作の許可と扱わない。PRのmerge/closeはmainのcleanupによる削除を起動し得るため、無断で実行しない。

アプリ説明とローカルセットアップは[README](README.md)を参照する。

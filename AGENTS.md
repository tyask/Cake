# Cake の開発ルール

開発・PR作成・QA操作の前に、[開発・QA運用手順](docs/development-workflow.md)を読む。CloudとローカルPCで同じコマンドを使う。

QAはCake単体で運用する。PRごとのVercel Deployment固有URLとNeon Native Preview DBを使う。Cannele、固定QA URL、QA枠、旧台帳・旧Actions方式へのfallbackは使わない。

Actionsの結果は専用stepの標準notice annotationから受け取り、artifact取得や外部relay、`checks: write`を必要としない。CloudとPCは既存gh本人認証と同じコマンドを使う。receiptの欠落・重複・不一致では停止する。

ローカルの `qa:verify` は維持する。Actionsで既存Previewを検証する `qa:verify:ci` は、最新mainとHEADが一致するcleanなcontrol checkoutから対象PR・完全SHA・Deployment IDを明示し、独立した `preview-verify.config.json` capabilityを照合して実行する。信頼済みmainだけをcheckoutし、provider管理APIはGETだけに制限する。ブラウザの `GET /api/app` は所属workspaceが0件なら初期workspace・membershipをINSERTし得るため、HTTP GETだけを根拠にDB無変更と扱わない。

Actions検証の成功だけではPRをReadyにしない。control側の `.cake/verify-<PR>.json` を `task:pr --remote-proof <path>` で再照合し、現在HEADのCIと検証証拠が一致することを確認する。新CLIを持たない古い対象PRには、最新mainのcleanなcontrol checkoutから任意の `--target-worktree <path>` を併用する。この指定はremote proof必須・非draft時だけ許可し、controlの最新main/capabilityと対象worktreeのcleanな専用branch/HEADを照合する。対象PRの旧コードは実行せず、Git/ghの管理操作だけを行う。既存のローカル証拠と `task:pr` の既定動作は変更しない。

機能・UI・API・DBを変更する際は、関連する[基本設計](docs/design.html)と[詳細設計](docs/detail-design.html)を確認する。仕様・運用の変更はこれらと運用手順へ反映する。

最新mainから `npm run task:start -- <task-name>` で専用worktreeを作る。利用者の依頼範囲を守り、未コミット変更を保持する。mainへのmergeとProductionの手動操作は利用者の明示依頼時だけ行う。

実Deployment・DBの作成/更新・資源削除は、対象と影響が利用者に承認されている範囲で行う。未承認なら実行前に確認する。draft PR作成の依頼を資源操作の許可と扱わない。PRのmerge/closeはmainのcleanupによる削除を起動し得るため、無断で実行しない。

アプリ説明とローカルセットアップは[README](README.md)を参照する。

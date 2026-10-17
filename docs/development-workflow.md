# 開発・QA運用手順

CakeはPRごとのVercel Preview固有URLと専用Neon Native DBで検証する。WSL2/LinuxまたはWindowsネイティブで開発し、通常CI・Preview/DB管理・close時cleanupはmainのActionsで実行する。PRと検証報告は日本語で書く。

## 1. 環境と作業ディレクトリ

Node.js 24・npm・Git・既存本人認証済みgh・公式Playwright Chromiumを使う。CIのNode版は `.github/workflows/ci.yml` を参照し、ローカルの実行版も記録する。

- WSL2はLinux版ツールを使う。[WSL開発・ブラウザ検証](wsl-development.md)で環境・認証・実行方法を確認する。
- WindowsはPowerShellで `npm.cmd` / `npx.cmd` を使い、[Windows QA手順](windows-qa-credentials.md)で保存済み資格情報を扱う。
- タスクごと、OSごとに独立したclone/worktreeを使う。既存変更を保持し、依存・build成果物・ `.cake` ・環境ファイルを分離する。資格情報を別環境からコピーしない。
- PATH補完は当該プロセスに限定する。globalのGit/PATH・CA・proxy・セキュリティ設定は変更しない。追跡テキストのLFは `.gitattributes` に従う。

元のCake checkoutで次を実行し、表示された作業先へ移動する。初回cloneで依存がなければ先に `npm ci` を行う。Windowsでは `npm` を `npm.cmd` に読み替える。

```bash
npm run task:start -- feature-name
```

このコマンドは最新 `origin/main` から `codex/feature-name` と専用worktreeを作り、その中で `npm ci` を実行する。作業先を変える場合は `CAKE_WORKTREE_ROOT` をそのプロセスだけに指定する。

## 2. ローカル検証と日本語のdraft PR

機能変更は関連テストと同じbranchへcommitし、最終commitで以下を実行する。WSL用の前後SHA・clean確認を含む例は[WSL手順](wsl-development.md#基本検証)を参照する。

```bash
npm run lint
npx --no-install tsc --noEmit
npm test
npm run build
```

`npm test` はfixture・PGlite・スタブ・ローカルChromiumを使い、実DBへ接続しない。ローカルCake全体の起動や実Previewでの操作とは区別する。文書のみの変更はリンク、コマンド、現行実装との整合性を確認する。アプリテストを省略した場合は理由を報告する。

PRのタイトル・本文・コメント・レビューコメント・検証報告は日本語にする。コマンド、識別子、エラーコード、引用するログは原文のままでよい。PR本文は最終的な問題・変更内容・検証結果を記載し、作業途中の経緯や過去の受入記録を混ぜない。

報告をGit外の `.cake/report.md` に保存する。環境・ツール版・完全SHA、コマンド別の成否/所要時間、件数、実画面で確認した内容、未実施項目を記載する。PR作成・更新が専用Preview/DBを操作することを承認済みの範囲で、次を実行する。

```bash
npm run task:pr -- --draft --title '変更内容を日本語で記載' --verification-file /absolute/path/report.md
```

CLIがpushしてdraft PRを作成/更新する。remoteとPRの完全SHAが検証commitに一致すること、現在HEADのpush/PR CIの最新attemptが成功したことを確認する。固定の過去テスト件数を報告へ流用しない。

## 3. 自動PreviewとDB書込

同一repositoryの `codex/*` からmainへのPRのopened・synchronize・reopenedで自動deploy、closedでcleanupを行う。draftも対象。PR未作成のpush、fork、別base/branch、PR本文の編集は自動deployの対象外。 `vercel.json` の `**: false` / `main: true` はVercel Git連携からの直接feature deployを止め、mainのActionsにDB準備を任せる設定である。

| 対象 | 自動で行う操作 |
| --- | --- |
| 初回Deployment | provisioningとapplicationの最大2回の作成要求。provisioningはNative準備後、DB接続前guardでERRORとなる設計。applicationがREADYになることを確認する |
| 専用DB | PR branchに対応するNative child branchとread-write endpointを準備。親・所属・作成時刻・世代・endpointを照合する |
| 初期化 | 専用DBの所有権marker、番号順migration・適用履歴、QAユーザーA/B・共有workspace・membershipのseed |
| 同PRの更新 | 同じDB/endpoint/generationを維持し、未適用migrationとbuildを実行。初回seed済みのデータ・ユーザー名・権限を上書きしない |
| PR merge/close | 紐づく全Deployment（失敗した準備用を含む）と専用DB/endpointを削除 |

Native連携で生成される実資源数は作成後に照合する。別PR・本番endpointとの一致、DB消失、複数世代、未管理の同名branchでは停止する。空DBまたは承認済みの完全一致fixtureだけを初期化し、既存markerを別PRへ付け替えない。本番接続文字列をPreviewへ渡さず、Previewは `CAKE_TEST_DATABASE_URL` を使う。

QAのAはテスト管理者・共有OWNER、Bは一般・MEMBER。正規QA用ログインは登録済みユーザーをSELECTし、自動作成・権限修復しない。ただし認証後のホームや `GET /api/app` は所属workspaceが0件なら個人workspaceとOWNER membershipをINSERTし得る。ローカルテスト認証のユーザー登録、Googleログイン時のプロフィール更新もDB書込として区別する。

自動deployはActionsのSummaryとnoticeで結果を確認する。手動deployが必要な場合だけ `npm run deploy:preview` を使う。自動runはrun ID由来の安定したoperation UUIDで再実行を照合し、不明なPOSTを盲目的に再発行しない。PRのHEADがイベントから進んだ場合もprovider書込前に停止する。

## 4. Previewの特定と認証

対象worktreeで次を実行する。statusはmainのActionsをdispatchし、provider管理APIをGETだけで照合する。SQLやアプリ操作はしない。

```bash
npm run qa:status
```

OPEN PR・branch・完全SHA・READY application Deployment ID・固有URL・DB branch/endpoint・generationを揃える。branch aliasや過去のURLから対象を推測しない。 `.cake/preview.json` は照合結果であり、資源の正本はVercel/Neonにある。

| 認証 | 使用先 |
| --- | --- |
| OS側の既存gh本人認証 | PR/CI/Actions/Checksの管理・読取。 `GH_TOKEN` / `GITHUB_TOKEN` が設定されていればそちらが優先される |
| Actionsの `VERCEL_TOKEN` ・ `NEON_API_KEY` | mainのprovider管理。値をローカルへ移さない |
| WSL側の本人Vercel認証、またはWindowsの保存済み資格情報 | 同一project/teamのdevelopment OIDC取得。QA処理のメモリ内だけで扱う |
| PreviewのテストユーザーA/B | アプリへのログイン。Vercel保護の認証とは別 |

Vercelはproject読取とOIDC取得で確認し、 `whoami` の結果だけでprojectへのアクセス可否を判断しない。401/403は未認証・期限・scope・対象の問題を値なしで切り分ける。本人ログインが必要なら停止して依頼する。秘密値・Cookie・接続文字列・生のprovider/browser例外をログやartifactへ出さない。

## 5. 実Previewのブラウザ検証

WSLでは[WSL手順](wsl-development.md#実previewの正式ブラウザ検証)、Windowsでは[Windows QA手順](windows-qa-credentials.md)を使う。公式Playwright Chromiumを一時プロファイルで起動し、終了時にセッションを破棄する。OIDCは同一project/team・development・有効期限を確認し、redirect各hopを含めて対象originだけへ付ける。TLS/CA/権限の問題を保護や証明書検証の無効化で回避しない。

標準helperはPC/mobile × A/Bでログイン、ホーム・取引明細・設定への16クリック、session/app GETとruntime proofの12観測を検証する。通常はGET/HEAD/OPTIONSとテスト認証callback POSTだけを許可する。前後のstatusで同じPR/SHA/Deployment/DB/generationを確認し、 `.cake/verification.json` と画面画像を保存する。検証実装のSHAとruntime対象のSHAも区別する。既存Chromeでの目視確認だけを正式証跡と扱わない。

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
2. 変更に必要な検証と差分の自己レビューが完了し、未解決の不具合・競合・必要な検証の不足がない。アプリ変更は同じHEADの正式ブラウザ証拠と変更箇所固有の検証を確認する。業務更新テストは承認済みの範囲で行う。
3. 自動Previewが成功し、現在HEADのPR・Deployment・固有URL・DB branch/endpoint・generationが正式statusと一致している。
4. PR本文に最終変更内容と、今回の成功・失敗・未実施、根拠・制約・残る資源を日本語で記載している。

条件未達ならdraftを維持し、阻害要因と必要な対応を報告する。Ready直前にもPRのHEADと証拠の一致を再確認し、更新後に過去SHAの成功を再利用しない。

**アプリ変更のReady操作：** ローカル証拠は対象worktreeの `task:pr` で再照合する。Actionsで検証する場合は、最新mainとHEADが一致するcleanなcontrol checkoutから既存対象を指定する。これはWSL上のブラウザ検証とは別の実行環境である。

```bash
npm run qa:verify:ci -- --pr <PR番号> --sha <完全SHA> --deployment <Deployment ID>
npm run task:pr -- --title '変更内容を日本語で記載' --verification-file /absolute/path/report.md --remote-proof /absolute/path/proof.json
```

controlの `preview-verify.config.json` capabilityを照合し、成功証拠は `.cake/verify-<PR>.json` に保存する。検証CLI自体はReadyにしないため、Codexが上記条件を確認して `task:pr` まで続けて行う。対象checkoutに管理CLIがない場合は、最新main側で `task:pr --remote-proof ... --target-worktree /absolute/path/target` を使う。target指定はremote proof必須・非draft専用で、対象コードを管理資格情報付きで実行しない。

**文書のみのReady操作：** mainとの差分がAGENTS.md・README.md・docs配下の文書だけで、アプリ・script・workflow・依存・設定を変更しない場合に限る。リンク・コマンド例・現行実装との整合性と差分全体をレビューし、上記のCI・自動Preview/statusを確認する。実行時の挙動を変えないためブラウザ再検証を省略したことをPR本文に明記し、次を実行する。この場合もブラウザ証拠の成功を作ったり、アプリ変更の `task:pr` の証拠チェックを弱めたりしない。

```bash
gh pr ready <PR番号> --repo tyask/Cake
```

Ready完了後、このチャットで「Codexとしてマージ可能と判断し、Readyにした」と日本語で通知する。PRリンク、判断理由、検証の要点、未実施項目と残る資源を添える。ReadyはCodex側の検証完了を示すもので、GitHubの必須レビュー・branch保護や利用者によるマージ判断は維持する。

main mergeはProduction deployと本番buildのDB更新を起動し得る。PR merge/closeは専用DBと入力データの削除を起動する。実行前に対象と影響を提示し、既に承認された範囲なら再承認を求めず進める。

closeして削除確認を依頼された場合は次を行う。

1. 現在PR/SHA、generation、紐づく全Deployment ID、専用DB branch/endpoint IDをclose前に記録する。
2. `gh pr close <PR番号> --repo tyask/Cake` を実行し、自動 `Preview cleanup PR ...` runの成功と対象を確認する。Git branchの削除やmain mergeは別操作である。
3. 記録した全Deployment IDへの直接GETが404であることを確認する。401/403/timeoutは削除確認にならない。
4. cleanupは削除前の所有権照合後に、専用DB branch/endpointの直接GETと一覧の不在を検査する。Neon資格情報がローカルにない場合はActions内の照合結果を使い、資格情報をコピーしない。
5. closed状態のsourceを指定した `requestReceipt('status', source, cwd)` で後続statusを取得し、provider一覧にDeployment/DBがないことを再確認する。通常の `npm run qa:status` はOPEN PR用なので、closed後には使わない。WSLでの実行例は[WSL手順](wsl-development.md#close後のstatus再照合)を参照する。

失敗した場合は削除済み・残存・未確認のIDを分けて報告する。cleanupを再実行する必要があり、その対象削除が承認済みの場合だけ `npm run qa:release -- --pr <閉じたPR番号>` を使う。再作成で復旧しない。確認は既存資源の削除であり、開始済みFunction/transactionの即時停止を保証しない。

## 7. 管理側の契約と停止条件

- `preview.config.json` はrepository、Vercel project/team、Neon project/親branch、本番host digest、 `receiptTransport: github-actions-notice/v1` を固定する。provider protocolは `cake-preview/v1` 、DB markerはversion 2。具体IDの正本は設定ファイルを参照する。
- `.github/workflows/preview.yml` は信頼済みmainだけをcheckoutし、PR単位のconcurrencyで直列化する。PRコードはVercel側で対象SHAをbuildする。手動dispatchの `controlSha` は実行時main SHAと一致させる。
- Actions結果は標準noticeから受け取り、run/初回attempt/job/check/suite/repository/appと、PR/HEAD/operation/control SHA/時刻を照合する。receiptは公開項目だけ、4,096 UTF-8 bytes以下。Checks書込やartifact取得は使わない。
- 欠落・重複・不正JSON・切詰め・秘密mask・対象変更・応答不明では停止する。単なるrun成功や過去receiptで現在の資源照合を省略しない。自動runの成否と、CLIで再取得する正式statusを区別する。
- 必要なSecretが不足していれば名前だけを報告する。資格情報の新規発行・移動、保護設定変更、盲目的なdeploy/cleanup再試行で修復しない。

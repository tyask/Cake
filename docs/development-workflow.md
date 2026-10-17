# 開発・QA運用手順

CakeはCanneleを使用せず、PR単位のVercel Preview固有URLでQAする。開発停止中に一括切替し、旧貸出・台帳・検証証拠は移さない。旧方式への自動fallbackは設けない。コード導入、外部設定、実環境受入の完了はそれぞれ区別する。

標準の開発環境はWindowsネイティブとする。Windowsの専用cloneからタスクごとのworktreeを作り、実装・ローカル検証・PR作成・実ブラウザ検証を進める。通常CI、専用Preview/DBの管理、close時cleanupとnotice受信は既存のActions経路を維持する。Codex Cloudの利用は前提にしない。以下の既存Actions検証・Cloud関連の注意事項は代替経路のために残す。

## 構成と権限

`preview.config.json`にrepository、Vercel project/team、Neon Preview project・親branch、本番endpointのSHA-256と`receiptTransport: "github-actions-notice/v1"`を固定する。現行対象はGitHub `tyask/Cake`、Vercel `fumin1/cake`、Neon Preview project `misty-meadow-88903426`。provider protocol `cake-preview/v1`とDB marker version 2は変更しない。本番の接続情報をPreviewへ渡さない。

Actionsブラウザ検証のcapabilityは独立した `preview-verify.config.json` で宣言する。`protocol: "cake-preview-verify/v1"`、`workflow: ".github/workflows/preview.yml"`、`action: "verify"` をmainの完全SHAで照合し、未導入・不一致のmainへはdispatchしない。既存deploy/status/cleanupのwire・receipt title/schema・`preview.config.json`を変更して検証機能の有無を表さない。

Cloud/PCのコマンドはmainの `.github/workflows/preview.yml` を明示的にdispatchし、同じPRの操作をActionsのconcurrencyで直列化する。Actionsのverifyもこのconcurrencyを使い、信頼済みmain上のスクリプトだけがprovider管理資格情報を使う。`pull_request_target` のopened・synchronize・reopenedで自動deploy、closedでcleanupを行う。同一repositoryの `codex/*` からmainへのPRだけを対象とし、管理側ではmainの完全SHAだけをcheckoutする。PRコードを管理資格情報付きでcheckout・実行しない。Vercelは指定したGitSourceのコードを、Preview DBの権限でリモートビルドする。

Actionsには既存のRepository secrets `VERCEL_TOKEN` と `NEON_API_KEY` が必要。GitHub読取は最小権限の `github.token` を使う。Cannele用Secret名を暗黙に代用しない。設定不足なら両Secret名を資格情報の値なしで報告し、providerの読取・作成・削除を始める前に停止する。新規資格情報・DB・deploymentを代わりに作らない。旧Cannele名のSecretだけでは使えないため、既存資格情報をGitHub Repository Settings → Secrets and variables → Actionsでこの2名に登録する。値をチャットへ送らない。

Cloud/PCのCLIは既存gh本人認証をそのまま使い、workflow・run・jobsとChecksの読取権限を確認する。`GH_TOKEN` / `GITHUB_TOKEN`などの環境変数は保存済みgh認証より優先するため、401/403では選択中の認証を値なしで確認して停止する。無断で資格情報やproxy・CA・ネットワークpolicyを変更しない。Vercel保護へのブラウザアクセスは別に確認する。結果受信に`checks: write`、新しいGitHub App、外部relay、artifact cacheは不要。

実Deployment・DBの作成/更新・資源削除は、対象project・PR・branch・資源と影響を示し、利用者の承認済み範囲で実行する。未承認なら実行前に確認する。ローカル検証・draft PR作成だけの依頼を、これらの実資源操作の許可と扱わない。

## 開発とdraft PR

Node.js 24、npm、Git、既存認証済みgh、公式Playwright Chromiumを使う。Windowsの初回準備は[README](../README.md#ローカルセットアップ)を参照する。PowerShellでは `npm.cmd` / `npx.cmd` を使い、ghのPATH補完は必要なターミナル内だけに限定する。実行ポリシー・グローバルPATH・Gitのglobal/system設定・proxy・CA・ネットワークpolicyは変更しない。Node 24.13.0でWindowsの全366回帰テスト・lint・型検査・buildは成功済みで、CIは24.19.0を使う。実行版を報告に残し、作業の一環として自動更新しない。

```powershell
npm.cmd run task:start -- feature-name
# task:startが出力した Set-Location -LiteralPath ... を実行する
```

`task:start`は最新origin/mainから `codex/<task-name>` と専用worktreeを作り、そこで `npm ci` を行う。並行タスクごとに別のworktree/ブランチを使う。`node_modules`・`.next`・`.cake`・`.env.local`等の環境ファイルは各worktreeに分離し、他タスクやWSLと共有しない。npmと公式Playwright Chromiumのキャッシュは共有できる。既存のChromiumキャッシュがなければ `npx.cmd playwright install chromium` で公式配布を用意する。追跡テキストは `.gitattributes` のLFを維持し、一時Git fixtureもテスト内で改行設定を固定する。

実装と追加テストを同じ開発ブランチへcommitし、最終commitをWindowsで検証する。追加テストを先にmainへmergeする必要はない。対象worktree内で次を実行し、一つでも失敗したら修正後のcommitで全工程を再確認する。

```powershell
if (git status --porcelain) { throw '未コミット変更を確認してください。' }
$testedSha = (git rev-parse HEAD).Trim()
npm.cmd run lint
if ($LASTEXITCODE -ne 0) { throw 'lint失敗' }
npx.cmd tsc --noEmit
if ($LASTEXITCODE -ne 0) { throw '型検査失敗' }
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw '回帰テスト失敗' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'build失敗' }
if ((git rev-parse HEAD).Trim() -ne $testedSha -or (git status --porcelain)) {
  throw '検証中にHEADまたは追跡ファイルが変わりました。'
}
```

SHA・Node版・コマンドの成否・件数・未実施項目をGit外の `.cake/report.md` 等へ記録し、その結果付きdraft PRを作る。push後はリモートHEADとPRの完全SHAが検証したSHAに一致すること、および現在HEADの通常CIの最新attemptが成功したことを確認する。

```powershell
npm.cmd run task:pr -- --draft --title '変更内容' --verification-file '.cake\report.md'
```

通常の `npm test` は実DB不要の回帰テストで、ローカルChromium fixtureを含む。localhostでCake全体を起動してログインするE2Eには、別途隔離DB・Auth.js設定・migration/seedが必要であり、PGliteの回帰テストで代用したとは報告しない。対象と書込範囲の承認なしにDB作成・接続・設定変更を行わない。

タスクブランチは `codex/<task-name>`。環境ファイル・資格情報を別環境からコピーしない。`vercel.json` は `**: false` / `main: true` を維持し、Vercel Git連携から直接のfeature deployは止める。専用DB識別情報なしのbuildを防ぐため、PreviewはmainのActionsが管理する。PR未作成のpushは通常CIだけを起動し、同一repositoryの `codex/*` からmainへのPR作成・更新・再openはdraftを含めて専用Previewを自動作成・更新する。fork・他のbase/branch・編集イベントは対象外。draft作成のpush前にローカルと現在mainの設定、workflowのtriggerを確認する。mainの本番Git連携は維持する。PRのmerge/closeは別にcleanupを起動し得るため、無断で行わない。

## Previewの作成と読取

```powershell
npm.cmd run deploy:preview
npm.cmd run qa:status
```

自動Previewの導入・有効化には、対象team/projectでの専用Deployment/Native branch/endpoint作成、初回migration/seed、PR更新時の同DBへの未適用migrationを含む継続的な範囲の承認が必要。導入後は対象PRの作成・更新・再openで自動実行する。初回は最大2回のDeployment作成要求、以後の同PR更新は同じDBを維持してapplication Deploymentを作る。build/seed前のDB所有権guardとfixture照合は省略しない。必要なSecretsやbindingが不足していれば停止し、資格情報や外部設定を自動変更しない。

自動runはGitHub run IDから一意で安定したoperation UUIDを生成し、同じrunの再実行では既存操作を照合する。不明なPOSTを盲目的に再発行しない。PRのHEADがイベントから進んだ場合もprovider書込前に停止する。結果はActionsのSummaryと既存noticeに表示し、検証用の `qa:status` / `qa:verify` は従来どおり最新mainと資源状態を再照合する。

手動の `deploy:preview` も維持する。Previewが必要で、その作成/更新と初回migration/seedが承認されている場合だけ実行する。作成後は同じ対象ブランチのworktreeで `qa:verify` を実行する。Preview管理に信頼済みmainを使うことと、Windowsで開発ブランチのテストを実行することは別であり、テスト追加のmainへの先行mergeは不要。

現在のOPEN PR・専用ブランチ・完全SHAを照合し、mainの`preview.config.json`がtransportを含めて実行中CLIの設定と完全一致することを確認してからmainへdispatchする。旧mainにnotice方式が未導入なら`PREVIEW_NOT_INSTALLED_ON_MAIN`でdispatch前に停止する。CLIはworkflow ID/path、repository、main SHA、operation UUID、REST APIの `run_attempt: 1` とrun成功を検証する。`gh run list --json attempt` はCLIによって未対応のため使用しない。失敗時は対応するActions run URLを報告する。完了確認は呼出し内の有限時間だけで、定期監視は行わない。

dispatch inputの`controlSha`へCLIが固定したmain SHAを渡す。workflowは開始時の`GITHUB_SHA`との一致をprovider操作前に確認し、dispatch直前にmainが進んだ場合も停止する。競合による停止後にdispatchを盲目的に繰り返さず、該当runと資源状態を読取調査する。

Actionsは公開用receiptへ`runId`・`runAttempt`・`controlSha`・operationを付け、専用stepで固定title `cake-preview-receipt/v1` の標準noticeを1件だけ出す。compact JSONは送出前に4,096 UTF-8 bytes以下を検査し、超過は失敗する。noticeはログにも残るため、接続文字列・token・DB host原文などの秘密を含めない。runnerの4,096文字切詰めや秘密マスクを正常なreceiptとして扱わない。

Cloud/PCは同じ`gh api`経路で、対象runの初回attemptの全jobsから唯一のpreview jobを選び、その`check_run_url`、CheckSuite、repository・main SHA・GitHub Actions appの対応を確認する。全annotationを取得して固定titleのnoticeが正確に1件であることを確認し、厳密なJSONとreceiptのPR/HEAD・operation・run ID/attempt・main SHA・時刻を照合する。欠落・重複・古いattempt・秘密マスク・切詰め・不正JSON・metadata変化では停止し、別runやログの転記へfallbackしない。読取前後のrun/check再照合は変更の検出であり、annotationの永続不変や暗号学的署名を保証しない。

結果受信はartifact ZIPのダウンロードに依存しない。受理したreceiptはGit外の `.cake/preview.json` に保存する。資源の正本はVercel/Neonで、receiptの欠落を資源消失と扱わない。

初回はVercel REST GitSourceでNative用のprovisioning deploymentを作る。このbuildは確認済みendpoint情報がないためDB接続前に停止する。その後、Native branchの正確な名前、親branch、作成時刻、所属、read-write endpointをlistと直接GETで照合する。application deploymentには確認済みIDとhost digestだけを渡し、接続文字列はNativeに供給させる。

同じPRの追加commitでは既存DBを維持する。別PR・別世代のmetadata、複数DB、本番endpoint一致、消失した既存DB、未管理の同名branchは停止条件。DB消失を再作成で修復しない。失敗deploymentもcleanup対象として残す。

応答不明では新しいdispatchを繰り返さず、同じActions runとprovider metadataを読取調査する。Actionsの再実行でもrun attempt 2以降は不明なPOSTを再発行せず、CLIは初回attempt以外のreceiptを受理しない。証拠がない場合は `PREVIEW_CREATE_RESULT_UNKNOWN` で停止する。新規作成を再開する前に未知の資源がないことを確認する。

## DB接続・migration・seed

Previewは `CAKE_TEST_DATABASE_URL` 必須。本番・Developmentの `DATABASE_URL` で代用しない。repository・PR・ブランチ・完全SHA・DB世代・Native branch ID・確認済みhost digest・本番host digestをクライアント作成前に検査する。URLの接続先上書きparameterは拒否する。

DB内の `cake_preview_database_identity` version 2はrepository・PR・ブランチ・世代・Native branch・host・database名を保持する。同PRのcommit更新でidentityは変えない。初回は空DBまたは承認済みの完全一致fixtureだけを受け入れ、他PR・旧versionのmarkerを上書きしない。migrationとseedは同じ所有権guardを通し、初回seed以降は入力データ・ユーザー名・権限を変更しない。

Aはテスト管理者・共有OWNER、Bは一般・MEMBER。Productionのテストログインは禁止。本番buildは従来どおりbuild成功後にmigrationを行い、失敗時は公開を止める。既存のアプリmigrationは変更しない。

画面確認のHTTP methodとDBの副作用は区別する。現在の `GET /api/app` は、ログインしたユーザーの所属workspaceが0件なら `workspaces` と `workspace_members` に初期の個人workspaceとOWNERをINSERTしてから返す。認証後のホーム表示もこのbootstrapを通る。ブラウザ検証で業務更新POSTを遮断しても、この既存GETの副作用は防止しない。検証対象のfixtureと許可されたDB書込範囲を確認し、DB完全無変更の検証として報告しない。

## Windowsの実Previewブラウザ検証とReady

Windowsでは[Windows QA資格情報・実行手順](windows-qa-credentials.md)の共通ランチャーを標準にする。リポジトリ内のソースから既存Windows compilerで毎回構築し、Git外の `%LOCALAPPDATA%\CakeQa\vercel-token.dpapi.json` を参照する。日付付き作業フォルダー、利用者名、SID、特定PR/SHA、ブラウザキャッシュの絶対pathは手順に固定しない。新しい独立タスクもAGENTS.mdからこの手順を辿り、保存済み資格情報を再入力せず利用できる。

```powershell
npm.cmd run qa:windows -- status
npm.cmd run qa:windows -- preflight
npm.cmd run qa:windows -- verify --pr <PR番号> --sha <完全SHA> --deployment <Deployment ID> --database <Native branch ID> --generation <DB generation UUID>
# QA成功・最新CI照合・Readyへの明示依頼後だけ実行する
npm.cmd run task:pr -- --title '変更内容' --verification-file '.cake\report.md'
```

既存の `qa:verify` は維持する。共通ランチャーは実行中checkoutの検証実装を使い、対象PRのcleanなworktree（既定は現在のworktree、別の場合は `--target-worktree <path>`）とruntimeの完全SHAを照合する。検証実装SHAと対象runtime SHAを別々に記録し、古いPRへ現在のCLIを無理に渡さない。Windows側のPlaywright Chromiumから実Previewへアクセスし、localhostのアプリE2Eとは区別する。検証前後にActionsで現在HEAD・READY Deployment・Native DB・generationを再照合し、指定と不一致なら停止する。固有URLのみを使い、任意URLやbranch aliasは受け付けない。PC/mobileでA/Bログイン、ダッシュボード、取引明細・設定・ホームの計16実クリック、session/app GETとruntime proofを確認する。送信するHTTP methodはGET/HEAD/OPTIONSとテスト認証callbackのPOSTに制限するが、前節のbootstrap INSERTは起こり得る。変更箇所固有のテスト結果は報告書へ別途記載する。

普段のChromeを正規ブラウザAPIで直接操作する確認は、利用者の目視確認を補助する別の経路とする。既存タブを変更せず、新規タブで確認する。この経路の2026-10-17の成功範囲は公開ページ操作と既存Previewのログイン前表示まで。別途Windowsの正式Playwright検証ではPR #75のA/B × PC/mobile、16クリック、API・runtime観測12件、画像12枚、指定SHA・Deployment・DB・generationの前後status照合が成功し、全体114.178秒だった。同DB更新後の保持、cleanup、全スクロール範囲はこの受入に含まない。特定実機・既存PRでの一度の成功と、共通化コードのダミー試験、別PR・別PCでの実環境再現は区別する。認証後のDB書込が許可されていない場合は、A/Bログインに進まず到達点を報告する。

Vercel保護には同一project/team・development環境・期限内のOIDCを対象originだけへ付与する。既存 `VERCEL_OIDC_TOKEN` を優先し、なければ既存 `VERCEL_TOKEN` で同projectのdevelopment env取得APIからメモリ内へ取り込む。ユーザー照会の成功をproject単位操作の前提にしない。保護設定を弱めず、secretを新規発行しない。token・Cookie・生のprovider/browser例外をログ・artifact・スクリーンショットへ出さない。

現行 `qa:verify` は公開PreviewでもこのOIDC取得を必須にするため、gh認証だけでは実行できない。Windowsの共通ランチャーは保存済みファイルの本人ACLとDPAPI CurrentUserを検査し、Vercel tokenをpreflight/QA専用子プロセスだけへ供給する。Git/ghには渡さず、環境ファイルへの保存・別環境からのコピーは行わない。未保存・失効・アクセス拒否は安全な成否と停止段階だけを報告し、別認証、権限拡張、保護や証明書検証の回避へ自動fallbackしない。必要な初回保存や失効時の再設定は本人の操作とし、[保存・更新手順と制約](windows-qa-credentials.md#初回保存と失効時の再設定)に従う。既存tokenを自動上書き・削除しない。

Cloudでローカル検証を行う場合は、実効policyの `*.vercel.app` と提供CA・既存NSS登録を読み取り照合する。ChromiumはLinuxのNSS信頼ストアを利用し、NSS DBにはSQLiteが必要とするアクセス権が必要。CA不足や読み取り専用状態で失敗した場合は対象hostと段階を報告して停止し、承認なしにCA・権限・proxy・ネットワーク設定を変更しない。信頼ストアのコピーやHOME移動で読み取り専用制限を回避しない。検証用ブラウザは一時プロファイルを使い、セッションは終了時に破棄する。既存Chromiumを使う場合は `CAKE_BROWSER_EXECUTABLE=/usr/bin/chromium` を指定できる。`ignoreHTTPSErrors`、証明書無視フラグ、TLS検証無効化、`route.fetch`による画面通信の代替は使わない。次節のActions検証は公式Playwright Chromiumを使用し、Cloudの信頼設定を変更しない。

対象worktreeの `.cake/verification.json` に対象commit・Deployment・DB・case・クリック時刻・成否を記録し、画面画像も `.cake/` に保存する。共通ランチャーの追加結果は対象worktreeの `.cake/windows-qa-launch-<UUID>.json`、進捗は `.cake/windows-qa-progress-<UUID>.json` に残り、実装/対象SHAと時間・前後照合を確認できる。失敗時は以前の成功証拠を無効にする。Readyには現在HEADのpush/PR CIの最新attempt成功と一致する検証証拠が必要。古い成功runで新しい失敗を隠さない。共通ランチャーはPRをReadyにしない。PR更新後にもHEADを再照合して、明示依頼がある場合だけ `task:pr` でdraftを解除し、mergeは利用者が行う。旧対象PRを最新controlから管理する `task:pr --target-worktree` のremote proof必須条件は変えず、Windowsのローカル証跡だけを流用しない。

## Actionsによる既存Previewの実ブラウザ検証（任意）

この機能が導入された最新mainとHEADが一致するcleanなcontrol checkoutから、既存のOPEN PR・完全HEAD SHA・READY application Deployment IDを明示する。対象PRのブランチへ移動して新CLIを実行する方式ではない。

```bash
npm run qa:verify:ci -- --pr <PR番号> --sha <完全SHA> --deployment <Deployment ID>
```

CLIは既存gh本人認証でPR、最新main、設定、verify capability、workflowを照合し、mainへ `action: verify` と対象Deployment ID・operation・controlShaを明示dispatchする。旧mainにverify capabilityがない場合はdispatch前に停止し、旧deploy/status/cleanupやローカル検証へ自動fallbackしない。dispatch後も対象PR/HEADとcontrol SHAを照合する。新CLIのために `preview.config.json` を変更しない。

Actionsは信頼済みmainの完全SHAだけをcheckoutし、PRコードを管理資格情報付きで実行しない。verifyの場合だけ、資格情報を渡す前のstepで公式Playwright Chromiumをインストールする。既存の `VERCEL_TOKEN`・`NEON_API_KEY` と読取用 `github.token` だけを使い、新規secret・認証方式・security/network設定は作らない。provider管理APIはbodyなしGETだけを許す専用guardを通し、検証前のstatus → ブラウザ → 検証後のstatusを同一run内で行う。対象PR/完全SHA/Deployment/URL/DB世代/Native branch/endpointの一致が条件となる。deploy・再作成・migration・seed・direct SQLは実行しない。アプリのGETが起こすbootstrap INSERTは前節のとおり別の副作用であり、このguardでのDB無変更保証には含めない。

PC/mobileのA/B、16クリック、session/app GET、runtime proofはローカルと同じブラウザhelperで検証する。各caseのruntime-before・session/app・runtime-afterの観測時刻を記録する。OIDCは既存 `VERCEL_TOKEN` で同projectのdevelopment env取得APIからメモリ内だけへ読み、project/team・environment・期限を確認して対象originだけへ付与する。redirect各hopもoriginを確認し、token/Cookieを別origin、ログ、receipt、artifactへ出さない。TLS検証を維持し、保護設定を弱めない。

verify専用のnotice titleとreceipt protocolは `cake-preview-verify/v1`。成功・失敗とも公開可能なprojectionを厳密に検査し、compact JSONを4,096 UTF-8 bytes以下に制限する。失敗時は固定stage/codeと部分的な非秘密証拠だけを出し、provider/browserの生例外や秘密を含めない。CLIは既存notice受信と同じrun ID/初回attempt/operation/control SHA、workflow/job/CheckRun/CheckSuite/repository/GitHub Actions app、対象PR/HEAD/Deploymentを照合する。成功はrun/job/checkのsuccessと一致するものだけ受理し、failure receiptはrun/job/checkのfailureに一致する診断として読み、成功扱いしない。欠落・重複・不一致・マスク・切詰めでは停止する。artifact ZIP・外部relay・`checks: write`は不要で、Actionsの画面画像を結果取得経路に使わない。

成功証拠は対象PRのworktreeではなくcontrol checkoutの `.cake/verify-<PR番号>.json` へ保存する。wrapper protocolは `cake-preview-remote-proof/v1` で、workflow IDと受理したverify receiptを保持する。失敗・未完了・不一致で以前の成功を再利用しない。このコマンド自体はPRを更新せず、Readyにも変更しない。

検証成功後にReadyへ進める依頼がある場合は、対象PRの現在HEADと最新push/PR CIを確認し、新CLIを含む対象PRのcleanなworktreeから明示的にremote proofを渡す。`task:pr` は保存ファイルだけを信頼せず、そのActions run・noticeの来歴と現在の対象を再照合する。

```bash
npm run task:pr -- --title '変更内容' --verification-file /path/report.md --remote-proof /path/control-checkout/.cake/verify-<PR番号>.json
```

`--remote-proof` は任意で、省略時のローカル `.cake/verification.json` と既存 `task:pr` の動作は維持する。別PR、別HEAD、別Deployment、失敗receipt、古いattemptの証拠をReadyへ流用しない。

PR #75のように対象ブランチの旧 `task:pr` が `--remote-proof` を持たない場合は、そのブランチを更新せず、最新mainのcontrol checkoutから `--target-worktree` を併用する。この指定は `--remote-proof` 必須で `--draft` と併用できない。controlのcleanなHEADと最新main・verify capabilityを照合した後、対象worktreeのcleanな専用branch・PR・完全HEADを照合する。対象ブランチのスクリプトやアプリコードは実行せず、信頼済みcontrol側の管理コードから対象のGit/gh操作を行う。

```bash
# CWDは更新済みmainのcontrol checkout。実QA成功・最新CI確認・Readyの依頼後だけ実行する。
npm run task:pr -- --title '変更内容' --verification-file /absolute/path/target-report.md --remote-proof /absolute/path/control-checkout/.cake/verify-75.json --target-worktree /absolute/path/Cake-worktrees/notice-receipt-acceptance
```

報告書・remote proof・対象worktreeは絶対pathを推奨する。相対pathは実行元のcontrol checkoutを基準に解釈される。`--target-worktree` も省略時の既定動作を変えず、検証CLIの成功から自動でReady処理を始めることはない。

## PR終了時のcleanup

mergeと未マージcloseの両方でmainのworkflowを起動し、対象PRのDeployment・Neon branch/endpointを削除し得る。PRを閉じるだけの操作も実資源に影響するため、cleanup対象と影響が承認されるまで無断でmerge/closeしない。再実行は次の明示コマンドを使う。

```bash
npm run qa:release -- --pr <閉じたPR番号>
```

全ページのprovider inventoryと直接GETを照合し、対象repository・PR・専用ブランチ・DB世代・projectに所属する資源だけを処理する。名前の部分一致では削除しない。作成中build、所属矛盾、応答不明は停止する。削除直前にもPRがclosedであることと対象IDを確認する。

失敗後の復旧用に一つのDeployment metadataを最後まで保持する。他のdeploymentを削除後、対象Neon branchとendpointの消失を確認し、最後のmetadata保持deploymentを削除する。Nativeが先に削除した場合も直接GETの404を確認する。本番・Native親DB・他PR・旧方式の資源は対象外。HTTP失敗・403・timeoutは消失確認ではない。削除済み資源も再実行で整合を確認し、全対象不在後だけ完了にする。実行中FunctionやDB transactionの即時停止は保証しない。

## 一括切替と受入

旧QA運用との並行稼働・台帳移行は行わない。既存QA資源を別途棚卸しして整理し、旧writerと実行中runを止める。Cakeから旧workflow・CLI・固定alias処理・管理DB依存を撤去する。外部Canneleサービス・管理DB・旧資格情報自体の撤去は別作業で、本変更のコード削除に伴って実行しない。

main導入後、試験PRで初回Native作成、アプリDB接続、追加commitでのDB保持、PC/mobile A/Bの画面操作、merge/close後のDeployment/branch/endpoint消失を受け入れる。2026-10-16の既存Preview検証はCloud接続・CA・OIDC・A/B読取操作の証拠であり、新方式の作成・cleanupを検証した証拠ではない。実資源の生成・削除が許可されていない開発依頼では、ローカル検証まで行いdraft PRに未実施理由を記載する。

## notice receiptの検証状況と実機受入計画

2026-10-16の隔離[probe run 38917756089](https://github.com/tyask/Cake/actions/runs/38917756089)は、`codex/checks-receipt-probe` のcommit `c2b8e948f283a71a872a76c638c2aa3a0627e88d` で合成noticeを1件生成した。workflow/jobとも`permissions: {}`、provider呼出しなしで、Cloudの既存gh認証から329 bytesの同一JSONを33.5秒隔てた2回の読取で確認した。同commitの[通常CI run 38917699728](https://github.com/tyask/Cake/actions/runs/38917699728)も成功した。probe branchは検証証拠として残す。この結果はnotice輸送の証拠であり、正式なPreview receiptや実Deployment・DBの作成/保持/cleanupの検証結果ではない。

正式な受信実装も同日にCloudの実APIへGETだけで照合し、既存[run 38896088643](https://github.com/tyask/Cake/actions/runs/38896088643)の正確なattempt/job/check/suiteを確認後、新noticeがない旧結果を拒否した。旧mainに対する`PREVIEW_NOT_INSTALLED_ON_MAIN`停止も実測し、dispatch・provider操作は0件だった。これは所属照合と導入前停止の確認であり、正式receiptの実機往復成功とは区別する。

notice実装PR `codex/notice-receipts` の作業範囲はローカル検証と実装draft PR作成までで、その時点では実資源の受入と試験PR作成は未実施だった。PR段階のCLIはtransport設定がない旧mainのdeploy/status/cleanupをdispatch前に拒否する。provider workflowもmain限定なので、非main branchへdispatchして正式receiptを検証した扱いにしない。当時のmain導入後受入は、別のOPEN試験PR/branchについて次の対象・影響を承認してから進める計画とした。現在の実施範囲は次節に分ける。

1. Vercel `fumin1/cake` とNeon Preview project `misty-meadow-88903426`（親branch `br-lively-frog-b3y2mauu`）で別のOPEN試験PRの初回Previewを作る。branch例は`codex/notice-receipt-acceptance`、Native branch候補は`preview/codex/notice-receipt-acceptance`。実行前にPR番号、完全HEAD、configのproject/親branch bindingを改めて提示する。初回はprovisioningとapplicationの最大2 Deployment、専用DB branch/read-write endpointの生成と初回migration/seedを予定する。生成されたID・世代を記録し、別PR・本番・旧資源には触れない。
2. 正式receiptを既存Cloud gh認証で受領し、`qa:status`とPC/mobile A/Bの`qa:verify`を確認する。同じ試験PRの追加commitを配置し、Native branch/endpoint・DB世代と入力済みデータが保持されることを確認する。追加配置と検証に伴う書込も承認範囲を確認する。
3. cleanupは対象Deployment ID・Neon branch/endpointと削除影響を改めて提示し、承認後にだけPRをclose/merge、またはclosed PRへ明示cleanupを実行する。削除後の全対象不在を直接GETで確認する。cleanupの承認前にPRを閉じない。

## Actions verify実装PRの範囲と残る実環境受入

2026-10-16の `codex/actions-preview-qa` は、Actions検証経路の実装、ローカル検証、draft PRと通常CIまでを対象とする。既存の受入PR #75 (`codex/notice-receipt-acceptance`、HEAD `a0e0aac6fa479040463a268182ea61b5fefd07e2`) とそのDeployment/DBは更新しない。この実装作業では実Actions QA dispatch、OIDCによるPreviewアクセス、DB書込、deploy、migration/seed、main merge、cleanupを行わない。ローカルのスタブ/契約テストと通常CIの成功を、実Actionsのブラウザ/OIDC成功として報告しない。

mainへの導入は既存Production Git連携のdeployを起動し得るため、別途承認が必要。導入と対象の実環境検証が承認された後は、更新したmainのcontrol checkoutでPR #75の最新HEAD・Deployment・専用DBを改めて照合する。次は現在の対象を示す未実施のコマンド例で、実行時点の値が変わっていた場合は停止して確認する。

```bash
npm run qa:verify:ci -- --pr 75 --sha a0e0aac6fa479040463a268182ea61b5fefd07e2 --deployment dpl_8GpqT3jbuDqdLBMTWyvPwzjK1oDW
```

PR #75の旧管理CLIへ新flagsを渡さない。実Actions QA成功と最新CIを確認し、Readyへの依頼がある場合だけ、前節のcontrol checkoutから `--remote-proof .../verify-75.json --target-worktree .../notice-receipt-acceptance` を指定する。これは将来の手順であり、この実装PRではReady操作を実行しない。

同DB更新後のデータ保持、非機密の識別データ投入、PRのReady化、merge/closeや資源cleanupはこの実装PRの検証完了に含めない。既存受入の初回配置予算は2/2消費済み、同DB更新は0/1のまま保持し、再作成しない。各段階の対象・影響・実測結果を確認してから、承認された範囲だけ進める。

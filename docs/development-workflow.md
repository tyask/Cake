# 開発・QA運用手順

CakeはCanneleを使用せず、PR単位のVercel Preview固有URLでQAする。開発停止中に一括切替し、旧貸出・台帳・検証証拠は移さない。旧方式への自動fallbackは設けない。コード導入、外部設定、実環境受入の完了はそれぞれ区別する。

## 構成と権限

`preview.config.json`にrepository、Vercel project/team、Neon Preview project・親branch、本番endpointのSHA-256と`receiptTransport: "github-actions-notice/v1"`を固定する。現行対象はGitHub `tyask/Cake`、Vercel `fumin1/cake`、Neon Preview project `misty-meadow-88903426`。provider protocol `cake-preview/v1`とDB marker version 2は変更しない。本番の接続情報をPreviewへ渡さない。

Actionsブラウザ検証のcapabilityは独立した `preview-verify.config.json` で宣言する。`protocol: "cake-preview-verify/v1"`、`workflow: ".github/workflows/preview.yml"`、`action: "verify"` をmainの完全SHAで照合し、未導入・不一致のmainへはdispatchしない。既存deploy/status/cleanupのwire・receipt title/schema・`preview.config.json`を変更して検証機能の有無を表さない。

同DB保持受入は別の `preview-retention.config.json` capabilityで宣言する。protocolは `cake-preview-retention/v1`、workflowは同じ `preview.yml`、actionsは `retention-prepare`・`retention-inspect`・`retention-update`・`retention-reconcile`・`retention-check` に固定する。最新mainの完全SHAでの一致を確認してからdispatchし、未導入なら停止する。既存deploy/status/cleanup/verifyの動作とprotocolは維持する。

Cloud/PCのコマンドはmainの `.github/workflows/preview.yml` を明示的にdispatchし、同じPRの操作をActionsのconcurrencyで直列化する。Actionsのverifyもこのconcurrencyを使い、信頼済みmain上のスクリプトだけがprovider管理資格情報を使う。`pull_request_target` はclosedイベントだけで、PRコードをcheckout・実行しない。Vercelは指定したGitSourceのコードを、Preview DBの権限でリモートビルドする。

Actionsには既存のRepository secrets `VERCEL_TOKEN` と `NEON_API_KEY` が必要。GitHub読取は最小権限の `github.token` を使う。Cannele用Secret名を暗黙に代用しない。設定不足なら両Secret名を資格情報の値なしで報告し、providerの読取・作成・削除を始める前に停止する。新規資格情報・DB・deploymentを代わりに作らない。旧Cannele名のSecretだけでは使えないため、既存資格情報をGitHub Repository Settings → Secrets and variables → Actionsでこの2名に登録する。値をチャットへ送らない。

retentionの原noticeと全run履歴を読むため、既存preview jobへ `actions: read` と `checks: read` を追加する。どちらも読取用で、Checksへのwriteや新しいSecret/認証方式は追加しない。

Cloud/PCのCLIは既存gh本人認証をそのまま使い、workflow・run・jobsとChecksの読取権限を確認する。`GH_TOKEN` / `GITHUB_TOKEN`などの環境変数は保存済みgh認証より優先するため、401/403では選択中の認証を値なしで確認して停止する。無断で資格情報やproxy・CA・ネットワークpolicyを変更しない。Vercel保護へのブラウザアクセスは別に確認する。結果受信に`checks: write`、新しいGitHub App、外部relay、artifact cacheは不要。

実Deployment・DBの作成/更新・資源削除は、対象project・PR・branch・資源と影響を示し、利用者の承認済み範囲で実行する。未承認なら実行前に確認する。ローカル検証・draft PR作成だけの依頼を、これらの実資源操作の許可と扱わない。

## 開発とdraft PR

Node.js 24、npm、Git、gh、PlaywrightのChromiumを用意する。環境のproxy・CA・ネットワークpolicyを保持する。

```bash
npm run task:start -- feature-name
cd ../Cake-worktrees/feature-name
npm run lint
npm test
npx tsc --noEmit
npm run build
# 変更をcommitした後
npm run task:pr -- --draft --title '変更内容' --verification-file /path/report.md
```

タスクブランチは `codex/<task-name>`。環境ファイル・資格情報を別環境からコピーしない。`vercel.json` は `**: false` / `main: true` を維持し、feature pushによる自動Previewを止める。draft作成のpush前にローカルと現在mainの設定、workflowのtriggerを確認する。この設定下のpushとdraft PR作成は通常CIだけを起動し、Previewは明示dispatch時に操作する。mainの本番Git連携は維持する。PRのmerge/closeは別にcleanupを起動し得るため、無断で行わない。

## Previewの作成と読取

```bash
npm run deploy:preview
npm run qa:status
```

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

文書commitだけの同DB更新でも、Preview/testのbuildは `db:setup → db:seed:test → build` を実行する。`db:setup` は既存migration ledgerの適用済み項目で本体をskipし、`db:seed:test` は既存identityの `seeded_at` があれば挿入前に戻る。DB接続・所有権guard・advisory lockは実行するため「DB処理なし」と報告しない。この保持はコード上の契約であり、既存の実DBでledger/seeded_atと更新後データを照合した結果は別に記録する。

Aはテスト管理者・共有OWNER、Bは一般・MEMBER。Productionのテストログインは禁止。本番buildは従来どおりbuild成功後にmigrationを行い、失敗時は公開を止める。既存のアプリmigrationは変更しない。

画面確認のHTTP methodとDBの副作用は区別する。現在の `GET /api/app` は、ログインしたユーザーの所属workspaceが0件なら `workspaces` と `workspace_members` に初期の個人workspaceとOWNERをINSERTしてから返す。認証後のホーム表示もこのbootstrapを通る。ブラウザ検証で業務更新POSTを遮断しても、この既存GETの副作用は防止しない。検証対象のfixtureと許可されたDB書込範囲を確認し、DB完全無変更の検証として報告しない。

## ローカル実ブラウザ検証とReady

```bash
npm run qa:verify
npm run task:pr -- --title '変更内容' --verification-file /path/report.md
```

既存の `qa:verify` は対象PRのcleanなworktreeで実行し、ローカルブラウザを使う。検証前後にActionsで現在HEAD・READY Deployment・DBを再照合する。固有URLのみを使い、任意URLやbranch aliasは受け付けない。PC/mobileでA/Bログイン、ダッシュボード、取引明細・設定・ホームの計16実クリック、session/app GETとruntime proofを確認する。送信するHTTP methodはGET/HEAD/OPTIONSとテスト認証callbackのPOSTに制限するが、前節のbootstrap INSERTは起こり得る。変更箇所固有のテスト結果は報告書へ別途記載する。

Vercel保護には同一project/team・development環境・期限内のOIDCを対象originだけへ付与する。既存 `VERCEL_OIDC_TOKEN` を優先し、なければ既存 `VERCEL_TOKEN` で同projectのdevelopment env取得APIからメモリ内へ取り込む。ユーザー照会の成功をproject単位操作の前提にしない。保護設定を弱めず、secretを新規発行しない。token・Cookie・生のprovider/browser例外をログ・artifact・スクリーンショットへ出さない。

Cloudでローカル検証を行う場合は、実効policyの `*.vercel.app` と提供CA・既存NSS登録を読み取り照合する。ChromiumはLinuxのNSS信頼ストアを利用し、NSS DBにはSQLiteが必要とするアクセス権が必要。CA不足や読み取り専用状態で失敗した場合は対象hostと段階を報告して停止し、承認なしにCA・権限・proxy・ネットワーク設定を変更しない。信頼ストアのコピーやHOME移動で読み取り専用制限を回避しない。検証用ブラウザは一時プロファイルを使い、セッションは終了時に破棄する。既存Chromiumを使う場合は `CAKE_BROWSER_EXECUTABLE=/usr/bin/chromium` を指定できる。`ignoreHTTPSErrors`、証明書無視フラグ、TLS検証無効化、`route.fetch`による画面通信の代替は使わない。次節のActions検証は公式Playwright Chromiumを使用し、Cloudの信頼設定を変更しない。

`.cake/verification.json` に対象commit・Deployment・DB・case・クリック時刻・成否を記録し、画面画像も `.cake/` に保存する。失敗時は以前の成功証拠を無効にする。Readyには現在HEADのpush/PR CIの最新attempt成功と一致する検証証拠が必要。古い成功runで新しい失敗を隠さない。PR更新後にもHEADを再照合してdraftを解除し、mergeは利用者が行う。

## Actionsによる既存Previewの実ブラウザ検証

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

## 同DB更新後のデータ保持受入

`qa:retention` は、独立capabilityを導入した最新mainとHEADが一致するcleanなcontrol checkoutで実行する。対象は同一repositoryのOPEN PR・専用branch・完全SHA・固有Deployment URL・専用DBで、既存PR #75の旧CLIを実行・変更する必要はない。trusted mainに固定した管理・ブラウザ処理だけを実行し、任意のPRテスト、任意HTTP payload、追加操作を渡す入口は設けない。この範囲を超える将来のテスト実行方式は現仕様に含めない。

通常CIはPR自身の `npm test`／buildを実行するため、新しい単体・結合・localhostブラウザテストの追加にmainへの事前mergeは不要。上記のmain固定は、実Previewへの管理・ブラウザ検証経路に対する制限である。

承認済みの実環境受入では、次の順に進める。各値と証拠pathはCLIが確認したものを使い、pathは絶対指定を推奨する。

1. 更新前の正確なHEAD/READY application Deployment/DBを照合し、prepareで固定ダミー明細を1件だけ登録する。登録後GETからbaselineを受領してから次へ進む。
2. 対象PRのworktreeに非機能の文書commitを1回追加し、pushと新HEADの最新CIを確認する。管理CLIはcontrol checkoutから実行し続ける。
3. 旧baselineへ結び付くupdateを1回だけ実行し、新READY Deploymentと同一DB/世代を確認する。
4. checkコマンドが新HEAD/Deploymentの既存 `qa:verify:ci` を自動実行し、成功後に登録明細とデータdigestをGETで最終照合する。通常QA中のGET副作用後も保持されていることを確認し、PC/mobile A/B QAと最終保持確認の両成功で完了する。

```bash
npm run qa:retention -- prepare --pr <PR番号> --sha <旧完全SHA> --deployment <旧Deployment ID> --marker <UUID>
# baselineを受領後、対象PRに文書commitを1回追加してpush/CIを確認
npm run qa:retention -- update --pr <PR番号> --sha <新完全SHA> --baseline <登録証拠path>
npm run qa:retention -- check --pr <PR番号> --sha <新完全SHA> --deployment <新Deployment ID> --baseline <登録証拠path> --update <更新証拠path>
```

prepareはテストユーザーAで、固定共有workspace `00000000-0000-4000-8000-000000000001` に通常の `POST /api/app`・`action: saveTransaction` を最大1回だけ送る。入力は日時 `2020-01-01T00:00:00.000Z`、取引先 `Cake retention test`、支払方法 `QA_TEST`、支払1,234円、支払者A、個人費、割合A=1/B=0、メモ `cake-retention:<marker>` に固定し、任意入力は受け付けない。markerは正規形の小文字UUIDを使う。既存markerがあればPOST前に停止する。専用interceptorは明示arm後の完全一致payload・同origin・同pathの1回だけを許可し、redirectや他の業務書込を遮断する。既存verifyのPOST遮断は変更しない。通常登録は明細だけでなくworkspaceの更新日時も変更する。GETの初期workspace作成という既存副作用も前節どおりで、「DBの1行だけ変更」とは扱わない。

baselineはPOST応答ではなく、その後のGET fullから作る。GETが日時を秒単位に整形するため、精度が異なるPOST応答と直接比較しない。要求したworkspaceと返却されたselected workspace、固定A/Bの所属・役割・重み・Aの有効/管理者条件を検査し、marker一致が正確に1件であることを確認する。公開証拠にはmarker、workspace/明細UUID、件数1、金額1,234円、全明細件数/合計、単体content digest・全明細collection digest・workspace/参加者/A identityのfixture digestを保持する。digestは検査済みの既知項目をID/key順に正規化したSHA-256とする。名前・メールやアプリの生応答をreceiptへ公開せず、欠落・重複・値やdigestの変化では停止する。

updateは原baselineの旧READY Deployment、DB branch/endpoint/host digest、世代を固定し、旧SHAとは異なる文書だけの子孫SHAを対象にする。差分は `docs/` 配下または `README.md`／`AGENTS.md` に限定し、アプリ・workflow・設定の変更を拒否する。Vercel application作成POSTを最大1回だけ許し、初回provisioning、DB再作成、Neon書込、削除は行わない。旧Deploymentの所属/READYと全資源を再照合し、pendingや未知のapplication、別DB/世代を見つけたら停止する。Vercel上の新buildは対象PRのGitSourceを使い、前節の既存DB setup/seed guardを実行する。control側で対象PRの旧CLIを実行しないことと、リモートbuildの実行は区別する。

更新POST後に新Deployment IDが判明したERROR/timeoutは、failure receiptの `attemptedDeploymentId` にその公開IDを残し、更新枠を消費した試行として保持する。POST自体の結果が不明でIDも未判明なら、その不確定性を明示する。reconcileはGETだけで元operationに属する候補IDを回収・照合し、成功しなくても判明済みIDを報告する。失敗資源を消えた扱いにせず、再POSTや予算復活を行わない。providerの生例外は公開しない。

prepare/updateはoperationをmarkerと一致させる。書込dispatch前にPR/mode固定path `.cake/retention-<PR>-<mode>.intent.json` をmode 0600・排他的な新規作成で保存する。markerは中に保持し、別markerで同時に書込入口を作れないようにする。失敗/不確定なdispatchでもintentを残し、削除して再dispatchしない。run IDが判明した場合だけ記録を追記してinspect/reconcileへ渡す。ローカルファイルだけでなく、同PRの正式workflow履歴の全ページと初回attemptを確認し、failed/cancelled/incompleteを含む先行書込runがあれば再書込を拒否する。同じ受入PRでprepare後にmarkerを変更しても新たな書込を許さない。失敗buildやPOST応答不明を理由に更新予算を復活させず、再dispatch/rerunしない。全retention actionはattempt 2以降を拒否する。

不確定な登録はinspect、不確定な更新はreconcileで元runを指定してGETだけで確認する。prepareの不確定結果を解消する前に文書commit/更新へ進まない。

この節のGET/read-onlyはprovider管理APIと認証後の業務データ取得を指す。inspectのブラウザログインは既存の認証callback POSTを使い、GETのbootstrap副作用も残る。新たな業務POSTやprovider書込を許さないことと、DB完全無変更の保証は区別する。

```bash
npm run qa:retention -- inspect --pr <PR番号> --sha <旧完全SHA> --deployment <旧Deployment ID> --marker <同じUUID> --run <元prepare run ID>
npm run qa:retention -- reconcile --pr <PR番号> --sha <新完全SHA> --baseline <登録証拠path> --run <元update run ID>
```

正式noticeがあり不確定結果を示した原prepareへ、1段だけのinspectが厳密に結び付き、presentと完全な証拠を返せた場合はbaselineとして扱える。登録baselineを観測するinspectのabsentやunknownは成功扱いしない。原updateに厳密に結び付くreconcileの成功も更新証拠として使える。`outcome` は明細観測の結果を表すため、update/reconcileの成功でもデータ未読の `outcome: unknown` を返す。この場合は新DeploymentのREADY成功が確定しており、更新自体の成否不明を意味しない。データ保持は通常QA後の最終checkで初めて確定する。inspect/reconcileは新たなPOSTを許可しない。

原write runの正式noticeが欠落した場合、REST metadataから確認できるPR/action/operation/mainだけでは、原要求の対象SHA/Deploymentを復元できない。GETだけの診断で観測できても元結果の不確定性を残し、成功/baselineへ昇格せず停止する。欠落receiptを別の成功で置き換えず、再POSTもしない。不正・曖昧な元証拠も同様に停止する。

retention専用protocol/titleは `cake-preview-retention/v1`、公開wrapperは `cake-preview-retention-proof/v1`。CLIは原noticeの来歴を照合したstrict receiptとworkflow IDを、control側の `.cake/retention-<PR>-<marker>-<mode>.json` にmode 0600で保存し、modeは `prepare`／`inspect`／`update`／`reconcile`／`check` とする。`readRetentionProof` 単独はローカルの形・値の確認だけで来歴を保証しない。baseline/updateファイルはヒントであり、使用する各commandが `loadRegistrationBaseline`／`loadRetentionUpdate` などで原noticeと参照chainを同じworkflow/job/check/suite/app/repository/main/run/初回attempt/operationへ再結合する。成功・失敗・明細未観測・実行結果不確定は分け、未知/重複key、秘密マスク、切詰め、4,096 UTF-8 bytes超過を拒否する。管理APIは原則GETのみで、updateの正確なVercel application POSTだけを例外とする。既存Secret、OIDCのメモリ内/origin限定、TLS検証を維持し、新規Secret・認証方式・schema・network/security設定は追加しない。

check CLIは既存UI QAの成功後に最終GET保持checkを実行し、同じDB/世代の明細ID・値・件数・全digestを登録後baselineと比較する。QA中のGETで生じ得る副作用も、この最後の観測に含める。通常QAまたは最終保持checkが失敗したらコマンド全体は失敗で、成功check proofを保存せず、証拠参照と未完了段階を報告する。両方が成功したcombined proofは、同じ新HEAD/Deployment/control SHA、原baseline/updateと通常QAのworkflow/run/proof pathを結合する。保持成功や通常QA成功から自動でPRをReadyにしない。Readyへ進める依頼がある場合だけ、現在HEAD/CIと新しい通常QA証拠を既存 `task:pr --remote-proof` へ渡す。旧PR #75ではcontrol側から `--target-worktree` を併用し、旧証拠を新HEADへ流用しない。cleanupは別の承認対象とする。

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

この節はActions verify実装PR当時の範囲を記録し、その後のmain導入や実QAの現在状態を示すものではない。

2026-10-16の `codex/actions-preview-qa` は、Actions検証経路の実装、ローカル検証、draft PRと通常CIまでを対象とする。既存の受入PR #75 (`codex/notice-receipt-acceptance`、HEAD `a0e0aac6fa479040463a268182ea61b5fefd07e2`) とそのDeployment/DBは更新しない。この実装作業では実Actions QA dispatch、OIDCによるPreviewアクセス、DB書込、deploy、migration/seed、main merge、cleanupを行わない。ローカルのスタブ/契約テストと通常CIの成功を、実Actionsのブラウザ/OIDC成功として報告しない。

mainへの導入は既存Production Git連携のdeployを起動し得るため、別途承認が必要。導入と対象の実環境検証が承認された後は、更新したmainのcontrol checkoutでPR #75の最新HEAD・Deployment・専用DBを改めて照合する。次は現在の対象を示す未実施のコマンド例で、実行時点の値が変わっていた場合は停止して確認する。

```bash
npm run qa:verify:ci -- --pr 75 --sha a0e0aac6fa479040463a268182ea61b5fefd07e2 --deployment dpl_8GpqT3jbuDqdLBMTWyvPwzjK1oDW
```

PR #75の旧管理CLIへ新flagsを渡さない。実Actions QA成功と最新CIを確認し、Readyへの依頼がある場合だけ、前節のcontrol checkoutから `--remote-proof .../verify-75.json --target-worktree .../notice-receipt-acceptance` を指定する。これは将来の手順であり、この実装PRではReady操作を実行しない。

同DB更新後のデータ保持、非機密の識別データ投入、PRのReady化、merge/closeや資源cleanupはこの実装PRの検証完了に含めない。既存受入の初回配置予算は2/2消費済み、同DB更新は0/1のまま保持し、再作成しない。各段階の対象・影響・実測結果を確認してから、承認された範囲だけ進める。

## Retention実装PRの範囲

2026-10-17の `codex/preview-retention` はmain `3f5f9903713a948ccc5e60143281b8437e6c4a25` を基に、固定した保持受入経路の実装、ローカル/統合テスト、draft PRと通常CIまでを対象とする。一般PRの任意テスト実行や新しい任意操作へ設計を拡張しない。既存PR #75の旧HEAD/コード・Deployment・専用DBに変更を加えず、実dispatch、明細登録、文書commit/push、更新deploy、実QA/保持確認、Ready、main merge、cleanupは行わない。ここでいう文書commit/push未実施は受入PR #75を指し、この実装PR自身のcommit/pushと通常CIは含まない。

受入の初回配置予算2/2、同DB更新0/1は保持する。ローカルのスタブ/統合テストや通常CIの成功を、実環境での登録・更新・保持・OIDC/UI QAの成功として扱わない。機能のmain導入は既存Production Git連携のdeployを起動し得るため別途承認を得る。導入後も実資源受入の対象/影響を照合して承認範囲だけで進め、cleanup・本番/親DB/他作業・認証やnetwork/security設定の変更を含めない。

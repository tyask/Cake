# 開発・QA運用手順

CakeはCanneleを使用せず、PR単位のVercel Preview固有URLでQAする。開発停止中に一括切替し、旧貸出・台帳・検証証拠は移さない。旧方式への自動fallbackは設けない。コード導入、外部設定、実環境受入の完了はそれぞれ区別する。

## 構成と権限

`preview.config.json`にrepository、Vercel project/team、Neon Preview project・親branch、本番endpointのSHA-256と`receiptTransport: "github-actions-notice/v1"`を固定する。現行対象はGitHub `tyask/Cake`、Vercel `fumin1/cake`、Neon Preview project `misty-meadow-88903426`。provider protocol `cake-preview/v1`とDB marker version 2は変更しない。本番の接続情報をPreviewへ渡さない。

Cloud/PCのコマンドはmainの `.github/workflows/preview.yml` を明示的にdispatchし、同じPRの操作をActionsのconcurrencyで直列化する。main上のスクリプトだけがprovider管理資格情報を使う。`pull_request_target` はclosedイベントだけで、PRコードをcheckout・実行しない。Vercelは指定したGitSourceのコードを、Preview DBの権限でリモートビルドする。

Actionsには既存のRepository secrets `VERCEL_TOKEN` と `NEON_API_KEY` が必要。GitHub読取は最小権限の `github.token` を使う。Cannele用Secret名を暗黙に代用しない。設定不足なら両Secret名を資格情報の値なしで報告し、providerの読取・作成・削除を始める前に停止する。新規資格情報・DB・deploymentを代わりに作らない。旧Cannele名のSecretだけでは使えないため、既存資格情報をGitHub Repository Settings → Secrets and variables → Actionsでこの2名に登録する。値をチャットへ送らない。

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

Aはテスト管理者・共有OWNER、Bは一般・MEMBER。Productionのテストログインは禁止。本番buildは従来どおりbuild成功後にmigrationを行い、失敗時は公開を止める。既存のアプリmigrationは変更しない。

## 実ブラウザ検証とReady

```bash
npm run qa:verify
npm run task:pr -- --title '変更内容' --verification-file /path/report.md
```

検証前後にActionsで現在HEAD・READY Deployment・DBを再照合する。固有URLのみを使い、任意URLやbranch aliasは受け付けない。PC/mobileでA/Bログイン、ダッシュボード、取引明細・設定・ホームの実クリック、session/app GETとruntime proofを確認する。読取スモークは認証callback以外の書込を送らない。変更箇所固有のテスト結果は報告書へ別途記載する。

Vercel保護には同一project/team・development環境・期限内のOIDCを対象originだけへ付与する。既存 `VERCEL_OIDC_TOKEN` を優先し、なければ既存 `VERCEL_TOKEN` で同projectのdevelopment env取得APIからメモリ内へ取り込む。ユーザー照会の成功をproject単位操作の前提にしない。保護設定を弱めず、secretを新規発行しない。token・Cookie・生のprovider/browser例外をログ・artifact・スクリーンショットへ出さない。

Cloudでは実効policyの `*.vercel.app` と提供CAを確認する。ChromiumはLinuxのNSS信頼ストアを利用する。Cloud提供の `NODE_EXTRA_CA_CERTS` の証明書と既存NSS登録を照合し、未登録なら提供CAを標準の `certutil -A -d sql:<NSS DB> -t 'C,,' -i <Cloud CA>` で登録する。NSS DBにはSQLiteが必要とするアクセス権が必要。検証用ブラウザは一時プロファイルを使い、セッションは終了時に破棄する。必要なら `CAKE_BROWSER_EXECUTABLE=/usr/bin/chromium` を指定する。`ignoreHTTPSErrors`、証明書無視フラグ、TLS検証無効化、`route.fetch`による画面通信の代替は使わない。

`.cake/verification.json` に対象commit・Deployment・DB・case・クリック時刻・成否を記録し、画面画像も `.cake/` に保存する。失敗時は以前の成功証拠を無効にする。Readyには現在HEADのpush/PR CIの最新attempt成功と一致する検証証拠が必要。古い成功runで新しい失敗を隠さない。PR更新後にもHEADを再照合してdraftを解除し、mergeは利用者が行う。

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

今回の`codex/notice-receipts`はローカル検証と実装draft PR作成までを対象とし、実資源を使う受入は未実施。PR段階の新CLIはtransport設定がない旧mainのdeploy/status/cleanupをdispatch前に拒否する。provider workflowもmain限定なので、非main branchへdispatchして正式receiptを検証した扱いにしない。main導入後は本実装PRがclosedになるため、受入には別のOPEN試験PR/branchが必要。試験PR番号は未発行であり、今回は作成しない。main導入と実機試験は別途承認の対象とし、導入後に最新workflowと試験PR/HEADを確認して、次の対象・影響の承認が揃ってから実機受入を行う。

1. Vercel `fumin1/cake` とNeon Preview project `misty-meadow-88903426`（親branch `br-lively-frog-b3y2mauu`）で別のOPEN試験PRの初回Previewを作る。branch例は`codex/notice-receipt-acceptance`、Native branch候補は`preview/codex/notice-receipt-acceptance`。実行前にPR番号、完全HEAD、configのproject/親branch bindingを改めて提示する。初回はprovisioningとapplicationの最大2 Deployment、専用DB branch/read-write endpointの生成と初回migration/seedを予定する。生成されたID・世代を記録し、別PR・本番・旧資源には触れない。
2. 正式receiptを既存Cloud gh認証で受領し、`qa:status`とPC/mobile A/Bの`qa:verify`を確認する。同じ試験PRの追加commitを配置し、Native branch/endpoint・DB世代と入力済みデータが保持されることを確認する。追加配置と検証に伴う書込も承認範囲を確認する。
3. cleanupは対象Deployment ID・Neon branch/endpointと削除影響を改めて提示し、承認後にだけPRをclose/merge、またはclosed PRへ明示cleanupを実行する。削除後の全対象不在を直接GETで確認する。cleanupの承認前にPRを閉じない。

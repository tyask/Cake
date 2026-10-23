# 本番DBのmajor version更新と接続先切替

本番DBの移行は明示的に依頼された範囲で実施する。Neonのmajor version更新は、新しいversionのprojectを作成し、データ移行・検証後に接続先を切り替える。既存projectのversion変更や `pg_upgrade` は使わない。[Neon公式手順](https://neon.com/docs/postgresql/postgres-upgrade)を確認する。

## 実行経路と対象の固定

- 元本番、新本番候補、既存Previewをproject・branch・endpoint・database・roleで区別する。providerの一覧と直接GET、poolerを除いたhostのSHA-256を照合し、実行直前に対象を再確認する。
- 本番の手動操作は既存本人認証のprovider連携、Console、または承認された信頼済み実行環境で行う。通常のPR Preview・常設Preview管理は引き続き信頼済みmainのActionsを使い、本番IDをPreview用コマンドへ渡さない。
- 本番接続文字列、provider token、Cookieをチャット・引数・ログ・Git・環境ファイル・artifactへ出さず、WSLへコピーしない。SQL連携ではserver側で資格情報を解決する。dump/restoreは資格情報とデータを外へ公開しない実行経路を先に確保する。
- 旧本番projectとDBは保持する。既存Previewのproject・親branch・所有権marker・generation・テストデータを移行先に流用しない。
- DB版の要件を使うmigrationの導入前に、本番・Preview双方の実版とencodingを確認する。`SHOW server_version` の値やproviderのmajor版を、別projectの検証結果から推定しない。

接続先を識別できない、応答不明、復元経路がない場合はデータコピーを始めない。最終同期・切替は、切替中に通常利用・Googleログイン・Cron・旧Deployment・外部接続から本番DBへアクセスが来ないという利用者の前提で実行する。DB側の強制遮断、role・CONNECT権限の変更、管理用DBの追加は行わない。この前提は停止機構による実証とは区別し、元データのsnapshot照合を省略しない。

## Previewからの本番分離

`preview.config.json` の `productionHostDigest` は現用本番、`productionHostDigests` は現用・移行候補・保持旧DBを含むPreview禁止集合である。すべてpoolerを除いたendpoint hostのSHA-256を用い、接続文字列は設定しない。

新本番候補のhostを確定したら禁止集合へ追加する。現用値の切替後も、保持する旧DBのhostは集合へ残す。集合を縮めたり、注入値を任意の64桁hexとして受理したりして移行を通さない。準備用buildは、対象コードの禁止集合に厳密に含まれる注入値だけを受理し、DB接続前のguardはコード側の集合全件と環境側の本番値を拒否する。

管理CLIの設定と最新mainの設定の完全一致、Nativeの親・所属・世代・marker、正式receiptの照合は維持する。設定を変えるPRのReady管理には、最新mainのcleanなcontrolと `task:pr --remote-proof ... --target-worktree ...` を使う。管理資格情報付きで対象PRのCLIを実行しない。変更箇所の回帰・自己レビュー・別Agentレビュー、現在HEADのCI・正式Preview・ブラウザ証拠を揃える。

## リハーサル

1. 元本番をread-only transactionで棚卸しする。実版・encoding・DB容量・適用台帳・extension・locale/collation・関数・Trigger・制約・Index・owner/ACLと、外部writer・Cron・接続roleを確認する。SQL本文や業務行は公開せず、比較には件数・属性・hashを使う。
2. 同じregionに本番専用の新projectを作成する。必要なcompute・保護・復旧期間・network設定・権限を照合し、PG18以上・UTF8・`pg_catalog.pg_unicode_fast` を確認する。空候補への初回コピーと、019適用済み候補を更新する最終同期を別の操作として扱う。
3. 元の一貫したsnapshotを複製する。dumpと比較用inventoryは同じsnapshotを使う。`pg_dump` / `pg_restore` は移行先major版のものとdirect接続を使う。Import Data Assistantを使う場合は、画面の互換性検査で対象version・容量・extensionの対応を確認してから開始する。別versionへのbranch作成だけで移行できるとは扱わない。
4. 復元先で元の全表・全既存列、適用台帳とschema・権限を比較する。件数だけの一致で完了にしない。019適用前後は、追加する関数・生成列・Index・台帳以外のデータが変わらないことを確認する。適用済みmigration原文を変更せず、Productionでテストseedを実行しない。
5. 本番と同じ認証設定・runtime roleを使うProduction候補で、未認証ログイン画面・sessionとGoogle認証だけが提供されることを確認する。本人のGoogleログインと実機Safari・必要な業務操作は、切替後の利用者確認として別に扱う。実データを更新する検証は承認された範囲で行い、識別可能なfixtureを後片付けする。ProductionへA/B test-loginを有効化しない。
6. 最終同期と失敗回復の条件、切替中に本番DBアクセスが来ない前提を確認し、復元時間とmigration時間から作業時間を見積もる。強制停止機構の検証や本人Google QAを、このDBリハーサルの実施結果として扱わない。

019は `transactions` のACCESS EXCLUSIVEロック・STORED生成列計算・Index作成を伴う。リハーサルでの処理時間を最終実行時間と混同せず、本番では実時間と件数を別に記録する。

### Actionsによる対象固定のコピー

`.github/workflows/production-db-migration.yml` は `production-migration.config.json` に固定したsourceと未接続targetだけを扱う。レビュー済みmainへ導入後、`workflow_dispatch` の `action` に `inventory` または `rehearsal`、`controlSha` に現在mainの完全SHA、`operation` に新しいUUIDを指定する。任意のSQL・project・branch・接続文字列は入力しない。通常のPreview管理workflowへ本番IDを渡さない。

移行専用のActions Secret `PRODUCTION_DB_SOURCE_NEON_API_KEY` と `PRODUCTION_DB_TARGET_NEON_API_KEY`、既存の `VERCEL_TOKEN` を使う。Neonの各キーはsource/targetそれぞれのproject-scopedキーとし、workflowは実行stepだけへ `NEON_SOURCE_API_KEY` / `NEON_TARGET_API_KEY` として渡す。固定projectと許可されたAPI経路に応じて対応するキーを選び、不明なproject/経路や正規化で対象が変わるpathは呼出し前に拒否する。キー不足・改行・同一値の重複設定もprovider呼出し前に停止する。Preview用 `NEON_API_KEY` は移行に渡さず、fallbackにも使わない。

最初に `inventory` で両projectへのアクセスと実対象を確認する。Secretの存在や値の違いだけをscope・アクセス成功の証明とは扱わない。`rehearsal` は空の候補へ一度コピーする操作であり、既存データへの上書き、migration、seed、本番の停止・接続先切替・削除は行わない。`rehearsal` のActions rerunは拒否する。

#### 移行専用キーの登録

既存キーとの対応が不明な場合も、現在のPreview用Secretを変更せず、移行専用の対応を記録する。[Neon公式のAPIキー手順](https://neon.com/docs/manage/api-keys)に従い、対象Organizationの **Settings > API keys > Create new > Project-scoped** でそれぞれ作成する。project-scopedキーの作成にはOrganizationのAdmin権限が必要である。

| 用途 | Scopeに選ぶproject | Neonキー名の例 | GitHub Actionsのrepository Secret名 |
| --- | --- | --- | --- |
| 元本番 | `cake` / `shy-wave-07435387` | `cake-production-migration-source` | `PRODUCTION_DB_SOURCE_NEON_API_KEY` |
| PG18候補 | `cake-production-pg18` / `noisy-wind-66979379` | `cake-production-migration-target` | `PRODUCTION_DB_TARGET_NEON_API_KEY` |

対象IDの正本は `production-migration.config.json` とし、Consoleの名前だけで選ばない。GitHubの対象repositoryで **Settings > Secrets and variables > Actions > New repository secret** を開き、表示された新しいキー値を対応するSecretへ直接登録する。キー値は作成時だけ表示されるため、その場で本人が登録し、チャット・コマンド引数・WSL・環境ファイル・artifactへ渡さない。キーID/名前・project ID・Secret名の非秘密の対応を記録する。操作ができない場合は対象Organization/repositoryの権限を確認する。

キーのscopeはConsoleでの対象指定を確認し、Actionsでのアクセス成功はレビュー済みmainの `inventory` で別に確認する。新規キーの作成・Secret登録だけでコピーを開始せず、正式receiptの成功を確認してから `rehearsal` へ進む。移行完了後の専用キー失効・Secret削除は、依存する実行がなくなったことを確認して別に判断する。

sourceでは一貫したread-only snapshotを維持し、dumpと照合値を同じsnapshotから取得する。targetは復元直前にも未接続・空状態とprovider所属を確認する。PG18クライアントと証明書検証を使い、資格情報はrunnerのメモリと限定した子プロセス環境、一時dump/復元SQLは非公開の一時ファイルだけで扱う。raw SQL・業務行・接続文字列をログやartifactへ保存しない。

結果は `cake-production-db-migration/v1` のnoticeで受け取り、run/attempt・完全SHA・operation・config hash・source/target project・時刻・処理段階・件数/hash・成否・一時ファイル除去を照合する。run成功だけではコピー成功としない。noticeの欠落・重複・不一致・応答不明なら状態をread-onlyで確認し、再dispatchやtarget削除で解消しない。コピー後の候補が不一致なら保持して調査し、最終切替へ進まない。

DB接続前の失敗は、main・source/targetのprovider所属・Native接続数・接続情報取得・SQL接続のどこで止まったかを `stage` で区別する。providerの読取失敗は固定したprovider名とHTTP status、通信失敗、JSON解析失敗を `code` に記録する。401/403は認証・scopeの確認対象であり、404だけで資源の不在や権限不足を断定しない。応答本文・URL・生例外・資格情報は公開せず、記録した段階と対象を確認してから修正する。

### Actionsによるコピー候補のschema QA

`.github/workflows/production-db-schema-qa.yml` と `scripts/production-db-schema-qa.ts` は、コピー済みの未接続PG18候補へ019を一度だけ適用して検証する。レビュー済みmainへ導入後、`workflow_dispatch` に現在mainの完全SHAを `controlSha`、新しいUUIDを `operation` として指定する。入力はこの2項目だけとし、Actions rerun、任意SQL・URL・DB指定は受け付けない。対象の正本はコピーと同じ `production-migration.config.json` であり、元本番のDDL・書込停止・最終同期・Production切替・本人Google QA・旧DB削除はこのworkflowに含めない。

実行前後にsource/targetのprovider所属と固定ID、targetのNative project接続0件を照合する。DB接続文字列はtargetだけ取得し、独立した3つの実PG sessionをtargetへ接続する。source DBには接続しない。移行専用のNeon Secret、既存の `VERCEL_TOKEN`、読取用 `GH_TOKEN` は実行stepだけへ渡し、notice公開stepには渡さない。接続文字列とデータはrunnerのメモリ内だけで扱い、raw SQL・秘密値・業務行・artifactを公開しない。PreviewのA/B認証・所有権marker・本番host分離を緩めて流用しない。

実行条件と確認内容は次のとおりとする。

1. コピー済みの13表と001〜018の適用台帳、PG18・UTF8・`pg_catalog.pg_unicode_fast`、019未適用を確認する。適用前の全既存列・件数・hash、schema・owner/ACL、旧台帳の適用時刻を記録し、比較元とする。
2. 既存の取引先正規化migration helperを使い、所有権を確認できる新規scratch schema内で019の原文を検証する。生成値の計算、SQLSTATE `22012` によるDDL全体のrollback、別sessionのUPDATE待機を確認する。scratchのschema・table・function・Indexの残存0件とsession設定の復元を確認してからpublicへ進む。
3. 実際の `setupDatabase` を2 sessionで実行し、両方が018までの同じ台帳を読み終えてから019へ進める。監視sessionの `SHARE` table lockの下で、一方の `ACCESS EXCLUSIVE` 待機と他方のmigration advisory lock待機を実PIDで観測する。監視lockを解放した後、両実行の成功と019台帳が1行だけであることを確認する。
4. 全13表の既存全列・件数・hashと旧台帳の適用時刻、既存schema・owner/ACLの保持を照合する。差分は019の関数・STORED生成列・Index・台帳1行だけを許可し、生成式・関数属性・Index属性と正規化不一致0件を確認する。019適用後は新しい列を含むコピー時の全文一致を使わず、適用前の既存列projectionで比較する。
5. `setupDatabase` を再実行し、本文0読込・2往復とデータ・全台帳適用時刻の不変を確認する。provider所属と未接続状態を再照合し、scratch残存とsession設定の復元を報告する。

結果は専用protocol `cake-production-db-schema-qa/v1` の標準noticeを1件、4,096 UTF-8 bytes以下で受け取る。公開するのはrun/初回attempt・main完全SHA・operation・config hash・target ID・時刻・stage・固定code/SQLSTATE・合否・件数/hash・実PIDと待機観測・cleanup/session設定復元の結果だけとする。workflow/run/job/CheckRun/CheckSuite/repository/GitHub Actions appのmetadataとreceiptの来歴・要求・時刻を照合し、run成功だけで検証成功としない。欠落・重複・不一致・失敗・応答不明ではtargetを保持して停止し、盲目的な再実行・reset・削除を行わない。019適用済みの候補へ再dispatchして検証をやり直さない。

終了後は同じ完全SHAのcleanなcontrol checkoutで、次の読取専用CLIを実行する。これはdispatchやDB接続を行わず、標準noticeとGitHubのmetadataを前後で照合して `.cake/production-schema-qa-<run ID>-receipt.json` へ保存する。成功は終了code 0、出所を照合できた失敗receiptは2、証拠不備は1として区別する。

```bash
node --import tsx scripts/production-db-schema-qa-proof.ts <run ID> <controlSha> <operation UUID>
```

この結果は候補のDB schema QAであり、実データの最終同期・Production候補の画面/API・本人Google認証・切替の証拠とは区別する。実行結果と残る資源はPR本文・Git外の検証報告へ記録する。

### Cakeのデータとprovider管理情報

Cakeの認証はAuth.jsのGoogleログインとJWTを使い、利用者情報は `public.app_users` に保存する。Native projectに `neon_auth` がある場合も、未使用とは推定せず、両側のaccount・invitation・member・organization・session・user・verificationが0件であることを確認する。既知の管理9表だけが存在し、publicからの外部キー・関数・policy等の依存がなく、外部からもNeon Authを利用していない場合に限り、Cakeのpublicを移送対象にできる。利用データや未知の依存があれば停止し、Authを含めた移行方法を別に確認する。

この場合も `neon_auth.jwks` と `neon_auth.project_config` の内容は取得・複製せず、元projectの管理情報と新projectの新しい管理情報をそれぞれ保持する。Authの別projectへの移送を実証したとは報告しない。管理表のschemaと利用表0件は復元後にも照合する。

public限定dumpはschema外の依存を自動では含めない。pgcryptoを明示的に含め、sourceの版がtargetで利用可能であることを確認して同じ版を復元する。targetの既存publicは削除せず、owner一致を確認してCREATE SCHEMAだけを除く。Cakeの列・表・関数のowner/ACLを保持し、既定権限やextension内の権限変更も確認する。

`cloud_admin` が管理するpublicの既定ACLは通常のCake権限と分ける。対応する既知の定義だけを厳密に確認し、target側のprovider設定を保持して復元前後の不変を照合する。PostgreSQL版によるprovider既定値の差を、Cakeの権限コピーの成功として混同しない。

## 最終同期から公開まで

### 実行の承認範囲

`.github/workflows/production-db-cutover.yml` と `scripts/production-db-cutover.ts` は、本番PG17から019適用済みPG18候補への最終同期、Vercel NativeのProduction接続変更、Production候補のbuildと公開aliasの切替を扱う。**候補の既存publicデータの上書きと、本番の接続先・公開先の変更を伴う。** 実装PRをReadyにすること、リハーサルやschema QAに成功することだけでは実行しない。対象・上書き内容・Native接続とaliasへの作用・保持資源を記載した具体的なPRについて、利用者から実行の明示承認を得た後に、レビュー済みmainの完全SHAを固定して実行する。

切替中に本番DBアクセスが来ないことを利用者の前提とし、強制fence・session終了・role変更・CONNECT変更・maintenance modeの導入は行わない。通常POSTに加え、Googleログインのプロフィール更新、workspace 0件時の認証済みHome/`GET /api/app`、Cron、旧Deploymentの固有URL、開始済み処理、外部接続もこの前提の対象となる。予定外の更新や前提の不成立を検出した場合は処理を止め、接続設定や権限の変更で自動的に解消しない。

### Actionsによる最終同期と接続切替

workflowの入力は `controlSha` と新しい `operation` UUIDの2項目だけとする。source/targetのproject・branch・endpoint・database・role、Nativeのproject/team/storeは固定設定で照合し、任意SQL・接続文字列・接続先を入力しない。mainの完全SHAとの一致と初回attemptを確認し、Actions rerunを受け付けない。初回の空候補への `rehearsal`、019未適用候補へのschema QAとは別の経路である。

1. providerの直接GETと一覧でsourceとPG18候補の所属・候補の未接続状態を照合する。sourceがPG17・UTF8・001〜018の台帳、targetがPG18・UTF8・13表・019適用済みの既知の構造であることをread-only transactionで確認する。旧本番と既存の復旧用branch `br-withered-flower-a1hpafzu` を保持し、providerの新規branchや復旧snapshotは作成しない。既存の候補データを最終snapshotで上書きする範囲を、実行承認に含める。
2. sourceのrepeatable-read/read-only transactionがexportした同一snapshotから、全既存列の件数/hash・catalog・owner/ACL・台帳と、PG18クライアントによるdumpを取得する。Authの利用表0件、既知の管理構造・権限とprovider既定ACLも照合する。dump・復元SQLはActions runner内の非公開一時ファイルだけに保持する。
3. targetを再照合し、`psql --single-transaction` と `ON_ERROR_STOP` の下で最終snapshotへ置換する。既知の019生成列・関数だけを除去し、001〜018のpublicを `pg_restore --clean --if-exists` の出力から復元した後、原文の019と台帳を同じTransactionで適用する。`DROP SCHEMA`・`CASCADE`・branch resetは使わない。pgcrypto・public schema・`cloud_admin` の既定ACL・`neon_auth` は復元対象から除外して各project側のものを保持する。
4. targetの全既存列projectionの件数/hash、catalog・owner/ACL、旧台帳の適用時刻をsource snapshotと照合する。019による生成列・関数・Index・台帳1行だけを追加差分として確認し、Auth・provider既定ACLの不変も確認する。sourceを新しいread-only snapshotでも取得し、コピー時との一致を確認する。更新があればNative接続切替へ進まない。
5. Vercel Nativeの**Production scopeだけ**を旧storeから新storeへ切り替える。旧Production接続と他scopeの保持を照合し、切替前後のdefault Productionおよびmain branchの実効`DATABASE_URL`が固定source/targetのendpoint・database・roleを指すことと、許可した接続parameterだけであることをActionsのメモリ内で確認する。Previewの `CAKE_TEST_DATABASE_URL` や常設/PR PreviewのDBは変更しない。旧storeの接続解除は資源削除と区別する。
6. 開始時の公開先はcanonical aliasが実際に配信するREADYなDeploymentを基準にし、projectの`targets.production`が直近の失敗Deploymentを指す場合も、配信先とは区別する。project/team/repositoryと配信先の所属・READY、全Production domainの変化を照合する。固定したmain完全SHAから `autoAssignCustomDomains: false` のProduction候補を作り、build成功、候補に取り込まれた解決済み環境snapshot（`buildEnv`、runtime `env`にも値がある場合は併せて確認）の実効`DATABASE_URL`とNative接続を照合する。接続先はpooler hostをdirect hostへ正規化して固定targetと比較し、A/B認証やPreview用設定の混入も拒否する。作成直前・公開直前・完了時に再照合する。既存Deploymentの環境値が後から変わるとは扱わない。OIDCは同project/team・development・有効期限を確認し、通常TLSを維持して対象originに限定したGETで未認証ログイン画面・sessionとGoogle認証だけが提供されることを確認する。A/B test-loginはProductionで有効化せず、GoogleのcallbackによるDB更新はこのprobeで実行しない。
7. 照合済み候補をpromoteし、正式Production aliasの配信先・完全SHA・Native Production接続先を再照合する。全SQL sessionの終了と一時ファイルの除去を確認して完了とする。公開完了はcanonicalとproviderがProduction用として返す全domainの一致を意味する。既知のgenerated/legacy aliasがProduction用domainに含まれず旧Deploymentへ残る場合は、`knownAliasesCurrent: false`と各配信先IDを記録し、旧Deployment・旧DBへの到達経路として保持資源に明記する。本人Googleログイン、画面・API・必要な業務操作、実機Safari、DBエラー・定期支払いは切替後の利用者確認として区別し、未実施ならそのまま報告する。

接続文字列とprovider資格情報は信頼済みmainのActions実行stepでメモリ内だけに扱い、PG子プロセスの環境を限定する。既存の移行専用project-scoped Neonキー、`VERCEL_TOKEN`、読取用GitHub資格情報を使用し、WSL・ログ・Git・環境ファイル・artifactへ秘密値や業務行を出さない。正式PreviewのreceiptやA/Bブラウザ証拠を、本番移行の証拠へ流用しない。

結果は専用protocol `cake-production-db-cutover/v1` の標準noticeで受け取る。run/初回attempt・control SHA・operation・固定対象・時刻・各段階の成否、コピー比較、Deployment・Native接続・alias、全SQL session終了と一時ファイル除去を照合し、run成功だけで切替成功としない。利用者の無アクセス前提は `accessAssumption: no-production-db-access` として記録し、DB停止の実証に置き換えない。receiptの欠落・重複・不一致、失敗・応答不明では、候補・旧DB・復旧用branchを保持して停止する。上書き後や接続変更後の状態を確認せず、再dispatch・rollback・reset・削除を繰り返さない。

終了後は同じ完全SHAのcleanなcontrol checkoutで次の読取専用CLIを実行する。dispatch・DB接続・provider変更を行わず、workflow/run/job/CheckRun/CheckSuite/repository/GitHub Actions appの来歴と標準noticeを前後照合し、`.cake/production-cutover-<run ID>-receipt.json` へ保存する。成功は終了code 0、出所を照合できた失敗receiptは2、証拠不備は1として区別する。

```bash
node --import tsx scripts/production-db-cutover-proof.ts <run ID> <controlSha> <operation UUID>
```

## 切戻しと記録

新DBへ書込みが一件もない段階は、対象と現在の状態を照合したうえで、承認された復旧範囲で接続設定とaliasを旧系へ戻せる。Googleログインのプロフィール更新や初期workspace作成も新DBへの書込みに含める。強制停止やrole・CONNECT権限の変更は行わないため、その解除操作はない。

新DBへの書込み開始後は、旧Deploymentへのrollbackだけでは最新データを保持できない。新系の書込みを再停止し、追加データの保持・同期を含む復旧方法を決める。DBの逆major移行や単純な接続先変更を、検証せずに実行しない。

実行結果はGit外の報告とPR本文に日本語で記録する。完全SHA・実版・各resource ID・snapshot・所要時間・件数・比較結果・最初の新DB書込・成功/失敗/未実施・残る資源を分ける。本番DBアクセスが来ないという利用者の前提、未認証probeと本人Google/実機Safari QAの実施範囲も区別する。業務行や秘密値は記録しない。旧本番と復旧用branchの廃棄は保持期間と復旧確認を踏まえて別に判断する。

## 参照

- [Neon major version更新](https://neon.com/docs/postgresql/postgres-upgrade)
- [Neon Import Data Assistant](https://neon.com/docs/import/import-data-assistant)
- [Neon Authの構成](https://neon.com/docs/auth/about)
- [PostgreSQL 18 pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)
- [PostgreSQL 18 pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html)
- [Vercel Native連携](https://neon.com/docs/guides/vercel-managed-integration)
- [Vercel環境変数](https://vercel.com/docs/environment-variables)
- [Production公開を遅らせるdeploy](https://vercel.com/docs/cli/deploy#skip-domain)
- [Vercel Instant Rollback](https://vercel.com/docs/instant-rollback)

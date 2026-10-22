# 本番DBのmajor version更新と接続先切替

本番DBの移行は明示的に依頼された範囲で実施する。Neonのmajor version更新は、新しいversionのprojectを作成し、データ移行・検証後に接続先を切り替える。既存projectのversion変更や `pg_upgrade` は使わない。[Neon公式手順](https://neon.com/docs/postgresql/postgres-upgrade)を確認する。

## 実行経路と対象の固定

- 元本番、新本番候補、既存Previewをproject・branch・endpoint・database・roleで区別する。providerの一覧と直接GET、poolerを除いたhostのSHA-256を照合し、実行直前に対象を再確認する。
- 本番の手動操作は既存本人認証のprovider連携、Console、または承認された信頼済み実行環境で行う。通常のPR Preview・常設Preview管理は引き続き信頼済みmainのActionsを使い、本番IDをPreview用コマンドへ渡さない。
- 本番接続文字列、provider token、Cookieをチャット・引数・ログ・Git・環境ファイル・artifactへ出さず、WSLへコピーしない。SQL連携ではserver側で資格情報を解決する。dump/restoreは資格情報とデータを外へ公開しない実行経路を先に確保する。
- 旧本番projectとDBは保持する。既存Previewのproject・親branch・所有権marker・generation・テストデータを移行先に流用しない。
- DB版の要件を使うmigrationの導入前に、本番・Preview双方の実版とencodingを確認する。`SHOW server_version` の値やproviderのmajor版を、別projectの検証結果から推定しない。

接続先を識別できない、応答不明、復元経路がない場合はデータコピーを始めない。書込停止を実証できなければ、最終コピー・本番切替へ進まない。

## Previewからの本番分離

`preview.config.json` の `productionHostDigest` は現用本番、`productionHostDigests` は現用・移行候補・保持旧DBを含むPreview禁止集合である。すべてpoolerを除いたendpoint hostのSHA-256を用い、接続文字列は設定しない。

新本番候補のhostを確定したら禁止集合へ追加する。現用値の切替後も、保持する旧DBのhostは集合へ残す。集合を縮めたり、注入値を任意の64桁hexとして受理したりして移行を通さない。準備用buildは、対象コードの禁止集合に厳密に含まれる注入値だけを受理し、DB接続前のguardはコード側の集合全件と環境側の本番値を拒否する。

管理CLIの設定と最新mainの設定の完全一致、Nativeの親・所属・世代・marker、正式receiptの照合は維持する。設定を変えるPRのReady管理には、最新mainのcleanなcontrolと `task:pr --remote-proof ... --target-worktree ...` を使う。管理資格情報付きで対象PRのCLIを実行しない。変更箇所の回帰・自己レビュー・別Agentレビュー、現在HEADのCI・正式Preview・ブラウザ証拠を揃える。

## リハーサル

1. 元本番をread-only transactionで棚卸しする。実版・encoding・DB容量・適用台帳・extension・locale/collation・関数・Trigger・制約・Index・owner/ACLと、外部writer・Cron・接続roleを確認する。SQL本文や業務行は公開せず、比較には件数・属性・hashを使う。
2. 同じregionに本番専用の新projectを作成する。必要なcompute・保護・復旧期間・network設定・権限を照合し、PG18以上・UTF8・`pg_catalog.pg_unicode_fast` を確認する。リハーサル先と最終公開先を区別する。
3. 元の一貫したsnapshotを複製する。dumpと比較用inventoryは同じsnapshotを使う。`pg_dump` / `pg_restore` は移行先major版のものとdirect接続を使う。Import Data Assistantを使う場合は、画面の互換性検査で対象version・容量・extensionの対応を確認してから開始する。別versionへのbranch作成だけで移行できるとは扱わない。
4. 復元先で元の全表・全既存列、適用台帳とschema・権限を比較する。件数だけの一致で完了にしない。019適用前後は、追加する関数・生成列・Index・台帳以外のデータが変わらないことを確認する。適用済みmigration原文を変更せず、Productionでテストseedを実行しない。
5. 本番と同じ認証設定・runtime roleを使う非公開のProduction候補で、旧版/新版互換性と画面・API・必要な業務操作を検証する。実データを使う検証は承認されたcopy内だけで行い、識別可能なfixtureを後片付けする。ProductionへA/B test-loginを有効化せず、本人のGoogle認証を使う。
6. 書込停止・接続排出・解除・失敗回復を同じrole構成で試し、復元時間とmigration時間から停止時間を見積もる。必要な本人QAや停止能力を確認できなければ本番切替へ進まない。

019は `transactions` のACCESS EXCLUSIVEロック・STORED生成列計算・Index作成を伴う。リハーサルでの処理時間を最終実行時間と混同せず、本番では実時間と件数を別に記録する。

### Actionsによる対象固定のコピー

`.github/workflows/production-db-migration.yml` は `production-migration.config.json` に固定したsourceと未接続targetだけを扱う。レビュー済みmainへ導入後、`workflow_dispatch` の `action` に `inventory` または `rehearsal`、`controlSha` に現在mainの完全SHA、`operation` に新しいUUIDを指定する。任意のSQL・project・branch・接続文字列は入力しない。通常のPreview管理workflowへ本番IDを渡さない。

既存のActions Secret `NEON_API_KEY` と `VERCEL_TOKEN` を使い、最初に `inventory` で両projectへの権限と実対象を確認する。Secretの存在だけをアクセス成功とは扱わない。`rehearsal` は空の候補へ一度コピーする操作であり、既存データへの上書き、migration、seed、本番の停止・接続先切替・削除は行わない。`rehearsal` のActions rerunは拒否する。

sourceでは一貫したread-only snapshotを維持し、dumpと照合値を同じsnapshotから取得する。targetは復元直前にも未接続・空状態とprovider所属を確認する。PG18クライアントと証明書検証を使い、資格情報はrunnerのメモリと限定した子プロセス環境、一時dump/復元SQLは非公開の一時ファイルだけで扱う。raw SQL・業務行・接続文字列をログやartifactへ保存しない。

結果は `cake-production-db-migration/v1` のnoticeで受け取り、run/attempt・完全SHA・operation・config hash・source/target project・時刻・処理段階・件数/hash・成否・一時ファイル除去を照合する。run成功だけではコピー成功としない。noticeの欠落・重複・不一致・応答不明なら状態をread-onlyで確認し、再dispatchやtarget削除で解消しない。コピー後の候補が不一致なら保持して調査し、最終切替へ進まない。

### Cakeのデータとprovider管理情報

Cakeの認証はAuth.jsのGoogleログインとJWTを使い、利用者情報は `public.app_users` に保存する。Native projectに `neon_auth` がある場合も、未使用とは推定せず、両側のaccount・invitation・member・organization・session・user・verificationが0件であることを確認する。既知の管理9表だけが存在し、publicからの外部キー・関数・policy等の依存がなく、外部からもNeon Authを利用していない場合に限り、Cakeのpublicを移送対象にできる。利用データや未知の依存があれば停止し、Authを含めた移行方法を別に確認する。

この場合も `neon_auth.jwks` と `neon_auth.project_config` の内容は取得・複製せず、元projectの管理情報と新projectの新しい管理情報をそれぞれ保持する。Authの別projectへの移送を実証したとは報告しない。管理表のschemaと利用表0件は復元後にも照合する。

public限定dumpはschema外の依存を自動では含めない。pgcryptoを明示的に含め、sourceの版がtargetで利用可能であることを確認して同じ版を復元する。targetの既存publicは削除せず、owner一致を確認してCREATE SCHEMAだけを除く。Cakeの列・表・関数のowner/ACLを保持し、既定権限やextension内の権限変更も確認する。

`cloud_admin` が管理するpublicの既定ACLは通常のCake権限と分ける。対応する既知の定義だけを厳密に確認し、target側のprovider設定を保持して復元前後の不変を照合する。PostgreSQL版によるprovider既定値の差を、Cakeの権限コピーの成功として混同しない。

## 更新停止から公開まで

1. 許容停止時間・再開責任者・切戻し条件を決め、対象のmain merge/deployと外部writerを止める。通常POSTの遮断だけでは足りない。Googleログインのプロフィール更新、workspaceがない利用者の認証済みGET、Cron、旧Deploymentの固有URL、開始済み処理を含めて書込みを停止する。
2. 全runtime writerの再接続を遮断し、既存sessionと進行中transactionを排出する。接続設定の変更だけで既存sessionが止まるとは扱わない。独立sessionで停止を実証し、writer・未確定transaction・prepared transactionの残存を確認する。停止を保証できなければ最終コピーを始めない。
3. 停止後の元をバックアップし、確定した空の最終targetへ復元する。リハーサルで変更したDBへ差分上書きして代用しない。元の静止snapshotとtargetの全既存列・schema・権限を照合し、同じmigrationを適用・再確認する。
4. Vercel Nativeの接続を**Production scopeだけ**新本番へ切り替える。変数名の重複・古いbranch override・自動再deployの有無を確認する。旧資源の接続解除と削除は区別し、Preview用の `CAKE_TEST_DATABASE_URL` は変更しない。
5. 固定した完全SHAからProduction候補をbuildし、公開aliasの更新を遅らせて検証する。既存Deploymentの環境変数は後から変わらないため、Deployment・env scope・runtimeの接続先を照合する。正式PreviewのreceiptやA/Bブラウザ証拠を、本番移行の証拠へ流用しない。
6. 検証した候補へ正式Production aliasを切り替え、実際の配信先とDB接続先を再照合する。旧DBのwriter遮断を維持し、新系の書込み・公開入口・Cronを整合する順で再開する。
7. 本人認証、画面・API、必要な業務操作、DBエラー・定期支払いを確認する。PR Preview・常設Previewも最新mainの正式経路で再照合し、DBとgenerationの維持を確認する。

現行アプリに汎用maintenance switchはない。書込停止や復元を行う仕組み、本人Google QA、非公開Production候補を確認する手段は、その移行で実際に利用できることを検証する。用意した計画だけで実行済みとは扱わない。

## 切戻しと記録

新DBへ書込みが一件もない段階は、接続設定とaliasを旧系へ戻し、旧DBの停止を解除して復帰できる。Googleログインのプロフィール更新や初期workspace作成も新DBへの書込みに含める。

新DBへの書込み開始後は、旧Deploymentへのrollbackだけでは最新データを保持できない。新系の書込みを再停止し、追加データの保持・同期を含む復旧方法を決める。DBの逆major移行や単純な接続先変更を、検証せずに実行しない。

実行結果はGit外の報告とPR本文に日本語で記録する。完全SHA・実版・各resource ID・snapshot・所要時間・件数・比較結果・最初の新DB書込・成功/失敗/未実施・残る資源を分ける。業務行や秘密値は記録しない。旧本番の廃棄は保持期間と復旧確認を踏まえて別に判断する。

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

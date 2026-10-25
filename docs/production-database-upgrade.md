# 本番DBの運用・版更新と復旧

## 現用本番と保持する資源

現用本番はNeon PostgreSQL 18・UTF8を使い、Vercel NativeのProduction接続から `DATABASE_URL` を供給する。
旧PG17 DBと既存の復旧用branchは保持する。

| 用途 | Neon project | branch | endpoint |
| --- | --- | --- | --- |
| 現用PG18本番 | `cake-production-pg18` / `noisy-wind-66979379` | `br-lingering-poetry-a1t13r0u` | `ep-odd-wildflower-a1kwkl1v` |
| 保持旧PG17 DB | `cake` / `shy-wave-07435387` | `br-small-morning-azdm8g48` | `ep-ancient-flower-az7oh01x` |

両DBのdatabaseは `neondb`、roleは `neondb_owner`。
保持する復旧用branchは `br-withered-flower-a1hpafzu`。
利用者が対象と削除影響を承認するまで、旧DBと復旧用branchを削除しない。

`preview.config.json` の `productionHostDigest` は現用PG18本番、
`productionHostDigests` は現用PG18と保持旧PG17の両endpointを含むPreview禁止集合である。
digestはpoolerを除いたendpoint hostのSHA-256で、接続文字列は設定しない。
現用値の切替後も、保持する旧DBのdigestを集合へ残す。
準備用build・接続前guard・provider・Deployment metadata・正式receiptの分離を維持し、PR専用DBや常設Previewを本番用途へ流用しない。

## 通常のmigrationと検証

- `db/migrations` の番号付きSQLを `npm run db:setup` で適用する。
  Productionの `build:vercel` はNext build後にこの処理を実行し、成功してから公開する。
  Productionでテストseedは実行しない。
- 適用台帳を一度取得して未適用migrationだけを番号順に実行する。各migrationと台帳の記録は同じTransactionで確定し、適用済みSQLの原文は変更しない。
- 019の取引先正規化はPostgreSQL 18以上・UTF8・`pg_catalog.pg_unicode_fast` を必要とする。
  DB版を更新するときは、Unicodeによる正規化結果と既存の生成列・Indexへの影響も確認する。
- 通常のPR Previewでは専用DBの所有権と本番分離を確認してからmigration・初回seedを行う。
  取引先正規化とCSVカテゴリの実DBQAは、承認された専用Previewで
  [開発・QA運用手順](development-workflow.md#pr-preview-build内の実db並行検証)に従って実行する。

## 将来の版更新・復旧

本番操作は明示的に依頼された対象と影響の範囲で、既存本人認証のprovider連携・Consoleまたは承認された実行環境を使う。
対象版に対応する[Neon公式手順](https://neon.com/docs/postgresql/postgres-upgrade)を確認する。

1. 元DB・移行先・保持するバックアップをproject・branch・endpoint・database・roleで確認する。
   実版・encoding・適用台帳と復元方法、既存データ・schema・権限の比較方法を決める。
   通常Previewの資源を操作対象へ含めない。
2. バックアップと復元先を確認してからコピー・復元を行い、一貫したsnapshotのデータ・schema・権限・適用台帳を比較する。
   必要な番号付きmigrationを適用し、既存データの保持を確認する。
3. 切替中の更新を止める範囲と最新データの同期方法を確認する。
   通常利用に加え、Googleログイン、認証済みHome/`GET /api/app`、Cron、旧Deployment、開始済み処理、外部接続を考慮する。
   本人が利用を控える前提と、DBへのアクセス停止を実証した結果を区別する。
4. 最終同期と照合後、Vercel NativeのProduction接続だけを切り替え、承認済みの最新mainから新しいProduction Deploymentを作成する。
   接続設定の変更だけで既存Deploymentが更新されるとは扱わない。
   公開先・完全SHA・DB接続先を確認し、本人のGoogleログインと既存データ表示を確認する。
   ProductionでA/Bテスト認証は有効化しない。
5. 成功・失敗・未実施、完全SHA・DB実版・対象ID・所要時間・比較結果・残る資源を日本語のPR本文・検証結果へ記録する。
   旧DBと復旧用branchは保持し、削除は別途判断する。

失敗や応答不明の場合は、接続先・公開先・更新の有無を確認してから次の操作を決める。
新DBへの書込み開始後は、旧Deploymentへのrollbackだけでは最新データを保持できない。
追加データの保持・同期方法を確認して復旧する。
逆major版へのデータ復元や接続切替を、互換性の確認なしに実行しない。

接続文字列・provider token・Cookie・バックアップの業務行を、チャット・コマンド引数・ログ・Git・環境ファイル・公開artifactへ出さない。
資格情報を別環境へコピーせず、TLS検証と保護設定を維持する。

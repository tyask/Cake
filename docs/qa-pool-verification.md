# QA貸出方式への見直し検証

2026-10-12。PR #34 の保存済みhead `76487b0683e908d7bc470f042623475b2546ceda` を取得して実装を再構成。元executorの未コミット変更は取得・転用していない。base mainは `1877f0ff88b5250225db5d590a06e3c1e656ecb9`。AGENTS.mdを確認し、repo/.agents と workspace/.agents/skills に追加の作業指示はなかった。

## 実装とローカル検証

- qa1/2/3は貸出枠・候補aliasのみ。固定QA枝、台帳Git枝、DB保持parkingを撤去。
- GitHub Deploymentの専用task/payloadを全ページから再生する台帳と、信頼済みmainを用いる短い単一Actions writerを追加。queue:max、cancel-in-progress:false、既存Environment Previewを使い、未有効化が既定。
- claim後だけ生成intentを永続化してPreviewを開始。満枠・未承認head・ゲート未確認は生成しない。応答喪失は記録とmetadataから復元し、盲目的に再作成しない。
- 同PR更新はlease/slot/Native DBを保持し、現在headのREADYとDB identityを確認してalias更新。古いlease、別project/PR/枝/SHA、共有deployment ID、DB識別子変更を拒否。
- close/merge/手動返却はdeletingを永続化。記録済み全IDを照合して削除し、Neon branchと全endpointの消失を確認後だけfree。不可逆削除の承認がない場合と確認失敗は枠を保持。
- 新DBはmigration前に空状態を検査してPR/枝/lease/endpoint markerを登録。適用済み002を書き換えず、Preview限定で既知の実アカウントbootstrap INSERTを抑止。固定seedは初回のみ。同PRの更新でプロフィール・権限状態・家計・所属・割合・明細をseedが上書きしない。既存のログイン時認可処理は変更していない。
- CLIはコミット済みGit停止設定と確認済みゲートを照合してpushし、draft PR作成と台帳読取によるPreview確認を行う。旧直接deploy/alias入口を停止。
- README、AGENTS、両設計書、QA運用手順を更新。

最終コードで `npm run lint`、`npm test`（**288成功・失敗0・skip0**）、`npx tsc --noEmit`、`npm run build`、`git diff --check` 成功。Next buildはローカルのビルドのみで、DB migration/seedやcloud deploymentを実行していない。UI変更はない。

回帰には満枠待機、全snapshot系列、token/資源の所有者、DB再利用拒否、SHA更新、stale alias、応答喪失、未解決intent、削除失敗、Native残存、HTTP拒否、Vercel/Neon全ページ読取を含む。Neon paginationは公式の `pagination.next` を使用。Vercel/Neon操作の回帰はmockであり、実クラウドの成功を意味しない。

PGlite 0.5.8で、実11migration、空状態検査、未知表/routine/enum/extension-owned table拒否、marker不一致、bootstrap抑止、seed前混入、seed途中失敗rollback、初回seed、同PR再build時の既存値保持、ローカルseed再実行を**20/20成功**で確認。Neon接続や複数接続のロック競合は検証していない。再現スクリプトは `scripts/verify-preview-database-safety.mjs`。repo依存にはPGliteを追加していない。

```bash
npm install --prefix /tmp/cake-db-safety --no-save --no-package-lock --ignore-scripts @electric-sql/pglite@0.5.8
node --import tsx scripts/verify-preview-database-safety.mjs --pglite-module /tmp/cake-db-safety/node_modules/@electric-sql/pglite/dist/index.js
```

## 実環境のread-only確認

既存VERCEL_TOKENの通常認証で対象projectのREST GETが200。project ID/name、team、GitHub repository、Production Branch=mainを照合。deployment一覧とwithGitRepoInfo=trueのGETも200。PR #33の `5776adfca96d17d166234c4a38d7c286bb47982a` に対応するREADY deploymentを読取確認し、変更していない。

候補 `cake-qa1-fumin.vercel.app` / qa2 / qa3のalias GETはすべて404。ただし現在の認証scopeでの未発見であり、グローバルな空き・割当可能性・未使用期間の名前予約保証にはならない。PR #34のfeature枝に対応するVercel一覧はv6/v7とも200・0件だった。

Preview専用CAKE_TEST_DATABASE_URLのNative連携metadataはproject読取で確認。ただしNEON_API_KEYがなく、Neon project/親/feature branch/endpointやcleanupは直接確認できない。接続文字列・秘密値・owner向けAPI応答の全文は保存/表示していない。

既存GitHub認証によるActions variablesの一覧読取は403（Resource not accessible by integration）。実際の有効化/承認変数は確認できず、権限を追加していない。新QA workflowはまだmainに存在せず、このdraft PRをpushしても運用を有効化しない。

## 未実施と有効化条件

- 全既存PR（設定のない旧枝を含む）の生成前Gitゲート、REST Git sourceによるNative branching、同PRの実DB保持、alias割当と衝突、queue:maxの実workflow、最後のdeployment削除後のNative branch/endpoint消失は未実施。
- 公開REST create schemaにはenv/build.envの記載がない。[公式client型](https://raw.githubusercontent.com/vercel/vercel/main/packages/client/src/types.ts)と[POST実装](https://raw.githubusercontent.com/vercel/vercel/main/packages/client/src/deploy.ts)はfieldを支持するが、client自身はfilesを使う経路であり、filesなしGitSourceとの組合せ、build/runtime注入、Native動作は推論・live未検証。欠落時はDB接続前guardで停止する。targetは公式仕様どおり省略してpreview、forceNew=1はintent単位の一度だけの作成に使う。
- 本番host比較と空Native親の確認、Neon API認証、Actions権限、既存Preview環境の実行/承認方針、確認済みhead設定、有効化・不可逆削除の承認が必要。今回は新Secret・資格情報配置、権限適用、ネットワーク変更、実配置/削除、main/Production変更、mergeを実行していない。
- 実Previewの画面/API、Function/transaction停止挙動、複数接続の競合、retentionによる途中削除は未検証。資源消失を実行中処理の即停止保証と混同しない。

以上が未確認のためQA workflowを有効化せず、draft PRとしてレビューを続ける。最新headのGitHub CI結果はPRのChecksとPR本文を参照。実配置・検証済みQA URLや生成済みNeon枝を報告しない。

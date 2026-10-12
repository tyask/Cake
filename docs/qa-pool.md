# QA貸出枠の運用（適用前）

`qa1` / `qa2` / `qa3` は同時に貸し出せる検証枠の名前であり、Gitブランチではない。開発・PR・Vercel Previewは各PRの `codex/<task>` 枝を使い、Neon Native Preview DBもそのfeature枝に対応させる。同じPRの更新では同じleaseとDBを保持し、返却後に別PRへ貸し出すときは新しいDBを確認する。固定QA枝、台帳枝、DB保持用parking deploymentは作らない。

## 現在の適用状態

対象はGitHub `tyask/Cake`、Vercel `fumin1/cake`（`prj_Z37vquodhpRd08ZTAtYnP0qa59jD`）、Preview専用Neonリソース `cake-preview`（project `misty-meadow-88903426`）。既存GitHub Environment `Preview` を使い、qa1/2/3用Environmentや管理DBを追加しない。

このPRは無効のworkflowと実装・運用案をレビューする段階。新しいSecretの作成、権限の適用、ネットワーク制限の変更、Productionへの変更は今回許可されていない。現在の実行環境には `NEON_API_KEY` がなく、Neonの所属・親DB・cleanupを読取確認できないため、実配置と返却のlive検証は停止している。既存Vercel tokenによるREST読取では対象project ID/name/team/repository/Production Branchと既存Deploymentの情報を確認できた。PR #33のSHA `5776adfca96d17d166234c4a38d7c286bb47982a` のREADY deploymentは変更していない。候補aliasは現在scopeの読取で404だったが、全世界での空きや割当可の証明にはならない。確認状況は [検証報告](qa-pool-verification.md) を参照する。

実環境では、全既存PRを含むGit自動Preview停止、REST `gitSource` によるNative branching、候補aliasの割当、Actions `queue: max`、最後のdeployment削除後のbranch/endpoint消失をまだ検証していない。ローカルテストや公式API仕様だけで完了扱いにしない。

## URLと貸出数

追加alias候補は `cake-qa1-fumin.vercel.app` / `cake-qa2-fumin.vercel.app` / `cake-qa3-fumin.vercel.app`。取得済みURLではなく、実APIによる割当許可と衝突確認が必要。team slug、project名、本番domain、Preview suffixは変更しない。自動branch URLもteam名から推定せず、実deploymentから取得する。

更新直前に同じleaseが `held`、PRがOPEN、現在head SHAとREADY deployment SHAが一致することを確認してaliasを付け替え、更新後にproject IDとdeployment IDを読み取る。他projectや別leaseのaliasは上書きしない。衝突・API失敗は貸出を保持して停止する。空き期間にも `.vercel.app` 名を予約保持できる公式API保証は確認できていないため、候補名の恒久確保を約束しない。3枠とも使用中なら待機し、枠未取得PRのVercel deploymentやNeon branchを生成しない。

## 生成前に止めるGitゲート

`vercel.json` の `git.deploymentEnabled` はmain以外の自動Git deploymentを停止する。minimatch規則でスラッシュを含む `codex/...` も対象にし、mainのProductionは維持する。未指定枝はtrue、複数の規則に一致するとtrueが優先されるため、停止対象を漏らさない。

この設定ファイルがない古いPR枝まで停止済みとは扱わない。**全既存PRをdeployment/Neon生成前に止めるremote設定の提案・確認が未完了なら有効化しない。** 設定を持つ枝だけの成功確認では不足する。lease取得後のwriterによるREST deploymentを許可し、未取得PRの自動生成を止め、mainへの影響がないことを実環境で確認する必要がある。

Ignored Build Stepはdeployment作成後に働き、integrationのDB生成前に止める保証がないため代用にしない。`gitProviderOptions.createDeployments` はGitHub Deployments記録の通知設定であり、Vercel生成停止ではない。Project APIの `previewDeploymentsDisabled` は公開schemaに存在するが、手動REST Previewも停止するかは未確認なので、未取得PRだけを止める設定として未検証のまま採用しない。

## 正本と短い単一writer

正本はGitHub Deploymentのimmutable payload snapshot。専用 `task: cake-qa-lease`、`environment: Preview`、`payload.protocol: cake-qa/v1` の記録だけを扱い、通常のVercel記録を混ぜない。全ページを取得し、GitHub deployment ID順に各枠の `sequence` と `previousRecordId` を検証する。未知protocol、系列の分岐、重複所有、API失敗は空き扱いせず停止する。

payloadは枠、PR番号、feature枝、完全head SHA、lease UUID、`held` / `deleting` / `free`、作成・更新時刻、作成intent、全deployment ID/SHA/phase、READY deployment、Neon project/branch/endpoint/host、返却済みDB識別子を保持する。秘密情報や接続文字列は含めない。新snapshotは直前の記録へ連結し、既知のdeploymentや返却済みDB識別子を消さない。

書込みとclaim/release/alias mutationは信頼済みmainコードを使う1つの短いActions writerだけが行う。`pull_request_target`、`workflow_dispatch`、`schedule` が同じwriterを起動する。全枠・全操作で固定concurrency group、`queue: max`、`cancel-in-progress: false` を共有する。PRコードをwrite token付きでcheckout・実行しない。CLIは台帳読取のみで、直接予約・配置・解放しない。

長いbuildやcleanup完了待ちは排他区間で行わず、intentを保存してAPI操作を開始し、後続の短い実行で照合する。`queue: max` は実行中1件＋最大100pending、満杯時は新requestがcancelされる。FIFOはgroupの待機開始順で入力順ではない。cancelされたrequestは未予約とし、毎回最新snapshotとleaseを読み直す。pending置換方式へfallbackしない。

GitHub Deployment作成は完全SHAを `ref` に指定し、`auto_merge: false`、`production_environment: false`、`transient_environment: true`。台帳の `required_contexts: []` はアプリの必須CIを代用しない。現writerはstatusを書き込まない。将来表示用statusを追加する場合も `auto_inactive: false` を明示する。statusのsuccess/inactive/failure、PR close/merge、workflow完了、時間経過で貸出を解放しない。status履歴は90日で削除されるため、正本をstatus履歴へ依存させない。

これはGitHub APIのCASや永続ロックではなく、単一writerとsnapshot系列を前提としたprotocol。別workflowや通常APIから専用taskへ直接書き込まない。

## 無効のままレビューする設定

workflowは `CAKE_QA_POOL_ENABLED` がtrueのときだけwriterを実行する。適用前はfalseまたは未設定で保持する。次は有効化条件の提案であり、今回remoteへ登録・変更しない。

| 設定 | trueにする前の確認 |
| --- | --- |
| `CAKE_QA_POOL_ENABLED` | 下記の承認・ゲート・Native・削除条件を満たした後に明示承認で有効化 |
| `CAKE_QA_GIT_GATE_CONFIRMED` | 設定のない既存PRを含め、枠未取得時にdeployment/Neonを生成しない |
| `CAKE_QA_NATIVE_CONFIRMED` | REST Git deploymentが同feature枝のNative DBを使い、同PR更新でDBを保持する |
| `CAKE_QA_DELETE_APPROVED` | 記録済み対象の検証・削除・Native cleanupを含む返却操作が明示承認済み |
| `CAKE_QA_PARENT_BRANCH_ID` | 読取確認した空のNative親branch ID。DB guardでも継承schema/データの混入を検査 |
| `CAKE_QA_APPROVED_HEADS` | PR番号をキー、レビュー済み完全head SHAを値とするJSON object。未登録headは配置しない |

既存Vercel tokenとNeon API key、Actionsの短命 `GITHUB_TOKEN` を使う案。`deployments: write` 等の必要権限と既存Environment `Preview` の実行・承認方針も適用前に確認する。新Secret・資格情報や権限を勝手に追加しない。Vercel-managed NeonのCLI/APIにはNeon API keyが必要で、一般のproject-scoped keyもEditor権限を持ちread-onlyとは限らない。

同PRへ追加pushした場合も新しい完全head SHAのレビューと `CAKE_QA_APPROVED_HEADS` の承認更新が必要。承認なしのheadで新deploymentを作成・alias更新しない。非秘密guard値は作成requestの `env` / `build.env` に限定して渡す案で、feature枝やproject/branch環境変数をremote更新しない。公開REST create schemaにはこのfieldの記載がない一方、[公式clientのDeploymentOptions](https://raw.githubusercontent.com/vercel/vercel/main/packages/client/src/types.ts) は両fieldを定義し、[POST処理](https://raw.githubusercontent.com/vercel/vercel/main/packages/client/src/deploy.ts) は除去せずrequest bodyへ展開して [v13 endpoint](https://raw.githubusercontent.com/vercel/vercel/main/packages/client/src/utils/index.ts) に送る。これは一次資料による実装根拠であり、公開REST schemaの保証と区別する。client自身はfilesを付ける経路でgitSourceを定義していないため、writerのfilesなし `gitSource + env/build.env` の受理・build/runtime注入・Native動作は推論に留まりlive未検証。失敗・注入欠落はguardで停止し、有効化前に実測する。`files` と `gitSource` は公式仕様で併用不可。

本番endpointとの比較には非秘密の `CAKE_QA_PRODUCTION_DATABASE_HOST` を使い、読取確認した実hostだけを登録する。推定hostで補わず、接続文字列や秘密値を出力しない。ネットワーク拒否、SSO、Deployment Protectionを迂回しない。

## claimと初回配置

1. Cake内のmain向けOPEN PR、`codex/<task>` 枝、現在の完全head SHA、必須CIの確認結果、そのheadへの明示承認、生成前ゲートを確認する。空き枠へのclaim snapshot永続化までクラウドを生成しない。満枠時は待機する。
2. 作成intentを記録後、Vercel REST `POST /v13/deployments` の `gitSource` にGitHub repo ID・feature枝の `ref`・完全 `sha` を指定する。`project` はcake project ID、`target` を省略してpreviewにする。ローカルファイルのCLI deploymentや固定QA枝へのpushで代用しない。create入力に未定義の `prId` を追加しない。
3. 初回はNative hostが未確認なので、QA guardがDBクライアント作成前に停止する。このdeploymentはNative生成を開始するもので、成功Previewや検証済みアプリとは扱わない。DB保持用parkingは配置しない。
4. Neon APIで `misty-meadow-88903426` の対応feature枝・parent・branch ID・endpoint ID・実hostを確認する。Productionとの分離をhost比較だけで断定せず、project所属と親DBも確認する。前leaseのbranch ID、endpoint ID、hostの再利用を拒否する。
5. 確認済みidentityをsnapshotへ保存し、同feature枝・同leaseの次deploymentへPR/枝/lease/slot/完全SHA、専用DB host、本番DB hostの非秘密guard情報を渡す。Native供給の `CAKE_TEST_DATABASE_URL` を使い、Productionの `DATABASE_URL` へfallbackしない。
6. DB guardで新DBの空状態とidentityを確認してからmigrationと固定サンプルseedを行う。READY後にVercel GETの `withGitRepoInfo=true` でref/SHAを確認し、同lease・current headを再読取してaliasを付ける。旧headの成功で現在headのaliasを更新しない。

NeonのPreview actionと `Resource must be active before deployment` が必要。接続変数はdeployment時に注入され、projectの通常env一覧だけで取得できるとは限らない。Vercel owner向けGET応答は環境変数を含み得るため、全文をログへ出さず必要な非秘密fieldだけを記録する。

## DB初期化と同PR更新

新leaseは新feature枝由来のDBを使う。Native親から引き継いだ業務データ、未知表、既存schema等をDB guardが検出したらfail closedで停止する。設定確認だけをNative親の空証明にせず、migration前に実DBの空状態を確認する。確認失敗時に行を削除して続行しない。

初回空確認とPR/feature枝/lease/endpoint identity登録、seed前混入検査、固定サンプルとseed済み記録はtransactionで扱う。新DBへ未適用migrationと固定テストユーザー・共有ワークスペースを登録する。同PR更新はidentityを照合し、未適用migrationだけを適用して、既存サンプルとQAで入力・編集したデータを保持する。SHA更新だけで返却・新leaseへ切り替えない。

ビルド、runtime、`db:setup`、`db:seed:test` に同じ接続・identity確認を適用する。pooled/unpooledの同一endpointも比較し、専用接続なし、host不明、本番host一致、別PR/別lease/別endpointならDB操作前に停止する。DBのDROP/TRUNCATE/resetや既存schema消去は自動実行しない。空DBに戻すためschema消去が必要なら、対象と影響を確認して別途明示承認を得る。

## releaseと失敗回復

`held` と `deleting` はどちらも使用中。PR close/mergeは返却開始条件であり、cleanup完了前に空きを増やさない。

1. 現在leaseを検証し、`deleting` snapshotを永続化して新配置とalias更新を止める。
2. 未完了create intentを照合する。応答喪失で台帳に未記録のdeploymentも、project・PR・feature枝・SHA・lease・attemptの一致からreconcileする。曖昧なorphanや未知の関連deploymentが残る間はfreeへ進めない。
3. 記録済み全deployment IDをGETし、同project・同feature枝・記録済みSHA・同leaseを検証してcancel/deleteする。成功・失敗・初回provisioningを含む全件を対象とし、名前の類似だけで未記録対象を削除しない。Productionや他PRに触れない。
4. aliasの現在project/deploymentを照合して取り除き、記録済み全deployment削除と関連deployment残存なしを確認する。alias変更だけで旧deployment固有URLのアプリ/API停止とは扱わない。
5. 同feature枝の最後の関連Vercel deployment削除によるNative cleanupを待つ。正常な認証・全ページ取得によるNeon branch/endpoint一覧と対象ID照合で、branchと全endpointの消失を確認する。HTTP成功、cleanup webhook発火、PR closeだけを完了にせず、403やtimeoutを不存在扱いしない。deployment復元でNeon DBは復元されない。
6. 消失証跡を保存し、DB identityを返却済み識別子へ追加して `free` snapshotを記録する。次leaseが古いbranch ID・endpoint ID・hostを使うことを拒否する。

delete失敗、権限不足、ネットワーク拒否、Neon読取不能、intent未解決は `deleting` のまま保持し、後続writerで回復する。応答喪失は再読取して確定し、盲目的に同じ生成要求を繰り返さない。retentionによる途中削除も台帳とNative identityをreconcileする。保持deploymentを残してDBを温存する返却はしない。deployment/branch/endpoint消失は資源の削除確認であり、開始済みFunction/transactionの即停止を保証するものではない。現writerは実行中処理の監視APIを照会しない。この実処理の停止挙動もlive検証で確認する。

## 開発者のコマンドと検証

コードを検証・commitしたら、最初に `task:pr --draft` でmain向けPRを作る。draft入口はrepository variable `CAKE_QA_GIT_GATE_CONFIRMED=true` と `git show HEAD:vercel.json` のmain-only停止設定（`**: false` / `main: true`、他のtrueなし）を共通checkerで検証し、originとHEADが一致しない場合だけ安全確認後にfeature枝をpushする。Preview未実施はdraft本文で明示できる。`deploy:preview` も同じゲートに加え有効化と先行PRを確認してからfeature枝をpushし、同PR/同lease/current HEADのREADY記録を台帳から読む。直接Vercel/Neonを生成・削除しない。

```bash
npm run task:pr -- --draft --title '変更内容を表すタイトル' --verification-file /tmp/cake-verification.md
npm run deploy:preview
```

Preview完了後、Deployment固有URLでPC/スマートフォンの画面とAPIを確認し、完全SHA、lease、deployment ID、Neon project/branch/endpoint、migration/seed結果を報告する。固定aliasだけで検証コミットを判定しない。再変更後は再commit・再deployment・再検証する。検証済みPR本文更新は `task:pr` の通常経路を使い、draftからの公開・mergeはユーザーが判断する。

ローカルではlint、test、build、TypeScriptと、同時claim、旧lease拒否、snapshot分岐、重複request、応答喪失、stale head、alias不一致、orphan、全ページ読取、delete失敗保持、旧DB再利用拒否、同PRデータ保持、新PR混入停止の回帰を確認する。実SQLの空判定・transaction/lockとcloud lifecycleは別途実測する。現在は必要な承認・認証・ゲート確認がないため有効化しない。

## 公式仕様

- [GitHub Deployments API](https://docs.github.com/en/rest/deployments/deployments) / [statusとauto_inactive](https://docs.github.com/en/rest/deployments/statuses#create-a-deployment-status) / [status履歴retention](https://docs.github.com/en/rest/deployments/statuses#data-retention)
- [Actions concurrencyとqueue](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency) / [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [Vercel Git生成停止](https://vercel.com/docs/project-configuration/git-configuration) / [GitHub通知field](https://github.com/vercel/sdk/blob/main/docs/models/updateprojectgitprovideroptions.md) / [project設定API](https://vercel.com/docs/rest-api/projects/update-an-existing-project)
- [Vercel deployment作成](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment) / [gitSource schema](https://github.com/vercel/sdk/blob/main/docs/models/gitsource2.md) / [取得](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url) / [一覧](https://vercel.com/docs/rest-api/deployments/list-deployments) / [削除](https://vercel.com/docs/rest-api/deployments/delete-a-deployment)
- [alias割当](https://vercel.com/docs/rest-api/aliases/assign-an-alias) / [alias取得](https://vercel.com/docs/rest-api/aliases/get-an-alias) / [alias削除](https://vercel.com/docs/rest-api/aliases/delete-an-alias)
- [Vercel integration actions](https://vercel.com/docs/integrations/create-integration/deployment-integration-action) / [Neon managed integration](https://neon.com/docs/guides/vercel-managed-integration) / [cleanup](https://neon.com/docs/guides/vercel-branch-cleanup)
- [Neon branches一覧](https://api-docs.neon.tech/reference/listprojectbranches) / [endpoints一覧](https://api-docs.neon.tech/reference/listprojectendpoints) / [branch削除](https://api-docs.neon.tech/reference/deleteprojectbranch) / [API key権限](https://neon.com/docs/manage/api-keys)

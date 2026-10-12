# QA貸出方式の検証記録

2026-10-12。対象はdraft [PR #34](https://github.com/tyask/Cake/pull/34)、`codex/fixed-qa-pool`。今回の開始headは `81988ad23ae155f20aeb380292ad07fb3f64f985`。元executorの未コミット変更は転用していない。AGENTS.mdと利用可能な作業指示を確認した。

## Hobby向けの生成前ゲート

有料Deployment Sources policyを必須条件から除き、同一repositoryのmainと対象PRの完全commit SHAにある `vercel.json` を検査する。`git.deploymentEnabled` は `**: false`、`main: true`、main以外のtrueなし、boolean値だけを許可する。GitHub Contents応答のfile/path/encoding/実byte数/64KiB上限を検査し、Git blob SHAを再計算して照合する。Contents検証はGit tree modeの証明を含まない。

writerはPRごとに検査し、最初のlease、生成intentの保存前、REST POST直前に読み直す。最後にOPEN/current head/所属/承認を再確認する。全PR共通の生成ゲートcacheは使わない。通常生成の3確認flagと完全SHA承認、限定probeの5項目だけの期限付き承認は維持する。cleanupはGit設定不足から独立させ、既存のproject/lease/resource照合と削除対象別承認を維持する。

通常CLIはコミット済みHEADとremote mainを検査し、確認flagだけでは通さない。push元は検査済み完全SHAのrefspecに固定し、検査中にローカルHEADが動いても未検査commitを送らない。force pushや迂回flagは追加していない。

検査結果は `scope: repository-git-trigger-configuration`、main/対象commit/blobの証跡、`backendForcedDeploymentPreventionProven: false` を返す。この運用はproject全体の技術的な排他ではない。設定のない古い枝、設定改変、別REST/CLI、first-party callerは迂回し得る。Ignored Build StepもNative生成前の停止根拠にしない。

read-onlyの14 remote枝監査ではPR34だけが適合し、main `37a55b8`、PR33、他の古い枝は未導入だった。稼働枝を個別に更新または凍結し、将来の枝は更新済みmainから作る必要がある。PR33と他のremote枝は今回変更しない。

## Actionsでのhost表示対策

既存repository Variable `CAKE_QA_PRODUCTION_DATABASE_HOST` をcallerの `jobs.secrets` から一時的な `workflow_call` secretへ渡し、共通runnerが従来と同じenv名でguardへ供給する。remote Secretの新規登録・移動、Variable値や権限の変更はない。値そのものを取得・表示して検証していない。

[GitHubのcontext availability](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)、公式workflow schema/parser、[runnerのmask初期化](https://github.com/actions/runner/blob/main/src/Runner.Worker/Worker.cs)により、job secretでのvars利用とstep表示前のmask開始を確認した。公式 `@actions/workflow-parser` 0.3.61で3 workflowのparse/convert errorは0件。実Actionsでのmaskは未検証で、過去ログは変更していない。

hostはrepository-level Variableを契約とする。callerにEnvironmentがないため、Preview Environmentの同名Variable overrideを以前と同じ実効値として引き継ぐ保証はない。既存Preview Environmentの資格情報解決は維持し、単一writer queueはcalleeのpool jobだけに置く。診断はEnvironment/queueを使わず、読取権限とtrusted mainのdispatch SHA checkoutを維持する。JSON/削除manifestの非秘密DB host識別情報とActions step envのmaskは別の扱いである。

既存診断の要約も補強した。Native枝名にhostや既知資格情報が埋め込まれていても名前を省略し、Production hostが大文字・pooler表記でも一致する返却計画を拒否する。新規回帰3件は修正前の失敗と修正後の成功を確認した。実値の取得やresource操作は行っていない。

## Native・DB・権限の維持

qa1/qa2/qa3は貸出枠と候補aliasだけ。固定QA/台帳Git枝やDB保持parkingは作らない。GitHub Deploymentsの専用task/payloadを正本とし、statusのauto_inactiveで解放しない。claim→intent→REST Native生成→host未確認buildのDB接続前停止→Native metadata照合→application buildの順序を維持する。

同PRはleaseとDB identityを保ち、最新成功headだけをaliasへ割り当てる。新PRでは新feature枝/DBを要求する。close/手動返却はまずdeletingを保存し、全deployment IDと対象別承認を照合して削除し、旧Native branch/全endpoint消失後だけfreeにする。失敗や確認不能は保持する。資源削除を実行中Function/transactionの即停止保証として扱わない。

今回のfixture/auth/migration実装変更はない。開始headには、空DBまたは承認済み2人fixtureの厳密受入、A管理者/B一般、固定共有家計、11migration/正規schema/guard revision 4、業務7表の混入拒否、同PR編集保持、SELECT-only QAログインが含まれる。適用済みmigrationとProduction認証は変更していない。

過去の承認済みQA親DB変更と今回の作業は分ける。13:04:30 UTCのA管理者化1行/旧管理者削除1行と、13:18:32 UTCのcanonical fingerprint/11カテゴリ一致のread-only確認は前の作業の証跡。今回はDBへ書き込んでいない。13:29:38 UTCのmain診断ではQA branch/endpointが各5件で以前と同じ集合だったが、瞬間的な作成や後続変更は否定しない。

## ローカル検証

最終構成で `npm run lint`、`npm test`（**543成功・失敗0・skip0**）、`npx tsc --noEmit --incremental false`、`npm run build`、`git diff --check` が成功した。クラウド接続情報を外し、PGlite 0.5.8の一時メモリDB4個による実SQL67件の検証を全testsに含めた。今回packageやmigrationの追加・変更はなく、検証データをNeonへ保存していない。ローカルNext buildはcloud deploymentやmigration/seedを実行していない。

開始headの前回結果は449 tests成功/失敗0/skip0、実SQL67/67、lint/型/build成功。今回の検証ではworkflow抽出で移動した安全性assertionも更新した。最新main `37a55b8` をPR34側へ取り込み（local merge `8658443`）、既存診断処理を保持してファイル追加の衝突を解消した。remote mainは変更していない。最新headのCI結果はPR本文とChecksで確認する。

再現例:

```bash
npm install --prefix /tmp/cake-db-safety --no-save --no-package-lock --ignore-scripts @electric-sql/pglite@0.5.8
node --import tsx scripts/verify-preview-database-safety.mjs --pglite-module /tmp/cake-db-safety/node_modules/@electric-sql/pglite/dist/index.js
```

## 公開範囲と残る確認

今回はコード/文書/テスト、PR34へのcommit・通常push・draft本文更新と最新CI確認を承認された範囲で行う。push前の2026-10-12 14:26:13 UTC、対象feature枝のVercel一覧GETは200・全ページ0件だった。push後も同じGET専用手段で照合し、結果をPR本文へ記録する。

QA poolとHobby対応workflowはまだmain未導入で、既存の読取専用診断はmainに存在する。通常CLI/create/probeはmainの設定不足で停止する。初回導入はQA無効・承認なし・空/free台帳を確認してユーザーが手動mergeする手順とし、未実証flagをtrueにしない。mainへのmergeは自動Production deploymentを開始するため今回実施しない。mergeでPR34はCLOSEDとなるので、将来のprobeには別の設定済みOPEN PRと対象別承認が必要。今回は新PRを作らない。

HobbyのGit停止指定を保ったREST gitSource+完全SHA+env/build.envでのNative生成、Native親選択、build/runtime注入、同PR DB保持、alias衝突/割当/予約、queue:maxの実workflow、最後のdeployment削除後のNative消失はlive未検証。公開REST schemaと公式client実装のfieldの差は運用手順に明記する。Vercel Proへの変更は不要だが、Neonの既存plan/無料枠は別条件であり、無課金全体の保証はしない。

Production/mainへの変更、manual Preview/probe、pool/確認flag有効化、remote設定/Secrets/権限/ネットワーク変更、不可逆削除、PR33/他枝変更は行わない。実配置済みQA URLやNative成功を報告しない。

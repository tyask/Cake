> 履歴資料：旧固定QA／台帳方式の記録です。現在のコマンド・手順は [開発・QA運用手順](development-workflow.md) を参照してください。ここに記載された旧スクリプトは撤去済みです。

# QAのGET専用読取診断

診断単体はQA poolを有効化せず、アプリ、DB、build、seedを実行しない。GETだけで設定不足と資源の識別情報を確認し、probe・返却の計画を表示する。貸出の取得・返却、deployment作成・削除、alias変更、DB接続、設定適用の実行入口は持たない。main/対象PRの完全SHAにあるGit設定を確認し、writerと通常CLIの生成前確認は [QA貸出運用](development-workflow.md) の別の契約に従う。

通常運用開始は利用者が明示許可済み。2026-10-14 JSTのGET専用QA pool preflight [run 38485838972 / job 115599157037](https://github.com/tyask/Cake/actions/runs/38485838972/job/115599157037)で、実効 `CAKE_QA_POOL_ENABLED` / `CAKE_QA_GIT_GATE_CONFIRMED` / `CAKE_QA_NATIVE_CONFIRMED` はtrue、旧4承認入力は空、qa1 free、使用中QA DBは0個と確認した。これはその時点の観測であり、新しいタスクでは同等の既存認証、選択したCake環境、運用規則、実効設定と台帳を再確認する。セッション間の認証・許可の自動共有は保証しない。

[A（PR #42）](https://github.com/tyask/Cake/pull/42)・[B（PR #43）](https://github.com/tyask/Cake/pull/43)の文書のみのPRをqa1で順次実行し、既存owner認証での承認代行、同PRのlease/DB/入力保持、別PRの新DBと初期状態、固定aliasの最新READY反映、cleanup/freeを実証した。同時3枠、実ブラウザPC/mobileの全操作、外部alias競合、開始済みFunction/transactionの終了、scheduleだけでの収束は未試験。親fixture継承と空DB初期化の区別も未確認。qa2/qa3はCake環境で `cake-qa2-fumin.vercel.app` / `cake-qa3-fumin.vercel.app` の追加ホスト許可を要し、CONNECT 403を迂回しない。

導入・修正時の「pool無効維持」「PR #37のqa1保持」「今回dispatch・生成・削除を行わない」は過去のタスク範囲であり、現在の通常運用への一律禁止ではない。個別開発依頼で許可された範囲内ではCodexが既存owner認証で承認を代行でき、具体planのHEAD・最新push/PR CI・slot・lease・台帳世代・期限・digestと、GitHub由来のowner本人の識別情報（owner数値IDとactor/triggering_actorのUser種別・IDの一致）・main/workflow/plan結合・初回attempt・承認runのcompleted/successを機械照合する。新HEADへ承認を引き継がず、最新receiptの失敗・未完了時は古いapprovedへ戻らない。承認済み対象への毎回のチャット再確認をこの照合の代わりに要求しない。通常運用の有効化は各HEADのplan承認や、不可逆な削除の正確な対象・データ喪失への別承認を代替しない。

## 実行

ローカルでは既存の認証を環境変数で使い、次を実行する。資格情報を引数や報告へ記載しない。資格情報なしでも検査結果に不足が表示される。

```bash
node --import tsx scripts/qa-bootstrap.ts --action preflight
node --import tsx scripts/qa-bootstrap.ts --action plan-probe --pr <設定済みOPEN PR番号> --sha <現在の完全SHA> --slot qa1
node --import tsx scripts/qa-bootstrap.ts --action plan-release --pr <PR番号> --lease-id <現在のUUID>
```

GitHub Actionsの`QA diagnostics (read only)`は`workflow_dispatch`だけを使い、`tyask/Cake`の信頼済みmainを実行する。workflowはdefault branchへ導入されたコードだけを使うため、新しい出力privacyもmain導入後に反映される。診断callerは共通の `qa-private-run.yml` を呼び、診断jobはmainのcommitをcheckoutする。[GitHubの手動workflow仕様](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

実行はread権限の`GITHUB_TOKEN`と、取得できる場合だけ既存の`VERCEL_TOKEN`・`NEON_API_KEY`を使う。新Secretやcredentialは作成・配置しない。jobにEnvironmentを指定せず、環境へのdeployment記録も作らない。既存の資格情報がPreview環境だけにある場合、その値はこのjobへ渡らず、認証不足として報告する。repo/organization側の既存Secretがあってもscope不足は別の確認結果になる。

通常writerと同じPreview環境の実効値を確認する場合は、既存 `qa-pool.yml` の `action=preflight` をmainで実行する。inspect jobだけが選択され、GET以外を拒否するreaderを使う。`Run reviewed QA action` のstep envから3flagsと旧4承認入力（`CAKE_QA_APPROVED_HEADS` / `CAKE_QA_PROBE_APPROVALS` / `CAKE_QA_DELETE_APPROVALS` / `CAKE_QA_ALIAS_APPROVALS`）だけを内部で照合し、3flagsのtrue/空と旧入力が空かどうかの判定だけを報告する。raw logs・env dump・承認入力の原値や全文を表示・保存しない。`QA diagnostics (read only)` のEnvironmentなしjobには3flagsを注入しないため、その結果でPreviewの実効値を代用しない。Variables APIが403なら登録不存在は未確認とし、実効値が空でもRepository/Preview各scopeの未登録を証明したとは扱わない。

GitHub Variables APIにはrepository Variablesの読取権限が必要で、jobの`actions: read`と同じではない。403も正確に報告し、権限を拡大しない。`CAKE_QA_PARENT_BRANCH_ID`と`CAKE_QA_PRODUCTION_DATABASE_HOST`は存在する場合だけ参照する。診断JSON/CLI・console・報告はDB host、deployment URL、接続文字列、資格情報、応答本文を省略し、slots/planのDBも安全なproject/branch/endpoint IDで表示する。この表示計画はコピー可能な削除承認JSONではない。完全DB hostと期限は別のprivateな承認入力で照合する。

Actions callerは既存repository Variableの本番hostを `jobs.secrets` から一時的な `workflow_call` secret `production_database_host` へ渡し、calleeは元のenv keyへ設定する。writer用の削除/alias承認JSONも既存repository Variablesから一時的secretsへ渡す。remote Secret登録・移動、値・権限の変更はしない。診断caller/jobはEnvironmentを使わず、Preview Environmentの同名Variable overrideを引き継いだと推定しない。出力の除外とrunner maskは別の防御で、実Actionsのmask確認や過去ログ消去は完了扱いにしない。

## 結果の扱い

- `preflight`は対象project、専用Deployment台帳、同一repositoryのmainの完全SHAとGit設定、Neon metadata、親設定、本番host比較設定、候補aliasを読み取る。`--pr`があれば対象のOPEN PR/current headの設定も確認し、`--sha`を指定した場合は現在headとの一致を必要とする。供給された本番hostを取得済みQA endpoint hostと照合し、値を出さず結果とendpoint IDを報告する。認証なし・401/403・対象不一致・形式不明を区別し、他の読取を続ける。aliasの404は現在のscopeで未発見という意味であり、グローバルな空きや予約保証ではない。
- `plan-probe`はOPEN PRの現在完全SHAと指定枠、main/対象PRの完全SHAにあるGit設定を照合し、承認に必要な対象を表示する。main-only設定がなければ計画のブロッカーとして報告する。生成や貸出を行わず、このbootstrapでは実行入口も存在しない。
- `plan-release`は現在のleaseと全deployment ID、alias、Native DB identityを読み取って照合する。生成用のGit設定GETは行わず、設定不足で既知資源の削除計画を止めない。Productionや別lease、不明なintent、未確認DBがあれば計画を完成扱いしない。返却状態へ進めず、削除承認を発行しない。

`native`は、既存GETで取得した対象QA projectの完全一覧から、project ID、branch ID・安全なname・parent ID・default判定、endpoint IDと所属branch IDを要約する。各値の根拠は`branch.name`・`branch.parent_id`・`branch.default`・`endpoint.branch_id`として示し、欠落/不正値は`null`と`unavailable`にする。nameが資格情報・供給本番hostの値やNeon host形式なら、name経由の出力も避けて未確認扱いとする。明示された`parent_id: null`と、返されなかったparent情報を区別する。defaultはAPIがbooleanで返した場合だけ採用し、mainという名前や親なしの状態から推測しない。`defaultBranchIds`はAPIがtrueを返した枝だけで、未知の値がある場合の空配列を「defaultなし」の証明にはしない。

`parent.candidateSummary`は既存のID指定GETで照合した親候補と、一覧の`parent_id`が候補IDに一致する子IDを示す。一覧を確認できなければ子配列は`null`とし、子が0件と扱わない。`observedPreviewCodexBranchIds`と`observedPreviewCodexChildBranchIds`は`preview/codex/`という名前の慣例に合う観測結果であり、現在/次回のNative生成設定や空DBを証明しない。URI、connection string、host、role、password、資格情報や未選択のAPI項目はこの要約に出力しない。追加のAPI呼出し・権限・SQLは使わない。

`productionHostComparison`は、`CAKE_QA_PRODUCTION_DATABASE_HOST`と既存GETで取得したQA endpointsをメモリ内だけで比較し、全体と各endpointの`match`・`no-match`・`unknown`をendpoint IDとともに示す。Neonのpooler接続は第一DNS label末尾の`-pooler`を除いて同じendpointと照合する。DNSの大文字・小文字は同一視し、末尾dotやURI・port等を含む値は比較対象にしない。[Neon connection pooling仕様](https://neon.com/docs/connect/connection-pooling)

確認できた一致が1件あれば全体は`match`となる。一致がなく、全endpointを確認して不一致なら`no-match`となる。本番host不足、一覧の取得失敗・0件、endpoint host不足・不正・IDとの矛盾などで比較を完了できなければ`unknown`となり、不一致として扱わない。本番hostと同じendpoint IDなのにDNSの後続部分が異なる場合も`unknown`となる。一覧未確認の`endpoints: null`と確認済み0件の`endpoints: []`を区別する。本番host形式の既存check成功だけでは比較成功を意味しない。

`no-match`は供給された1つの本番hostと観測されたQA endpointsの比較結果であり、本番project全体との完全分離を証明しない。供給hostが実際のProduction DBに対応すること、次回Native作成の親設定、DBデータの由来・空状態は別の証拠が必要である。SQLは実行しないため、`parent.emptyStateProven: false`は空状態が未確認であることを表し、データが存在するという判定でもない。

Git設定は `vercel.json` の `git.deploymentEnabled: {"**": false, "main": true}` を確認し、main以外をtrueにする規則を拒否する。GitHubからcommitの完全SHAへ固定して読み、内容とblob SHAを照合する。出力の `gitConfiguration.scope: repository-git-trigger-configuration` は枝内のGit自動生成設定だけを示し、 `backendForcedDeploymentPreventionProven: false` を維持する。`main`は `branch` / `commitSha` / `blobSha`、`target`はこれらと `pr` を持ち、未確認ならnullとなる。確認結果・不足の項目名は `Preview enabled` / `Main Git configuration` / 対象指定時の `Target Git configuration` とする。main/対象PRのcommit・blobの証拠が得られても、古い枝、設定変更、直接REST/CLI、first-party callerの迂回を強制阻止した証拠ではない。有料Deployment Policiesの適用やProへの変更・課金、未検証API fieldへのfallbackを要求しない。

出力の`executionEnabled: false`は診断専用であることを示し、通常運用全体が無効という判定ではない。読取成功は操作承認・空DB証明・live検証成功を意味しない。GET専用の診断はpool/Gitゲート確認/Native確認flagをtrueにせず、不足を確認できる。限定probeは診断とは別の信頼済みmain writerで、設定済みOPEN PRへの `projectId` / `pr` / `sha` / `slot` / `expiresAt` の5項目だけの期限付き承認を使う。A/Bの同PR実DB保持・alias・Native cleanupの実測は別の実行証拠であり、今回の診断結果だけから同じ成功を推論しない。Native Neonの既存plan・無料枠はVercel Hobbyと別条件で確認し、無課金を保証しない。

## 公開とmain導入時の影響

設定のない枝のpushはPR作成前にもPreviewを作り得て、Native連携はアプリbuildより前にDBを作る。draft PRやIgnored Build Stepは資源生成前の停止保証ではない。公開時はmain/対象の完全SHAと生成前ゲート、対象と影響、その操作の許可を確認し、過去の監査結果を現在の停止保証へ流用しない。[Vercel GitHub連携](https://vercel.com/docs/git/vercel-for-github#a-deployment-for-each-push)、[Ignored Build Step](https://vercel.com/docs/project-configuration/project-settings#ignored-build-step)、[Native Neon連携](https://neon.com/docs/guides/vercel-managed-integration)

mainへのmergeは利用者が判断し、自動Production deploymentと既存の本番build・DB更新処理を起動し得る。手動Productionデプロイは別の明示依頼を必要とする。診断コードはアプリからimportされず、Production処理の仕様を変更しない。alias割当は現在HEADの有効な具体plan承認、不可逆なcleanupは正確な対象とデータ喪失への別承認を必要とし、診断成功やローカル検証をその操作承認へ置き換えない。導入前の禁止・保留記録は [過去の診断検証報告](qa-diagnostics-verification.md) の履歴として扱う。

# QA導入前の読取診断

診断単体はQA poolを有効化せず、アプリ、DB、build、seedを実行しない。GETだけで設定不足と資源の識別情報を確認し、probe・返却の計画を表示する。貸出の取得・返却、deployment作成・削除、alias変更、DB接続、設定適用の実行入口は持たない。PR #34のHobby対応では、有料source policyを必須とする旧診断をmain/対象PRの完全SHAにあるGit設定確認へ置き換える。writerと通常CLIの生成前確認は [QA貸出運用](qa-pool.md) の別の契約に従う。

## 実行

ローカルでは既存の認証を環境変数で使い、次を実行する。資格情報を引数や報告へ記載しない。資格情報なしでも検査結果に不足が表示される。

```bash
node --import tsx scripts/qa-bootstrap.ts --action preflight
node --import tsx scripts/qa-bootstrap.ts --action plan-probe --pr <設定済みOPEN PR番号> --sha <現在の完全SHA> --slot qa1
node --import tsx scripts/qa-bootstrap.ts --action plan-release --pr <PR番号> --lease-id <現在のUUID>
```

GitHub Actionsの`QA diagnostics (read only)`は`workflow_dispatch`だけを使い、`tyask/Cake`のmainだけで実行する。GitHubの仕様上、workflowファイルがdefault branchに存在する必要がある。診断workflow自体は最新mainに導入済みだが、このPR #34のHobby対応とhost表示対策はmainへ導入するまで現在のworkflowへ反映されない。診断callerは共通の `qa-private-run.yml` を呼び、診断jobはmainのcommitをcheckoutする。今回、実workflowを再実行しない。[GitHubの手動workflow仕様](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

実行はread権限の`GITHUB_TOKEN`と、取得できる場合だけ既存の`VERCEL_TOKEN`・`NEON_API_KEY`を使う。新Secretやcredentialは作成・配置しない。jobにEnvironmentを指定せず、環境へのdeployment記録も作らない。既存の資格情報がPreview環境だけにある場合、その値はこのjobへ渡らず、認証不足として報告する。repo/organization側の既存Secretがあってもscope不足は別の確認結果になる。

GitHub Variables APIにはrepository Variablesの読取権限が必要で、jobの`actions: read`を追加することと同じではない。今回の最小read `GITHUB_TOKEN`で403になる場合も正確に報告し、権限を拡大しない。`CAKE_QA_PARENT_BRANCH_ID`と`CAKE_QA_PRODUCTION_DATABASE_HOST`は存在する場合だけ参照し、Native要約・本番比較結果にはhost値を出力しない。接続文字列・資格情報・応答本文も出力しない。`slots.database`と`plan.database`には非秘密QA DB hostが照合用identityとして含まれ得るため、すべてのJSONでhostを省略するとは扱わない。計画には照合済みQA資源の識別情報だけを含める。

Actionsの本番hostは既存repository Variableをcallerの `jobs.secrets` から一時的な `workflow_call` secret `production_database_host` へ渡し、calleeは元の `CAKE_QA_PRODUCTION_DATABASE_HOST` env keyへ設定する。runnerがstep env表示前にmaskするコードであり、remote Secretへの登録・移動、Variable値や追加権限の変更はない。診断caller/jobはEnvironmentを使わず、Preview Environmentの同名Variable overrideも反映されない。以前と同じ実効値とは推定しない。main導入前のworkflowと既存ログにはrawの非秘密hostが含まれ得る。過去ログを消した、実Actionsでmaskを確認済み、全ログでhostを非表示にしたとは報告しない。

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

出力の`executionEnabled: false`は診断専用であることを示す。読取成功は操作承認・空DB証明・live検証成功を意味しない。GET専用の診断はpool/Gitゲート確認/Native確認flagをtrueにせず、不足を確認できる。限定probeは診断とは別の信頼済みmain writerで、設定済みOPEN PRへの `projectId` / `pr` / `sha` / `slot` / `expiresAt` の5項目だけの期限付き承認を使う。queue、同PRの実DB保持、alias、Native cleanupの実証は別途対象と影響をレビューして進める。Native Neonの既存plan・無料枠はVercel Hobbyと別条件で確認し、無課金を保証しない。

## 公開とmain導入時の影響

監査時のmain（`37a55b8`）はGit連携による自動Previewを止める設定を持たず、全remote 14枝のうちPR #34の枝だけがmain-only設定に適合する。PR #33や他の枝は未導入で、古いPreview枝もremoteに残る。設定のない枝のpushはPR作成前にもPreviewを作り得て、Native連携はアプリbuildより前にNeon枝を作る。draft PRやIgnored Build Stepは資源生成前の停止保証ではない。PR #33への将来の設定だけの変更にも別途承認が必要で、今回は変更しない。[Vercel GitHub連携](https://vercel.com/docs/git/vercel-for-github#a-deployment-for-each-push)、[Ignored Build Step](https://vercel.com/docs/project-configuration/project-settings#ignored-build-step)、[Native Neon連携](https://neon.com/docs/guides/vercel-managed-integration)

初回のHobby移行はQA無効・承認なし・空台帳のまま、ユーザーがこの修正を含むPR #34を手動mergeしmainへwriterとGit設定を導入する。mainの設定不足は生成・probe・通常CLIを止めるが、無効状態での導入mergeを禁止しない。mainのProductionを維持するためmergeは自動Production deploymentと既存DB処理を起動し、その承認が必要である。診断コードはアプリからimportされず、Productionのbuild後DB更新・runtimeの仕様は変えない。今回のPR #34へのcommit/push/本文更新はリスクを含め明示承認済みの限定作業で、merge、Preview/probe、pool有効化、削除、remote設定変更は行わない。merge後のPR #34はCLOSEDとなるため、限定probeには別の設定済みOPEN PRと個別承認が必要で、今回は作成しない。

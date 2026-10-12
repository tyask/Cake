# QA導入前の読取診断

この追加はPR #34のQA poolを有効化せず、既存のPreview、DB、build、seed、`deploy:preview`、`task:pr`の動作を変更しない。GETだけで設定不足と資源の識別情報を確認し、probe・返却の計画を表示する。貸出の取得・返却、deployment作成・削除、alias変更、DB接続、設定適用を実装しない。

## 実行

ローカルでは既存の認証を環境変数で使い、次を実行する。資格情報を引数や報告へ記載しない。資格情報なしでも検査結果に不足が表示される。

```bash
node --import tsx scripts/qa-bootstrap.ts --action preflight
node --import tsx scripts/qa-bootstrap.ts --action plan-probe --pr 34 --sha <現在の完全SHA> --slot qa1
node --import tsx scripts/qa-bootstrap.ts --action plan-release --pr <PR番号> --lease-id <現在のUUID>
```

GitHub Actionsの`QA diagnostics (read only)`は`workflow_dispatch`だけを使い、`tyask/Cake`のmainだけで実行する。GitHubの仕様上、workflowファイルがdefault branchに存在する必要があるため、この診断用追加をレビューしてmainへ導入した後に手動実行できる。PR #34はそのために先にmergeする必要がない。[GitHubの手動workflow仕様](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

実行はread権限の`GITHUB_TOKEN`と、取得できる場合だけ既存の`VERCEL_TOKEN`・`NEON_API_KEY`を使う。新Secretやcredentialは作成・配置しない。jobにEnvironmentを指定せず、環境へのdeployment記録も作らない。既存の資格情報がPreview環境だけにある場合、その値はこのjobへ渡らず、認証不足として報告する。repo/organization側の既存Secretがあってもscope不足は別の確認結果になる。

GitHub Variables APIにはrepository Variablesの読取権限が必要で、jobの`actions: read`を追加することと同じではない。今回の最小read `GITHUB_TOKEN`で403になる場合も正確に報告し、権限を拡大しない。`CAKE_QA_PARENT_BRANCH_ID`と`CAKE_QA_PRODUCTION_DATABASE_HOST`は存在する場合だけ参照し、本番host・変数の値・接続文字列・応答本文を出力しない。計画には照合済みQA資源の識別情報だけを含める。

## 結果の扱い

- `preflight`は対象project、専用Deployment台帳、Preview source policy、Neon metadata、親設定、本番host比較設定、候補aliasを読み取る。供給された本番hostを取得済みQA endpoint hostと照合し、値を出さず結果とendpoint IDを報告する。認証なし・401/403・対象不一致・形式不明を区別し、他の読取を続ける。aliasの404は現在のscopeで未発見という意味であり、グローバルな空きや予約保証ではない。
- `plan-probe`はOPEN PRの現在完全SHAと指定枠を照合し、承認に必要な対象を表示する。生成や貸出を行わず、このbootstrapでは実行入口も存在しない。
- `plan-release`は現在のleaseと全deployment ID、alias、Native DB identityを読み取って照合する。Productionや別lease、不明なintent、未確認DBがあれば計画を完成扱いしない。返却状態へ進めず、削除承認を発行しない。

`native`は、既存GETで取得した対象QA projectの完全一覧から、project ID、branch ID・安全なname・parent ID・default判定、endpoint IDと所属branch IDを要約する。各値の根拠は`branch.name`・`branch.parent_id`・`branch.default`・`endpoint.branch_id`として示し、欠落/不正値は`null`と`unavailable`にする。nameが資格情報・供給本番hostの値やNeon host形式なら、name経由の出力も避けて未確認扱いとする。明示された`parent_id: null`と、返されなかったparent情報を区別する。defaultはAPIがbooleanで返した場合だけ採用し、mainという名前や親なしの状態から推測しない。`defaultBranchIds`はAPIがtrueを返した枝だけで、未知の値がある場合の空配列を「defaultなし」の証明にはしない。

`parent.candidateSummary`は既存のID指定GETで照合した親候補と、一覧の`parent_id`が候補IDに一致する子IDを示す。一覧を確認できなければ子配列は`null`とし、子が0件と扱わない。`observedPreviewCodexBranchIds`と`observedPreviewCodexChildBranchIds`は`preview/codex/`という名前の慣例に合う観測結果であり、現在/次回のNative生成設定や空DBを証明しない。URI、connection string、host、role、password、資格情報や未選択のAPI項目はこの要約に出力しない。追加のAPI呼出し・権限・SQLは使わない。

`productionHostComparison`は、`CAKE_QA_PRODUCTION_DATABASE_HOST`と既存GETで取得したQA endpointsをメモリ内だけで比較し、全体と各endpointの`match`・`no-match`・`unknown`をendpoint IDとともに示す。Neonのpooler接続は第一DNS label末尾の`-pooler`を除いて同じendpointと照合する。DNSの大文字・小文字は同一視し、末尾dotやURI・port等を含む値は比較対象にしない。[Neon connection pooling仕様](https://neon.com/docs/connect/connection-pooling)

確認できた一致が1件あれば全体は`match`となる。一致がなく、全endpointを確認して不一致なら`no-match`となる。本番host不足、一覧の取得失敗・0件、endpoint host不足・不正・IDとの矛盾などで比較を完了できなければ`unknown`となり、不一致として扱わない。本番hostと同じendpoint IDなのにDNSの後続部分が異なる場合も`unknown`となる。一覧未確認の`endpoints: null`と確認済み0件の`endpoints: []`を区別する。本番host形式の既存check成功だけでは比較成功を意味しない。

`no-match`は供給された1つの本番hostと観測されたQA endpointsの比較結果であり、本番project全体との完全分離を証明しない。供給hostが実際のProduction DBに対応すること、次回Native作成の親設定、DBデータの由来・空状態は別の証拠が必要である。SQLは実行しないため、`parent.emptyStateProven: false`は空状態が未確認であることを表し、データが存在するという判定でもない。

出力の`executionEnabled: false`は診断専用であることを示す。読取成功は操作承認・空DB証明・live検証成功を意味しない。PR #34のpolicy適用、限定probe、queue、同PRの実DB保持、alias、Native cleanupの実証は別途対象と影響をレビューして進める。

## 公開とmain導入時の影響

現在のmainはGit連携による自動Previewを止めていない。新しい枝をpushするとPR作成前にもPreviewが作られ得て、Native連携はbuildより前にNeon枝を作る。draft PRやIgnored Build Stepは資源生成前の停止保証ではない。この追加は`vercel.json`やremote gateを変更しないため、公開前にその自動生成を許可するか、別途承認された生成前ゲートを確認する必要がある。[Vercel GitHub連携](https://vercel.com/docs/git/vercel-for-github#a-deployment-for-each-push)、[Ignored Build Step](https://vercel.com/docs/project-configuration/project-settings#ignored-build-step)、[Native Neon連携](https://neon.com/docs/guides/vercel-managed-integration)

mainへのmergeはユーザーが判断する。診断コードはアプリからimportされないが、mergeは既存のProduction buildと既存DB処理を通常どおり起動し得る。「本番影響ゼロ」とは扱わない。

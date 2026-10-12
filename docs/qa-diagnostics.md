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

- `preflight`は対象project、専用Deployment台帳、Preview source policy、Neon metadata、親設定、本番host比較設定、候補aliasを読み取る。認証なし・401/403・対象不一致・形式不明を区別し、他の読取を続ける。aliasの404は現在のscopeで未発見という意味であり、グローバルな空きや予約保証ではない。
- `plan-probe`はOPEN PRの現在完全SHAと指定枠を照合し、承認に必要な対象を表示する。生成や貸出を行わず、このbootstrapでは実行入口も存在しない。
- `plan-release`は現在のleaseと全deployment ID、alias、Native DB identityを読み取って照合する。Productionや別lease、不明なintent、未確認DBがあれば計画を完成扱いしない。返却状態へ進めず、削除承認を発行しない。

出力の`executionEnabled: false`は診断専用であることを示す。読取成功は操作承認・空DB証明・live検証成功を意味しない。PR #34のpolicy適用、限定probe、queue、同PRの実DB保持、alias、Native cleanupの実証は別途対象と影響をレビューして進める。

## 公開とmain導入時の影響

現在のmainはGit連携による自動Previewを止めていない。新しい枝をpushするとPR作成前にもPreviewが作られ得て、Native連携はbuildより前にNeon枝を作る。draft PRやIgnored Build Stepは資源生成前の停止保証ではない。この追加は`vercel.json`やremote gateを変更しないため、公開前にその自動生成を許可するか、別途承認された生成前ゲートを確認する必要がある。[Vercel GitHub連携](https://vercel.com/docs/git/vercel-for-github#a-deployment-for-each-push)、[Ignored Build Step](https://vercel.com/docs/project-configuration/project-settings#ignored-build-step)、[Native Neon連携](https://neon.com/docs/guides/vercel-managed-integration)

mainへのmergeはユーザーが判断する。診断コードはアプリからimportされないが、mergeは既存のProduction buildと既存DB処理を通常どおり起動し得る。「本番影響ゼロ」とは扱わない。

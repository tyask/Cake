# QA承認フローの検証

この文書は各実装・導入段階の検証記録です。以下の「今回」の操作禁止や未実証の記述は当時の範囲であり、現在の通常運用を一律禁止する指示ではありません。過去の詳細はそのまま残し、PR #42/#43のqa1実測、通常運用開始後の時点診断、未試験事項と現在の手順は [QA貸出運用](qa-pool.md) を参照してください。

## owner plan ID承認（今回の変更）

対象は `codex/qa-owner-approval-flow` の専用worktree。trusted mainが別task `cake-qa-approval` に安全projectionを保存し、owner本人のauthenticated dispatchからplan ID一個を承認・revokeする設計を確認する。今回の実操作、workflow dispatch、Variable・Secret・権限変更、Preview/DB生成、DELETE、main mergeは行わない。本番と既存PR #33の設定を変更しない。

確認する境界は、repository ownerの数値IDと実runのactor / triggering_actorの数値ID・User種別、main/workflow/repository/trusted main SHAの一致、非owner・bot・fork・CI・comment・rerun・偽creatorの拒否、実 `display_title` とimmutable planの結合、private manifestのSHA-256 digestとCI head/slot/lease/世代/期限の一致、revokeとmutationごとの期限確認。承認は初回attemptだけを受け入れ、completed/success後のwriterだけが消費する。最新の正当receiptが失敗・未完了ならPENDINGとして止め、旧approvedへfallbackせずownerの新dispatchで回復する。Deploymentsのcreatorは人間owner承認の代用にしない。承認taskの公開payloadはsafe projectionだけとし、host・資格情報・private manifestを保存・出力しない。既存cake-qa/v1貸出台帳の完全DB identity形式は変更せず、新承認taskへhostを複製しない。

CLIの標準手順は `deploy:preview` → WAIT_APPROVALとplan確認 → `npm run qa:approve -- --plan-id <ID>` → 承認Actionsの成功確認 → 再度 `deploy:preview`。取消は `--revoke`。Run workflowではmainのapprove/revokeとplan_id一個を指定する。承認run自身は資源操作をしない。計画はpreview/cleanupに限定し、TTLは既定2時間・最大24時間。内部固定envのQA_OWNER_FLOWを新Variableとして登録せず、限定probe/alias-onlyの個別承認は代替しない。

生成ではPOST前の親・lease・既存DB identityの再照合、同PR新HEADのsmall plan再レビュー、同lease/DB/data保持を確認する。cleanupではcloseまたは対象PR/完全source SHA/現在leaseのrequest-releaseでdeletingとsafe plan IDを残し、owner承認run成功後の再要求・refresh・5分scheduleが全既知deploymentを扱う。scheduleはpool flag falseでもwriterを起動するが、承認なしでVercel/Neon資源を変更しない。alias・全deployment・Native branch/endpointの直接GET消失確認後だけfreeとなることを確認する。旧APPROVED_HEADS/DELETE_APPROVALSは一致する既存入力の読取互換を保ち、runtime flagsや通常有効化を自動変更しない。

2026-10-13の今回最終構成で `npm run lint`（警告0）、`npx tsc --noEmit --incremental false`、`npm run build`、`git diff --check` が成功した。`CAKE_LOCAL_PGLITE_MODULE` を指定した全suiteは842成功・skip 0・失敗0。SQL回帰はrepository外のPGliteメモリDB4個・67ケースで成功し、実DBへの接続・SQLは0だった。新しいowner protocol、CLI、HTTP provenance/CI gate、intention回復、alias直前失効、DB消失・識別不一致、既存多枠・満枠・旧lease・全SHA記録の回帰を含む。追加コードと文書のtoken・接続文字列・実Neon hostname検査は0件。mock・静的workflow検査と新経路の実Actions/Native lifecycleの実測を区別する。

2026-10-13のread-only APIでtyask/Cakeがpublicであることと、既存runのcaller/reusable workflow path・独立SHAを確認した。run APIは公開資源なら追加のActions read権限なしで利用できる仕様だが、新経路の短命GITHUB_TOKENによる実実行はmain導入後の確認事項である。API拒否時に無認証へ切り替えたりscopeを追加せず停止する。一次資料の確認では、GitHub Free公開repositoryの基本ActionsとDeployment APIを使える一方、default branchにworkflowが存在するだけではmain固定・owner専用にはならない。rerunはinitial actorの権限で動くため実行者の再照合が必要。public Deploymentsは認証なしでも読める。根拠は[手動実行](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)、[run API](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run)、[Deployments API](https://docs.github.com/en/rest/deployments/deployments#get-a-deployment)、[GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)。

## 過去のREADY probeのalias限定操作とcleanupの検証

2026-10-13。対象は `codex/qa-ready-alias-safety` の専用worktree。本変更は既存READY probeのalias-only入口、対象PRだけのcleanup、承認入力と診断出力のprivacyを確認する。過去のPR #34のテスト数・workflow parser結果・公開許可を、この変更の成功証拠や操作承認として流用しない。

## 対象と保持条件

- 既存PR #37のhead、qa1のlease、READY deployment、Native DBと入力データを保持する。今回の作業から実alias割当、deployment/DB作成、cleanup、実DBへのSQL、remote設定変更を行わない。
- `alias-only` は既存のheld / purpose: probe / READYを使い、追加claim、全OPEN PR列挙、global reconcile、新deployment/DB作成を行わない。通常運用のflagを有効化しない。
- alias承認はprojectId/pr/headSha/slot/leaseId/deploymentId/database/alias/expiresAtの9項目だけ。hostを含む完全DB identityをprivateに照合し、対象不一致・期限切れ・未知項目は停止する。
- aliasAssignmentのpendingを先に保存し、exact GET一致でassignedへ進む。再実行時のpending＋GET nullは盲目的に再POSTせず保持する。応答喪失・assigned台帳保存失敗は再GETによる確認で復旧する。
- closeはそのPRの既存leaseだけをcleanupする。全記録deployment IDとalias有無の記録を維持し、pending不明なら停止、assigned aliasのGETがnullなら他の消失確認を継続する。Vercel資源とNative branch/全endpointの消失後だけfreeとする。

## 承認と診断出力

診断・CLI/console・報告からDB host、deployment URL、接続文字列、資格情報を除き、安全なIDと判定だけを示す。表示された削除計画はコピー可能な承認JSONではなく、完全DB identityと期限は別のprivateな承認入力を使う。削除によるQA DBと入力データの喪失、deploymentの復元がDB復旧を保証しないことを報告する。

Actions callerは既存repository Variableの本番host・削除承認JSON・alias承認JSONを一時的なworkflow_call secretsへ渡す。remote Secretの登録・移動、値や権限の変更は行わない。Preview Environmentの同名Variable overrideを引き継いだと推定しない。出力の除外とrunnerのmaskは別の防御で、過去ログの消去や実Actionsのmask検証は完了扱いにしない。

`CAKE_QA_APPROVED_HEADS` のunset・空文字・空白だけは空objectとして承認なしにする。不正な非空JSON、正の安全な整数でないPR key、完全SHAでない値は拒否する。alias-onlyの個別承認を通常生成の承認やpool有効化に変換しない。

## ローカル確認

2026-10-13の最終構成で `npm run lint`、`npx tsc --noEmit --incremental false`、`npm run build`、`git diff --check` が成功した。`npm test` は588成功・任意PGlite検証1件skip。その後、PGlite 0.5.8をrepository外の一時ディレクトリへ導入し、`CAKE_LOCAL_PGLITE_MODULE` を指定して同じ全suiteを再実行した結果、589成功・skip 0・失敗0だった。buildとPGlite実行時は実DB接続用の環境値を外し、実DBへのSQLは行っていない。

回帰には9項目承認の厳密照合、createなし、pendingのblind retry拒否、要求IDと異なるREADY応答の拒否、GET一致からのassigned復旧、対象PRだけのclose、assigned alias消失後のcleanup継続、全deployment IDとNative消失前の貸出保持、承認JSONのprivate受渡し、診断経路のhost非出力、空head承認と不正入力拒否を含む。独立レビューで見つかったGET応答のdeployment ID一致不足は、serviceとgatewayの両方で修正し回帰を追加した。

ローカルmock、workflowの静的検査、PGlite一時メモリDBのSQL回帰は、実ActionsやNeon cloud lifecycleの検証とは区別する。テスト件数と成功結果は、この変更の最終構成で実行した証拠だけを記録する。

PGlite補助検証の再現例（実環境の接続情報は使わない）:

```bash
npm install --prefix /tmp/cake-db-safety --no-save --no-package-lock --ignore-scripts @electric-sql/pglite@0.5.8
node --import tsx scripts/verify-preview-database-safety.mjs --pglite-module /tmp/cake-db-safety/node_modules/@electric-sql/pglite/dist/index.js
```

## 公開と実地確認の境界

mainへのmergeはユーザーだけが行う。mergeは自動Production deploymentと既存の本番build・DB更新処理を起動し得るため今回実行しない。main導入後のalias割当とcleanupは別の対象・期限付き承認を必要とする。PR #37は既に返却済みでqa1はfreeとして保持し、今回のコード追加を再取得や他PRへの実資源操作の承認へ置き換えない。

同じActions writerのqueueは直列化するが、外部writerとのalias競合にprovider APIのatomic保証があるとは扱わない。この変更による実queue、owner承認・生成・固定URL更新・cleanupの一連の動作は未検証として残す。旧コードでのPR #37返却は2026-10-13のrun 38383396610とfree台帳7036042481で確認済みだが、新承認経路の実証として流用しない。資源消失も開始済みFunction/transactionの即停止保証ではなく、cancelや処理終了の監視は現writerに未実装である。

# 固定QA枠の運用（適用前）

Git枠は `qa1` / `qa2` / `qa3`。開発・PRは引き続き独立した `codex/<task>` で行う。QA枝をmainへマージしない。通常PRのコードをそのまま固定枠へ配置し、同じGit枝のNeon Native Preview DBを再利用する。

## 現時点の確認と未適用事項

2026-10-12: mainは `1877f0ff88b5250225db5d590a06e3c1e656ecb9`。`git ls-remote`でqa1/2/3は存在しないことを確認。別作業PR #33の `codex/dedupe-autosave` は `5776adfca96d17d166234c4a38d7c286bb47982a` のまま保持する。

このPRは設定案と道具を追加する。main変更・merge・Production公開・QA枝作成・台帳枝作成・DB操作は行っていない。Vercel `fumin1/cake` (`prj_Z37vquodhpRd08ZTAtYnP0qa59jD`) はMCPで403、既存CLI認証ではuser読取404。Neon読取ツールも利用できないため、実alias・DB枝名/ID・integration・retentionの現在値は未確認。既存リソースの識別情報 `cake-preview` / `misty-meadow-88903426` は依頼で提供された値であり、APIによる再確認はできていない。

## 名前とURL

自動branch URLは `<project>-git-<branch>-<scope>.vercel.app`。teamの名前とslugは異なることがあり、`fumin1`から実URLを推定して台帳やallowlistに登録しない。

末尾を `fumin` にしたい場合、team slugを変更すると本番や他プロジェクトの命名にも影響し得る。無影響な候補はPreview固有の追加alias `cake-qa1-fumin.vercel.app` / `cake-qa2-fumin.vercel.app` / `cake-qa3-fumin.vercel.app`。**これらは希望名であり、取得済みURLではない。** 全世界での衝突とVercelの割当許可は実APIで確認する必要がある。自動branch URLとは別で、デプロイごとの再割当が必要。別プロジェクトの既存aliasを奪わず、新規Previewだけに追加する。本番domain・project name・team slug・Preview suffixを変更しない。使用可否が未確認の間は自動branch URLを実デプロイから取得する方式を優先する。

確認後の3つの実ホストをユーザーへ提示してからcloud allowlistを登録する。wildcard対応は未確認。ネットワーク拒否・SSO・Deployment Protectionを迂回しない。新規資格情報、永続アクセス、ネットワーク制限変更が必要なら別承認を求める。

## 自動デプロイの範囲

`vercel.json` の `git.deploymentEnabled` は `**: false` と `main/qa1/qa2/qa3: true`。minimatchの`**`はスラッシュを含む `codex/...` も対象とする。Vercel公式仕様では重複規則にtrueがあればデプロイされる。`main`の既存Production動作は維持する設定だが、本PRでmainには適用しない。

これは**その設定ファイルを含むGitコミットの自動デプロイ**を制御する。古いPR枝・設定を持たない枝、手動CLI/API/Deploy Hook、既存デプロイ削除を止めるプロジェクト全体の禁止ではない。通常PRの停止が全枝へ適用されたと見なさない。Ignored Build StepはintegrationのDB作成後に実行される可能性があるのでDB増殖対策の代用にしない。

移行時はユーザーが設定PRを確認・mergeした後、利用するPR枝を更新してこの設定を含める。古い枝の自動Preview停止については実挙動を確認し、project側で確実に止める設定があるかを調査する。新規設定ありcodex枝（スラッシュ付き）で「deploymentなし・Neon枝増加なし」、qa1で「Preview READY・専用DB1枝」、同じqa1再pushで「DB枝ID/endpoint不変」を確認する。停止設定の動作が確認できるまで通常Previewの無制限作成を再開しない。既存の `deploy:preview` / `task:pr` は通常codex枝Preview前提なので、移行後はそのまま使うと待機失敗する。本運用のdraft PRは `gh pr create --draft`、検証はQA Deployment固有URLと完全SHAを記録する。

## 台帳の選択肢（Deployments方式を設計採用・未実装）

管理ブランチ案は保留。代替としてGitHub Deployments台帳＋短いActions直列化を設計に採用する。台帳・管理DB・Environment・Issueは作成していない。必要な権限とcloud検証が未承認/未完了のため予約/解放CLIやworkflowは追加しない。コードは `lib/qa-pool.ts` の保存先に依存しない状態遷移のみで、まだ利用者へ枠を貸し出す仕組みはない。

| 候補 | 追加サービス・認証・コスト | 排他 | レビュー中の保持・注意点 |
| --- | --- | --- | --- |
| 専用GitHub Issue（1件に3枠） | 既存GitHubと通常API認証を再利用、DB不要 | Issue本文の同時更新だけでは厳密なCASを保証しない。単一管理者/直列dispatcher等の追加が必要 | OPEN IssueにPR/SHA/状態を保持でき、一覧性が高い。closeを自動解放にしない |
| GitHub Deployments / Environments（設計採用） | 既存GitHub、管理枝/追加DB不要。Actions実行分数とdeployments:write権限の確認が必要 | 標準deploymentはロックではない。短い単一writer jobでclaim/drain/releaseを直列化 | 専用payloadを台帳として長期保持。job完了や無関係statusでは解放しない |
| 専用管理DBテーブル | Neon既存test project内の管理用DB/枝を使えれば新projectは不要。ただし接続認証/権限/容量/料金/retentionの確認が必要 | 枠主キー＋transaction/CAS、世代tokenで競合と旧解放を防げる | 長期貸出を自然に保持。QA clone/reset/Native cleanupの対象から分離が必須 |
| 専用Git管理枝（保留案） | 既存GitHub/Git認証を再利用、追加DBなし | 旧台帳commitを親に通常fast-forward pushし、同時更新の兄弟commitを拒否。forceで競合を上書きしない | Git履歴で貸出を保持。管理枝は全自動デプロイfalse。ユーザーの再検討指示により未実装 |

Git管理枝はユーザー指示により保留。第一候補のDeployments方式は後述のlease protocolが必要で、GitHubが標準の永続ロックを提供するという意味ではない。Issueは単一管理者の手動予約なら最小で、自動化時は同様の直列writerが必要。管理DBはtransactionで排他できるが、QAから分離した接続と保全の確認が先になる。

既存 `cake-preview` mainに管理テーブルを置く案: 新DBを作らずに置ける可能性はあるが、現在のmain用途・Native親枝・権限は未確認。QA枝がmainをcloneすると台帳と操作者情報も各QAへ複製され、どの台帳が正本か曖昧になる。reset・migration・seed・親枝の削除やcleanupで台帳を失う可能性もある。正本はQAとは別の専用管理DB/枝とし、QA親からcloneされないこと、アプリのschema/reset対象から除外されること、Native最終deployment削除とretentionに巻き込まれないことを確認する必要がある。DB名を変えるだけで保全境界ができるとは扱わない。管理DB用の新規資格情報・永続アクセス・権限変更が必要なら別承認。今回スキーマや権限は変更しない。

GitHub読取でEnvironment `Production` / `Preview` の存在を確認した（両方ともprotection_rulesなし）。現在のOPEN Issuesの一覧にはQA管理台帳と分かるIssueは見つからなかった。EnvironmentやIssueは変更していない。過去のclosed Issueや別保存先まで不存在を保証するものではない。

## Deployments台帳＋Actionsの設計

管理用GitHub Environmentsはqa1/qa2/qa3（既存Preview/Productionは変更しない）。Environmentだけでは貸出を保持しない。台帳はGitHub Deploymentのimmutable payloadとする。専用 `task: cake:qa-lease`、`payload.type: cake-qa-lease/v1` を持つ記録だけを読み、Vercelの通常task=deployを混ぜない。

payloadにはop（claim/drain/release）、slot、PR、完全source SHA、lease ID、操作者、予約時刻、request ID、対象claim deployment IDを記録する。releaseには停止確認report URLと待機deployment IDも含める。秘密情報は含めない。GET deploymentsのtask/environment filterと全ページ走査を使い、GitHub IDで順序を検証して専用イベントを再生する。未知schema、重複claim、対応しないrelease、API失敗は空き扱いせず停止する。

- 全claim/drain/releaseと失敗回復の書込みは**1つの短いdispatcher job**だけが行う。固定concurrency groupを全枠・全操作で共有し、`queue: max`、`cancel-in-progress: false`。group名にPR/SHA/actionを含めない。cloud build/provision/cleanupの長時間処理をこの排他区間で実行しない。
- 最新GitHub公式仕様の `queue: max` は最大100pending、満杯では新requestがcancelされる。default queueはpendingを置換するので `cancel-in-progress: false` だけでは不十分。FIFOは待機開始順であって入力順を保証しないので、毎回現在のlease ID/stateを読み直す。queueからcancelされたrequestは未予約であり、provisionしてはいけない。
- claimはOPEN PRと固定SHA、空き状態を検証し、専用claim Deploymentを**provision前に**永続化する。`ref`は完全SHA、`auto_merge:false`（GitHubの既定trueで勝手にmergeしない）、`production_environment:false`、`transient_environment:false`。台帳claim時の`required_contexts:[]`はCIを代用しない。実配置前に当該SHAの必須CIを別途確認する。
- HTTP成功を確認してlease ID/claim IDを得たjobだけが配置へ進める。request IDで重複を検出し、API応答が失われた場合は再読取して確定する。claim後にworkflow/build/provisionが失敗してもheld/cleanup待ちで保持する。初期status追加に失敗してもclaim payloadがあれば使用中。
- drainは同じlease IDを確認して永続記録し、新配置を止める。cleanup完了後のreleaseだけが同じlease ID/claim IDと停止証跡を確認し、専用releaseイベントを永続化して空きにする。PR close/mergeやworkflow完了はreleaseの候補通知に留め、cleanup確認なしにfreeへ変えない。
- **GitHub deployment statusのsuccess/inactive/failureを貸出正本にしない。** 表示用statusをPOSTするときは毎回 `auto_inactive:false`。公式仕様のauto_inactiveは同repo/environmentの成功済みdeploymentに作用し、taskでの分離は保証されない。無関係なVercel statusが専用記録をinactiveにしてもpayloadを再生すればheldのまま。明示protocol release payloadだけが解放を表す。
- dispatcherは信頼済みdefault branchのコードだけを実行し、PRコードをwrite token付きでcheckout/実行しない。`deployment`イベントからの再帰実行を作らない。専用taskのdeploymentイベントが外部integrationのデプロイを誘発しないことも適用前に確認する。

これはGitHub Deployment APIのCAS/unique constraintではなく、単一writerを前提とするアプリ側protocol。別workflowや通常APIから台帳を直接更新すると排他を失うので、書込み経路をdispatcherに統一する。repo管理者等の権限を超える強制ロックではない。権限設定を新しく拡大してその穴を埋める操作は今回行わない。

### 追加承認・実検証が必要な範囲

既存CIはcontents:readだけ。新dispatcherにはjob限定の `deployments: write` と読み取りが必要で、権限追加の承認後に実装・適用する。新資格情報を作らず短命GITHUB_TOKENを使う設計。Environments qa1/qa2/qa3の作成も設定変更なので承認後。cloud更新の認証は別で、既存Vercel/Neonの認証が読取確認できるまでprovisionしない。

公式文書ではqueue:max対応を確認したが、Cake上の新workflowを実行していない。承認後、2件同時claim・claim/release競合・古いlease ID解放・job失敗/キャンセル・request重複・API応答喪失・無関係status auto_inactive・全ページ読取を回帰検証する。GitHub deployment payloadとstatusが貸出に影響する範囲、Environment作成や外部integrationの副作用も確認する。実仕様が使えない場合は勝手にpending置換へfallbackせず停止して報告する。

## 保存先によらない使用中判定

枠ごとにstate（held/draining/free）、PR番号、完全source SHA、GitHub操作者、予約時刻、一意の世代tokenを保持する。freeだけ空き。heldもdrainingも使用中。PR close/merge、CI失敗、時間経過、作業停止では解放しない。GitHub concurrencyはjob終了時に解放されるのでレビュー期間の貸出根拠にしない。

予約はCake内のmain向けOPEN PRの完全head SHAを記録する。二重取得を防ぐ保存先のatomic更新が成功してから配置できる。世代tokenは認証秘密ではなく、古い作業者が新貸出を誤解放しないための識別。返却は同じtokenでheld→draining→freeと進め、同じPRの停止確認コメントURLを記録する（コメント投稿には許可が必要）。失敗・停止確認不能はdrainingのまま。`lib/qa-pool.ts` はこの規則を回帰検証する純粋関数で、クラウド停止や排他保存を実施しない。

## 配置前のDB照合と記録

1. 必ず先に枠を予約する。使用元は採用した台帳に記録した **そのPRの完全head SHA**。PR更新後の別SHAを黙って配置しない。更新時は一度返却準備・停止確認・返却して新headで再予約する。
2. 初回QA枝作成前に、使用元SHA、予定Git枠、生成されるPreviewとNative DBの範囲をユーザーへ説明する。qa枝の名前衝突を `git ls-remote` で再確認。枝作成は空期待値でpushする。
3. 元コミットに本PRの自動デプロイ設定とDB照合コードがあることを確認する。Neon Console/APIで本番とは別のproject `misty-meadow-88903426`、専用test branch、parent、endpointを確認する。本番データをコピーした枝なら使用しない。Native branchingの親に本番データがないことも必須。
4. 初回Native枝の作成でendpointが未確定なら、DBを使わない待機deploymentを先に同じqa枝へ配置してendpointを確認する。Preview枝別の非秘密 `CAKE_QA_DATABASE_HOST` に**実際に確認した専用endpoint host**を設定する。資格情報を新規作成せずNative供給の `CAKE_TEST_DATABASE_URL` を使う。`AUTH_MODE=test`、既存 `AUTH_SECRET`、test DB接続とProduction環境の分離を確認する。環境値取得では接続文字列をログに出さない。
5. QAではビルド・runtime・直接db:setup/seedのいずれも専用接続を選び、確認済みhostと照合する。pooled/unpooledの同一endpointも検出する。host不一致・slot不一致・専用接続なしはDBクライアント生成前に停止する。hostだけではNeon project/branchの所属を証明できないので手順3を省略しない。ローカルQAは `CAKE_QA_SLOT=qa1` と確認済みhostを設定する。本番 `DATABASE_URL` は代用しない。
6. アプリSHAをCASでqa枝へpushする。置換前SHAを取得し、`--force-with-lease=refs/heads/qa1:<旧SHA>`を使う。無条件force禁止。pushはqaだけに限定する。予約台帳は配置を自動実行しない。
7. 同じSHAのPreview READYを確認する。実際のdeployment ID、deployment固有URL、branch alias、Neon project/branch ID・実枝名・endpoint host、lease token、migration結果、seed結果、ブラウザ/APIの検証結果を**該当PRの検証コメント**へ記録する。接続文字列・資格情報は記録しない。aliasだけでSHAを判定しない。コメント投稿は明示許可がある場合だけ行う。

migrationは既存 `schema_migrations` とadvisory lockで未適用分だけ実行する。seedは固定testユーザーと共有workspaceを冪等登録するが、共有fixtureの属性・権限を再設定するため既存状態に影響する。DB reset、TRUNCATE、DROP、全データ掃除は行わない。枠再利用でデータとschemaは残るので、試験データはPR/UUIDで区別し、旧schemaと互換性のないPRは固定枠へ配置しない。破壊的migrationの適用は別承認・専用環境を使う。

## 返却・旧処理停止・DB保持

保存方式を確定後、採用した台帳で同じ世代tokenの枠をheld→drainingへ変更する。

`draining`はまだ使用中。新予約・新配置を止める。PRがmerge/closeしていても、次の停止確認が完了しない限り空きにしない。

1. 同じ枠のQUEUED/BUILDING deploymentを全てcancelする。migrationのadvisory lockだけでは旧アプリの書込みを止められない。終了済みbuildにもdeploymentが残る。
2. `docs/qa-parking` だけをルートとする静的待機コミットをqa枝へCAS pushし、Preview READYを確認する。アプリ/API/DB/cronを含まない。同じGit枝を維持してNative枝を再利用する。aliasとdeployment固有URLの両方で待機ページとAPI不在を確認する。通常アプリの404画面へaliasを変えるだけではAPIを止められない。
3. 同じ枠の旧アプリdeploymentを列挙し、待機deploymentがDBを同じ枝で保持していることを確認した後、**その枠の旧deploymentだけ**を削除する。旧固有URL・独自aliasからもAPIが利用できなくなったことを確認する。元のcodex枝に作られた旧Native DBは別物なので削除対象を混同しない。Production・PR #33の資源は触らない。
4. cancel/deleteしても既に開始済みのFunction/SQLの即停止は保証されない。Function最大実行時間・build/DB実行状態を読み取り、実行中処理/transactionとDB書込みが止まるまで待つ。確認不能ならdrainingのままにする。資格情報のrevokeやネットワーク制限変更で強制停止しない。
5. Neon Nativeは同じGit枝のdeploymentでDBを共用し、最後のdeployment削除でDBも消える（依頼で提供された前提）。待機deploymentを最後まで残す。Vercel retentionの自動削除・Neon cleanup設定を読み取り確認し、待機deploymentが自動削除されない実現方法を確定する。現在未確認であるため、恒久保持を保証しない。保持のため課金・plan・権限変更が必要なら別承認。保証できない場合は解放せずblocked/drainingとして報告する。
6. 該当PRへ旧deployment IDs、cancel/delete結果、旧URL/API停止、実行処理停止、待機deployment ID/URL/SHA、Neon branch ID不変、retention確認の結果を記録する（投稿許可が必要）。この停止確認コメントURLを指定して返却する。

採用した台帳で同じ世代tokenと停止確認コメントURLを記録し、draining→freeへatomic更新する。

releaseは停止確認の**操作者による申告**を記録する。Vercel/Neon APIを自動照会して停止の正しさを検証するものではない。虚偽のURLや記録だけで停止できるとは扱わない。保存方式には返却記録と変更履歴の保全も求める。

待機コミットの作成例（以下は実行前に値と対象を確認する。新しい資格情報は不要）:

```bash
slot=qa1
old=$(git ls-remote --heads origin "refs/heads/$slot" | cut -f1)
git fetch --no-tags origin "refs/heads/$slot"
# oldは完全40桁SHA、FETCH_HEADと一致していることを確認する。
parking_tree=$(git rev-parse HEAD:docs/qa-parking)
parking_sha=$(git commit-tree "$parking_tree" -p "$old" -m "Park $slot before release")
git push "--force-with-lease=refs/heads/$slot:$old" origin "$parking_sha:refs/heads/$slot"
```

初回作成では親を付けず静的treeからcommitを作成し、期待値空文字でqa枝を作る。実際のDB生成と共有/保持はNative integrationの設定に依存するので、その確認ができない場合はこの手順も実行しない。

## 検証と段階適用

ローカル: lint、全test、build、TypeScript。貸出状態の上書き拒否・旧token拒否・停止記録の紐付け・DB不一致停止を回帰検証。cloud: 上記の設定あり/なし枝、再配置、返却、retentionの実操作は権限とネットワークがある環境で別途実施する。安全に読取できない間はQA枝/台帳枝を作成せず、draft PRでレビューする。未確認のURLとDB名を生成済みとして報告しない。

参照: [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)、[Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[GitHub Deployments API](https://docs.github.com/en/rest/deployments/deployments)、[Deployment statuses API](https://docs.github.com/en/rest/deployments/statuses)、[Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration)、[Generated URLs](https://vercel.com/docs/deployments/generated-urls)、[Neon Vercel cleanup](https://neon.com/docs/guides/vercel-branch-cleanup)（この作業ではNeonページ取得に失敗、Native共有/cleanupは依頼の前提）。

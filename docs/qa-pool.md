# QA貸出枠の運用

`qa1` / `qa2` / `qa3` は同時に貸し出せる検証枠の名前であり、Gitブランチではない。開発・PR・Vercel Previewは各PRの `codex/<task>` 枝を使い、Neon Native Preview DBもそのfeature枝に対応させる。同じPRの更新では同じleaseとDBを保持し、返却後に別PRへ貸し出すときは新しいDBを確認する。固定QA枝、台帳枝、DB保持用parking deploymentは作らない。

## 現在の適用状態

対象はGitHub `tyask/Cake`、Vercel `fumin1/cake`（`prj_Z37vquodhpRd08ZTAtYnP0qa59jD`）、Preview専用Neonリソース `cake-preview`（project `misty-meadow-88903426`）。既存GitHub Environment `Preview` を使い、qa1/2/3用Environmentや管理DBを追加しない。

通常運用は無効のまま保持する。mainには既にREADYのprobe deploymentだけを扱う手動 `alias-only` と、その記録を保持する対象PRだけのcleanupがある。今回の診断改善はGET専用 `plan-release` の実効削除承認サマリーと固定コードの失敗分類を追加する。既存PR #37と `qa1` の `deleting` lease・deployment・DBはこの作業で変更せず、cleanupの再実行や新規生成を行わない。

Hobby向けのGitゲートはmainと稼働対象枝の `git.deploymentEnabled: {"**": false, "main": true}` を照合する。設定のない古い枝・直接REST/CLI・外部callerまで停止する保証はない。Actionsの単一writer queue、alias割当・衝突時の挙動、最後のdeployment削除後のNative branch/endpoint消失は実地未検証のまま扱う。認証scope、個別操作承認、実証結果を混同しない。Vercel Proや新Secret・追加権限をこの変更の条件にせず、既存Neon planの無料枠や無課金も保証しない。

PGliteの実SQL検証はローカルWASMの一時メモリDBを使い、実環境の接続情報を読み込まない。Neon上のmigration・seed・Native lifecycleの実測とは区別する。再現方法と実施状況は [検証報告](qa-pool-verification.md) を参照する。

## URLと貸出数

追加alias候補は `cake-qa1-fumin.vercel.app` / `cake-qa2-fumin.vercel.app` / `cake-qa3-fumin.vercel.app`。取得済みURLではなく、実APIによる割当許可と衝突確認が必要。team slug、project名、本番domain、Preview suffixは変更しない。自動branch URLもteam名から推定せず、実deploymentから取得する。

更新直前に同じleaseが `held`、PRがOPEN、現在head SHAとREADY deployment SHAが一致することを確認してaliasを付け替え、更新後にproject IDとdeployment IDを読み取る。他projectや別leaseのaliasは上書きしない。衝突・API失敗は貸出を保持して停止する。空き期間にも `.vercel.app` 名を予約保持できる公式API保証は確認できていないため、候補名の恒久確保を約束しない。3枠とも使用中なら待機し、枠未取得PRのVercel deploymentやNeon branchを生成しない。

## 生成前に止めるGitゲート

[公式Git設定](https://vercel.com/docs/project-configuration/git-configuration) の `vercel.json` / `git.deploymentEnabled` をmainと稼働対象枝へ入れる。運用する値は次のmain-only設定とし、mainのProductionを維持する。

```json
{"git": {"deploymentEnabled": {"**": false, "main": true}}}
```

minimatchの `**` はスラッシュを含む `codex/...` も対象にする。未指定枝はtrue、複数の規則に一致するとtrueが優先されるため、main以外をtrueにする規則を禁止する。今後のfeature枝はこの設定を導入した最新mainから作り、追加commitでも設定を保持する。

writerは同一repositoryのmainと対象PRの現在headを完全SHAで特定し、そのcommitの設定を読取・検証する。枝名からローカルの別commitを読んだり、設定のない対象をmainの設定だけで補ったりしない。貸出取得前と各REST POST直前に両方を再照合し、SHA変更、設定の欠落・不正、main以外のtrue、repository不一致、読取不能は生成前に停止する。通常の `task:pr` / `deploy:preview` もpush前にmainと対象HEADの完全SHAの設定を確認し、push元refspecを検証した完全SHAに固定する。非同期にHEADが移動しても未検証commitを送らない。生成flagはこの確認の代用にならない。

これは枝と承認済みwriter/CLIの運用規約であり、project全体の強制停止ではない。設定のない古い枝、設定を変更するpush、直接REST/CLI、first-party callerは迂回し得る。既存deploymentやNeon branchを削除する効果もない。全稼働枝の監査と実際のGit停止を確認するまで `CAKE_QA_GIT_GATE_CONFIRMED` をtrueにしない。REST Nativeの実証前に `CAKE_QA_NATIVE_CONFIRMED` もtrueにしない。対象と期限を承認した限定probeだけは、mainと対象PRの設定導入後に通常運用のflagをfalseまたは未設定のまま実行できる。probe成功をflag更新へ自動変換しない。

Ignored Build Stepはdeployment作成後に働き、Native integrationはアプリbuild前にDBを作るため、DB生成前ゲートの代用にしない。`gitProviderOptions.createDeployments` はGitHub Deployments記録の通知設定であり、Vercel生成停止ではない。Preview全体を停止する `previewDeploymentsDisabled`、有料Deployment Policies、未検証のAPI fieldや新しい抜道flagを代替条件として追加しない。

### mainへの導入と公開

mainへのmergeはユーザーだけが行う。mainのProductionを維持するGit設定により、mergeは自動Production deploymentと既存の本番build・DB更新処理を起動し得る。本変更のローカル実装・検証と、mainへの導入・実alias割当・cleanupの承認は分け、今回mergeや実資源操作を行わない。既存PR #37のheadと `qa1` を保持し、導入後の個別操作もその時点の台帳と実資源を再照合する。

削除承認Variableが非空なら、通常poolが無効でも既存scheduleはwriterを起動する。mainへ診断コードを導入した後も、scheduleは既存の `deleting` leaseを新mainで再照合し、完全一致の有効な承認があればcleanupを進め得る。診断改善はこの条件を変更せず、GET診断の先行を保証する停止設定でもない。merge前に承認期限と実行中・待機中のworkflowを確認し、運用停止や承認の変更が必要なら別途承認を得る。期限切れは削除を許可しないが、Variableが非空である限りschedule起動条件には残る。

## 正本と短い単一writer

正本はGitHub Deploymentのimmutable payload snapshot。専用 `task: cake-qa-lease`、`environment: Preview`、`payload.protocol: cake-qa/v1` の記録だけを扱い、通常のVercel記録を混ぜない。全ページを取得し、GitHub deployment ID順に各枠の `sequence` と `previousRecordId` を検証する。未知protocol、系列の分岐、重複所有、API失敗は空き扱いせず停止する。

payloadは枠、PR番号、feature枝、完全head SHA、lease UUID、`held` / `deleting` / `free`、作成・更新時刻、作成intent、全deployment ID/SHA/phase、READY deployment、Native DB identity、返却済みDB識別子を保持する。限定aliasは `aliasAssignment: {alias, deploymentId, sha, state}` の `pending` / `assigned` を記録し、`purpose: probe` を維持する。hostは内部の台帳・照合で使うが、診断・CLI・報告へ出さない。秘密情報や接続文字列は保存しない。新snapshotは直前の記録へ連結し、既知deployment、alias対象、返却済みDBの識別記録を消さない。

書込みとclaim/release/alias mutationは信頼済みmainコードを使う1つの短いActions writerだけが行う。`pull_request_target`、`workflow_dispatch`、`schedule` が同じwriterを起動する。全枠・全操作で固定concurrency group、`queue: max`、`cancel-in-progress: false` を共有する。PRコードをwrite token付きでcheckout・実行しない。開発者のローカルCLIは読取専用で、直接予約・配置・解放しない。

限定実証の貸出はsnapshotの `purpose: probe` で通常運用と区別する。probeの継続は明示した手動入口だけから行い、PRイベントやscheduleから生成を自動継続せず、候補aliasも自動更新しない。probeも同じ3枠と単一queueを使い、失敗・期限切れ・承認不足で既存leaseやDBを解放しない。

長いbuildやcleanup完了待ちは排他区間で行わず、intentを保存してAPI操作を開始し、後続の短い実行で照合する。`queue: max` は実行中1件＋最大100pending、満杯時は新requestがcancelされる。FIFOはgroupの待機開始順で入力順ではない。cancelされたrequestは未予約とし、毎回最新snapshotとleaseを読み直す。pending置換方式へfallbackしない。

GitHub Deployment作成は完全SHAを `ref` に指定し、`auto_merge: false`、`production_environment: false`、`transient_environment: true`。台帳の `required_contexts: []` はアプリの必須CIを代用しない。現writerはstatusを書き込まない。将来表示用statusを追加する場合も `auto_inactive: false` を明示する。statusのsuccess/inactive/failure、PR close/merge、workflow完了、時間経過で貸出を解放しない。status履歴は90日で削除されるため、正本をstatus履歴へ依存させない。

これはGitHub APIのCASや永続ロックではなく、単一writerとsnapshot系列を前提としたprotocol。別workflowや通常APIから専用taskへ直接書き込まない。

## 無効のままレビューする設定

通常運用の生成・自動alias更新は `CAKE_QA_POOL_ENABLED=true` のときだけ行う。適用前はfalseまたは未設定で保持する。GET専用の `preflight` / `plan-release`、5項目承認の限定 `probe`、9項目承認の既存READY probe向け `alias-only` は別入口とする。alias-onlyのためにpool/確認flagをtrueへ変えず、通常生成のhead承認も追加しない。次は確認・承認情報の契約であり、今回remoteへ登録・変更しない。

| 設定 | 確認・承認の範囲 |
| --- | --- |
| `CAKE_QA_POOL_ENABLED` | 通常運用の有効化。生成前ゲートとNativeの実証が完了した後に明示承認でtrueにする |
| `CAKE_QA_GIT_GATE_CONFIRMED` | 全稼働枝のmain-only設定監査と実際のGit自動生成停止の確認結果。通常運用はflagに加えmain/対象PRの完全SHAの設定を毎回確認する。限定probeのために先にtrueへ変更しない |
| `CAKE_QA_NATIVE_CONFIRMED` | REST Git deploymentのNative動作を確認した後の通常運用条件。初回実証のために先にtrueへ変更しない |
| `CAKE_QA_PARENT_BRANCH_ID` | 読取確認した承認済みQA初期fixtureのNative親branch ID。実際の子DBでも初回fixtureを厳密照合する。Native親選択の実証完了を設定値だけで保証しない |
| `CAKE_QA_APPROVED_HEADS` | 通常運用のPR番号→レビュー済み完全head SHAのJSON object。unset・空文字・空白だけは `{}` として承認なし。不正な非空JSON、正の安全な整数でないPR key、完全SHAでない値は拒否する。probe/alias-onlyの個別承認とは別に扱う |
| `CAKE_QA_PROBE_APPROVALS` | repository variableのJSON配列。各要素は `projectId` / `pr` / `sha` / `slot` / `expiresAt` の5項目だけを持ち、現在head・対象project・枠が一致し、期限内の限定probe承認だけを使う |
| `CAKE_QA_DELETE_APPROVALS` | privateなJSON配列。project・PR・枠・lease・完全head SHA・全deployment ID・alias・完全DB identity・期限が一致する削除承認だけを使う。callerは既存repository Variableを一時的なworkflow_call secretへ渡す |
| `CAKE_QA_ALIAS_APPROVALS` | privateなJSON配列。各要素は `projectId` / `pr` / `headSha` / `slot` / `leaseId` / `deploymentId` / `database` / `alias` / `expiresAt` の9項目だけ。既存READY probeに完全一致する期限内承認を使い、callerは既存repository Variableを一時的なworkflow_call secretへ渡す |

既存Vercel tokenとNeon API key、Actionsの短命 `GITHUB_TOKEN` を使う案。`deployments: write` 等の必要権限と既存Environment `Preview` の実行・承認方針も適用前に確認する。新Secret・資格情報や権限を勝手に追加しない。Vercel-managed NeonのCLI/APIにはNeon API keyが必要で、一般のproject-scoped keyもEditor権限を持ちread-onlyとは限らない。

認証に成功したことやtokenの書込みscopeは操作の承認を意味しない。通常運用の有効化、特定headの生成承認、特定ID集合の削除承認、Native/cleanupの検証結果を分けて扱う。一括の削除許可booleanは使用しない。期限切れ・不明・対象不一致は操作を停止し、承認対象を広げない。新しいSecretの配置、追加scope、ネットワーク変更、本番操作は今回の許可範囲外のまま。

## GET専用preflightと限定probe

`preflight` は `CAKE_QA_POOL_ENABLED` や確認flagをtrueにせず実行できる読取入口。既存認証でVercel project/link、同一repositoryのmainの完全SHAとGit設定、GitHub台帳とrepository Variables名、Neon projectとbranch/endpoint件数を確認し、各読取・照合の成否と不足するVariable名を報告する。GET以外を拒否するtransportを使い、台帳snapshot、deployment、alias、環境変数、DBデータを作成・更新・削除しない。Variableの値やAPI全文は出力せず、読取成功だけで通常運用やNativeを確認済みに変更しない。親DBのfixture、Nativeの親選択や対象PRの実配置をこのmetadata読取で証明したとは扱わない。

`plan-probe` もGET専用。対象PR番号・レビュー対象の完全SHA・希望slotを指定し、同一repositoryのOPEN PR/current head、main/対象PRの完全SHAのGit設定と枠の状態を照合する。生成予定のproject・PR・feature枝・SHA・slot、最大追加deployment数、alias変更なし、別途削除承認が必要であることと読取のブロッカーを計画として返す。計画が出ても生成承認やNative実証完了を意味しない。

読取入口はローカルまたは信頼済みmainの手動workflowから実行できる。以下の `qa_pr` / `qa_sha` / `qa_slot` / `qa_lease` は読取で確認した非秘密識別値を使う。既存の認証値は表示せず、不足時は不足を報告するところで停止する。

```bash
QA_ACTION=preflight node --import tsx scripts/qa-pool-writer.ts
QA_ACTION=plan-probe QA_PR_NUMBER="$qa_pr" QA_SOURCE_SHA="$qa_sha" QA_SLOT="$qa_slot" node --import tsx scripts/qa-pool-writer.ts
QA_ACTION=plan-release QA_PR_NUMBER="$qa_pr" QA_LEASE_ID="$qa_lease" node --import tsx scripts/qa-pool-writer.ts
```

生成を伴う初回実証は `probe` を明示した手動実行に限る。信頼済みmainのコードと通常writerと同じqueueを使い、同一repositoryのOPEN PR、レビュー済みの現在完全head SHA、指定project・slotが `CAKE_QA_PROBE_APPROVALS` の5項目だけの1要素と一致し、`expiresAt`が現在より後であることを生成直前に再確認する。mainと対象PRの完全SHAにmain-only Git設定がなければprobeも開始せず、ブロッカーを報告する。設定済みの限定probeはpool/Gitゲート確認/Native確認flagをfalseまたは未設定のまま実施できる。通常生成はこのGit設定に加えて3つのflagがtrueであることを必要とする。

probeはclaimとintentを先に保存し、REST `gitSource` でNative DBをアプリbuild前に生成する。初回host未確認ならDBクライアント作成前に停止するdeploymentを作る。そのIDを保持してNative所属・親・作成時刻・branch/endpointをGETで照合し、必要な次の手動probeで同lease・同feature枝のphaseがapplicationの検証を進める。固定aliasは自動更新せず、Deployment固有URLと完全SHA、Native identityと親選択、build/runtimeへのguard注入、初回DB受入条件の照合、migration/seedの結果を実証記録へ残す。同PRへの追加pushは新headのレビューと期限付きprobe承認を更新し、同lease・同DBを維持する。新PRは新しいGit refとDBを使う。

probe承認は台帳・Previewの限定生成を許すもので、削除や新しい資格情報の登録を許すものではない。実証後の返却は別のGET専用計画と削除承認を使う。実証で成功した場合も、flagを自動変更したり通常運用へ切り替えたりしない。

通常運用では、同PRへの追加pushも新しい完全head SHAのレビューと `CAKE_QA_APPROVED_HEADS` の承認更新が必要。probeは別の期限付き `CAKE_QA_PROBE_APPROVALS` を使う。承認なしのheadで新deploymentを作成・alias更新しない。非秘密guard値は作成requestの `env` / `build.env` に限定して渡す案で、feature枝やproject/branch環境変数をremote更新しない。公開REST create schemaにはこのfieldの記載がない一方、[公式clientのDeploymentOptions](https://raw.githubusercontent.com/vercel/vercel/main/packages/client/src/types.ts) は両fieldを定義し、[POST処理](https://raw.githubusercontent.com/vercel/vercel/main/packages/client/src/deploy.ts) は除去せずrequest bodyへ展開して [v13 endpoint](https://raw.githubusercontent.com/vercel/vercel/main/packages/client/src/utils/index.ts) に送る。これは一次資料による実装根拠であり、公開REST schemaの保証と区別する。client自身はfilesを付ける経路でgitSourceを定義していないため、writerのfilesなし `gitSource + env/build.env` の受理・build/runtime注入・Native動作は推論に留まりlive未検証。失敗・注入欠落はguardで停止し、有効化前に実測する。`files` と `gitSource` は公式仕様で併用不可。

本番endpointとの比較には既存repository Variableの非秘密 `CAKE_QA_PRODUCTION_DATABASE_HOST` を使い、読取確認した実hostを使う。推定hostで補わず、接続文字列や秘密値を出力しない。ネットワーク拒否、SSO、Deployment Protectionを迂回しない。

QA読取検査のJSON/CLI・console・報告はdeployment URL・接続文字列・資格情報・raw DB hostを出力せず、allowlistしたproject/branch/endpoint/deployment ID等と判定だけを示す。表示された安全な削除計画は、そのままコピーできる承認JSONではない。内部の完全DB identityにはhostを保持し、別途承認されたprivate入力で厳密照合する。Gitゲートの証拠は `scope: repository-git-trigger-configuration` とmain/対象commit・blobの識別情報を持ち、`backendForcedDeploymentPreventionProven: false` のままとする。設定読取成功をproject全体の強制停止やlive実証完了として表示しない。

Actionsでは既存repository Variableの本番host、削除承認JSON、alias承認JSONをcallerの `jobs.secrets` から共通 `qa-private-run.yml` の一時的な `workflow_call` secretsへ渡し、calleeは対応するenv keyでprivateな照合へ供給する。remote Secretの登録・移動、Variable値や追加権限の変更はしない。callerにEnvironmentがないため、Preview Environmentの同名Variable overrideを引き継いだと推定しない。runnerのmaskと出力allowlistは別の防御であり、実Actionsのmask検証や過去ログの消去は今回行わない。既存ログのraw値も報告へ転記しない。

### 削除承認のGET診断と失敗分類

`qa-pool.yml` の `action=plan-release` / `pr_number` / `lease_id` は、同じ既存Environment `Preview` でGET専用のinspect jobを実行する。変更用writer jobは選択されず、transportもGET以外を拒否する。対象資源を照合した完全な内部 `DeletePlan` と、callerから既に渡された実効 `CAKE_QA_DELETE_APPROVALS` を比較し、追加のVariables API呼出しや状態変更を行わない。

`deleteApproval` は `valid`（JSON配列として解析できたか）、`matches`（期限以外の完全対象一致）、`expiry`、`decision`、固定 `reason` だけを返す。未設定・空白は現行どおり空配列として扱う。hostを含む全DB identityと全deployment ID集合は内部で比較し、承認全文・entry・host・期限の原値を表示しない。対象計画が確認できなければ一致と期限は未確認にする。

診断は同じ一度捕捉した時刻で既存matcherを呼ぶ。期限ちょうどは `EXPIRED`。複数entryのうち完全一致の有効な承認があれば `ACTIVE` / `ALLOWED`、有効な一致がなく期限不正の一致があれば `INVALID`、それ以外の期限切れ一致は `EXPIRED`。不正JSONや配列以外は `VALIDATION_ERROR` とし、通常の承認不一致 `DENIED` と区別する。既存matcherの複数entryに対する `some`、対象条件、例外、削除直前の再確認は変更しない。診断の `ALLOWED` は診断時点の照合結果で、後の削除を事前許可・予約しない。

API境界と承認解析の失敗は、固定 `stage` / `provider` / `method` / `reason` とHTTP `status`（応答未取得はnull）だけで報告する。例えば `DELETE_ALIAS` の失敗と `APPROVAL_VALIDATE` の失敗を区別できる。stageは操作境界の分類で、応答statusのないstage名だけではAPI送信・削除の実施を断定しない。未知の例外は `UNKNOWN`。URL、request/response body、例外message/stack、資格情報を表示せず、GitHub error annotationも同じ安全な分類だけを使う。分類を追加しても停止・保持・削除承認の判定は変わらない。

## 既存READY probeのalias-only

手動 `alias-only` は対象PR・slot・lease・完全head SHA・既存deployment IDを指定し、同一repositoryの現在OPEN PRと `held` / `purpose: probe` のREADY記録を照合する。`CAKE_QA_ALIAS_APPROVALS` のstrictな9項目だけの要素と、project、PR、head、slot、lease、deployment、hostを含む完全DB identity、候補alias、期限が一致する場合だけ割当へ進む。通常運用のflagや `CAKE_QA_APPROVED_HEADS` が空でも、この個別承認だけで実行できる。生成用probe承認をalias承認の代用にしない。

この入口は追加claim、全OPEN PRの列挙、他枠のglobal reconcile、新deployment・Neon DBの作成を行わない。対象PRがCLOSEDならalias割当を停止する。close入口は、そのPRの既存leaseだけを別の削除承認でcleanupする。現在のPR #37と `qa1` のhead・lease・DBを変更するための入口ではない。

初回は対象aliasをGETで照合し、`aliasAssignment: {alias, deploymentId, sha, state: pending}` をsnapshotへ保存して再GETする。aliasが未割当の場合だけ一度のPOSTへ進み、その後のexact GETが承認対象と一致した場合だけ `assigned` を保存する。POSTや台帳保存の応答を失っても記録を保持し、後続のexact GET一致で `assigned` へ復旧する。既存pendingからの再実行・応答喪失後の再照合でGETがnull、失敗、別対象なら、盲目的にPOSTを再試行せず停止する。限定aliasの記録対象を次headへ付け替えたり、probeを通常貸出へ変更したりしない。

同じActions writerのqueueは直列化するが、外部writerとのalias競合にprovider APIのatomic保証があるとは扱わない。直前・直後GETによる照合の限界と、実alias割当・衝突挙動が未検証であることを記録する。

## claimと初回配置

1. Cake内のmain向けOPEN PR、`codex/<task>` 枝、現在の完全head SHA、必須CIの確認結果、そのheadへの明示承認、同一repositoryのmain/対象PRの完全SHAにあるmain-only Git設定を確認する。空き枠へのclaim snapshot永続化までクラウドを生成しない。満枠時は待機する。
2. 作成intentを記録後、main/対象PRの完全SHAとGit設定を再確認し、Vercel REST `POST /v13/deployments` の `gitSource` にGitHub repo ID・feature枝の `ref`・完全 `sha` を指定する。`project` はcake project ID、`target` を省略してpreviewにする。Native DBはアプリbuild前に生成される。ローカルファイルのCLI deploymentや固定QA枝へのpushで代用しない。create入力に未定義の `prId` を追加しない。
3. 初回はNative hostが未確認なので、QA guardがDBクライアント作成前に停止する。このdeploymentはNative生成を開始するもので、成功Previewや検証済みアプリとは扱わない。DB保持用parkingは配置しない。
4. Neon APIで `misty-meadow-88903426` の対応feature枝・parent・branch ID・endpoint ID・実host・作成時刻を確認する。Productionとの分離をhost比較だけで断定せず、project所属と親DBも確認する。branchが今回のlease開始以降に作られ、書込みendpointが一意で所属も一致することを確認し、前leaseのbranch ID、endpoint ID、hostの再利用を拒否する。
5. 確認済みidentityをsnapshotへ保存し、同feature枝・同leaseの次deploymentへPR/枝/lease/slot/完全SHA、専用DB host、本番DB hostの非秘密guard情報を渡す。Native供給の `CAKE_TEST_DATABASE_URL` を使い、Productionの `DATABASE_URL` へfallbackしない。
6. phaseがapplicationのdeploymentで、lease markerのないDBはDB guardにより空DBまたは承認済みQA初期fixtureとの厳密一致を確認してidentityを登録する。空DBではmigrationと固定サンプルseedを行い、fixture一致時はseed済みとして使用する。受入後はレビュー済みの未適用migrationだけを適用する。READY後にVercel GETの `withGitRepoInfo=true` で同feature枝のref/完全SHAを確認する。通常運用では同lease・current headを再読取してaliasを付ける。probeは固有URLで結果を記録し、aliasを自動更新しない。旧headの成功で現在headのaliasを更新しない。

NeonのPreview actionと `Resource must be active before deployment` が必要。接続変数はdeployment時に注入され、projectの通常env一覧だけで取得できるとは限らない。Vercel owner向けGET応答は環境変数を含み得るため、全文をログへ出さず必要な非秘密fieldだけを記録する。

## DB初期化と同PR更新

新leaseは新feature枝由来のDBを使う。新PRのNative親は承認済みQA初期fixtureを持つ設計とし、lease markerがない初回だけ実DBを厳密照合する。従来の空DBからの初期化も維持する。親の設定値やmetadata読取だけでは、Nativeがその親を選ぶことや子DBのfixture一致を証明できない。親選択と新PRでの継承はlive未実証のまま。

承認済みQA初期fixtureの受入条件は次の全項目の一致とする。件数だけの照合や既知名だけのallowlistでは受け入れない。

- `schema_migrations`は001〜011の既知ファイル名11件だけを持ち、schema・表/列/制約・index・trigger・routine・型はその適用結果の既知定義に一致する。extensionは既知の`pgcrypto` 1.4を照合し、余分なschemaやobjectを許可しない。
- `app_users`は`test-user-a` / `test-a@cake.local` / `テストユーザーA`と、`test-user-b` / `test-b@cake.local` / `テストユーザーB`の二人だけ。両者の`image_url`はNULL、`is_enabled=true`で、Aだけ`is_admin=true`、Bはfalseとする。
- `workspaces`は`00000000-0000-4000-8000-000000000001` / `テスト共有家計` / `SHARED` / owner `test-user-a`の一件だけ。`workspace_members`はその家計のA OWNER・B MEMBERの二件だけで、weightは両者1とする。
- `app_user_access_guard`はsingleton一件、revision 4だけを持つ。`invitations`、`import_batches`、`transactions`、`default_rules`、`settlements`、`settlement_transactions`、`recurring_payments`の業務7表はすべて空とする。

初回照合とPR/feature枝/lease/endpoint identity登録は同じtransactionで扱う。fixture一致時だけ`cake_preview_database_identity.seeded_at`を非NULLとして登録し、fixture SQLの再実行や権限・名前・利用可否の修復は行わない。空DBではidentity登録後に未適用migrationを適用し、seed前混入検査、固定二人・共有家計の登録とseed済み記録をtransactionで行う。Previewのmigration準備では既知のProduction初期管理者INSERT全体を除き、第三ユーザーや実メールを混入させない。適用済みmigration原文とProduction処理、従来ローカルの両者非管理者fixtureは変更しない。

11migrationは承認済み初期baseの検証基準であり、後続migrationを禁止する上限ではない。初回受入後と同PR更新ではレビュー済みの未適用migrationを適用できる。marker登録済みの同PRではidentityを照合し、初期fixtureの完全一致は再検査せず、既存サンプルとQAで入力・編集したデータ・名前・権限・停止状態を保持する。SHA更新だけで返却・新leaseへ切り替えない。公開済み旧版のテストログインはAを非管理者へ戻し得るため、新コードの公開・ログイン確認前に管理者ログイン完了とは扱わない。

ビルド、runtime、`db:setup`、`db:seed:test` に同じ接続・identity確認を適用する。pooled/unpooledの同一endpointも比較し、専用接続なし、host不明、本番host一致、別PR/別lease/別endpointならDB操作前に停止する。fixtureの不一致や既知001〜011のsource/schemaと検証基準のずれはfail closedで停止する。検証定義や親の変更はレビュー・明示承認を必要とし、DBのDROP/TRUNCATE/reset、既存schema消去やfixtureの自動修復で続行しない。

## releaseと失敗回復

`held` と `deleting` はどちらも使用中。PR close/mergeは返却開始条件であり、cleanup完了前に空きを増やさない。

1. `plan-release` をGET専用transportで実行し、現在lease・台帳・全deployment ID・alias・Native identity・intent/orphanと実効削除承認サマリーを確認する。この入口は安全な計画と判定だけを返し、`deleting`への状態変更、生成、削除を行わない。確認不能な対象は承認候補を確定せず停止する。
2. privateな削除承認の `projectId` / `pr` / `slot` / `leaseId` / `headSha` / `deploymentIds` / `alias` / `database` をレビューし、現在より後の `expiresAt` を添えて承認する。表示計画のDBはhostを除いた安全な識別情報であり、そのまま承認JSONへコピーしない。承認内の `database` はhostを含む完全identityまたはnull。`deploymentIds` は全記録IDの昇順配列、`alias` は通常貸出の候補名、限定probeはalias記録がなければnull、記録があればその候補名を保持する。既に消失したIDやaliasも対象集合から除かず、head・lease・DB・alias・ID集合が変われば再計画・再承認する。
3. PR close/mergeまたは手動返却を処理するwriterは対象PRの現在leaseを再確認し、先に `deleting` snapshotを永続化して配置とalias更新を止める。承認待ちも使用中として保持する。closeはそのPRだけをcleanupし、他枠のclaim・全OPEN PR列挙・global reconcile・生成へ広げない。未完了create intentや曖昧なorphanを解決できなければ削除・freeへ進めない。限定aliasの `pending` がexact GETで未確認ならcleanupも停止し、記録を保持する。
4. 成功・失敗・初回provisioningを含む記録済み全deployment IDをまずGETし、全件のproject・feature枝・記録済みSHA・leaseを検証する。現在の完全な対象集合と期限付き承認が一致するときだけ、承認されたaliasとdeployment IDをDELETEする。名前の類似で未記録対象を削除せず、Productionや他PRに触れない。cancel APIは現writerに未実装で、実行中buildのcancelやFunction停止をこの操作で保証しない。
5. alias消失、全記録IDの不在、関連deployment残存なしをGETで確認する。`assigned` のalias GETがnullなら既に削除された可能性があるため、alias記録と全IDを保ったまま他の消失確認を続ける。alias変更だけで旧固有URLのアプリ/API停止とは扱わない。正常な認証・全ページ取得・対象ID照合によりNative branchと全endpointの消失も確認し、HTTP成功、PR close、403やtimeoutを消失証拠にしない。
6. 消失結果を記録し、DB identityを返却済み識別子へ追加して `free` snapshotを保存する。開始済みFunction/transactionの監視・終了確認は現writerに未実装で、資源消失と実処理停止を区別する。次leaseが古いbranch ID・endpoint ID・hostを使うことを拒否する。deploymentの復元をNeon DBの復元保証として扱わない。

delete失敗、権限不足、ネットワーク拒否、Neon読取不能、intent未解決は `deleting` のまま保持し、後続writerで回復する。応答喪失は再読取して確定し、盲目的に同じ生成要求を繰り返さない。retentionによる途中削除も台帳とNative identityをreconcileする。保持deploymentを残してDBを温存する返却はしない。deployment/branch/endpoint消失は資源の削除確認であり、開始済みFunction/transactionの即停止を保証するものではない。現writerは実行中処理の監視APIを照会しない。この実処理の停止挙動もlive検証で確認する。

cleanupの実証結果、API認証のscope、削除の明示承認は独立した情報。cleanup未実証を承認済みとして補ったり、tokenがDELETE可能という理由で承認を省略したりしない。intentが一覧で解決できない場合やDBが生成されなかったことを証明できない場合の手動復旧入口は未実装で、貸出を保持して調査する。

削除は通常生成の有効化やNative確認flagをtrueにして許可する仕組みではない。生成停止中でも、記録と実資源の所属・完全な対象集合・期限付き削除承認・必要な読取認証が揃えば対象PRの返却を再照合する。probeのalias有無は `aliasAssignment` 記録に従い、aliasや一部IDが途中で消失しても承認対象集合を勝手に縮めない。

## 開発者のコマンドと検証

コードを検証・commitしたら、最初に `task:pr --draft` でmain向けPRを作る。通常のdraft入口はrepository variable `CAKE_QA_GIT_GATE_CONFIRMED=true` と、同一repositoryのmain/対象HEADを完全SHAで読む `vercel.json` のmain-only停止設定（`**: false` / `main: true`、main以外のtrueなし）を共通checkerで検証し、originとHEADが一致しない場合だけ安全確認後にfeature枝をpushする。Preview未実施はdraft本文で明示できる。`deploy:preview` も同じゲートに加え有効化と先行PRを確認してからfeature枝をpushし、同PR/同lease/current HEADのREADY記録を台帳から読む。直接Vercel/Neonを生成・削除しない。pushの許可と実alias割当・cleanupの許可は分ける。

```bash
npm run task:pr -- --draft --title '変更内容を表すタイトル' --verification-file /tmp/cake-verification.md
npm run deploy:preview
```

Preview完了後、Deployment固有URLでPC/スマートフォンの画面とAPIを確認し、完全SHA、lease、deployment ID、Neon project/branch/endpoint、migration/seed結果を報告する。固定aliasだけで検証コミットを判定しない。再変更後は再commit・再deployment・再検証する。検証済みPR本文更新は `task:pr` の通常経路を使い、draftからの公開・mergeはユーザーが判断する。

ローカルではlint、test、build、TypeScriptと、同時claim、旧lease拒否、snapshot分岐、重複request、応答喪失、stale head、alias不一致、orphan、全ページ読取、delete失敗保持、旧DB再利用拒否、同PRデータ保持、新PR混入停止の回帰を確認する。実SQLの空DB/承認済みfixture判定・transaction/lockとcloud lifecycleは別途実測する。現在は必要な承認・認証・ゲート確認がないため有効化しない。

## ローカルSQL検証

`scripts/verify-preview-database-safety.mjs` は任意に導入したPGlite 0.5.8で現行11migrationと初回base照合・guard/seedの実SQLを実行する補助スクリプト。`dataDir`を指定しない[一時メモリDB](https://pglite.dev/docs/filesystems)を使い、`finally`で閉じる。実環境の本番・`CAKE_TEST_DATABASE_URL`を読み込まず、setupの接続先はローカルDBへ差し替え、seedは生成したSQLを同じDBへ実行する。DELETE/DROPもこの一時DB内の検証fixtureに限る。

この成功は承認済みNeonテストDBでの実測ではない。Neon上のmigration/seed、Native作成/保持/cleanup、複数接続の競合は未実施のまま。一時ディレクトリに残るエンジン・npmキャッシュ・検証ソースは実証DBの保存データではない。再現コマンドと検証結果は [検証報告](qa-pool-verification.md) を参照する。

## 公式仕様

- [GitHub Deployments API](https://docs.github.com/en/rest/deployments/deployments) / [statusとauto_inactive](https://docs.github.com/en/rest/deployments/statuses#create-a-deployment-status) / [status履歴retention](https://docs.github.com/en/rest/deployments/statuses#data-retention)
- [Actions concurrencyとqueue](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency) / [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [Vercel Git生成停止](https://vercel.com/docs/project-configuration/git-configuration) / [GitHub通知field](https://github.com/vercel/sdk/blob/main/docs/models/updateprojectgitprovideroptions.md) / [project設定API](https://vercel.com/docs/rest-api/projects/update-an-existing-project)
- [Vercel deployment作成](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment) / [gitSource schema](https://github.com/vercel/sdk/blob/main/docs/models/gitsource2.md) / [取得](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url) / [一覧](https://vercel.com/docs/rest-api/deployments/list-deployments) / [削除](https://vercel.com/docs/rest-api/deployments/delete-a-deployment)
- [alias割当](https://vercel.com/docs/rest-api/aliases/assign-an-alias) / [alias取得](https://vercel.com/docs/rest-api/aliases/get-an-alias) / [alias削除](https://vercel.com/docs/rest-api/aliases/delete-an-alias)
- [Vercel integration actions](https://vercel.com/docs/integrations/create-integration/deployment-integration-action) / [Neon managed integration](https://neon.com/docs/guides/vercel-managed-integration) / [cleanup](https://neon.com/docs/guides/vercel-branch-cleanup)
- [Neon branches一覧](https://api-docs.neon.tech/reference/listprojectbranches) / [endpoints一覧](https://api-docs.neon.tech/reference/listprojectendpoints) / [branch削除](https://api-docs.neon.tech/reference/deleteprojectbranch) / [API key権限](https://neon.com/docs/manage/api-keys)

# QA貸出枠の運用

`qa1` / `qa2` / `qa3` は同時に貸し出せる検証枠の名前であり、Gitブランチではない。開発・PR・Vercel Previewは各PRの `codex/<task>` 枝を使い、Neon Native Preview DBもそのfeature枝に対応させる。同じPRの更新では同じleaseとDBを保持し、返却後に別PRへ貸し出すときは新しいDBを確認する。固定QA枝、台帳枝、DB保持用parking deploymentは作らない。

## 現在の適用状態

対象はGitHub `tyask/Cake`、Vercel `fumin1/cake`（`prj_Z37vquodhpRd08ZTAtYnP0qa59jD`）、Preview専用Neonリソース `cake-preview`（project `misty-meadow-88903426`）。既存GitHub Environment `Preview` を使い、qa1/2/3用Environmentや管理DBを追加しない。

通常のPreview生成の標準入口は、信頼済みmainが作る小さな安全plan IDのowner承認である。ユーザーは通常運用開始を明示し、Repositoryの `CAKE_QA_POOL_ENABLED` / `CAKE_QA_GIT_GATE_CONFIRMED` / `CAKE_QA_NATIVE_CONFIRMED` をtrueに登録した。2026-10-14 JSTの[GET専用診断（run 38485838972 / job 115599157037）](https://github.com/tyask/Cake/actions/runs/38485838972/job/115599157037)では3flagの実効true、旧4承認Variableの空状態、qa1の `free` と使用中QA DB 0個を確認した。これは診断時点の証拠であり、以後の依頼でも現在の実効値・台帳・対象HEADを再読取する。flagの有効化だけで個別PRの生成や削除を許可しない。

個別の開発依頼で許可された範囲内では、Codexが既存のowner本人の `gh` 認証を使い、計画の機械照合、`qa:approve`、後続writerの確認まで代行できる。許可済みの対象について毎回のチャット再確認や本人のGitHub UI操作を必須にしない。Preview生成では現在HEADごとの計画確認・owner承認Actionsは省略せず、依頼の対象・資源数・操作範囲を広げる恒久的な権限にはしない。ユーザーは、同一repositoryのmainへマージ済みの通常QA leaseを自動返却する運用方針を承認した。QA DBと入力データも削除され、対象ごとのcleanup owner承認は要求しない。未マージclose・OPEN PRの手動返却・限定probeの削除は、全対象とデータ喪失を示して別途承認を得る。draftからの公開とmergeはユーザーが判断する。

実環境の受入結果は[PR #42](https://github.com/tyask/Cake/pull/42)と[PR #43](https://github.com/tyask/Cake/pull/43)の記録を参照する。qa1の順次貸出、同PR更新でのlease・DB・ユーザー・登録データ保持、固定aliasの最新READY一致、返却後の別PRで新DBと初期状態、既存owner認証による承認代行とcleanup・`free` を実証した。同時3枠、実ブラウザでのPC/スマートフォン全操作、外部callerとのalias競合、実行中Function/transactionの終了は未試験。子DBの初期状態が親fixtureの継承と空DB初期化のどちらで得られたかは区別できておらず、親fixture継承の実証完了とはしない。

Hobby向けのGitゲートはmainと稼働対象枝の `git.deploymentEnabled: {"**": false, "main": true}` を照合する。設定のない古い枝・直接REST/CLI・外部callerまで停止する保証はない。認証scope、個別操作承認、実証結果を混同しない。Vercel Proや新Secret・追加権限を通常運用の条件にせず、既存Neon planの無料枠や無課金も保証しない。

PGliteの実SQL検証はローカルWASMの一時メモリDBを使い、実環境の接続情報を読み込まない。Neon上のmigration・seed・Native lifecycleの実測とは区別する。再現方法と実施状況は [検証報告](qa-pool-verification.md) を参照する。

### 導入時の履歴

owner-plan入口の導入PRではコード・ローカル検証とdraft PRまでを扱い、runtime flag変更、workflow dispatch、クラウド資源操作、mergeを行わなかった。当時のpool false/unset保持と「今回実行しない」はこの導入段階の範囲であり、その後に明示承認された受入試験と通常運用を禁止する条件ではない。

2026-10-13の08:16に、ユーザーから `CAKE_QA_DELETE_APPROVALS` Variableを削除したと報告された。従前の同日10:00の期限は延長・再利用しない。この報告だけを後続操作の許可や実効値確認にせず、その後のPR #42/#43では新しい具体的な対象と期限を持つowner cleanup planを別承認した。旧Variableの再登録を標準手順にしない。

## URLと貸出数

追加alias候補は `cake-qa1-fumin.vercel.app` / `cake-qa2-fumin.vercel.app` / `cake-qa3-fumin.vercel.app`。取得済みURLではなく、実APIによる割当許可と衝突確認が必要。team slug、project名、本番domain、Preview suffixは変更しない。自動branch URLもteam名から推定せず、実deploymentから取得する。

受入試験ではqa1のruntime接続を確認した。qa2/qa3のruntimeホストはクラウド環境の許可リスト不足でCONNECT 403となり、アプリ到達前に拒否された。利用前に `cake-qa2-fumin.vercel.app` / `cake-qa3-fumin.vercel.app` の追加許可が必要で、拒否を迂回しない。ネットワーク許可とVercel protectionの認証は別条件として確認する。

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

mainへのmergeはユーザーだけが行う。mainのProductionを維持するGit設定により、mergeは自動Production deploymentと既存の本番build、その後の `db:setup` を起動し得る。実装・ローカル検証、mainへの導入、個別の生成・alias割当、マージ済み通常QAの自動返却方針、その他のcleanupの個別承認は分ける。導入後の個別操作も、その時点の台帳と実資源を再照合する。導入時には設定監査が未完の既存PR #33を通常運用開始の許可だけで変更・反映しなかった。この履歴を現在のマージ済み通常QAの自動返却禁止にはしない。

既存の5分scheduleは通常poolのflagがfalseでも同じmain writerを起動する。マージ済み通常leaseはソース管理された自動返却条件を、未マージclose・OPENの手動返却・probeは有効な個別削除承認を再照合してcleanupを継続する。追加flag・Repository Variable・資格情報・owner承認receiptを自動返却のために作らない。いずれも全資源の消失確認までは `deleting` を使用中として保持する。merge前にはこのQAデータ喪失とProductionへの影響を確認し、Codexはmergeを実行しない。GET診断の先行や手動一回だけの実行を、この入口だけでは保証しない。運用方針の停止・変更は別途判断し、個別承認の期限を延長しない。

## 正本と短い単一writer

正本はGitHub Deploymentのimmutable payload snapshot。専用 `task: cake-qa-lease`、`environment: Preview`、`payload.protocol: cake-qa/v1` の記録だけを扱い、通常のVercel記録を混ぜない。全ページを取得し、GitHub deployment ID順に各枠の `sequence` と `previousRecordId` を検証する。未知protocol、系列の分岐、重複所有、API失敗は空き扱いせず停止する。

payloadは枠、PR番号、feature枝、完全head SHA、lease UUID、`held` / `deleting` / `free`、作成・更新時刻、作成intent、全deployment ID/SHA/phase、READY deployment、Native DB identity、返却済みDB識別子を保持する。限定aliasは `aliasAssignment: {alias, deploymentId, sha, state}` の `pending` / `assigned` を記録し、`purpose: probe` を維持する。hostは内部の台帳・照合で使うが、診断・CLI・報告へ出さない。秘密情報や接続文字列は保存しない。新snapshotは直前の記録へ連結し、既知deployment、alias対象、返却済みDBの識別記録を消さない。

書込みとclaim/release/alias mutationは信頼済みmainコードを使う1つの短いActions writerだけが行う。`pull_request_target`、`workflow_dispatch`、`schedule` が同じwriterを起動する。全枠・全操作で固定concurrency group、`queue: max`、`cancel-in-progress: false` を共有する。PRコードをwrite token付きでcheckout・実行しない。開発者のローカルCLIはGitHubへ計画要求・承認のdispatchを行い、結果を読む。Vercel/Neon資源を直接予約・配置・解放しない。

限定実証の貸出はsnapshotの `purpose: probe` で通常運用と区別する。probeの継続は明示した手動入口だけから行い、PRイベントやscheduleから生成を自動継続せず、候補aliasも自動更新しない。probeも同じ3枠と単一queueを使い、失敗・期限切れ・承認不足で既存leaseやDBを解放しない。

長いbuildやcleanup完了待ちは排他区間で行わず、intentを保存してAPI操作を開始し、後続の短い実行で照合する。`queue: max` は実行中1件＋最大100pending、満杯時は新requestがcancelされる。FIFOはgroupの待機開始順で入力順ではない。cancelされたrequestは未予約とし、毎回最新snapshotとleaseを読み直す。pending置換方式へfallbackしない。

GitHub Deployment作成は完全SHAを `ref` に指定し、`auto_merge: false`、`production_environment: false`、`transient_environment: true`。台帳の `required_contexts: []` はアプリの必須CIを代用しない。現writerはstatusを書き込まない。将来表示用statusを追加する場合も `auto_inactive: false` を明示する。statusのsuccess/inactive/failure、PR close/merge、workflow完了、時間経過だけで貸出を解放しない。マージ済み通常QAも全資源の消失確認後にだけfreeにする。status履歴は90日で削除されるため、正本をstatus履歴へ依存させない。

これはGitHub APIのCASや永続ロックではなく、単一writerとsnapshot系列を前提としたprotocol。別workflowや通常APIから専用taskへ直接書き込まない。

## 小さな計画とowner承認

貸出台帳の `cake-qa-lease` と承認台帳の `cake-qa-approval` を分ける。後者は既存Environment `Preview` と `cake-qa-approval/v1` を使い、通常配置の `preview` と、個別承認を要する返却の `cleanup` を対象にする。マージ済み通常leaseの自動返却はcleanup planのowner承認を要求せず、人間の承認receiptを作成・流用しない。公開planにはPR・feature枝・完全SHA・slot・lease・直前台帳ID・生成main SHA・確認済み親branch ID・生成run ID/attempt・期限、全deployment ID・候補alias・hostなしDB project/branch/endpoint ID、生成数上限、SHA-256 digestを載せる。DB host、接続文字列、資格情報、privateな完全manifestは公開しない。期限は既定2時間、最大24時間で、自動延長しない。plan IDは一つの対象・操作・期限を指すレビュー入口であり、通常運用でもHEADごとに小さな計画を確認する。cleanupの表示にはQA DBと入力データが失われることを明記する。

1. 信頼済みmainが現在PRの完全head、slot・lease・台帳世代、保存済み資源を読み直し、安全な対象ID・操作範囲・期限とdigestを持つplanを作る。未確認の作成intentはGETで回復してから計画へ含め、未回復なら計画を保留する。計画発行はCI成功の証明ではなく、Preview承認と生成・alias変更の前に、その完全SHAの最新pushとpull_requestのCIが両方completed/successであることをGitHub APIで照合する。返却はCI成功を条件にしない。計画生成はVercel/Neon資源を変更しないが、安全なGitHub承認台帳の書込みを伴う。既存GET専用 `preflight` / `plan-probe` / `plan-release` 自体に書込みを追加しない。
2. ownerは表示された小さな計画を確認し、`npm run qa:approve -- --plan-id <ID>` で承認する。個別依頼の許可範囲内では、Codexが既存owner本人の `gh` 認証で機械照合と実行を代行できる。現在の計画を照合することと、許可済み対象について毎回チャットで再確認することは別である。取消は同じコマンドに `--revoke` を付ける。GitHubのRun workflowでもmainの `action=approve` / `revoke` と `plan_id` 一個を指定できる。巨大なVariable JSONや新しい資格情報を要求しない。入力中のowner名・actor ID、CI結果、コメントやfork側の主張を承認証拠にしない。
3. mainはGitHubが返したrepository ownerとdispatch/runの実行者・実行元を照合し、完全manifestを内部で再構成する。承認はSHA-256 digest、承認対象のPR/CI head、slot、lease、台帳世代、期限へ束縛する。workflowを実行するmain SHAと、承認するPRのhead SHAは別々に確認する。承認run自身は資源操作をせず、GitHubのrunが `completed` / `success` になった後のwriterだけが承認を消費する。
4. 既存の単一queueが計画と承認を再読取し、変更直前ごとに現在対象・digest・期限・revoke・既存gateを確認する。新HEAD、別lease、計画が許す台帳系列・資源数からの逸脱、確認済みDBの不一致、失効、不明は承認を引き継がず停止する。最新の正当な承認receiptが未完了・失敗なら `PENDING` として止め、古い承認へfallbackしない。回復はownerによる新しいdispatchで行い、rerunで承認を作り直さない。

owner認証の根拠はauthenticated dispatchとGitHub由来のrun metadataであり、Deploymentsの `creator` 単独ではない。`GITHUB_TOKEN` はGitHub App installation tokenなので、workflowのAPI書込みはappへ帰属する。writerのcreator確認とは別に、実runのactorとtriggering_actorがともにrepository ownerの数値ID・`User` であること、main・repository・workflow pathとtrusted main SHAを確認する。承認は初回attemptだけを受け入れ、rerunを拒否する。run APIにはdispatch入力本文がないため、GitHubが返した `display_title` の `Cake QA approve <ID>` / `Cake QA revoke <ID>` とimmutable planを結び付ける。`creator` の欠落・偽装、metadataの読取拒否や不正、対象planとの結合が不明なら停止し、追加permissionや資格情報で補わない。

通常のCLI操作は `deploy:preview` → `WAIT_APPROVAL` とplan IDを確認 → owner承認runの成功確認 → 再度 `deploy:preview` の順に進める。再実行するCLIも現在HEADと同leaseの承認を読み直す。owner planは通常previewと個別承認を要するcleanupだけに使い、マージ済み通常leaseの自動返却には不要。既存の限定 `probe` / `alias-only` の個別承認を代替しない。`QA_OWNER_FLOW=true` はworkflow内部の固定envであり、追加repository Variableとして登録しない。

[GitHub Freeの公開repository](https://docs.github.com/en/get-started/learning-about-github/githubs-plans#github-free-for-personal-accounts)はこの基本Actions/API構成を利用できる。ただし手動dispatchを実行できるwrite accessはowner専用ではなく、main以外のrefも指定できるため、main固定とowner照合はCake側の条件とする。public Deploymentsは認証なしでも読めるので、安全projectionをprivate manifestの保管場所に使わない。根拠は[手動実行](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[dispatchイベント](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)、[actor/rerun contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)、[run API](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run)、[GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)、[Deployments API](https://docs.github.com/en/rest/deployments/deployments#get-a-deployment)。GitHubのenvironment reviewer機能や有料planをこの入口の条件にしない。

新規生成ではPOST前に予定lease・slot世代・確認済みNative親を再照合し、既存の同PR DBがあれば完全identityを照合する。新PRは旧PRのDBを再利用せず、同PRの追加HEADは同lease・同DB・入力データを保持する。初回にはまだない子DB identityを推測して承認へ埋めない。現在HEADの正しいlatest READYとaliasの割当先をGETで確認した後だけ固定URLを案内し、固有deploymentの識別情報と診断は別に保持する。PR本文とCLIの公開操作は既存の本人 `gh` 認証を使い、Actionsに `pull-requests: write` を増やさない。

### 旧承認の読取互換

`CAKE_QA_APPROVED_HEADS` と `CAKE_QA_DELETE_APPROVALS` は移行中の読取互換を残す。前者はレビュー対象の完全head SHA、後者は既存のlease・全ID・alias・完全DB identity・期限が一致する場合だけ従前の照合を通す。値の自動登録・変換・延長や、owner planによる旧不一致の救済をしない。未知・不正・不一致・期限切れの扱いも既存matcherに従う。新しいPreview生成・個別承認が必要な返却ではplan IDを使う。マージ済み通常leaseの自動返却はこれと別のソース管理された方針とし、通常運用flag、Git設定の確認、pool有効化を承認台帳から自動変更しない。

旧削除承認が有効なまま残れば、既存scheduleやclose経路がcleanupを進め得る。新しい「planを先に確認する」UIだけで、旧承認による実行や待機中writerを停止したと扱わない。導入時のPR #33など設定監査が未完の旧枝への生成は通常運用開始の許可だけでは進めず、mainの設定だけで対象HEADのGit停止を補わなかった。生成のGitゲートと、マージ済み通常leaseの自動返却は区別する。

## 通常運用の設定と導入前の限定入口

通常運用の生成・自動alias更新には `CAKE_QA_POOL_ENABLED` / `CAKE_QA_GIT_GATE_CONFIRMED` / `CAKE_QA_NATIVE_CONFIRMED` の3つがtrueであり、現在対象のowner plan承認と各gateが成立する必要がある。通常運用開始の明示承認前はfalseまたは未設定で保持する。登録報告だけで実効値を推定せず、既存GET専用診断を使う。Repository Variables管理APIの権限をdraft PR作成やowner-plan標準経路の条件にしない。

GET専用の `preflight` / `plan-release`、5項目承認の限定 `probe`、9項目承認の既存READY probe向け `alias-only` は別入口とする。限定入口のためにpool/確認flagを先行してtrueへ変えず、通常生成のhead承認も追加しない。通常配置と、未マージclose・OPENの手動返却に必要なcleanupの標準承認はowner plan IDで行う。マージ済み通常leaseは個別cleanup承認を要求せず、probeの削除には引き続き既存の期限付き個別承認を使う。次のVariable承認列は既存経路の読取互換契約であり、新標準の操作手順として巨大JSONの登録を要求しない。

| 設定 | 確認・承認の範囲 |
| --- | --- |
| `CAKE_QA_POOL_ENABLED` | 通常運用の有効化。生成前ゲートとNativeの実証が完了した後に明示承認でtrueにする |
| `CAKE_QA_GIT_GATE_CONFIRMED` | 全稼働枝のmain-only設定監査と実際のGit自動生成停止の確認結果。通常運用はflagに加えmain/対象PRの完全SHAの設定を毎回確認する。限定probeのために先にtrueへ変更しない |
| `CAKE_QA_NATIVE_CONFIRMED` | REST Git deploymentのNative動作を確認した後の通常運用条件。初回実証のために先にtrueへ変更しない |
| `CAKE_QA_PARENT_BRANCH_ID` | 読取確認した承認済みQA初期fixtureのNative親branch ID。実際の子DBでも初回fixtureを厳密照合する。Native親選択の実証完了を設定値だけで保証しない |
| `CAKE_QA_APPROVED_HEADS` | 通常運用の旧PR番号→レビュー済み完全head SHAのJSON object。現在headに一致する既存入力の読取互換。unset・空文字・空白だけは `{}` として承認なし。不正な非空JSON、正の安全な整数でないPR key、完全SHAでない値は既存matcherに従って拒否する。新標準はowner plan承認を使い、probe/alias-onlyの個別承認とは別に扱う |
| `CAKE_QA_PROBE_APPROVALS` | repository variableのJSON配列。各要素は `projectId` / `pr` / `sha` / `slot` / `expiresAt` の5項目だけを持ち、現在head・対象project・枠が一致し、期限内の限定probe承認だけを使う |
| `CAKE_QA_DELETE_APPROVALS` | 旧private JSON配列の読取互換。project・PR・枠・lease・完全head SHA・全deployment ID・alias・完全DB identity・期限が一致する既存入力だけを使う。callerは既存repository Variableを一時的なworkflow_call secretへ渡す。新標準の完全manifestはmain内部で再構成する |
| `CAKE_QA_ALIAS_APPROVALS` | privateなJSON配列。各要素は `projectId` / `pr` / `headSha` / `slot` / `leaseId` / `deploymentId` / `database` / `alias` / `expiresAt` の9項目だけ。既存READY probeに完全一致する期限内承認を使い、callerは既存repository Variableを一時的なworkflow_call secretへ渡す |

既存Vercel tokenとNeon API key、Actionsの短命 `GITHUB_TOKEN` を使う。`deployments: write` 等の必要権限と既存Environment `Preview` の実行・承認方針も確認する。新Secret・資格情報や権限を勝手に追加しない。Vercel-managed NeonのCLI/APIにはNeon API keyが必要で、一般のproject-scoped keyもEditor権限を持ちread-onlyとは限らない。

認証に成功したことやtokenの書込みscopeは操作の承認を意味しない。通常運用の有効化、特定headの生成承認、特定ID集合の削除承認、Native/cleanupの検証結果を分けて扱う。一括の削除許可booleanは使用しない。マージ済み通常QAの自動返却は利用者が承認したソース管理された方針に限り、RESTのmerged確認と現在leaseの完全照合を要する。個別承認の期限切れ、自動返却条件の不明、対象不一致は操作を停止し、対象を広げない。新しいSecretの配置、追加scope、ネットワーク変更、本番操作は個別開発依頼の通常QA操作に含めない。

## GET専用preflightと限定probe

`preflight` は `CAKE_QA_POOL_ENABLED` や確認flagをtrueにせず実行できる読取入口。既存認証でVercel project/link、同一repositoryのmainの完全SHAとGit設定、GitHub台帳とrepository Variables名、Neon projectとbranch/endpoint件数を確認し、各読取・照合の成否と不足するVariable名を報告する。GET以外を拒否するtransportを使い、台帳snapshot、deployment、alias、環境変数、DBデータを作成・更新・削除しない。Variableの値やAPI全文は出力せず、読取成功だけで通常運用やNativeを確認済みに変更しない。親DBのfixture、Nativeの親選択や対象PRの実配置をこのmetadata読取で証明したとは扱わない。

`plan-probe` もGET専用。対象PR番号・レビュー対象の完全SHA・希望slotを指定し、同一repositoryのOPEN PR/current head、main/対象PRの完全SHAのGit設定と枠の状態を照合する。生成予定のproject・PR・feature枝・SHA・slot、最大追加deployment数、alias変更なし、別途削除承認が必要であることと読取のブロッカーを計画として返す。計画が出ても生成承認やNative実証完了を意味しない。

読取入口はローカルまたは信頼済みmainの手動workflowから実行できる。以下の `qa_pr` / `qa_sha` / `qa_slot` / `qa_lease` は読取で確認した非秘密識別値を使う。既存の認証値は表示せず、不足時は不足を報告するところで停止する。

```bash
QA_ACTION=preflight node --import tsx scripts/qa-pool-writer.ts
QA_ACTION=plan-probe QA_PR_NUMBER="$qa_pr" QA_SOURCE_SHA="$qa_sha" QA_SLOT="$qa_slot" node --import tsx scripts/qa-pool-writer.ts
QA_ACTION=plan-release QA_PR_NUMBER="$qa_pr" QA_LEASE_ID="$qa_lease" node --import tsx scripts/qa-pool-writer.ts
```

Native未実証の導入前に行う限定実証は `probe` を明示した手動実行に限る。通常運用で新PRへ初回配置する標準owner-plan経路とは区別する。信頼済みmainのコードと通常writerと同じqueueを使い、同一repositoryのOPEN PR、レビュー済みの現在完全head SHA、指定project・slotが `CAKE_QA_PROBE_APPROVALS` の5項目だけの1要素と一致し、`expiresAt`が現在より後であることを生成直前に再確認する。mainと対象PRの完全SHAにmain-only Git設定がなければprobeも開始せず、ブロッカーを報告する。設定済みの限定probeはpool/Gitゲート確認/Native確認flagをfalseまたは未設定のまま実施できる。通常生成はこのGit設定に加えて3つのflagがtrueであることを必要とする。

probeはclaimとintentを先に保存し、REST `gitSource` でNative DBをアプリbuild前に生成する。初回host未確認ならDBクライアント作成前に停止するdeploymentを作る。そのIDを保持してNative所属・親・作成時刻・branch/endpointをGETで照合し、必要な次の手動probeで同lease・同feature枝のphaseがapplicationの検証を進める。固定aliasは自動更新せず、Deployment固有URLと完全SHA、Native identityと親選択、build/runtimeへのguard注入、初回DB受入条件の照合、migration/seedの結果を実証記録へ残す。同PRへの追加pushは新headのレビューと期限付きprobe承認を更新し、同lease・同DBを維持する。新PRは新しいGit refとDBを使う。

probe承認は台帳・Previewの限定生成を許すもので、削除や新しい資格情報の登録を許すものではない。実証後の返却は別のGET専用計画と削除承認を使う。実証で成功した場合も、flagを自動変更したり通常運用へ切り替えたりしない。

通常運用では、同PRへの追加pushも新しい完全head SHAの小さな計画をレビューし、owner plan承認または完全一致する旧 `CAKE_QA_APPROVED_HEADS` を確認する。probeは別の期限付き `CAKE_QA_PROBE_APPROVALS` を使う。承認なしのheadで新deploymentを作成・alias更新しない。非秘密guard値は作成requestの `env` / `build.env` に限定して渡し、feature枝やproject/branch環境変数をremote更新しない。公開REST create schemaにはこのfieldの記載がない一方、[公式clientのDeploymentOptions](https://raw.githubusercontent.com/vercel/vercel/main/packages/client/src/types.ts) は両fieldを定義し、[POST処理](https://raw.githubusercontent.com/vercel/vercel/main/packages/client/src/deploy.ts) は除去せずrequest bodyへ展開して [v13 endpoint](https://raw.githubusercontent.com/vercel/vercel/main/packages/client/src/utils/index.ts) に送る。これは一次資料による実装根拠であり、公開REST schemaの保証と区別する。client自身はfilesを付ける経路でgitSourceを定義していない。writerのfilesなし `gitSource + env/build.env` の受理・build/runtime注入・Native動作はPR #42/#43の実証範囲で確認したが、一般のAPI保証にはしない。失敗・注入欠落はguardで停止する。`files` と `gitSource` は公式仕様で併用不可。

本番endpointとの比較には既存repository Variableの非秘密 `CAKE_QA_PRODUCTION_DATABASE_HOST` を使い、読取確認した実hostを使う。推定hostで補わず、接続文字列や秘密値を出力しない。ネットワーク拒否、SSO、Deployment Protectionを迂回しない。

QA読取検査のJSON/CLI・console・報告はdeployment URL・接続文字列・資格情報・raw DB hostを出力せず、allowlistしたproject/branch/endpoint/deployment ID等と判定だけを示す。表示された安全な削除計画は、そのままコピーできる承認JSONではない。内部の完全DB identityにはhostを保持し、自動返却の現在lease照合または個別承認されたprivate入力との厳密照合に使う。Gitゲートの証拠は `scope: repository-git-trigger-configuration` とmain/対象commit・blobの識別情報を持ち、`backendForcedDeploymentPreventionProven: false` のままとする。設定読取成功をproject全体の強制停止やlive実証完了として表示しない。

Actionsでは既存repository Variableの本番host、削除承認JSON、alias承認JSONをcallerの `jobs.secrets` から共通 `qa-private-run.yml` の一時的な `workflow_call` secretsへ渡し、calleeは対応するenv keyでprivateな照合へ供給する。remote Secretの登録・移動、Variable値や追加権限の変更はしない。callerにEnvironmentがないため、Preview Environmentの同名Variable overrideを引き継いだと推定しない。runnerのmaskと出力allowlistは別の防御であり、実Actionsのmask検証や過去ログの消去は完了扱いにしない。既存ログのraw値も報告へ転記しない。

### 削除承認のGET診断と失敗分類

`qa-pool.yml` の `action=plan-release` / `pr_number` / `lease_id` は、同じ既存Environment `Preview` でGET専用のinspect jobを実行する。変更用writer jobは選択されず、transportもGET以外を拒否する。対象資源を照合した完全な内部 `DeletePlan` と、callerから既に渡された旧 `CAKE_QA_DELETE_APPROVALS` を比較し、追加のVariables API呼出しや状態変更を行わない。ここでの `deleteApproval` は旧入力の診断であり、新しいowner planの発行・承認結果や、マージ済み通常QAの自動返却可否を示すものではない。

`deleteApproval` は `valid`（JSON配列として解析できたか）、`matches`（期限以外の完全対象一致）、`expiry`、`decision`、固定 `reason` だけを返す。未設定・空白は現行どおり空配列として扱う。hostを含む全DB identityと全deployment ID集合は内部で比較し、承認全文・entry・host・期限の原値を表示しない。対象計画が確認できなければ一致と期限は未確認にする。

診断は同じ一度捕捉した時刻で既存matcherを呼ぶ。期限ちょうどは `EXPIRED`。複数entryのうち完全一致の有効な承認があれば `ACTIVE` / `ALLOWED`、有効な一致がなく期限不正の一致があれば `INVALID`、それ以外の期限切れ一致は `EXPIRED`。不正JSONや配列以外は `VALIDATION_ERROR` とし、通常の承認不一致 `DENIED` と区別する。既存matcherの複数entryに対する `some`、対象条件、例外、削除直前の再確認は変更しない。診断の `ALLOWED` は診断時点の照合結果で、後の削除を事前許可・予約しない。

API境界と承認解析の失敗は、固定 `stage` / `provider` / `method` / `reason` とHTTP `status`（応答未取得はnull）だけで報告する。例えば `DELETE_ALIAS` の失敗と `APPROVAL_VALIDATE` の失敗を区別できる。stageは操作境界の分類で、応答statusのないstage名だけではAPI送信・削除の実施を断定しない。未知の例外は `UNKNOWN`。URL、request/response body、例外message/stack、資格情報を表示せず、GitHub error annotationも同じ安全な分類だけを使う。分類を追加しても停止・保持・削除承認の判定は変わらない。

## 既存READY probeのalias-only

手動 `alias-only` は対象PR・slot・lease・完全head SHA・既存deployment IDを指定し、同一repositoryの現在OPEN PRと `held` / `purpose: probe` のREADY記録を照合する。`CAKE_QA_ALIAS_APPROVALS` のstrictな9項目だけの要素と、project、PR、head、slot、lease、deployment、hostを含む完全DB identity、候補alias、期限が一致する場合だけ割当へ進む。通常運用のflagや `CAKE_QA_APPROVED_HEADS` が空でも、この個別承認だけで実行できる。生成用probe承認をalias承認の代用にしない。

この入口は追加claim、全OPEN PRの列挙、他枠のglobal reconcile、新deployment・Neon DBの作成を行わない。対象PRがCLOSEDならalias割当を停止する。close入口は、そのPRの既存leaseだけを別の削除承認でcleanupする。操作対象以外のPR・枠・lease・DBは変更しない。PR #37返却後のqa1再取得禁止は当時の導入作業の範囲であり、通常運用ではfreeを確認した枠に、新PR・新lease・新DBの承認済み計画で貸し出せる。

初回は対象aliasをGETで照合し、`aliasAssignment: {alias, deploymentId, sha, state: pending}` をsnapshotへ保存して再GETする。aliasが未割当の場合だけ一度のPOSTへ進み、その後のexact GETが承認対象と一致した場合だけ `assigned` を保存する。POSTや台帳保存の応答を失っても記録を保持し、後続のexact GET一致で `assigned` へ復旧する。既存pendingからの再実行・応答喪失後の再照合でGETがnull、失敗、別対象なら、盲目的にPOSTを再試行せず停止する。限定aliasの記録対象を次headへ付け替えたり、probeを通常貸出へ変更したりしない。

同じActions writerのqueueは直列化するが、外部writerとのalias競合にprovider APIのatomic保証があるとは扱わない。PR #42/#43の通常alias割当は確認済みだが、限定probeのalias-onlyと外部callerとの衝突挙動はこの受入試験で検証していない。直前・直後GETによる照合の限界を維持する。

## claimと初回配置

1. Cake内のmain向けOPEN PR、`codex/<task>` 枝、現在の完全head SHA、必須CIの確認結果、そのheadへの明示承認、同一repositoryのmain/対象PRの完全SHAにあるmain-only Git設定を確認する。空き枠へのclaim snapshot永続化までクラウドを生成しない。満枠時は待機する。
2. 作成intentを記録後、main/対象PRの完全SHAとGit設定を再確認し、Vercel REST `POST /v13/deployments` の `gitSource` にGitHub repo ID・feature枝の `ref`・完全 `sha` を指定する。`project` はcake project ID、`target` を省略してpreviewにする。Native DBはアプリbuild前に生成される。ローカルファイルのCLI deploymentや固定QA枝へのpushで代用しない。create入力に未定義の `prId` を追加しない。
3. 初回はNative hostが未確認なので、QA guardがDBクライアント作成前に停止する。このdeploymentはNative生成を開始するもので、成功Previewや検証済みアプリとは扱わない。DB保持用parkingは配置しない。
4. Neon APIで `misty-meadow-88903426` の対応feature枝・parent・branch ID・endpoint ID・実host・作成時刻を確認する。Productionとの分離をhost比較だけで断定せず、project所属と親DBも確認する。branchが今回のlease開始以降に作られ、書込みendpointが一意で所属も一致することを確認し、前leaseのbranch ID、endpoint ID、hostの再利用を拒否する。
5. 確認済みidentityをsnapshotへ保存し、同feature枝・同leaseの次deploymentへPR/枝/lease/slot/完全SHA、専用DB host、本番DB hostの非秘密guard情報を渡す。Native供給の `CAKE_TEST_DATABASE_URL` を使い、Productionの `DATABASE_URL` へfallbackしない。
6. phaseがapplicationのdeploymentで、lease markerのないDBはDB guardにより空DBまたは承認済みQA初期fixtureとの厳密一致を確認してidentityを登録する。空DBではmigrationと固定サンプルseedを行い、fixture一致時はseed済みとして使用する。受入後はレビュー済みの未適用migrationだけを適用する。READY後にVercel GETの `withGitRepoInfo=true` で同feature枝のref/完全SHAを確認する。通常運用では同lease・current headを再読取してaliasを付ける。probeは固有URLで結果を記録し、aliasを自動更新しない。旧headの成功で現在headのaliasを更新しない。

NeonのPreview actionと `Resource must be active before deployment` が必要。接続変数はdeployment時に注入され、projectの通常env一覧だけで取得できるとは限らない。Vercel owner向けGET応答は環境変数を含み得るため、全文をログへ出さず必要な非秘密fieldだけを記録する。

## DB初期化と同PR更新

新leaseは新feature枝由来のDBを使う。新PRのNative親は承認済みQA初期fixtureを持つ設計とし、lease markerがない初回だけ実DBを厳密照合する。従来の空DBからの初期化も維持する。親の設定値やmetadata読取だけでは、Nativeがその親を選ぶことや子DBのfixture一致を証明できない。PR #42/#43では子DBの所属・親ID、新PRの別DBと初期状態を確認したが、親fixture継承と空DB初期化の経路は区別できていない。

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

利用者が承認した運用方針により、通常leaseは同一repositoryのmainへPRがマージされたら自動返却する。既存のclosedイベントと5分scheduleから信頼済みmainの単一writerを使い、対象ごとのcleanup planのowner承認は要求しない。追加flag・Repository Variable・資格情報は作らず、人間の承認receiptを生成・代用しない。QA DBと入力データも失われる。この方針がmainに導入されてから実行され、コード・文書の変更だけを実資源の削除実施やlive検証として扱わない。

未マージでcloseしたPR、OPEN PRの手動返却、限定probeは自動返却の対象外。これらの不可逆な削除は、記録済み全deployment・alias・Native child branch/endpointと、QA DB・登録データが失われることを示して別承認を得る。個別開発依頼による通常生成やowner認証の利用だけで削除許可を推定しない。probeはPRがマージされても従来の期限付き個別削除承認を維持する。

1. closeのwriterは対象leaseを `deleting` に保存し、配置とalias更新を止める。自動返却ではGitHub RESTの現在PRを読み直し、番号・head repository・base main・feature枝・closedかつmergedであることを確認する。イベント入力や台帳だけからmergedを推定しない。現在slotのdeleting lease・head SHA・全記録deployment ID・alias・完全DB identityと、内部の完全削除計画を一致させる。QAがmerged HEADより古い場合も、削除するのは当該leaseの記録済み資源だけとする。未完了create intentや曖昧なorphanを解決できなければ削除・freeへ進めない。限定aliasの `pending` がexact GETで未確認ならcleanupも停止して記録を保持する。closeはそのPRだけを扱い、他枠のclaim・全OPEN PR列挙・global reconcile・生成へ広げない。
2. 個別承認を要する返却では、GET専用 `plan-release` で現在lease・台帳・全deployment ID・alias・Native identity・intent/orphanと実効削除承認サマリーを確認できる。この入口は安全な計画と判定だけを返し、状態変更・生成・削除をしない。未マージcloseは安全なcleanup plan IDを残し、OPENの手動計画要求はmainの `action=request-release` に対象 `pr_number`・完全 `source_sha`・現在 `lease_id` を指定する。ownerは全対象・台帳世代・期限・digest・データ喪失をレビューし、許可済み範囲ではCodexが既存owner認証で `qa:approve` を代行できる。probeは既存の個別承認経路を維持する。完全DB identityはmain内部で照合し、公開計画を承認JSONへコピーさせない。消失したIDやaliasも対象集合から除かず、手動計画のhead・lease・DB・alias・ID集合・世代が変われば再計画・再承認する。
3. マージ済み通常leaseは個別承認待ちにせず、そのrunまたは後続scheduleで進める。個別承認の対象は承認run成功後、対象 `pr_number`・現在 `lease_id` を指定する既存 `action=release` または既存5分scheduleで継続する。OPENでは `request-release` も使えるが、closed PRに繰り返さない。手動の対象限定操作を他PRまで扱うglobal refreshへ代替しない。承認run自身はDELETEを行わない。scheduleはpool flag falseでも動き、毎回自動返却条件または有効な個別削除承認を再照合する。
4. 成功・失敗・初回provisioningを含む記録済み全deployment IDをまずGETし、全件のproject・preview target・PR・feature枝・記録済みSHA・phase・leaseを検証する。現在lease・完全な対象集合・PRの所属と自動返却条件または個別承認、完全DB identityまたは既知DBの消失を各mutation直前にも再照合し、一致するaliasとdeployment IDだけをDELETEする。名前の類似で未記録対象を削除せず、Production、親DB、他PRに触れない。cancel APIは現writerに未実装で、実行中buildのcancelやFunction停止をこの操作で保証しない。
5. alias消失、全記録IDの不在、関連deployment残存なしをGETで確認する。`assigned` のalias GETがnullなら既に削除された可能性があるため、alias記録と全IDを保ったまま他の消失確認を続ける。通常aliasは候補名、限定probeは未記録ならnull・記録済みなら候補名を保持する。alias変更だけで旧固有URLのアプリ/API停止とは扱わない。正常な認証・全ページ取得・対象ID照合によりNative branchと全endpointの消失も直接GETで確認し、HTTP成功、PR close/merge、403やtimeoutを消失証拠にしない。
6. 消失結果を記録し、DB identityを返却済み識別子へ追加して `free` snapshotを保存する。開始済みFunction/transactionの監視・終了確認は現writerに未実装で、資源消失と実処理停止を区別する。次leaseが古いbranch ID・endpoint ID・hostを使うことを拒否する。deploymentの復元をNeon DBの復元保証として扱わない。

delete失敗、権限不足、ネットワーク拒否、Neon読取不能、intent未解決は `deleting` のまま保持し、後続writerが現在の記録・実資源・自動返却条件または個別承認を再照合して回復する。応答喪失は再読取して確定し、盲目的に同じ生成要求を繰り返さない。retentionによる途中削除も台帳とNative identityをreconcileする。保持deploymentを残してDBを温存する返却はしない。deployment/branch/endpoint消失は資源の削除確認であり、開始済みFunction/transactionの即停止を保証するものではない。現writerは実行中処理の監視APIを照会しない。この実処理の停止挙動もlive検証で確認する。

cleanupの実証結果、API認証のscope、自動返却方針、個別削除承認は独立した情報。cleanup未実証を検証済みとして補ったり、tokenがDELETE可能という理由で自動返却条件や個別承認を省略したりしない。intentが一覧で解決できない場合やDBが生成されなかったことを証明できない場合の手動復旧入口は未実装で、貸出を保持して調査する。

削除は通常生成の有効化やNative確認flagをtrueにして許可する仕組みではない。生成停止中でも、記録と実資源の所属・完全な対象集合・必要な読取認証と、マージ済み通常QAの自動返却条件または期限付き個別削除承認が揃えば対象PRの返却を再照合する。旧private `CAKE_QA_DELETE_APPROVALS` は完全DB identityと期限まで一致する既存入力のみ読取互換とし、新標準のために再登録しない。probeのalias有無は `aliasAssignment` 記録に従い、aliasや一部IDが途中で消失しても対象集合を勝手に縮めない。

### alias UIDを使う削除

[Get an Alias](https://vercel.com/docs/rest-api/aliases/get-an-alias) はhostnameまたはIDからaliasを取得し、`uid`・`alias`・`projectId`・`deploymentId`を返す。[Delete an Alias](https://vercel.com/docs/rest-api/aliases/delete-an-alias) はalias IDを削除対象とし、path説明ではIDまたはaliasを許容している。従って、実機のhostname指定DELETE 404を「hostnameが非対応だから」と断定しない。公式CLIの [alias rm](https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/alias/rm.ts) はlookup後の `alias.uid` を削除し、[Client](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/client.ts) が選択teamをscopeへ渡す。ただしCLIのliteral endpointは `/now/aliases/...` で、v2の根拠はREST仕様。Cakeでのproject・deployment・検証済みaccountIdの照合は追加guardである。PR #42/#43のcleanupではUID指定削除とUID・候補名の不在確認を実証したが、過去のhostname指定DELETE 404の原因を断定する証拠にはしない。

削除候補の正確な名前をGETし、取得したUID・名前・project・deploymentが現在の記録と一致することを確認する。teamはslugやalias名から推測せず、読取・照合済みprojectの `accountId` を使い、同じ `teamId` scopeでUIDを再GETする。DELETE直前にも候補名をGETしてUID・割当先・team所属を再照合し、現在lease・記録全体・自動返却条件または個別承認期限・完全DB identityの既存gateを通した対象だけを `/v2/aliases/{uid}?teamId=...` で削除する。削除専用の読取とDELETEは検証済み `teamId` だけをqueryへ渡し、通常の他Vercel操作が使う `slug` と同時送信しない。HTTP成功と応答の `status=SUCCESS` を確認しても、同じ実行内ではUID・候補名双方のGET404まで消失完了としない。privateな承認の `alias` は候補名のままとし、UIDへの置換や承認項目の追加は行わない。UIDや割当先の変更を観測した場合は新しい対象を自動追跡して削除せず停止する。GETからDELETEまでの完全な排他やCASを保証せず、Actionsの単一queueも外部callerを排他しない。直前GETの後に同じUIDが外部から再割当された競合は、DELETE後の不在確認でも完全に検出できないため、最後に観測した所属の照合を絶対的な誤削除防止保証としない。

| 観測 | 判定と次の処理 |
| --- | --- |
| 正しい認証・team scopeで対象を限定したGETが404 | その読取での不在。`assigned` の記録を保持して他の資源の消失確認を続ける。未確認の `pending` は引き続き保留し、不在だけで `free` にしない |
| UID指定DELETEが404、403、timeout、その他失敗 | 削除成功とせず固定stage/statusを報告して停止し、`deleting` と全記録IDを保持する。hostname DELETEなどへのfallbackや盲目的な再DELETEをしない |
| DELETE応答後のUIDまたは候補名GETが残存、別割当、読取不能 | 未完了・不明として停止する。後続の自動返却条件または個別承認を満たす再開でまずGETし、消失と現在の対象を確認する |
| 同じ実行のUID・候補名、全記録deployment、関連deployment、Native branch・全endpointの不在を確認 | 初めて返却済みDB identityを記録して `free` にできる。HTTP成功だけで解放しない |

現実装はalias UIDを台帳に追加保存しない。transport failureなどの不明結果から別runで再開する場合、最初の候補名GET404は「現在その名前が不在」という証拠であり、前runの旧UIDを独立して確認した証拠ではない。`assigned` の記録と全対象IDを保持したまま、既存serviceの他資源・所属・生成停止gateの確認へ進む。前runのDELETE成功や旧UIDの独立消失を後から確認済みと報告しない。

### 導入時のcleanup再開条件と現在の適用

導入時の承認はコード修正・検証・draft PRまでであり、remote DELETE、cleanup dispatch、設定変更、main merge、新規deployment/DB生成を含まなかった。その後のPR #42/#43では対象・データ喪失を別承認してcleanupと `free` を確認した。これらは当時の実証履歴であり、現在は利用者がマージ済み通常QAの自動返却方針を承認している。未マージclose・OPEN手動返却・probeには個別承認を維持する。削除済み旧Variableの復元や従前の10:00期限の延長を標準手順にしない。

1. ユーザーがmain導入を判断する前に、自動Production build → `db:setup` の影響、マージ済み通常QAの自動返却方針、個別承認の状態、実行中・待機中writerとschedule条件を確認する。Codexはmergeや現在資源の削除を、この実装変更の付随作業として実行しない。
2. main導入後はwriterが現在lease・全記録ID・aliasの所属・完全DB identity・intent/orphanと、RESTのmerged状態または個別承認を再照合する。GET専用 `plan-release` は同じ対象の診断に使えるが、自動返却の前に人が実行する必須手順ではない。UID照合は削除専用の内部読取で行い、GET診断から新owner承認を発行したり、旧Variableの `DENIED` を承認済みへ書き換えたりしない。
3. マージ済み通常QAは個別cleanup承認を要求せず、closedイベント・scheduleで継続する。未マージclose・OPENの手動返却は別途許可された `request-release`（OPENのみ）またはcloseのplan発行から安全なcleanup planをレビュー・owner承認する。probeは既存の個別削除承認を使う。個別承認runの成功後、対象PR番号・現在leaseの `action=release` またはscheduleで再開する。標準経路は旧private JSON再登録を要求せず、旧入力を使う場合だけGET診断の `deleteApproval.decision=ALLOWED` を確認する。自動返却・個別承認のどちらもscheduleが動くため、GET先行や手動一回だけの実行を保証しない。
4. 失敗したら固定stage/statusだけを記録し、deletingと全記録を保持する。後続writerは現在の記録・資源・自動返却条件または個別承認を再照合して回復する。個別承認は期限を延長せず、最新receiptの失敗・未完了なら新owner dispatch、対象や期限が変われば新planへの別承認を必要とする。
5. 全alias・全記録deployment・関連deployment・Native branch/全endpointの不在と台帳の `free` だけを返却完了とする。次PRの新しいDB identityと旧DB非再利用はcleanup成功だけで検証済みとしない。PR #42から#43への順次貸出で確認した範囲は両PRの実証記録に分けて残す。

## 開発者のコマンドと検証

コードを検証・commitしたら、最初に `task:pr --draft` でmain向けPRを作る。通常のdraft入口でoriginとHEADが一致せずpushが必要な場合は、同一repositoryのmain/対象HEADを完全SHAで読む `vercel.json` のmain-only停止設定（`**: false` / `main: true`、main以外のtrueなし）とローカルcommitのblobを共通checkerで検証してからfeature枝をpushする。この入口はRepository Variablesの管理権限や3flagの有効化を要求しない。Preview未実施はdraft本文で理由を明示でき、文書のみの変更ではPreviewは不要。`deploy:preview` は同じGit設定のゲートに加え通常有効化と先行PRを確認してから検証済みSHAをfeature枝へpushし、mainへ `request-preview` をdispatchする。plan承認待ちなら安全なplan IDを返し、承認run成功後の再実行で同PR/同lease/current HEADのREADY記録を読む。CLIはVercel/Neonを直接生成・削除しない。個別開発依頼の生成範囲を守る。マージ済み通常QAは承認済み方針により自動返却し、未マージclose・OPEN手動返却・probeは全対象とデータ喪失の別承認を得る。

```bash
npm run task:pr -- --draft --title '変更内容を表すタイトル' --verification-file /tmp/cake-verification.md
npm run deploy:preview
# WAIT_APPROVALの対象・HEAD・両CI・lease・期限・digestを機械照合する
# 個別依頼の許可範囲内ではCodexが既存owner本人のgh認証で代行できる
npm run qa:approve -- --plan-id <ID>
# actor/main/attempt 1/completed-successの確認後に同じHEADで再実行する
npm run deploy:preview
```

Preview完了後、最新GETで同PR・現在HEAD・lease・READY deploymentとaliasの割当先が一致することを確認してから固定QA URLを使い、PC/スマートフォンの画面とAPIを検証する。Deployment固有URLは診断用に併記し、完全SHA、lease、deployment ID、Neon project/branch/endpoint、migration/seed結果を報告する。固定aliasの名前だけで検証コミットを判定しない。再変更後は再commit・新HEADの計画承認・再deployment・再検証する。検証済みPR本文更新は `task:pr` の通常経路を使い、draftからの公開・mergeはユーザーが判断する。

ローカルではlint、test、build、TypeScriptと、同時claim、旧lease拒否、snapshot分岐、重複request、応答喪失、stale head、alias不一致、orphan、全ページ読取、delete失敗保持、旧DB再利用拒否、同PRデータ保持、新PR混入停止の回帰を確認する。実SQLの空DB/承認済みfixture判定・transaction/lockとcloud lifecycleの証拠は区別し、PR #42/#43の実測範囲と上記の未試験項目を混同しない。必要な承認・認証・現在のgateを確認できない対象は生成・alias更新・削除を停止する。

## ローカルSQL検証

`scripts/verify-preview-database-safety.mjs` は任意に導入したPGlite 0.5.8で現行11migrationと初回base照合・guard/seedの実SQLを実行する補助スクリプト。`dataDir`を指定しない[一時メモリDB](https://pglite.dev/docs/filesystems)を使い、`finally`で閉じる。実環境の本番・`CAKE_TEST_DATABASE_URL`を読み込まず、setupの接続先はローカルDBへ差し替え、seedは生成したSQLを同じDBへ実行する。DELETE/DROPもこの一時DB内の検証fixtureに限る。

この成功自体は承認済みNeonテストDBでの実測ではない。PR #42/#43の実環境での初期状態、Native作成・保持・cleanupの記録とは別の証拠として扱い、親fixture継承か空DB初期化かの経路や複数接続の競合を検証済みにしない。一時ディレクトリに残るエンジン・npmキャッシュ・検証ソースは実証DBの保存データではない。再現コマンドと検証結果は [検証報告](qa-pool-verification.md) を参照する。

## 公式仕様

- [GitHub Deployments API](https://docs.github.com/en/rest/deployments/deployments) / [statusとauto_inactive](https://docs.github.com/en/rest/deployments/statuses#create-a-deployment-status) / [status履歴retention](https://docs.github.com/en/rest/deployments/statuses#data-retention)
- [Actions concurrencyとqueue](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency) / [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [Vercel Git生成停止](https://vercel.com/docs/project-configuration/git-configuration) / [GitHub通知field](https://github.com/vercel/sdk/blob/main/docs/models/updateprojectgitprovideroptions.md) / [project設定API](https://vercel.com/docs/rest-api/projects/update-an-existing-project)
- [Vercel deployment作成](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment) / [gitSource schema](https://github.com/vercel/sdk/blob/main/docs/models/gitsource2.md) / [取得](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url) / [一覧](https://vercel.com/docs/rest-api/deployments/list-deployments) / [削除](https://vercel.com/docs/rest-api/deployments/delete-a-deployment)
- [alias割当](https://vercel.com/docs/rest-api/aliases/assign-an-alias) / [alias取得](https://vercel.com/docs/rest-api/aliases/get-an-alias) / [alias削除](https://vercel.com/docs/rest-api/aliases/delete-an-alias)
- [Vercel integration actions](https://vercel.com/docs/integrations/create-integration/deployment-integration-action) / [Neon managed integration](https://neon.com/docs/guides/vercel-managed-integration) / [cleanup](https://neon.com/docs/guides/vercel-branch-cleanup)
- [Neon branches一覧](https://api-docs.neon.tech/reference/listprojectbranches) / [endpoints一覧](https://api-docs.neon.tech/reference/listprojectendpoints) / [branch削除](https://api-docs.neon.tech/reference/deleteprojectbranch) / [API key権限](https://neon.com/docs/manage/api-keys)

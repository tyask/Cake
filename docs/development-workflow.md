# 開発・QA運用手順

Cakeの開発、PR作成、QA予約、デプロイ、検証、返却の手順をここで管理する。Codexの作業場所がCloudでもローカルPCでも同じ手順を使う。作業開始前にAGENTS.mdとこの文書を読む。

## 適用状態と導入

現在の方式は、GitHub Actionsが常設の管理専用DBでQA枠を管理し、CodexがVercel CLIでデプロイ・テストする構成である。GitHub Deployments APIを貸出台帳や承認計画の保存に使う方式から移行する。文書・実装の変更だけで、管理DBの作成、Secrets設定、mainへの導入、既存資源の返却を完了したとは扱わない。

Cannele APIへの連携は[「Canneleへの切替」](#canneleへの切替)の条件を満たしてから有効化する。初期設定は無効で、この切替までは以下のActions方式を使う。

導入時は次を確認する。

1. Vercel MarketplaceのNeonで管理専用resource `cake-qa-registry`を用意し、Actionsから接続できるようにする。管理DBは本番の業務DBやタスク専用テストDBと分け、Cakeの本番アプリへ接続せず、QA返却時にも削除しない。
2. 旧台帳の全QA枠、進行中のActions、Vercelのalias・Deployment、Neonのbranch・endpointを読み取り照合する。旧台帳の使用中資源を消したり、新台帳を空で初期化して貸し直したりしない。
3. 旧貸出を旧方式で安全に返却し、全枠が空きで固定alias・旧Deployment・Native DBが消失していることを直接確認する。`CAKE_QA_POOL_ENABLED=false`へ設定し、旧`qa-pool.yml`のqueued/in-progress runが0であることを確認してから、owner本人が管理専用DBの初期化を依頼する。管理専用の`db/qa-registry/001_registry.sql`だけを適用し、使用中の旧貸出を新管理DBへ自動移行しない。
4. 初期化成功後、`CAKE_QA_REGISTRY_ENABLED=true`へ切り替えて旧writerのskipを確認する。その後`CAKE_QA_POOL_ENABLED=true`へ戻し、実際の予約・デプロイ・公開・cleanupを検証して運用結果を記録する。旧方式の承認や有効化flagsを、新方式の稼働証拠として流用しない。

旧方式のPR #46は未マージでclose済み。そのqa1のcleanupは[run 38566413401](https://github.com/tyask/Cake/actions/runs/38566413401)が成功し、writerが全対象資源の消失を確認して、台帳record `7065735775`で`free`へ戻した。これはcleanup実行時点の記録であり、切替前にも全枠・実資源を読み直す。旧方式では未マージcloseに別の削除承認が必要だったため、新方式の自動削除方針を過去の貸出に無条件で適用しない。

新方式の入口はmainの`qa-registry.yml`である。管理DBの接続情報はRepository Secretsの`CAKE_QA_REGISTRY_DATABASE_URL`、接続先を固定照合するhostは同じくSecretの`CAKE_QA_REGISTRY_DATABASE_HOST`に置く。QA枠ごとのGitHub Environmentは追加しない。既存の`VERCEL_TOKEN`と`NEON_API_KEY`もActionsで使う。これらは値を表示せず、設定済みであることと実接続・権限を確認する。管理DB用SQLは業務DBの`db/migrations/`や`db:setup`に混ぜない。Secrets管理APIの403は登録失敗として報告し、DB作成やmainへの実装導入だけで接続設定まで完了したと扱わない。

### 管理DBの作成状況と非公開設定

管理用resource `fumin1/cake-qa-registry`（ID `store_zFAmizNB1NM3cSNF`）はVercel Marketplaceで作成済み。Neonの`free_v3`、region `iad1`、`auth=false`で、Cakeアプリのprojectには接続していない。`auth=false`はMarketplace resourceの作成設定であり、DBを認証不要で公開したという意味ではない。料金・上限は利用時のplanで確認する。

利用者は次の2件を[Repository Secrets設定](https://github.com/tyask/Cake/settings/secrets/actions)へ非公開で登録した。GitHub Secrets管理APIは403のため値を読み取って検証していないが、initialize run `38584074090`でActionsからの接続・初期化・3枠freeのreadbackは成功した。接続情報を変更する場合も管理用resourceのConnectから取得し、チャットやPRへ貼らない。

| Secret | 登録する値 |
| --- | --- |
| `CAKE_QA_REGISTRY_DATABASE_URL` | 管理専用DBの認証付きPostgreSQL接続URL |
| `CAKE_QA_REGISTRY_DATABASE_HOST` | 同じ管理専用DBのendpoint hostname |

接続URLとpinのhostは照合し、本番・テスト・親DBと同じ接続先を拒否する。`DATABASE_URL`や`CAKE_TEST_DATABASE_URL`を管理DBへ代用しない。

### 管理DBの初期化

新workflowをmainへ導入し、接続Secretsを登録してから、`CAKE_QA_REGISTRY_ENABLED`をfalseまたは未設定、`CAKE_QA_POOL_ENABLED=false`に保ってowner本人が初期化を依頼する。旧`qa-pool.yml`のqueued/in-progress runが0であることも必須である。毎回新しいUUIDを`request_id`に指定する。初期化にはPR番号は不要である。

```bash
node -p 'crypto.randomUUID()'
```

表示されたUUIDを次の`request_id`へ指定する。

```text
gh workflow run qa-registry.yml --repo tyask/Cake --ref main -f action=initialize -f request_id=<生成したUUID>
```

mainの`scripts/qa-registry-initialize.ts`が、GitHub由来のowner本人・trusted main・初回attempt、旧pool無効と旧runの待機・実行中0件を確認する。次に旧poolの全枠がfree、全固定aliasが未割当、記録済みDeploymentが直接GETで不在、返却済みDBを含む全branch・endpointが不在であることを確認し、管理DBだけへ`db/qa-registry/001_registry.sql`を適用する。どれかが残存・不明なら初期化を停止する。

初期化runの成功と管理DBの3枠を読み取り確認してから`CAKE_QA_REGISTRY_ENABLED=true`へ変更し、旧writerがskipすることを確認して`CAKE_QA_POOL_ENABLED=true`へ戻す。initializeは通常操作と異なりreceipt artifactを作らないので、同じ依頼UUIDのrunと安全な初期化完了ログを確認する。使用中DBを空に戻す目的でinitializeを再実行しない。

管理DDLはSQLのトップレベル文へ分割し、外側の`BEGIN` / `COMMIT`をNeon HTTPSの`transaction`へ置き換えて一括適用する。関数本体のドル引用内のセミコロンは分割しない。途中の文が失敗した場合は全体をrollbackする。初期化ログは固定のstage名だけを出し、接続先・SQL本文・DBエラーの詳細は表示しない。

PR #47のmain導入後、初回の[initialize run 38581479595](https://github.com/tyask/Cake/actions/runs/38581479595)は失敗した。このrunでは停止stageを表示していないため、その失敗原因をDDLと断定しない。PR #48のmain導入後、[initialize run 38584074090](https://github.com/tyask/Cake/actions/runs/38584074090)はowner・旧run停止・旧台帳・alias・Deployment・DB不在、DDL適用、管理DBの3枠freeのreadbackまで成功した。`CAKE_QA_REGISTRY_ENABLED=true`と`CAKE_QA_POOL_ENABLED=true`へ切り替え、[旧writerのrun 38584608059](https://github.com/tyask/Cake/actions/runs/38584608059)がskipすることを確認してからQA生成を再開した。再実行時も空DB・旧資源不在のguardを省略しない。

管理DBの将来のschema変更は`db/qa-registry/`へ番号付きDDLを追加し、適用済みDDLを書き換えず、管理専用の適用手順をレビューして実行する。Cakeの業務migration、`npm run db:setup`、Vercelのアプリbuildから管理用DDLを実行しない。

### Cannele切替前の旧管理DB互換fence

`db/qa-registry/002_cannele_fence.sql`と専用の`qa-registry-fence.yml`はCanneleへの切替準備である。実装の追加だけで実DBへ適用した、旧認証を失効させた、APIへ切り替えたとは扱わない。適用済みの`001_registry.sql`は変更しない。

適用前に、今回の旧workflow停止guardを含むmainをレビューして導入する。`CAKE_CANNELE_ENABLED=true`は旧`qa-pool.yml` / `qa-private-run.yml` / `qa-registry.yml` / `qa-registry-run.yml`のQA操作jobを停止する。`CAKE_QA_POOL_ENABLED=false`、`CAKE_QA_REGISTRY_ENABLED=false`も維持する。この段階のflagは旧job停止を表し、Cannele APIの稼働やCloud/PCクライアントの移行完了を証明しない。二つの旧flagだけをfalseへ変更すると旧`qa-pool.yml`のclosedイベント処理が動き得るため、Cannele停止guardを省略しない。

使用中の旧貸出がある場合は、旧方式でcleanupを確認してからglobal停止guardを有効にする。停止後に旧cleanup jobが動くことを前提としない。owner本人は、4つの旧workflowのqueued / in-progress / waitingなどのrunがすべて終了したことに加え、旧コードを使うCloud・PC・別の自動処理を止め、旧管理DB/owner資格情報の撤去と管理DB接続sessionのdrainを確認する。provider tokenを保持する場合も旧actor・送信中writer・不明な作成intentが残らないことを確認し、保持方針を移行JSONへ明示する。Actions一覧やDB内のfenceだけでは、古いowner資格情報を使う外部処理の停止・権限失効を保証できない。確認できない状態では適用しない。

互換installerとreadinessも、新しい`CANNELE_REGISTRY_ADMIN_DATABASE_URL` / `_HOST`だけを使う。既存objectの実ownerとして接続できる新しい資格情報を別名へ確保し、旧password・旧Secret名を失効・撤去して接続sessionを終了してから002を導入する。SQL roleを変える場合は既存objectのownership要件を確認し、旧Secret名へ新passwordを入れ直さない。

レビューした現在のmainの完全なSHAを指定して、専用workflowを依頼する。`confirm_legacy_drain=true`は上述の旧actor停止・旧管理DB/owner資格情報撤去・DB session排出を完了したownerの明示確認であり、provider token失効済みという意味ではない。installerが外部停止を自動的に証明する値でもない。

```text
gh workflow run qa-registry-fence.yml --repo tyask/Cake --ref main -f action=install -f reviewed_revision=<レビュー済み現在mainの40桁SHA> -f confirm_legacy_drain=true
```

installerはowner本人、初回run、専用workflow、checkoutと現在mainの一致、停止flags、全4workflowの完全な一覧を検査する。専用DBのhost pin、旧identity、`001`の固定SHA-256とtable・column・constraint・index・function本体を含む既知のobject footprintを照合する。未知のobject、変更されたguard、別DB、Cannele schema、部分適用済みfenceがあれば停止する。GitHubとDB以外のAPIは呼ばず、providerの認証情報も受け取らない。

適用前に、同じordered lock内で既存のidentityとschemaを読み取り検査する。すでに完全に同じrevision・checksumのreceiptと`002`のobject・function本体があれば、保存済みreceiptを返してDDLやUPDATEを実行しない。異なるreceipt・部分適用・schema driftがあれば拒否する。`action=inspect`ではこの読み取り検査だけを行い、未適用の場合もDDLへ進まない。応答が失われた場合は同じレビュー済みSHAの`inspect`で確認し、mainが変わった場合は別のレビュー済み読取手順で元のreceiptを照合する。

初回の適用は同じNeon transaction内で旧legacy lock、Cannele control lockの順に取得し、`001`のschema検査を再実施してから、`002`、両DDLのchecksumとmain SHAを含むimmutable receipt、readbackをまとめてcommitする。既存の貸出・履歴・資源IDを保持し、`writer_mode=legacy`、`writer_epoch=1`の互換状態で終える。途中失敗はrollbackし、応答が不明ならreceiptを読み取り確認するまで適用成功と扱わない。fence適用だけで旧資源を削除したりCannele用の空台帳を作ったりしない。

実際のCannele clean-startは別のレビュー済み管理手順で行う。旧writerをmaintenanceへ変える処理とCannele初期化は、この互換installerの対象外である。新しい旧initializerは同じordered lock内でCannele schemaまたはmaintenance fenceを検出すると拒否し、切替後の旧台帳再作成を防ぐ。Cannele側のschemaはAPIを無効化しても保持する。

Cloud/PCの共通クライアントは`scripts/qa-client.ts`。Actionsの結果は安全なID・状態だけの`qa-result-<requestId>` artifactの`result.json`から受け取る。DB host、接続文字列、認証情報をartifactへ出さない。mainの実行元SHA、workflow、依頼ID、owner本人、全job成功、初回attempt、PR・貸出の一致を確認し、別run・失敗run・rerunの結果を使わない。mainへの導入前は新コマンドを実行可能な入口として案内しない。旧方式の実装条件・実測記録は末尾の「旧方式の運用・検証記録」に保持する。

通常はGitHub CLIがartifactをダウンロードする。Cloudでartifact保存先へのリダイレクトが403になる場合は、`CAKE_QA_ARTIFACT_CACHE`に作業用ディレクトリを指定する。共通コマンドは確認済みrunのartifact ID・依頼IDを通知して有限時間だけ待つ。`qa:verify`も画面確認の前後にstatusを取得するため、両方の通知を同じ方法で処理する。CodexがGitHub連携のartifact取得ツールでその正確なIDを取得し、ZIPを同ディレクトリの`<artifact ID>.zip`へ置く。接続制限を迂回せず、GitHub APIのdigest・サイズとZIP全体を照合してから、単一の`result.json`を読み取る。任意のJSONやActionsログの転記をreceiptの代用にしない。取得後にもmain・PR・runを再照合し、作業終了後にcacheを削除する。ZIPのダウンロードURLをログ・PRへ表示しない。

## 役割と保存先

| 担当 | 役割 |
| --- | --- |
| Codex（Cloud / ローカルPC） | ブランチ作成、開発、ローカル検証、draft PR作成、Actionsへの依頼、Vercel CLIでのデプロイ、画面・APIテスト、Ready for reviewへの切替 |
| GitHub Actions | QA枠の予約、資源情報の登録、固定QA URLの公開、cleanup、返却 |
| 常設の管理専用DB | QA枠の状態、貸出ID、PR・ブランチ・コミット、資源ID、再実行に必要な操作情報 |
| 利用者 | PRのレビューとmainへのマージ |

CloudとPCは管理DBを直接操作せず、mainの`workflow_dispatch`を使ってActionsに依頼し、その結果を読み取る。管理DBの接続情報はActions側だけに置く。PRのコードを管理DBやcleanup用の認証付きで実行しない。

`qa1` / `qa2` / `qa3`は固定URLを貸し出す確認枠であり、Gitブランチではない。各PRの`codex/<task>`ブランチからDeploymentを作る。固定QA枝、台帳枝、DB保持用parking deploymentは作らない。

| 枠 | 固定QA URL |
| --- | --- |
| qa1 | https://cake-qa1-fumin.vercel.app/ |
| qa2 | https://cake-qa2-fumin.vercel.app/ |
| qa3 | https://cake-qa3-fumin.vercel.app/ |

対象はGitHub `tyask/Cake`、Vercel `fumin1/cake`（project `prj_Z37vquodhpRd08ZTAtYnP0qa59jD`）。タスク用Preview DBは本番と別のNeon project `misty-meadow-88903426`の`cake-preview`を使う。管理専用DBの接続先・権限はこれと別に確認する。

## 作業環境の準備と認証

Cloud・PCのどちらでもNode.js 24、npm、Git、GitHub CLI、Vercel CLI 64.0.2、ブラウザ操作ツールを用意する。既存認証を確認し、別環境・別セッションの設定を自動で引き継いだと仮定しない。

```bash
gh auth status
gh api repos/tyask/Cake --jq .full_name
npx --yes vercel@64.0.2 whoami
npx --yes vercel@64.0.2 link --scope fumin1 --project cake
```

Gitの取得、GitHub API、Vercelの認証は別々に確認する。QA操作には`tyask/Cake`のowner本人のGitHub認証と、`fumin1/cake`にアクセスできるVercel本人認証を使う。未認証なら各環境で`gh auth login`や`vercel login`を行う。device認証は表示されたURLを利用者が開いて認証する。CloudとPCの間で認証ファイルをコピーしない。worktreeの`.vercel`もコピーせず、対象projectへのlinkを確認する。

`GH_TOKEN` / `GITHUB_TOKEN`はGitHub CLIの保存済み認証より優先する。401発生後に本人ログインをやり直しても、古い環境変数が残ると認証は切り替わらない。保存済み本人認証を使う場合は、そのタスクのコマンドだけ両変数を外し、同じ`GH_CONFIG_DIR`をghとnpmへ引き継ぐ。例えばCloudのBashでは、本人確認済みの設定に対して次を使える。認証ファイルは作業ユーザーだけが読める権限で保存し、値を表示・Git登録しない。

```bash
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR=/workspace/.gh-cli gh api user --jq .login
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR=/workspace/.gh-cli npm run qa:status
```

Cloudでは環境のネットワーク方針、proxy、CA、書込み可能な場所を確認し、制限を迂回しない。npmの既定キャッシュへ書き込めない場合は、書込み可能な一時ディレクトリを指定する。

```bash
export npm_config_cache=/tmp/cake-npm-cache
```

認証情報、接続文字列、Cookie、短期トークンをGit・PR・作業ログ・例外メッセージ・スクリーンショットへ出さない。短期トークンをブラウザへ渡す場合は対象のQA originへのリクエストに限り、外部ページへ送らない。認証用の環境ファイルと一時ブラウザデータはGitに登録せず、不要になったら削除する。期限・権限は発行元の実際の設定で確認し、過去の認証の有効期間を一般化しない。

個別の開発依頼と合意した範囲に基づいて作業を進め、同じ許可済み対象へ毎回のチャット再確認やGitHub UI操作を要求しない。依頼外のPR・本番・設定、資源数や影響を変更する場合は具体的な対象を示して確認する。認証成功を恒久的な無制限の操作許可として扱わない。説明・作業結果の報告は日本語で行い、既存の未コミット変更を保持する。

VercelのDeployment ProtectionとCake自身のログインは別である。Previewへ到達する認証を確認したうえで、CakeのテストユーザーA/Bでログインする。保護を通過できない場合は検証未実施として扱い、利用者に必要な認証操作を案内する。保護設定を無断で弱めない。

## 開発からPR公開まで

### 1. 最新mainから開発する

設計と依頼範囲を確認し、元のリポジトリから次を実行する。

```bash
npm run task:start -- feature-name
cd ../Cake-worktrees/feature-name
```

`task:start`は最新の`origin/main`から`codex/feature-name`と専用worktreeを作成し、`npm ci`を実行する。タスク名は60文字以内の英小文字・数字・ハイフン。既存ブランチやフォルダは上書きしない。作成先を変える場合は`CAKE_WORKTREE_ROOT`を指定する。インストールに失敗した場合は作成済みworktreeで`npm ci`を再実行する。

元のフォルダの未コミット変更、`.env.local`、`.vercel`、`node_modules`を新worktreeへコピーしない。アプリ一般の設定は[READMEのローカルセットアップ](../README.md#ローカルセットアップ)を参照する。対象タスクのテストDBを使い、本番の環境ファイルや`DATABASE_URL`を流用しない。まだQA枠を予約しない。

機能・UI・API・DBを変更する場合は関連する基本設計・詳細設計を確認する。仕様や運用が変わったら関連設計書とこの文書を更新する。DB変更は適用済みmigrationを書き換えず、番号付きmigrationを追加する。本番公開時に旧版も同じDBを使うため、旧版互換のある変更を行う。

### 2. ローカル検証してcommitする

コード変更後は次を実行する。

```bash
npm run lint
npm test
npm run build
```

業務ロジック・認可を変更した場合は回帰テストを追加・更新する。UI変更はPCとスマートフォンで表示・操作を確認する。検証できない項目は理由を報告する。変更したファイルだけをcommitし、秘密情報を含めない。

### 3. draft PRを作る

変更内容、完全head SHA、ローカル検証結果、未検証項目をMarkdownへ記録し、専用worktreeから実行する。

```bash
npm run task:pr -- --draft --title '変更内容を表すタイトル' --verification-file /tmp/cake-verification.md
```

main向けの同一repositoryのPRを作る。Git連携でfeatureブランチのPreviewが勝手に生成されないよう、mainと対象HEADの`vercel.json`で`git.deploymentEnabled: {"**": false, "main": true}`を確認する。main以外をtrueにする規則は禁止する。確認不能ならpushを停止する。Git設定はCLIや外部callerからの生成まで強制的に禁止する仕組みではない。

文書のみの変更はQAデプロイ不要と理由を記載できる。設定変更の導入PRも、未導入の機能を使って検証済みと扱わない。

CIのランタイム・テスト実行設定と説明文書だけを変更し、アプリ・QA運用コード・DB・依存関係を変更しない場合は、PreviewではそのCI環境を検証できないためQA枠を予約しない。PR本文へ理由を記載し、共通コマンドでdraft PRを作成する。現在HEADのpush・PR両方のCIで`npm ci`・lint・test・buildの成功を確認した後、本文を更新し`gh pr ready`でdraftを解除する。この場合はQAの貸出や画面検証証拠を作らない。

### 4. デプロイ直前にQA枠を予約する

`npm run deploy:preview`はデプロイ直前にmainのActionsへ予約を依頼し、貸出IDを取得する。予約だけ行う共通入口は`npm run qa:reserve`、貸出状態の読取は`npm run qa:status`である。PR番号・現在の完全SHAを使い、Actionsが同一repository、OPEN PR、main向け、ブランチ、現在HEADを確認して空き枠を条件付き更新で予約する。以後の操作はこの貸出IDを照合する。

**満杯の場合はデプロイ・テストDB生成を行わず、PRをdraftのまま残して作業を終了する。** 空き確認を利用者に要求しない。「このPRのQA確認を再開して」という再依頼時に、Codexが空きを確認して予約を再実行する。待ち行列による自動再開や定期監視は設けない。

### 5. Cloud / PCからデプロイしてテストする

Codexが`npm run deploy:preview`で予約した貸出に対してVercel CLIの`vercel api`から実証済みのGitSource作成経路を呼び、Previewとタスク専用Native DBを準備する。Cloud/PC側が作成を行い、ActionsはDeploymentを生成しない。通常の`vercel deploy`によるファイルuploadでNative branchが生成される保証は確認していないため、この共通コマンドの作成経路を使う。

外部資源の作成前にActionsへ操作情報を記録し、作成後にDeployment・Neon branch・endpointの正確なIDを登録する。作成のbegin/registerはこの共通コマンドの内部処理であり、利用者が手入力で台帳を書き換えない。失敗や通信断時に同じ資源を二重作成しない。

ActionsがNeon APIで貸出先DBの完全なhostとbranch・endpointを照合し、そのhostをpooler表記の差分だけ正規化してSHA-256にした`databaseHostDigest`を返す。Cloud/PCはこの値を`CAKE_QA_DATABASE_HOST_SHA256`としてアプリへ渡す。アプリはNativeが供給する`CAKE_TEST_DATABASE_URL`のhostを同じ方法で照合し、不一致・確認不足ならDB接続前に停止する。endpoint IDの一部分だけの比較で代用しない。新CLIはDB接続URLやhost原文を取得せず、ローカルの`.vercel`にはprojectの識別情報だけを保存する。ブランチの静的なPreview設定を`env pull`してNative DBの接続先と推定しない。

本番との分離照合には`productionHostDigest`（本番hostを同じ方法で正規化したSHA-256）をActionsから受け取り、アプリguardの`CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256`へ渡す。本番host原文はActions側だけに置く。貸出先と本番のhost hashは非秘密の照合用metadataであり、DBの認証情報ではない。接続URL・host原文・資格情報をartifact・PR・ログへ出さない。旧plain host方式は既存環境の互換として保持し、新方式の公開receiptへ混ぜない。

PR #49では、qa1の予約とprovisioning DeploymentからのNative DB生成、Actionsによる初回registerまで確認した。静的なPreview設定と実際の子DBの接続先が異なる問題をQA host hashの照合で修正し、mainへ導入した。#49のマージ後、[自動返却 run 38596154103](https://github.com/tyask/Cake/actions/runs/38596154103)が全記録済み資源の消失を確認してqa1をfreeへ戻した。この貸出ではapplication Deploymentと画面・APIの検証は完了していないため、新しい試験PRで予約から公開・画面確認・close後の返却まで検証する。返却済みの貸出やブランチを再予約しない。

```bash
npm run deploy:preview
```

初回DBは空DBまたは承認済みQA初期fixtureを厳密照合して受け入れる。混入したschema・ユーザー・業務データを削除して続行しない。build・migration・seedとDB identityの照合に成功してから、READYなDeployment固有URLで画面操作・APIテストを行う。VercelがREADYになっただけでは動作確認完了としない。

新方式の導入確認には試験用PRを使い、予約・固有URLの確認・固定URLの公開・Readyへの切替を順に実行する。試験PRのclose後は、自動返却Actionsが成功し、対象alias・全Deployment・専用DBが消失して枠が空きへ戻ったことを確認する。

同じPRの追加commitは同じ貸出・テストDBを使い、編集データや利用者設定を保持する。新HEADで再デプロイ・再検証する。別PRには前の貸出のDBを再利用しない。

`npm run qa:verify -- --url <Deployment固有URL>`でPC/mobile、A/Bテストログイン、ダッシュボード、読み取りAPIのスモーク確認を行う。ブラウザ全体、各組み合わせ、API取得と終了処理には時間上限を設ける。表示する進捗はPC/mobile・A/Bと固定の確認段階だけとし、認証・レスポンス本文・原例外は出さない。失敗や時間超過では成功証拠を作らず、終了時に中断した背景通信を待ち続けない。Vercelの保護を通過する短期トークンは`vercel env run`で子プロセス環境へ渡し、チャット・ファイル・引数へ保存しない。変更箇所固有の操作・APIテストはCodexが別途行い、検証報告へ記載する。

### 6. 固定QA URLで公開して確認する

`npm run qa:publish -- --deployment <確認済みDeployment ID>`でテスト済みDeploymentと現在HEADを指定してActionsへ公開を依頼する。Actionsは貸出ID、PR・ブランチ・完全SHA、Vercel project、DeploymentのPreview/READY状態、DB identityを照合し、固定URLのaliasを割り当てる。aliasを上書きする前後に実際の割当先を確認し、他project・他貸出の資源を変更しない。

Codexが固定QA URLでもログイン、変更箇所の画面・API、必要なPC/mobile操作を確認する。固定URLの名前だけで正しいコミットと判断しない。変更後は再デプロイ・再検証・公開確認が必要である。

`npm run qa:verify -- --url <固定QA URL>`でもスモーク確認を行う。同じ貸出・HEAD・Deploymentで固有URLと固定URLの両方が成功した場合だけ、秘密情報を含まない`.cake/qa-verification.json`をReady判定に使う。スモークは業務データの登録・更新まで確認した証拠ではない。

### 7. PRをReady for reviewにする

PR本文へ固定QA URL、Deployment固有URL、完全SHA、貸出ID、資源ID、lint/test/build、migration/seed、画面・APIの検証結果、未実施項目と理由を記載する。最新HEADと公開先の一致を確認し、次のコマンドで同じPRを更新してCodexがdraftを解除する。本文とタイトルはGitHub REST APIで更新し、更新に成功した後だけReadyへ進む。失敗・未確認のデプロイを成功として記載しない。必要な検証が不足している場合は`--draft`を付けてdraftを維持して理由を報告する。

```bash
npm run task:pr -- --title '変更内容を表すタイトル' --verification-file /tmp/cake-verification.md
```

CIはNode.js 24.19.0に固定して`npm ci`、lint、test、buildを行う。QA台帳fenceの競合検証には使い捨てPostgreSQL17を用意し、`CAKE_REGISTRY_FENCE_REQUIRE_DATABASE_TESTS=true`でDB検証のskipを拒否する。24系の最新版へ自動追従させない。Node.js 24.21.0のCIではPGliteの実SQLテスト中にプロセスが異常終了したため、Cloudと同じ版へ揃える暫定対策である。`corrupted size vs. prev_size`やV8の内部assertによる停止をSQLのアサーション失敗と扱わず、DBテストは省略しない。ランタイムを更新するときは、SQLテストと全体のlint/test/buildを新しい版で確認してからCIの固定値を変更する。mainのRulesetはPR経由と必須`ci`の成功、最新mainへの追従を要求する。Codexはマージ・自動マージ設定を行わない。利用者が差分、検証結果、QA画面を確認してマージする。

## 台帳と競合防止

管理専用DBには各枠の状態、貸出ID、PR、featureブランチ、完全SHA、作成したDeployment・テストDBの識別情報、更新日時と必要な操作intentを保存する。秘密情報や接続文字列は保存しない。細かな表示用の進捗はActions/Vercelのログから確認する。

状態は`free`（空き）→`reserved`（予約中）→`published`（公開中）→`deleting`（削除中）→`free`を基本とする。作成成功・失敗やworkflow完了だけで枠を返却しない。

予約はDBのトランザクション・条件付き更新で空き確認と確保を一度に行う。更新・公開・返却では枠名だけでなく貸出IDと期待する状態・世代を条件に含める。遅れた古い作業の操作が、新しい貸出を変更・削除できないようにする。Actionsの直列実行だけに競合防止を依存しない。

別のCloud/PCで同じPRを続ける場合はブランチを取得し、Actionsから現貸出と実資源を読み直す。ローカルの古いファイルを正本にせず、同じ貸出・DBを使って再開する。台帳が不明・不整合の場合は空きと扱わず停止する。

## 返却・失敗時の対応

新方式の貸出はPRのマージまたは未マージcloseを契機に、mainのActionsが自動返却する。QAの登録データも削除される。OPEN PRを途中で返却する場合は、そのPR・貸出の正確な削除対象とデータ喪失を示し、利用者の依頼範囲を確認して明示的な返却依頼を行う。

1. 現在のPR、貸出ID、資源ID、aliasの所属を再照合し、状態を`deleting`にする。
2. 固定URLの割当を解除し、その貸出に記録された全Vercel Deploymentを削除する。
3. テストDBのbranch・全endpointの消失を確認する。
4. 全資源の不在を直接APIで確認できた場合だけ`free`にする。

alias解除だけではDeployment固有URLのAPIを止めたことにはならない。Production、本番DB、親DB、管理専用DB、他PR、他の貸出をcleanup対象にしない。

| 状況 | 対応 |
| --- | --- |
| 枠が満杯 | draftで終了し、再依頼時に予約を再実行する |
| 作成中の通信断・Actions失敗 | 操作intentと実資源を読み直し、同じ貸出の対象を確認して再開する。二重作成しない |
| DB guard・build・画面/APIテスト失敗 | 原因を修正し、同じ貸出で再検証する。固定URLの公開やReady切替を成功扱いにしない |
| aliasの競合・所属不明 | 上書きせず停止し、記録と実際の割当先を照合する |
| PRを再open | 返却中・返却済みなら旧資源を再利用したと扱わず、状態を確認して新しい貸出を取得する |
| cleanupの失敗・timeout・API拒否 | `deleting`を保持し、同じPR・貸出を指定して返却を再実行する |
| 認証・ネットワーク不足 | 不足を報告し、必要な設定を行ってから同じ対象の手順を再開する |

明示的な返却・失敗後の再開は`npm run qa:release -- --pr <PR番号> --lease <現在の貸出ID>`からmainのActionsへ依頼する。旧貸出や別のPRに対象を広げない。これらのコマンドは対象featureブランチのcleanなworktreeから実行する。QAの定期監視は設けない。非同期資源操作を開始した実行内での有限時間の完了確認と、失敗後の明示的な再実行を使う。家計の定期支払い用Vercel Cronは別の機能であり、この方針で廃止しない。資源消失を、開始済みFunctionやDB transactionの即時停止保証として報告しない。

## Vercelのアプリ設定とProduction

VercelのProduction Branchはmain、Build Commandは`npm run build:vercel`、Node.jsは24.xとし、System Environment Variablesの自動公開を有効にする。Productionには`DATABASE_URL`、`AUTH_SECRET`、`AUTH_GOOGLE_ID`、`AUTH_GOOGLE_SECRET`、`AUTH_URL`、`AUTH_MODE=google`、`CRON_SECRET`を設定する。Google OAuthのredirect URIは本番URLの`/api/auth/callback/google`。秘密情報はVercel/Neonの設定画面へ保存し、Gitへ書かない。

Previewは`AUTH_MODE=test`とPreview用`AUTH_SECRET`を使い、Nativeが供給する`CAKE_TEST_DATABASE_URL`だけをテストDB接続先にする。Production/DevelopmentのDBで代用しない。Neon resourceのPreview対象、Native Preview Branching、Resource must be active before deployment、確認済み親branchと子DBの照合を確認する。

利用者がmainへマージするとVercelのGit連携がProductionをリモートビルドし、アプリのbuild、`db:setup`の両方が成功してから公開する。build失敗時はDB更新を行わず、DB更新失敗時は公開を止める。Productionにテストデータを登録しない。DB更新はアプリのロールバックで戻らないため、列やテーブルの削除・名前変更は追加、移行、アプリ切替、削除を段階に分ける。

Productionの手動デプロイは別途明示依頼された場合だけ行い、通常のDB更新を含むリモートbuildを使う。`--prebuilt`やPreviewの昇格でDB準備を省略しない。

読取診断には`vercel list --environment=preview`、`vercel inspect <Deployment URL>`を使える。Vercel Development設定でローカル起動する場合は`vercel dev`を使い、停止・再起動は起動端末でCtrl+Cを押す。Development設定も本番DBの流用にならないように確認する。

## Canneleへの切替

Canneleは[tyask/cannele](https://github.com/tyask/cannele)で管理する共通QA API・CLIである。Cake連携は実装準備中・未有効化。連携用の設定・入口とruntime proofの導入だけでLive API、認証、管理DBの切替、QAの実環境検証を完了したとは扱わない。

### 設定と共通クライアント

`cannele.config.json`のprotocolは`cake-cannele/v1`。初期値は`enabled: false`、`profile: null`で、現行Actions方式を維持する。`sourceRevision`にはレビュー対象のCannele CLI commitを固定し、配置設定が未完了でも実行方式は切り替えない。設定を準備しても`enabled: false`なら切り替わらない。共通入口は取得し直した`origin/main`の設定を読み、作業ブランチ側の変更を実行方式の根拠にしない。

有効化時の`sourceRevision`はレビュー済みCanneleの完全commit SHA、`profile`はAPI origin・instance・repository・provider ID・schema version・branch prefix・必要featureを固定する公開設定である。CLIはこれをAPIのcapabilitiesと照合する。管理DBの接続情報、Vercel/Neonの管理資格情報、session tokenをprofileやGitへ保存しない。

CloudとローカルPCは同じCLI・手順を使う。`CANNELE_SOURCE_DIR`には`sourceRevision`と一致するcleanなCannele checkoutを指定し、同じrevisionの[共通操作手順](https://github.com/tyask/cannele/blob/main/docs/integration-guide.md)と[Skill](https://github.com/tyask/cannele/blob/main/skills/cannele/SKILL.md)を読む。リンクは文書の所在を示すもので、実行時の正本は固定revisionのcheckoutである。CLI更新もCakeの設定変更としてレビューする。

Canneleの本人認証は`npm run cannele:auth -- login`でブラウザpairingを行う。確認と失効は`status` / `logout`。既存の`gh` tokenをCannele APIへ渡す認証方式ではない。端末鍵・短期session・再実行用のprivate stateはGit管理外に保存する。Cloudでは`CANNELE_STATE_DIR`に書込可能な専用領域を指定できる。Vercelの本人認証とDeployment Protectionは別に維持し、必要に応じて`CANNELE_VERCEL_GLOBAL_CONFIG`で専用CLI profileを選ぶ。資格情報を環境間でコピーしたり、チャット・引数・PRへ出したりしない。

### 有効化後の通常手順

1. 最新mainの専用worktreeで開発し、lint・test・buildを実施してdraft PRを作る。
2. QAデプロイ直前に`npm run deploy:preview`を実行する。共通CLIがCannele APIへ原子的な予約を依頼し、貸出・attemptのreceiptを確定してからVercel CLIのGitSource経路で作成する。予約だけの入口は`qa:reserve`、状態は`qa:status`、枠一覧は`qa:slots`。
3. 満枠なら資源を作らずdraftで作業を終了する。利用者からの再依頼時にCodexが再予約する。定期監視・待ち行列による自動再開は設けない。
4. 初回はprovisioningからNative DBを発見・登録し、確認済みhost digestでapplicationを配置する。登録・finalize・status・公開はAPIを直接呼ぶ。同PRの追加commitは同じ貸出とNative DBを使い、既存の固定URLは次の公開が確定するまで前の配置を保持する。
5. 固有URLで`qa:verify`のPC/mobile・A/Bの実ブラウザスモークと変更箇所固有の画面・APIテストを行う。`qa:publish`で確認済みDeploymentを公開し、固定URLでも同じ検証を行う。
6. 現在HEADのCIと両URLの証拠を確認し、`npm run task:pr -- --title '<タイトル>' --verification-file <検証報告>`でPR本文を更新してReadyへ進める。公開コマンドだけではReadyにしない。APIの資源照合やruntime proofはブラウザ操作・変更箇所の動作確認の代わりにはならない。
7. 利用者がマージまたはcloseすると、mainの`cannele-release.yml`がGitHub OIDCでCannele返却APIを呼ぶ。checkoutやアプリ管理資格情報を使わず、APIがalias UID・全Deployment・Native branch・全endpointの消失を確認してから枠を返す。

APIの202は未完了を示す。`nextAction: advance`に対して、依頼中のCLI/Actionsが上限付きで明示POSTを続ける。GETは処理を進めず、バックグラウンド監視もない。`blocked_unknown` / `inspect`や不明な作成・公開結果では枠を保持して停止し、再依頼時に同じ貸出・保存済みoperationを読み直す。timeoutや空の資源一覧だけで空きと扱わない。

### runtime proofとDBの安全境界

`GET /api/qa/cannele?nonce=<256bit base64url>`は`AUTH_MODE=test`かつVercel Previewだけの読取入口。実アプリと同じ`db()` clientで、QA identity markerのslot・PR・lease・branch・host・DB名と`current_database()`、行数1件を照合するSELECTを実行する。nonce、Vercel system Deployment ID・SHA、Cannele instance/attempt、貸出識別情報と接続先digestだけを`no-store`で返す。業務データの読取・更新、guard初期化、migration、seedは行わない。

`CANNELE_INSTANCE_ID` / `CANNELE_ATTEMPT_ID` / `CANNELE_PHASE`と既存`CAKE_QA_*` guardを配置時に渡す。ローカルCLI設定の`CANNELE_SOURCE_DIR` / `CANNELE_STATE_DIR` / `CANNELE_VERCEL_GLOBAL_CONFIG`を除き、Cannele metadataが一つでもあれば、共通DB選択処理が完全な識別情報とPreview/test modeを確認し、URLの接続先上書き・重複query parameterをDB client作成前に拒否する。許可するURL queryは`sslmode=require`と`channel_binding=require`のみ。接続URL・host原文・SQL・driver errorをproofへ出さない。旧QAに新しいtagがない場合は503で、旧配置のmetadataからproofを補わない。

これは許可されたrepositoryのCakeコードを信頼した実行時報告であり、任意のfeatureコードに対する暗号学的attestationではない。Canneleは報告されたID・SHA・digestをGitHub/Vercel/Neonの証拠と再照合する。Cakeのアプリ認証とVercel Deployment Protectionを弱めず、API側の保護通過資格情報は固定されたDeployment originへの読取に限る。

### 実際の切替と残作業

Cake専用Cannele APIのProduction healthと、GitHub App用Secret・暗号化キーのSensitive/Production限定設定は確認済み。旧管理DBの002互換fence導入と、schema 4への原子的なclean-start移行のcommitも確認した。公開bindingはAPI projectのProduction Configへ登録済みだが、再配置前である。本人pairing・Actions OIDC認可、稼働Deploymentへのbinding反映、runtime資格情報4件の転送完了・APIからの管理DB接続、実QAの受入検証は未完了である。共通管理DDLの正本はCanneleの`db/migrations/`、業務DDLの正本は引き続きCakeの`db/migrations/`である。

切替前の読取確認には、mainへ導入した`cannele-readiness.yml`を使う。旧`qa:inspect`のGitHub Deployments台帳は現在のSQL台帳の全枠状態を証明しない。専用のreadinessは、新しい`CANNELE_REGISTRY_ADMIN_*`・`CANNELE_TRANSITION_*`の資格情報をActions内だけで使い、現在の3枠、未完了request、履歴の解決状態、既知schema、管理者権限、全QA資源を読み取る。DBは読取専用transaction、providerはGETだけとし、DDL、資源の削除、flag・環境変数の変更、Canneleへの切替は行わない。

owner本人が、レビューした現在mainの完全SHAと新しい依頼UUIDを指定する。

```text
gh workflow run cannele-readiness.yml --repo tyask/Cake --ref main -f reviewed_revision=<現在mainの40桁SHA> -f request_id=<新しいUUID>
```

Environmentを指定しない専用jobでRepository Variablesを取得するため、Variables APIの403を停止済みと読み替えない。production比較hostはreusable workflowのsecretとして渡し、stepの環境変数表示前からmaskする。接続URL・host原文・role名・認証値・台帳snapshotはログやartifactへ出さず、固定されたID・digest・状態・件数・権限の判定だけを`result.json`へ保存する。結果は成功した初回attemptのowner/main/workflow/job・依頼ID・完全SHA・artifact digestを照合して使う。これは確認時点の読取結果であり、外部Cloud/PCの停止、資格情報の失効、接続sessionの排出や移行直前の再検査の代わりにはならない。

providerの読取失敗は、`blockers`に`READINESS_PROVIDER_<provider>_<stage>_HTTP_<statusまたはNONE>_<reason>`として残す。例えば`READINESS_PROVIDER_NEON_READ_DATABASE_HTTP_403_HTTP_ERROR`はNeonの読取権限・対象scopeを確認する手掛かりで、`AUTH_MISSING`は資格情報不足、`TRANSPORT_ERROR`は通信結果不明を表す。inventoryの不成立は`READINESS_INVENTORY_<固定stage>_<固定reason>`で区別する。stageは`VERCEL_DEPLOYMENTS`・`NEON_BRANCHES`・`NEON_ENDPOINTS`・`GITHUB_RUNS`、reasonは例えば`PAGINATION_UNKNOWN_KEY`・`PAGINATION_NEXT_MISSING`・`PAGINATION_SORT_BY_MISMATCH`・`PAGINATION_PRESENT`・`DUPLICATE_ID`で、どの読取判定が不成立かを示す。出力は固定enumとHTTP statusだけで、未知のfield名・値、URL・host・token・応答本文・例外本文を含めない。失敗を空のinventoryや資源消失と扱わず、設定を確認して新しい読取runで再検査する。

履歴にないPreview Deploymentや取得不能な資源があれば、readinessの実行成功だけで切替可能と扱わない。貸出に属する残存資源は旧方式で返却し、用途不明の公開先は対象を特定してから廃止の範囲を確認する。管理者接続はActionsに保持し、APIには別の限定LOGINだけを設定する。旧owner資格情報を失効する前に、移行と再送に使える管理者接続を確保する。GitHub Secrets書込APIが使えない場合は、利用者が新しい接続情報をActionsの設定画面へ直接登録し、Cloudやチャットへ渡さない。

2026-10-15 JSTの[読取診断 run 38738969961](https://github.com/tyask/Cake/actions/runs/38738969961)は、Cake main `8af33b34d07f44b303a1b562ac78159a649072b5`からowner本人の初回attemptで成功した。qa1〜qa3の固定aliasは不在、QA用Neonは確認済み親branch `br-lively-frog-b3y2mauu`とendpoint `ep-autumn-pine-b3nii81c`だけで、子branchは0件だった。これは旧GitHub台帳も使う診断であり、現在のSQL台帳の3枠freeや管理DB切替の証拠にはしない。他のCloud/PC作業は停止済みと利用者から確認したが、資格情報の失効は未確認である。

同日のVercel完全一覧にはProduction 27件と、旧`preview`枝のDeployment `dpl_73xdiLE19fEvEUNdW1X7hMoiB8HE`が1件残っていた。利用者がその廃止を承認したため、project・完全SHA `c974c1bb7ca12b244098f6770085de38875d77df`・alias・現在Productionとの不一致を再照合し、`cake-preview-fumin1.vercel.app`の割当とこのDeploymentだけを削除した。両対象の直接GETで404を確認し、Production `dpl_EPZaDYkkbx1s89zUsWXTthnB6Qd2`が変わっていないことを読み直した。DB操作、flags・Secrets変更は行っていない。移行直前にも全資源を再取得する。

PR #57のマージ後の[readiness run 38744829643](https://github.com/tyask/Cake/actions/runs/38744829643)は、main `0ef3daaecfa860d354bda763ac28d0de94af40a2`・owner本人・初回attempt・専用helper・全job成功を確認した。artifact `11978330490`のZIP全体のSHA-256 `ae0d93edc13e913d567d73e9074a0e0b9d43b100e51bc42ccf1f57f8b85d491f`、依頼UUID、実行元とworkflow blobを照合して読んだ。管理DBはPostgreSQL 18.6、専用identityと001 catalogが一致し、qa1/version44・qa2/version13・qa3/version13がすべてfree、履歴70件・requests・leasesは解決済み、他のDB接続0件、旧未完了workflow 0件だった。002は未適用。providerの一覧検証は`READINESS_INVENTORY_INCOMPLETE`で未確定だったため、このrunだけで全資源不在や切替可能とは扱わない。実効flagは当時POOL/REGISTRYともtrue・CANNELE未設定だった。利用者の変更後、[readiness run 38749502912](https://github.com/tyask/Cake/actions/runs/38749502912)でも同じsource・owner・初回attempt・全job成功を確認した。artifact `11979914628`のZIP SHA-256 `41369548502b324e6eca3f7ceb1d92e86c11784f5fa57bfdfecb02b9c73ace5c`と依頼・source blobを照合し、POOL=false・REGISTRY=true・CANNELE未設定、3枠free・履歴状態不変・他session 0・旧未完了run 0を確認した。provider一覧は引き続き未確定で、global停止や002適用はまだ行っていない。

その後、利用者が停止flagsを変更した。[readiness run 38761274463](https://github.com/tyask/Cake/actions/runs/38761274463)のsourceはmain `22f367310fbac20a9de48a9fb4de30f40b92561c`、確認時刻は2026-10-16 00:33:45.704 JST（`checkedAt: 2026-10-15T15:33:45.704Z`）。artifact `11985024672`のZIP全体のSHA-256 `b3057d73ea7c3b3b65223df73f00fc756a1f581dc0eb6cb374a184b34170dbf5`を照合して、次の読取結果を確認した。

- 実効flagsは`CAKE_CANNELE_ENABLED=true`・`CAKE_QA_REGISTRY_ENABLED=false`・`CAKE_QA_POOL_ENABLED=false`。旧workflowの未完了runは0件だった。
- qa1〜qa3はすべてfree、requests・leases・履歴70件は解決済み。他のDB接続は0件だった。
- provider inventoryは完全取得でき、固定alias 3件は不在。Vercel Deploymentは31件すべてProductionで、QA扱いの配置は0件。QA用Neonは確認済み親branch 1件とそのendpoint 1件だけで、子branchは0件だった。
- 履歴内のDeployment 11件・branch 5件・endpoint 5件・host 5件はすべて不在を確認した。

このrunの残るblockerは`LEGACY_FENCE_REQUIRED`のみで、002は未適用だった。外部actor・資格情報の停止判定は`unconfirmed`、Cannele APIも無効のままであり、切替完了の証拠にはしない。旧管理DB/owner資格情報の更新・失効と接続排出を利用者が確認した後に、レビュー済み手順で002を導入し、移行直前に再検査する。

利用者から管理DB passwordの更新、新ADMIN URLの保存、旧4Secretsの撤去が完了したとの回答後、[readiness run 38765120650](https://github.com/tyask/Cake/actions/runs/38765120650)で再確認した。同じmainのowner本人・初回attempt・専用workflow/helperと全job成功、依頼UUID、artifact `11988291564`のZIP全体のSHA-256 `9ac83c376db1b9f0632be640562e7efa4d39a8a4a76ae9fd95d62d1eb503505f`を照合した。確認時刻は2026-10-16 01:00:30.111 JST（`checkedAt: 2026-10-15T16:00:30.111Z`）。新ADMIN接続は成功し、専用identity・001 catalog・台帳stateは不変、停止3flags・他session 0・旧未完了run 0・全QA資源不在も確認した。旧providerキーと旧CLI認証は対象を特定できておらず、失効は未確認である。readiness成功やSecret撤去をその失効証拠に代用せず、002導入・移行はまだ実行していない。

その後、利用者はprovider tokenと既存CLI認証を現状のまま保持する方針を明示した。移行admissionではprovider資格情報の失効をfalse、保持の明示受入をtrueとして記録する。旧管理DB/owner資格情報の無効化・旧actor停止・DB接続排出と完全な資源再検査は引き続き必要で、保持方針を失効済みと読み替えない。

移行準備PRのマージ後、main `025b09976e9bee4095e6ef70f38353f94d9193af`の[readiness run 38780461871](https://github.com/tyask/Cake/actions/runs/38780461871)を再確認した。確認時刻は2026-10-16 02:50:05.897 JST（`checkedAt: 2026-10-15T17:50:05.897Z`）。artifact `11994928958`のZIP SHA-256 `17f662ffd8775ff8743867058eeb71f982f5cf07beb6a5aee3115864a5d9ec04`を照合し、PostgreSQL 18.6の専用identity・001 catalog、3枠free・履歴70件とrequests/leases解決済み、他session 0、停止3flags・旧未完了run 0を確認した。完全provider inventoryはDeployment 32件すべてProduction・QA 0件、固定alias 3件不在、Neonは親branchとそのendpointだけだった。履歴内のDeployment 11件・branch 5件・endpoint 5件・host 5件もすべて不在だった。

続く[002 installer run 38780876011](https://github.com/tyask/Cake/actions/runs/38780876011)は、owner本人・同じ現在main・初回attemptのjob `116580440297`が成功した。2026-10-16 02:52:42.8008963 JST（`2026-10-15T17:52:42.8008963Z`）にversion 2・writerEpoch 1・上記sourceの互換fence導入を確認し、既存履歴を保持した。これはlegacyモードの互換導入であり、maintenanceへの切替やCannele台帳への移行、API有効化はまだ行っていない。後続のonboarding `inspect`は[run 38781120504](https://github.com/tyask/Cake/actions/runs/38781120504)のjob `116581275195`で`ONBOARDING_DEPENDENCY_FAILED`により停止した。読取だけの再確認[run 38782009506](https://github.com/tyask/Cake/actions/runs/38782009506)のjob `116584360725`も、2026-10-16 03:01:06.847 JST（`2026-10-15T18:01:06.847Z`）に同じ失敗となった。当時は失敗stage・reasonを保存していないため原因は未確定で、未検証のまま移行を進めていない。

Neon direct接続での[onboarding inspect run 38821474058](https://github.com/tyask/Cake/actions/runs/38821474058)は、Cake main `8181111538b8f5303e216091d1423e62f1911587`・Cannele helper `623520315b7b2c982e4b98ecdb72658252709d7c`から成功した。artifact `12012892153`のZIP SHA-256 `5807a9ec10e26211a1191431cbe89e4251f08b9234295409739fb31071911836`を照合し、PostgreSQL 18・legacy/epoch 1・保存済みfence revision `025b09976e9bee4095e6ef70f38353f94d9193af`を確認した。旧state digest `23a3f9dfb15e3a93629037d9aa337e51e7dc66cbffe7bbae4e880aca5e8db4b6`とfootprint digest `1989fcafc230b1b399cf8b50e2e8061a4e66fb0afaa5ba2814a6c0b2fe11d3fa`は、レビュー済み移行入力の期待値と一致した。

続く[transition run 38822418113](https://github.com/tyask/Cake/actions/runs/38822418113)のartifact `12012802833`で、transition `86ee46a3-eb41-414e-85aa-d21e053d152d`の初回commit（`replayed: false`）を確認した。実入力のcanonical fingerprint `f61d5ab956926013633f206364382011205dc6c166bcbb0328bee3921fbfbc1c`はレビュー時の値と一致する。旧fenceを経た台帳の移行とCannele初期化は一つのtransactionで確定し、schema versionは4、checksumは`69d6b54f6ebc4e623876734bd5e0163050450d8136e29d898c2423ecf579fba8`、provider証跡digestは`74bf1a238faab178ccc887cb0882e9ef6e5803df933fd4eea52ce5b71372592f`だった。公開receiptの`providerCredentialRetentionAccepted: true`も確認した。provider資格情報は保持したままで、失効済みとして記録していない。

新しい資源の公開定義は[Cannele resource manifest](cannele/resource-manifest.json)に保存する。instanceは`34122771-e322-4478-bc7b-96ed363c6c41`、feature branch prefixは`codex/cannele-34122771-e322-4478-bc7b-96ed363c6c41/`、新PRの受付cutoffは`2026-10-15T23:12:46.565Z`。manifestのJSON Canonicalization SchemeによるSHA-256は`fb847b478ed9e0c5b0eeb972657da0ec8b6205e71c095bfc742633bc2cc5685e`で、実runtime contextのbindingDigestと一致する。digest対象はinstanceId・appId・repository・providers・slotsで、認証値、GitHub App設定、ユーザー権限、cleanup/CI workflow設定、writerEpoch、schema情報は含めない。

公開API bindingは、Vercel `fumin1/cannele-cake`の`CANNELE_BINDING_JSON`へConfig/Productionとして登録した。固定contextとownerの6 scopesをsource parserで照合した公開設定であり、DB・provider資格情報を含まない。現時点では再配置しておらず、稼働Production Deploymentへの反映やAPI接続の成功を確認したとは扱わない。

利用者が承認したAPI projectの未使用汎用DB環境変数16件は、2026-10-16 08:46:50.895 JST（`2026-10-15T23:46:50.895227Z`）に設定から削除を完了し、全16件の不在を読み直した。Cannele用のbinding・暗号化鍵・GitHub App秘密鍵/OAuth secret・API origin・2 flagsの計7件は、存在・型・Production対象のmetadataを保持した。今回の設定整理ではprovider/CLI tokenの失効、DB操作、password変更は行っていない。

runtime LOGINの作成・最小権限確認は後述のbootstrap runで完了した。runtime/provider SecretsのAPIへの登録は一部のみで、Cannele APIは無効のままである。Cakeの`cannele.config.json`は`enabled: false`・`profile: null`を維持する。以後の再配置・API接続・本人認証・OIDC返却・試験PRでの一連の受入が確認されるまで、通常開発がCanneleへ切り替わったとは扱わない。

PR #63のマージ後、現在main `d0a99d76d1fe01c784f1f0a976f55f91389aea6f`からの[bootstrap run 38834840137](https://github.com/tyask/Cake/actions/runs/38834840137)は、SQL作成前の`RUNTIME_PREFLIGHT`で`RUNTIME_HANDOFF_REQUEST_FAILED`となった。同じcontext・roleの[再確認 run 38835661141](https://github.com/tyask/Cake/actions/runs/38835661141)も同じ段階・codeで停止した。両runともruntime LOGIN作成・権限設定・4件の登録には進んでいない。既存provider tokenは保持した。現行の失敗結果はAPI種類とHTTP statusを含まないため、token名やCloud側CLIの成功だけでActionsの失敗原因を断定しない。

PR #64のマージ後、main `6100a9e1ffdf23870fb9ef9054f5ee08655b44d0`の[診断 run 38836488949](https://github.com/tyask/Cake/actions/runs/38836488949)は、`GET`・`PROJECT`・404・`HTTP`を記録した。SQL作成前の停止である。「Cake GitHub」の公開token metadataではCake project `prj_Z37vquodhpRd08ZTAtYnP0qa59jD`への限定を確認した。Cake操作用のtokenでCannele自身のproject設定も管理しようとしていたため、bootstrapの管理認証を別にする。既存Cake/Neon tokenの範囲・値・失効状態は変更しない。

PR #65のマージとCannele project限定の管理用Secret登録後、main `cf912ba7888b3502241235736d4db0159d27ce13`の[bootstrap run 38838161652](https://github.com/tyask/Cake/actions/runs/38838161652)は、2026-10-16 11:01:30 JSTまでに専用LOGINの作成、候補資格情報での実LOGIN、固定権限設定、lock解放後の別LOGINによる最小権限確認まで進んだ。続くVercel転送は`RUNTIME_HANDOFF_WRITE_UNKNOWN`・`PATCH`・`SECRET_UPDATE`・400・`HTTP`で停止した。metadataでは所有markerが一致する`CANNELE_REGISTRY_DATABASE_URL`のSensitive/Production 1件だけが存在し、4件転送の完了receiptはない。

対象Secretへ値を送らない同一metadataの更新で、同じ名前の`key`を含むPATCHはSecret名の変更制限で拒否され、`key`を省いたPATCHは成功し、前後の所有metadataが一致した。[公式CLIの修正](https://github.com/vercel/vercel/commit/4a5be0bf142afd3ec9f6ca81fc27e45f20248071)と同じく、Sensitiveの更新では名前が同じでも`key`を送らず、確認済みの環境変数IDを使う。POSTでの作成には固定の`key`を含める。既存roleや資格情報は維持し、修正がmainへ導入された後に同じ管理者Secret・context・roleで部分転送を再開する。

PostgreSQL 18ではNOT NULL制約がcatalogへ追加されるため、Canneleの移行helperは17/18それぞれの完全な固定hashで照合する。17.10と18.4の使い捨てDBで検証し、実18.6も移行前に同じhashと一致することを確認する。Neonのbranch一覧は最初の応答の`sort_order`が`asc`・`desc`・`ASC`・`DESC`なら小文字へ正規化し、次ページのGETへ引き継ぐ。2ページ目以降の順序変更や未知の値は拒否し、`sort_by=created_at`を維持する。最終branchページの`next`とsort echoは省略され得て、`next`の空文字もnullと同じ終端として扱う。短い最終ページでの省略を受け入れつつ、false・0、不明なcursor・未知field・重複ID・未完了ページは引き続き拒否する。

### Actionsからの管理操作

`cannele-onboarding.yml`は、Cloudへ管理DB資格情報を渡さず、Canneleの既存管理helperをActions内で実行する入口である。`cannele-onboarding.config.json`に固定したCanneleの完全SHAを、取得した同repositoryのmainに含まれるclean checkoutとして準備する。依存installとcontract生成には管理者・provider資格情報を渡さない。実操作はowner本人・現在Cake main・初回attempt・専用caller/helperとGit blobをAPIで照合してから行う。Environmentを指定しないjobの停止3flagsだけを狭いadapterで供給し、Variables APIの403を回避する。それ以外のGitHub・Vercel・Neon確認は実APIを使う。

| action | 実行内容 |
| --- | --- |
| `inspect` | 002導入済みの旧台帳を、legacy/controlの順のlock内で確認する。Cannele core形式のstate/footprint digest、実hostのdigest、DB名、PostgreSQL majorとfence revisionだけを返す。DDLや台帳更新は行わない。 |
| `transition` | レビューしたJSONをそのまま渡し、既存の一つのtransactionで旧fenceをmaintenanceへ進め、freshな完全provider証跡を照合してから旧6tables/functionsの削除とCannele初期化を行う。失敗時はrollbackする。 |
| `bootstrap-runtime` | 新しい専用LOGINをSQLで作成し、fresh LOGIN・固定ACL・最小権限を確認してから、固定API projectのProduction Sensitiveへruntime/providerの4資格情報をActions内で直接登録する。 |
| `provision-runtime` | 既存専用LOGINを使う場合の権限設定と確認。admin/runtimeのhost・port・DB、明示したroleを照合し、別の実ログインでcontext・最小権限を検証する。新規作成とSecret転送は行わない。 |

全actionにglobal停止gateのtrueと旧2flagsのfalseが必要である。`confirm_credential_drain=true`は旧actor停止・旧管理DB/owner資格情報撤去・DB session排出の確認を意味する。provider資格情報の方針はadmissionへ別途記録し、保持する場合に失効をtrueで補わない。002 installerにも同じ新しい管理者Secret名を使う。新しい管理者接続を確立してから旧管理DB/owner資格情報を失効させ、002を導入する。同じ管理roleのpassword更新でも、旧passwordの無効化と旧接続の終了、fresh loginを確認する。

管理者接続と既存provider資格情報は次のRepository Secretsを使う。値をCloud・チャット・JSON引数・artifactへ渡さない。`bootstrap-runtime`では新しいruntime passwordをActions内で生成し、GitHubへruntime Secretsを追加登録せず、Vercelへ直接渡す。

| Repository Secret | 用途 |
| --- | --- |
| `CANNELE_REGISTRY_ADMIN_DATABASE_URL` / `CANNELE_REGISTRY_ADMIN_DATABASE_HOST` | 切替とreceipt再確認に使う、更新済み管理者接続。APIへ登録しない。 |
| `CANNELE_TRANSITION_VERCEL_TOKEN` / `CANNELE_TRANSITION_NEON_API_KEY` | readiness・移行のCake資源確認と、APIへ登録するruntime provider値に使う既存資格情報。Vercel tokenはCake project限定のまま維持し、Cannele projectの設定管理には使わない。旧`VERCEL_TOKEN` / `NEON_API_KEY`名へ入れ直さない。 |
| `CANNELE_BOOTSTRAP_VERCEL_TOKEN` | bootstrapだけで使う、Cannele project限定の管理用token。固定API projectの読取・Production環境変数登録のBearer専用とし、転送値・runtime環境へ保存しない。 |
| `CANNELE_REGISTRY_DATABASE_URL` / `CANNELE_REGISTRY_DATABASE_HOST` | 既存LOGINの`provision-runtime`を使う場合のみ。`bootstrap-runtime`には登録不要で、この既存値も渡さない。 |

旧`CAKE_QA_REGISTRY_DATABASE_URL` / `_HOST`は新管理者接続を確保してから、002導入前に撤去する。新しい管理者接続を旧Secret名へ入れ直すと、古いworkflowが新しい資格情報を取得できるため避ける。別の管理者接続を確保しないまま旧資格情報だけを消さない。

bootstrapの管理用tokenは、[Vercel Tokens](https://vercel.com/account/tokens)で対象team `fumin1`・project `cannele-cake`（`prj_EgVvFUE4gXVZnMTuw69lQ3mIGYVN`）に限定して作り、[Cake Repository Secrets](https://github.com/tyask/Cake/settings/secrets/actions)の`CANNELE_BOOTSTRAP_VERCEL_TOKEN`へ非公開で登録する。用途名は`Cannele bootstrap`などとし、有効期限はセットアップに必要な短期間（例：1日）にする。既存のCake用tokenを広いscopeへ変えたり、この管理tokenで置き換えたりしない。新しい管理用SecretがなければSQL前で停止し、旧tokenへのfallbackは行わない。管理用tokenはbootstrap実行stepだけに渡し、inspect・transition・provision-runtime・依存installには渡さない。

今回の`bootstrap-runtime`管理workflow導入PRは、API未有効化の段階のsource管理変更としてQA配置なしでローカル検証・CI・ownerレビューを行う。実bootstrapはmain導入後の専用runで確認し、実行receiptを運用記録へ追加する。

新しいruntime LOGINの作成は、owner本人・現在main・初回attemptの`bootstrap-runtime`から行う。利用者がSQLやpasswordをチャットへ渡したり、手動SQLを実行したりする手順は不要である。公開入力は初期化receiptと一致する6項目の`runtime_context_json`と明示した`runtime_role_name`だけとし、接続先・API project/team・passwordを入力で差し替えない。

```text
gh workflow run cannele-onboarding.yml --repo tyask/Cake --ref main -f action=bootstrap-runtime -f reviewed_revision=<レビュー済み現在mainの40桁SHA> -f request_id=<新しいUUID> -f runtime_context_json='<レビュー済み公開context JSON>' -f runtime_role_name=<専用role名> -f confirm_credential_drain=false
```

Actionsは既存ADMIN接続と固定contextを照合し、管理権限やmembershipを持たない新しい専用roleを作成する。同じ管理者Secretとcontext・roleを維持して再実行すれば、同じ資格情報で継続できる。既存roleは管理markerと完全一致する場合だけ再利用し、別管理の既存roleやcontext不一致を拒否する。`ALTER ROLE`やpassword resetで既存roleを上書きしない。NeonのSQL role作成はhash済みpasswordを受け付けないため、passwordをTLS接続のbind parameterからtransaction内だけで渡す。Actionsから送るSQL本文や公開commentへ値を埋め込まず、Actionsログ・artifactにも出力しない。作成した資格情報でfresh LOGINした後に権限を設定・検証し、その後にだけVercelへ渡す。失敗・結果不明時もroleを削除せず、同じ管理者Secret・context・roleで再依頼する。

`transition_json`はCanneleの`LegacyTransitionInput`に従う公開JSONで、管理DB接続先のdigest、完全な旧state/footprint、固定scope、新instance・未使用prefix・受付開始時刻をレビューして指定する。

provider資格情報を失効した場合は`oldProviderCreationCredentialsRevoked: true`として`providerCredentialRetentionAccepted`を省略する。保持する場合は`oldProviderCreationCredentialsRevoked: false`と`providerCredentialRetentionAccepted: true`を明示する。片方だけのfalse、曖昧な値、失効trueと保持受入の併記は拒否する。他の5確認項目（Cloud/PC停止・旧管理DB/owner資格情報無効化・送信中writerなし・不明な作成intentなし）は常にtrueが必要である。保持したtokenは旧provider書込み権限を残すため、DB fenceはprovider API呼出しまで遮断しない。保持を受け入れた場合だけ、実core receiptと照合した`providerCredentialRetentionAccepted: true`を公開resultにも保存する。失効済みの既存receipt/resultはこのfieldを追加せず維持する。

`source.cakeRevision`は保存済み002 fence receiptの導入SHA、`reviewed_revision`と`admission.trustedMainRevision`は今回の現在mainを表す。両者を同じ値に書き換えない。commit結果不明時はUUIDや時刻を再生成せず、同じJSONを新しいworkflow runへ渡す。coreの同一receipt再送はprovider資格情報を要求せず、schemaや枠をresetしない。

`runtime_context_json`はinstanceId・repositoryId・bindingDigest・writerEpoch・schemaVersion・schemaChecksumの6項目で、初期化receiptと照合する。`runtime_role_name`は明示した専用roleである。結果はrequest UUID付きの単一`result.json` artifactから、実行元・owner・全job・依頼・digestを照合して取得する。

onboardingの失敗JSONは、既存の安全な`code`に加え、固定された`stage`と`reason`を返す。例えば`ADMIN_CONNECT`と`PROTOCOL`は接続時の既知protocolエラー、`INSPECT_CORE`と`UNDEFINED_COLUMN`はcore読取時の既知columnエラーを示し、SQLや例外本文を見ずに停止箇所を切り分けられる。既知のPostgreSQL SQLSTATE・Node通信/TLS codeだけを固定reasonへ変換し、未知の値やcauseは`UNKNOWN`とする。URL・host・token・SQL・応答や例外本文・stack・未知code原文は出さず、rollbackや接続解放が後から失敗しても最初の失敗を保持する。診断の追加で接続設定や移行条件は変更しない。Vercel handoffの既知の失敗には、検証済みの`handoff`を付ける。method、固定endpoint分類、HTTP statusまたはnull、固定reasonだけを含め、例えば`PUBLIC_BINDING`・`GET`・403・`HTTP`なら公開bindingの読取で拒否されたことを示す。URL・環境変数ID・key/value・応答本文・例外本文は含めない。通信不明・redirect・空応答も固定reasonで区別し、診断が未知の形なら追加情報を省略する。処理順・再試行回数・所有marker条件・SQL作成やSecret転送の条件は変えない。

`bootstrap-runtime`のhandoff先は固定のVercel `fumin1/cannele-cake`（project `prj_EgVvFUE4gXVZnMTuw69lQ3mIGYVN`、team `team_D1Mcx2TdFWPKcypfu8KzNMub`）だけである。runtime URL/HOSTとprovider 2件の計4環境変数をSensitive/Productionへ直接登録し、各4件のcommentにcontext・roleへ束縛したversion付きmarkerを付ける。5番目のConfig keyは作らず、既存値の所有marker・型・対象が不明なら上書きしない。password・URL・provider値をstep output・artifact・ログやCloudへ出さず、管理者接続もAPIへ渡さない。

作成用POSTだけに`key`を含め、更新用PATCHでは同じ名前でも`key`を省略する。PATCH先のIDは直前に取得したmetadataで名前・所有marker・Sensitive/Production対象を照合する。POST応答の有無にかかわらず、同じ値のPATCHが200で受理され、その後のmetadataも一致することを各4件で要求する。metadataの存在や202応答だけで秘密値の登録完了とは扱わない。

bootstrap完了は、role作成・fresh LOGIN/最小権限の確認と4件の登録までを示す。再配置、DB writerやAPI flagの有効化、Cake設定の有効化は行わない。bindingと権限を確認してから別工程でAPIの再配置・本人認証・運用有効化へ進む。既存のGitHub App用Secretと暗号化キーを作り直さない。

切替前に旧QA clientを止め、旧方式で全貸出を返却する。旧Actionsの待機・実行が0件で、全alias・Deployment・Native branch・endpointが不在であることを読み直してから、レビュー済みの管理DB移行を実行する。Cakeの旧台帳履歴は引き継がず、新しいinstance・generation・branch prefixとPR作成時刻cutoffで共通台帳を開始する。旧履歴の削除はこの実移行で行い、業務DBや親DBには適用しない。

`cannele.config.json`の有効化とRepository variable `CAKE_CANNELE_ENABLED=true`を、確認済みのAPI・profile・切替状態に合わせる。後者は旧QA Actionsをskipし、新しいclosed返却workflowを許可する実行gateであり、DB writer fenceを実施した証拠ではない。古いcheckoutや既に起動したrunも含め、台帳writerを移行処理で止める。flagsだけを変更して空台帳へ切り替えない。

切替後の試験PRで予約・Native作成・runtime proof・固有/固定URLの画面/API・Ready・close後の全資源消失とfreeを確認して、実測結果を記録する。それまではこの節を運用完了の記録として使わない。

## 旧方式の運用・検証記録

以下はGitHub Deployments台帳を使っていた方式の仕様・操作条件・実測記録である。新方式の運用開始後に新しい貸出へ適用する手順ではない。移行前の資源の診断・回復と、過去の検証根拠を確認するために保持する。新方式のコマンドや削除方針と混在させない。

`qa1` / `qa2` / `qa3` は同時に貸し出せる検証枠の名前であり、Gitブランチではない。開発・PR・Vercel Previewは各PRの `codex/<task>` 枝を使い、Neon Native Preview DBもそのfeature枝に対応させる。同じPRの更新では同じleaseとDBを保持し、返却後に別PRへ貸し出すときは新しいDBを確認する。固定QA枝、台帳枝、DB保持用parking deploymentは作らない。

### 現在の適用状態

対象はGitHub `tyask/Cake`、Vercel `fumin1/cake`（`prj_Z37vquodhpRd08ZTAtYnP0qa59jD`）、Preview専用Neonリソース `cake-preview`（project `misty-meadow-88903426`）。既存GitHub Environment `Preview` を使い、qa1/2/3用Environmentや管理DBを追加しない。

通常のPreview生成の標準入口は、信頼済みmainが作る小さな安全plan IDのowner承認である。ユーザーは通常運用開始を明示し、Repositoryの `CAKE_QA_POOL_ENABLED` / `CAKE_QA_GIT_GATE_CONFIRMED` / `CAKE_QA_NATIVE_CONFIRMED` をtrueに登録した。2026-10-14 JSTの[GET専用診断（run 38485838972 / job 115599157037）](https://github.com/tyask/Cake/actions/runs/38485838972/job/115599157037)では3flagの実効true、旧4承認Variableの空状態、qa1の `free` と使用中QA DB 0個を確認した。これは診断時点の証拠であり、以後の依頼でも現在の実効値・台帳・対象HEADを再読取する。flagの有効化だけで個別PRの生成や削除を許可しない。

個別の開発依頼で許可された範囲内では、Codexが既存のowner本人の `gh` 認証を使い、計画の機械照合、`qa:approve`、後続writerの確認まで代行できる。許可済みの対象について毎回のチャット再確認や本人のGitHub UI操作を必須にしない。Preview生成では現在HEADごとの計画確認・owner承認Actionsは省略せず、依頼の対象・資源数・操作範囲を広げる恒久的な権限にはしない。ユーザーは、同一repositoryのmainへマージ済みの通常QA leaseを自動返却する運用方針を承認した。QA DBと入力データも削除され、対象ごとのcleanup owner承認は要求しない。未マージclose・OPEN PRの手動返却・限定probeの削除は、全対象とデータ喪失を示して別途承認を得る。draftからの公開とmergeはユーザーが判断する。

実環境の受入結果は[PR #42](https://github.com/tyask/Cake/pull/42)と[PR #43](https://github.com/tyask/Cake/pull/43)の記録を参照する。qa1の順次貸出、同PR更新でのlease・DB・ユーザー・登録データ保持、固定aliasの最新READY一致、返却後の別PRで新DBと初期状態、既存owner認証による承認代行とcleanup・`free` を実証した。同時3枠、実ブラウザでのPC/スマートフォン全操作、外部callerとのalias競合、実行中Function/transactionの終了は未試験。子DBの初期状態が親fixtureの継承と空DB初期化のどちらで得られたかは区別できておらず、親fixture継承の実証完了とはしない。

Hobby向けのGitゲートはmainと稼働対象枝の `git.deploymentEnabled: {"**": false, "main": true}` を照合する。設定のない古い枝・直接REST/CLI・外部callerまで停止する保証はない。認証scope、個別操作承認、実証結果を混同しない。Vercel Proや新Secret・追加権限を通常運用の条件にせず、既存Neon planの無料枠や無課金も保証しない。

PGliteの実SQL検証はローカルWASMの一時メモリDBを使い、実環境の接続情報を読み込まない。Neon上のmigration・seed・Native lifecycleの実測とは区別する。再現方法と実施状況は [検証報告](qa-pool-verification.md) を参照する。

#### 導入時の履歴

owner-plan入口の導入PRではコード・ローカル検証とdraft PRまでを扱い、runtime flag変更、workflow dispatch、クラウド資源操作、mergeを行わなかった。当時のpool false/unset保持と「今回実行しない」はこの導入段階の範囲であり、その後に明示承認された受入試験と通常運用を禁止する条件ではない。

2026-10-13の08:16に、ユーザーから `CAKE_QA_DELETE_APPROVALS` Variableを削除したと報告された。従前の同日10:00の期限は延長・再利用しない。この報告だけを後続操作の許可や実効値確認にせず、その後のPR #42/#43では新しい具体的な対象と期限を持つowner cleanup planを別承認した。旧Variableの再登録を標準手順にしない。

### URLと貸出数

追加alias候補は `cake-qa1-fumin.vercel.app` / `cake-qa2-fumin.vercel.app` / `cake-qa3-fumin.vercel.app`。取得済みURLではなく、実APIによる割当許可と衝突確認が必要。team slug、project名、本番domain、Preview suffixは変更しない。自動branch URLもteam名から推定せず、実deploymentから取得する。

受入試験ではqa1のruntime接続を確認した。qa2/qa3のruntimeホストはクラウド環境の許可リスト不足でCONNECT 403となり、アプリ到達前に拒否された。利用前に `cake-qa2-fumin.vercel.app` / `cake-qa3-fumin.vercel.app` の追加許可が必要で、拒否を迂回しない。ネットワーク許可とVercel protectionの認証は別条件として確認する。

更新直前に同じleaseが `held`、PRがOPEN、現在head SHAとREADY deployment SHAが一致することを確認してaliasを付け替え、更新後にproject IDとdeployment IDを読み取る。他projectや別leaseのaliasは上書きしない。衝突・API失敗は貸出を保持して停止する。空き期間にも `.vercel.app` 名を予約保持できる公式API保証は確認できていないため、候補名の恒久確保を約束しない。3枠とも使用中なら待機し、枠未取得PRのVercel deploymentやNeon branchを生成しない。

### 生成前に止めるGitゲート

[公式Git設定](https://vercel.com/docs/project-configuration/git-configuration) の `vercel.json` / `git.deploymentEnabled` をmainと稼働対象枝へ入れる。運用する値は次のmain-only設定とし、mainのProductionを維持する。

```json
{"git": {"deploymentEnabled": {"**": false, "main": true}}}
```

minimatchの `**` はスラッシュを含む `codex/...` も対象にする。未指定枝はtrue、複数の規則に一致するとtrueが優先されるため、main以外をtrueにする規則を禁止する。今後のfeature枝はこの設定を導入した最新mainから作り、追加commitでも設定を保持する。

writerは同一repositoryのmainと対象PRの現在headを完全SHAで特定し、そのcommitの設定を読取・検証する。枝名からローカルの別commitを読んだり、設定のない対象をmainの設定だけで補ったりしない。貸出取得前と各REST POST直前に両方を再照合し、SHA変更、設定の欠落・不正、main以外のtrue、repository不一致、読取不能は生成前に停止する。通常の `task:pr` / `deploy:preview` もpush前にmainと対象HEADの完全SHAの設定を確認し、push元refspecを検証した完全SHAに固定する。非同期にHEADが移動しても未検証commitを送らない。生成flagはこの確認の代用にならない。

これは枝と承認済みwriter/CLIの運用規約であり、project全体の強制停止ではない。設定のない古い枝、設定を変更するpush、直接REST/CLI、first-party callerは迂回し得る。既存deploymentやNeon branchを削除する効果もない。全稼働枝の監査と実際のGit停止を確認するまで `CAKE_QA_GIT_GATE_CONFIRMED` をtrueにしない。REST Nativeの実証前に `CAKE_QA_NATIVE_CONFIRMED` もtrueにしない。対象と期限を承認した限定probeだけは、mainと対象PRの設定導入後に通常運用のflagをfalseまたは未設定のまま実行できる。probe成功をflag更新へ自動変換しない。

Ignored Build Stepはdeployment作成後に働き、Native integrationはアプリbuild前にDBを作るため、DB生成前ゲートの代用にしない。`gitProviderOptions.createDeployments` はGitHub Deployments記録の通知設定であり、Vercel生成停止ではない。Preview全体を停止する `previewDeploymentsDisabled`、有料Deployment Policies、未検証のAPI fieldや新しい抜道flagを代替条件として追加しない。

#### mainへの導入と公開

mainへのmergeはユーザーだけが行う。mainのProductionを維持するGit設定により、mergeは自動Production deploymentと既存の本番build、その後の `db:setup` を起動し得る。実装・ローカル検証、mainへの導入、個別の生成・alias割当、マージ済み通常QAの自動返却方針、その他のcleanupの個別承認は分ける。導入後の個別操作も、その時点の台帳と実資源を再照合する。導入時には設定監査が未完の既存PR #33を通常運用開始の許可だけで変更・反映しなかった。この履歴を現在のマージ済み通常QAの自動返却禁止にはしない。

QAの5分schedule定期監視は廃止した。マージ済み通常leaseの返却はclosedイベントの同じActionsでalias解除・全Deployment削除・DB消失確認・freeまで進める。非同期完了は10秒間隔・最大3分の待機予算で確認し、上限到達・API失敗時はrunを失敗させdeletingを保持する。回復は対象PR番号と現在leaseを指定するmainのreleaseで行う。未マージclose・OPEN手動返却・probeは有効な個別承認を再照合する。通常Preview生成もrequest-previewの同じ実行内で完了を待ち、上限時はdeploy:previewを再実行する。追加flag・資格情報・承認receiptは作らず、家計の定期支払いCronは変更しない。

### 正本と単一writer

正本はGitHub Deploymentのimmutable payload snapshot。専用 `task: cake-qa-lease`、`environment: Preview`、`payload.protocol: cake-qa/v1` の記録だけを扱い、通常のVercel記録を混ぜない。全ページを取得し、GitHub deployment ID順に各枠の `sequence` と `previousRecordId` を検証する。未知protocol、系列の分岐、重複所有、API失敗は空き扱いせず停止する。

payloadは枠、PR番号、feature枝、完全head SHA、lease UUID、`held` / `deleting` / `free`、作成・更新時刻、作成intent、全deployment ID/SHA/phase、READY deployment、Native DB identity、返却済みDB識別子を保持する。限定aliasは `aliasAssignment: {alias, deploymentId, sha, state}` の `pending` / `assigned` を記録し、`purpose: probe` を維持する。hostは内部の台帳・照合で使うが、診断・CLI・報告へ出さない。秘密情報や接続文字列は保存しない。新snapshotは直前の記録へ連結し、既知deployment、alias対象、返却済みDBの識別記録を消さない。

書込みとclaim/release/alias mutationは信頼済みmainコードを使う1つのActions writerだけが行う。`pull_request_target`、`workflow_dispatch` が同じwriterを起動する。全枠・全操作で固定concurrency group、`queue: max`、`cancel-in-progress: false` を共有する。PRコードをwrite token付きでcheckout・実行しない。開発者のローカルCLIはGitHubへ計画要求・承認のdispatchを行い、結果を読む。Vercel/Neon資源を直接予約・配置・解放しない。

限定実証の貸出はsnapshotの `purpose: probe` で通常運用と区別する。probeの継続は明示した手動入口だけから行い、PRイベントから生成を自動継続せず、候補aliasも自動更新しない。probeも同じ3枠と単一queueを使い、失敗・期限切れ・承認不足で既存leaseやDBを解放しない。

1回のservice照合は待機せず、対象限定のrunnerがclosed/release/request-release/request-previewで非同期完了だけを待つ。承認待ち・不明intent・不明alias・terminal build失敗・API失敗を盲目的にpoll/retryしない。10秒間隔・最大3分の待機予算を使い、外部API時間は別途かかるためActions jobの5分上限も維持する。待機前後の貸出台帳を比較し、世代変更で停止する。queueを保持して待つため他枠はこの実行の終了後に進む。`queue: max` は実行中1件＋最大100pending、満杯時は要求側が再実行し、cancel-in-progressは使わない。

GitHub Deployment作成は完全SHAを `ref` に指定し、`auto_merge: false`、`production_environment: false`、`transient_environment: true`。台帳の `required_contexts: []` はアプリの必須CIを代用しない。現writerはstatusを書き込まない。将来表示用statusを追加する場合も `auto_inactive: false` を明示する。statusのsuccess/inactive/failure、PR close/merge、workflow完了、時間経過だけで貸出を解放しない。マージ済み通常QAも全資源の消失確認後にだけfreeにする。status履歴は90日で削除されるため、正本をstatus履歴へ依存させない。

これはGitHub APIのCASや永続ロックではなく、単一writerとsnapshot系列を前提としたprotocol。別workflowや通常APIから専用taskへ直接書き込まない。

### 小さな計画とowner承認

貸出台帳の `cake-qa-lease` と承認台帳の `cake-qa-approval` を分ける。後者は既存Environment `Preview` と `cake-qa-approval/v1` を使い、通常配置の `preview` と、個別承認を要する返却の `cleanup` を対象にする。マージ済み通常leaseの自動返却はcleanup planのowner承認を要求せず、人間の承認receiptを作成・流用しない。公開planにはPR・feature枝・完全SHA・slot・lease・直前台帳ID・生成main SHA・確認済み親branch ID・生成run ID/attempt・期限、全deployment ID・候補alias・hostなしDB project/branch/endpoint ID、生成数上限、SHA-256 digestを載せる。DB host、接続文字列、資格情報、privateな完全manifestは公開しない。期限は既定2時間、最大24時間で、自動延長しない。plan IDは一つの対象・操作・期限を指すレビュー入口であり、通常運用でもHEADごとに小さな計画を確認する。cleanupの表示にはQA DBと入力データが失われることを明記する。

1. 信頼済みmainが現在PRの完全head、slot・lease・台帳世代、保存済み資源を読み直し、安全な対象ID・操作範囲・期限とdigestを持つplanを作る。未確認の作成intentはGETで回復してから計画へ含め、未回復なら計画を保留する。計画発行はCI成功の証明ではなく、Preview承認と生成・alias変更の前に、その完全SHAの最新pushとpull_requestのCIが両方completed/successであることをGitHub APIで照合する。返却はCI成功を条件にしない。計画生成はVercel/Neon資源を変更しないが、安全なGitHub承認台帳の書込みを伴う。既存GET専用 `preflight` / `plan-probe` / `plan-release` 自体に書込みを追加しない。
2. ownerは表示された小さな計画を確認し、`npm run qa:approve -- --plan-id <ID>` で承認する。個別依頼の許可範囲内では、Codexが既存owner本人の `gh` 認証で機械照合と実行を代行できる。現在の計画を照合することと、許可済み対象について毎回チャットで再確認することは別である。取消は同じコマンドに `--revoke` を付ける。GitHubのRun workflowでもmainの `action=approve` / `revoke` と `plan_id` 一個を指定できる。巨大なVariable JSONや新しい資格情報を要求しない。入力中のowner名・actor ID、CI結果、コメントやfork側の主張を承認証拠にしない。
3. mainはGitHubが返したrepository ownerとdispatch/runの実行者・実行元を照合し、完全manifestを内部で再構成する。承認はSHA-256 digest、承認対象のPR/CI head、slot、lease、台帳世代、期限へ束縛する。workflowを実行するmain SHAと、承認するPRのhead SHAは別々に確認する。承認run自身は資源操作をせず、GitHubのrunが `completed` / `success` になった後のwriterだけが承認を消費する。
4. 既存の単一queueが計画と承認を再読取し、変更直前ごとに現在対象・digest・期限・revoke・既存gateを確認する。新HEAD、別lease、計画が許す台帳系列・資源数からの逸脱、確認済みDBの不一致、失効、不明は承認を引き継がず停止する。最新の正当な承認receiptが未完了・失敗なら `PENDING` として止め、古い承認へfallbackしない。回復はownerによる新しいdispatchで行い、rerunで承認を作り直さない。

owner認証の根拠はauthenticated dispatchとGitHub由来のrun metadataであり、Deploymentsの `creator` 単独ではない。`GITHUB_TOKEN` はGitHub App installation tokenなので、workflowのAPI書込みはappへ帰属する。writerのcreator確認とは別に、実runのactorとtriggering_actorがともにrepository ownerの数値ID・`User` であること、main・repository・workflow pathとtrusted main SHAを確認する。承認は初回attemptだけを受け入れ、rerunを拒否する。run APIにはdispatch入力本文がないため、GitHubが返した `display_title` の `Cake QA approve <ID>` / `Cake QA revoke <ID>` とimmutable planを結び付ける。`creator` の欠落・偽装、metadataの読取拒否や不正、対象planとの結合が不明なら停止し、追加permissionや資格情報で補わない。

通常のCLI操作は `deploy:preview` → `WAIT_APPROVAL` とplan IDを確認 → owner承認runの成功確認 → 再度 `deploy:preview` の順に進める。再実行するCLIも現在HEADと同leaseの承認を読み直す。owner planは通常previewと個別承認を要するcleanupだけに使い、マージ済み通常leaseの自動返却には不要。既存の限定 `probe` / `alias-only` の個別承認を代替しない。`QA_OWNER_FLOW=true` はworkflow内部の固定envであり、追加repository Variableとして登録しない。

[GitHub Freeの公開repository](https://docs.github.com/en/get-started/learning-about-github/githubs-plans#github-free-for-personal-accounts)はこの基本Actions/API構成を利用できる。ただし手動dispatchを実行できるwrite accessはowner専用ではなく、main以外のrefも指定できるため、main固定とowner照合はCake側の条件とする。public Deploymentsは認証なしでも読めるので、安全projectionをprivate manifestの保管場所に使わない。根拠は[手動実行](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[dispatchイベント](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)、[actor/rerun contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)、[run API](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run)、[GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)、[Deployments API](https://docs.github.com/en/rest/deployments/deployments#get-a-deployment)。GitHubのenvironment reviewer機能や有料planをこの入口の条件にしない。

新規生成ではPOST前に予定lease・slot世代・確認済みNative親を再照合し、既存の同PR DBがあれば完全identityを照合する。新PRは旧PRのDBを再利用せず、同PRの追加HEADは同lease・同DB・入力データを保持する。初回にはまだない子DB identityを推測して承認へ埋めない。現在HEADの正しいlatest READYとaliasの割当先をGETで確認した後だけ固定URLを案内し、固有deploymentの識別情報と診断は別に保持する。PR本文とCLIの公開操作は既存の本人 `gh` 認証を使い、Actionsに `pull-requests: write` を増やさない。

#### 旧承認の読取互換

`CAKE_QA_APPROVED_HEADS` と `CAKE_QA_DELETE_APPROVALS` は移行中の読取互換を残す。前者はレビュー対象の完全head SHA、後者は既存のlease・全ID・alias・完全DB identity・期限が一致する場合だけ従前の照合を通す。値の自動登録・変換・延長や、owner planによる旧不一致の救済をしない。未知・不正・不一致・期限切れの扱いも既存matcherに従う。新しいPreview生成・個別承認が必要な返却ではplan IDを使う。マージ済み通常leaseの自動返却はこれと別のソース管理された方針とし、通常運用flag、Git設定の確認、pool有効化を承認台帳から自動変更しない。

旧削除承認が有効なまま残れば、closeや明示的な手動実行がcleanupを進め得る。新しい「planを先に確認する」UIだけで、旧承認による実行や待機中writerを停止したと扱わない。導入時のPR #33など設定監査が未完の旧枝への生成は通常運用開始の許可だけでは進めず、mainの設定だけで対象HEADのGit停止を補わなかった。生成のGitゲートと、マージ済み通常leaseの自動返却は区別する。

### 通常運用の設定と導入前の限定入口

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

### GET専用preflightと限定probe

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

#### 削除承認のGET診断と失敗分類

`qa-pool.yml` の `action=plan-release` / `pr_number` / `lease_id` は、同じ既存Environment `Preview` でGET専用のinspect jobを実行する。変更用writer jobは選択されず、transportもGET以外を拒否する。対象資源を照合した完全な内部 `DeletePlan` と、callerから既に渡された旧 `CAKE_QA_DELETE_APPROVALS` を比較し、追加のVariables API呼出しや状態変更を行わない。ここでの `deleteApproval` は旧入力の診断であり、新しいowner planの発行・承認結果や、マージ済み通常QAの自動返却可否を示すものではない。

`deleteApproval` は `valid`（JSON配列として解析できたか）、`matches`（期限以外の完全対象一致）、`expiry`、`decision`、固定 `reason` だけを返す。未設定・空白は現行どおり空配列として扱う。hostを含む全DB identityと全deployment ID集合は内部で比較し、承認全文・entry・host・期限の原値を表示しない。対象計画が確認できなければ一致と期限は未確認にする。

診断は同じ一度捕捉した時刻で既存matcherを呼ぶ。期限ちょうどは `EXPIRED`。複数entryのうち完全一致の有効な承認があれば `ACTIVE` / `ALLOWED`、有効な一致がなく期限不正の一致があれば `INVALID`、それ以外の期限切れ一致は `EXPIRED`。不正JSONや配列以外は `VALIDATION_ERROR` とし、通常の承認不一致 `DENIED` と区別する。既存matcherの複数entryに対する `some`、対象条件、例外、削除直前の再確認は変更しない。診断の `ALLOWED` は診断時点の照合結果で、後の削除を事前許可・予約しない。

API境界と承認解析の失敗は、固定 `stage` / `provider` / `method` / `reason` とHTTP `status`（応答未取得はnull）だけで報告する。例えば `DELETE_ALIAS` の失敗と `APPROVAL_VALIDATE` の失敗を区別できる。stageは操作境界の分類で、応答statusのないstage名だけではAPI送信・削除の実施を断定しない。未知の例外は `UNKNOWN`。URL、request/response body、例外message/stack、資格情報を表示せず、GitHub error annotationも同じ安全な分類だけを使う。分類を追加しても停止・保持・削除承認の判定は変わらない。

### 既存READY probeのalias-only

手動 `alias-only` は対象PR・slot・lease・完全head SHA・既存deployment IDを指定し、同一repositoryの現在OPEN PRと `held` / `purpose: probe` のREADY記録を照合する。`CAKE_QA_ALIAS_APPROVALS` のstrictな9項目だけの要素と、project、PR、head、slot、lease、deployment、hostを含む完全DB identity、候補alias、期限が一致する場合だけ割当へ進む。通常運用のflagや `CAKE_QA_APPROVED_HEADS` が空でも、この個別承認だけで実行できる。生成用probe承認をalias承認の代用にしない。

この入口は追加claim、全OPEN PRの列挙、他枠のglobal reconcile、新deployment・Neon DBの作成を行わない。対象PRがCLOSEDならalias割当を停止する。close入口は、そのPRの既存leaseだけを別の削除承認でcleanupする。操作対象以外のPR・枠・lease・DBは変更しない。PR #37返却後のqa1再取得禁止は当時の導入作業の範囲であり、通常運用ではfreeを確認した枠に、新PR・新lease・新DBの承認済み計画で貸し出せる。

初回は対象aliasをGETで照合し、`aliasAssignment: {alias, deploymentId, sha, state: pending}` をsnapshotへ保存して再GETする。aliasが未割当の場合だけ一度のPOSTへ進み、その後のexact GETが承認対象と一致した場合だけ `assigned` を保存する。POSTや台帳保存の応答を失っても記録を保持し、後続のexact GET一致で `assigned` へ復旧する。既存pendingからの再実行・応答喪失後の再照合でGETがnull、失敗、別対象なら、盲目的にPOSTを再試行せず停止する。限定aliasの記録対象を次headへ付け替えたり、probeを通常貸出へ変更したりしない。

同じActions writerのqueueは直列化するが、外部writerとのalias競合にprovider APIのatomic保証があるとは扱わない。PR #42/#43の通常alias割当は確認済みだが、限定probeのalias-onlyと外部callerとの衝突挙動はこの受入試験で検証していない。直前・直後GETによる照合の限界を維持する。

### claimと初回配置

1. Cake内のmain向けOPEN PR、`codex/<task>` 枝、現在の完全head SHA、必須CIの確認結果、そのheadへの明示承認、同一repositoryのmain/対象PRの完全SHAにあるmain-only Git設定を確認する。空き枠へのclaim snapshot永続化までクラウドを生成しない。満枠時は待機する。
2. 作成intentを記録後、main/対象PRの完全SHAとGit設定を再確認し、Vercel REST `POST /v13/deployments` の `gitSource` にGitHub repo ID・feature枝の `ref`・完全 `sha` を指定する。`project` はcake project ID、`target` を省略してpreviewにする。Native DBはアプリbuild前に生成される。ローカルファイルのCLI deploymentや固定QA枝へのpushで代用しない。create入力に未定義の `prId` を追加しない。
3. 初回はNative hostが未確認なので、QA guardがDBクライアント作成前に停止する。このdeploymentはNative生成を開始するもので、成功Previewや検証済みアプリとは扱わない。DB保持用parkingは配置しない。
4. Neon APIで `misty-meadow-88903426` の対応feature枝・parent・branch ID・endpoint ID・実host・作成時刻を確認する。Productionとの分離をhost比較だけで断定せず、project所属と親DBも確認する。branchが今回のlease開始以降に作られ、書込みendpointが一意で所属も一致することを確認し、前leaseのbranch ID、endpoint ID、hostの再利用を拒否する。
5. 確認済みidentityをsnapshotへ保存し、同feature枝・同leaseの次deploymentへPR/枝/lease/slot/完全SHA、専用DB host、本番DB hostの非秘密guard情報を渡す。Native供給の `CAKE_TEST_DATABASE_URL` を使い、Productionの `DATABASE_URL` へfallbackしない。
6. phaseがapplicationのdeploymentで、lease markerのないDBはDB guardにより空DBまたは承認済みQA初期fixtureとの厳密一致を確認してidentityを登録する。空DBではmigrationと固定サンプルseedを行い、fixture一致時はseed済みとして使用する。受入後はレビュー済みの未適用migrationだけを適用する。READY後にVercel GETの `withGitRepoInfo=true` で同feature枝のref/完全SHAを確認する。通常運用では同lease・current headを再読取してaliasを付ける。probeは固有URLで結果を記録し、aliasを自動更新しない。旧headの成功で現在headのaliasを更新しない。

NeonのPreview actionと `Resource must be active before deployment` が必要。接続変数はdeployment時に注入され、projectの通常env一覧だけで取得できるとは限らない。Vercel owner向けGET応答は環境変数を含み得るため、全文をログへ出さず必要な非秘密fieldだけを記録する。

### DB初期化と同PR更新

新leaseは新feature枝由来のDBを使う。新PRのNative親は承認済みQA初期fixtureを持つ設計とし、lease markerがない初回だけ実DBを厳密照合する。従来の空DBからの初期化も維持する。親の設定値やmetadata読取だけでは、Nativeがその親を選ぶことや子DBのfixture一致を証明できない。PR #42/#43では子DBの所属・親ID、新PRの別DBと初期状態を確認したが、親fixture継承と空DB初期化の経路は区別できていない。

承認済みQA初期fixtureの受入条件は次の全項目の一致とする。件数だけの照合や既知名だけのallowlistでは受け入れない。

- `schema_migrations`は001〜011の既知ファイル名11件だけを持ち、schema・表/列/制約・index・trigger・routine・型はその適用結果の既知定義に一致する。extensionは既知の`pgcrypto` 1.4を照合し、余分なschemaやobjectを許可しない。
- `app_users`は`test-user-a` / `test-a@cake.local` / `テストユーザーA`と、`test-user-b` / `test-b@cake.local` / `テストユーザーB`の二人だけ。両者の`image_url`はNULL、`is_enabled=true`で、Aだけ`is_admin=true`、Bはfalseとする。
- `workspaces`は`00000000-0000-4000-8000-000000000001` / `テスト共有家計` / `SHARED` / owner `test-user-a`の一件だけ。`workspace_members`はその家計のA OWNER・B MEMBERの二件だけで、weightは両者1とする。
- `app_user_access_guard`はsingleton一件、revision 4だけを持つ。`invitations`、`import_batches`、`transactions`、`default_rules`、`settlements`、`settlement_transactions`、`recurring_payments`の業務7表はすべて空とする。

初回照合とPR/feature枝/lease/endpoint identity登録は同じtransactionで扱う。fixture一致時だけ`cake_preview_database_identity.seeded_at`を非NULLとして登録し、fixture SQLの再実行や権限・名前・利用可否の修復は行わない。空DBではidentity登録後に未適用migrationを適用し、seed前混入検査、固定二人・共有家計の登録とseed済み記録をtransactionで行う。Previewのmigration準備では既知のProduction初期管理者INSERT全体を除き、第三ユーザーや実メールを混入させない。適用済みmigration原文とProduction処理、従来ローカルの両者非管理者fixtureは変更しない。

11migrationは承認済み初期baseの検証基準であり、後続migrationを禁止する上限ではない。初回受入後と同PR更新ではレビュー済みの未適用migrationを適用できる。marker登録済みの同PRではidentityを照合し、初期fixtureの完全一致は再検査せず、既存サンプルとQAで入力・編集したデータ・名前・権限・停止状態を保持する。SHA更新だけで返却・新leaseへ切り替えない。公開済み旧版のテストログインはAを非管理者へ戻し得るため、新コードの公開・ログイン確認前に管理者ログイン完了とは扱わない。

ビルド、runtime、`db:setup`、`db:seed:test` に同じ接続・identity確認を適用する。pooled/unpooledの同一endpointも比較し、専用接続なし、host不明、本番host一致、別PR/別lease/別endpointならDB操作前に停止する。fixtureの不一致や既知001〜011のsource/schemaと検証基準のずれはfail closedで停止する。検証定義や親の変更はレビュー・明示承認を必要とし、DBのDROP/TRUNCATE/reset、既存schema消去やfixtureの自動修復で続行しない。

### releaseと失敗回復

`held` と `deleting` はどちらも使用中。PR close/mergeは返却開始条件であり、cleanup完了前に空きを増やさない。

利用者が承認した運用方針により、通常leaseは同一repositoryのmainへPRがマージされたら自動返却する。closedイベントから信頼済みmainの単一writerを使い、対象ごとのcleanup planのowner承認は要求しない。追加flag・Repository Variable・資格情報は作らず、人間の承認receiptを生成・代用しない。QA DBと入力データも失われる。この方針がmainに導入されてから実行され、コード・文書の変更だけを実資源の削除実施やlive検証として扱わない。

未マージでcloseしたPR、OPEN PRの手動返却、限定probeは自動返却の対象外。これらの不可逆な削除は、記録済み全deployment・alias・Native child branch/endpointと、QA DB・登録データが失われることを示して別承認を得る。個別開発依頼による通常生成やowner認証の利用だけで削除許可を推定しない。probeはPRがマージされても従来の期限付き個別削除承認を維持する。

1. closeのwriterは対象leaseを `deleting` に保存し、配置とalias更新を止める。自動返却ではGitHub RESTの現在PRを読み直し、番号・head repository・base main・feature枝・closedかつmergedであることを確認する。イベント入力や台帳だけからmergedを推定しない。現在slotのdeleting lease・head SHA・全記録deployment ID・alias・完全DB identityと、内部の完全削除計画を一致させる。QAがmerged HEADより古い場合も、削除するのは当該leaseの記録済み資源だけとする。未完了create intentや曖昧なorphanを解決できなければ削除・freeへ進めない。限定aliasの `pending` がexact GETで未確認ならcleanupも停止して記録を保持する。closeはそのPRだけを扱い、他枠のclaim・全OPEN PR列挙・global reconcile・生成へ広げない。
2. 個別承認を要する返却では、GET専用 `plan-release` で現在lease・台帳・全deployment ID・alias・Native identity・intent/orphanと実効削除承認サマリーを確認できる。この入口は安全な計画と判定だけを返し、状態変更・生成・削除をしない。未マージcloseは安全なcleanup plan IDを残し、OPENの手動計画要求はmainの `action=request-release` に対象 `pr_number`・完全 `source_sha`・現在 `lease_id` を指定する。ownerは全対象・台帳世代・期限・digest・データ喪失をレビューし、許可済み範囲ではCodexが既存owner認証で `qa:approve` を代行できる。probeは既存の個別承認経路を維持する。完全DB identityはmain内部で照合し、公開計画を承認JSONへコピーさせない。消失したIDやaliasも対象集合から除かず、手動計画のhead・lease・DB・alias・ID集合・世代が変われば再計画・再承認する。
3. マージ済み通常leaseはclosedの同じrun内で削除・消失確認まで進める。個別承認の対象は承認run成功後、対象pr_number・現在lease_idのaction=releaseで同じ完了待ちを進める。OPENではrequest-releaseも使えるがclosed PRには使わない。3分の待機予算を超えた返却はdeletingを保持してrunを失敗させ、現在のPR・leaseのreleaseで再開する。定期監視・自動の全枠scanは行わず、対象限定操作をglobal refreshへ代替しない。承認run自身はDELETEを行わない。
4. 成功・失敗・初回provisioningを含む記録済み全deployment IDをまずGETし、全件のproject・preview target・PR・feature枝・記録済みSHA・phase・leaseを検証する。現在lease・完全な対象集合・PRの所属と自動返却条件または個別承認、完全DB identityまたは既知DBの消失を各mutation直前にも再照合し、一致するaliasとdeployment IDだけをDELETEする。名前の類似で未記録対象を削除せず、Production、親DB、他PRに触れない。cancel APIは現writerに未実装で、実行中buildのcancelやFunction停止をこの操作で保証しない。
5. alias消失、全記録IDの不在、関連deployment残存なしをGETで確認する。`assigned` のalias GETがnullなら既に削除された可能性があるため、alias記録と全IDを保ったまま他の消失確認を続ける。通常aliasは候補名、限定probeは未記録ならnull・記録済みなら候補名を保持する。alias変更だけで旧固有URLのアプリ/API停止とは扱わない。正常な認証・全ページ取得・対象ID照合によりNative branchと全endpointの消失も直接GETで確認し、HTTP成功、PR close/merge、403やtimeoutを消失証拠にしない。
6. 消失結果を記録し、DB identityを返却済み識別子へ追加して `free` snapshotを保存する。開始済みFunction/transactionの監視・終了確認は現writerに未実装で、資源消失と実処理停止を区別する。次leaseが古いbranch ID・endpoint ID・hostを使うことを拒否する。deploymentの復元をNeon DBの復元保証として扱わない。

delete失敗、権限不足、ネットワーク拒否、Neon読取不能、intent未解決は `deleting` のまま保持し、後続writerが現在の記録・実資源・自動返却条件または個別承認を再照合して回復する。応答喪失は再読取して確定し、盲目的に同じ生成要求を繰り返さない。retentionによる途中削除も台帳とNative identityをreconcileする。保持deploymentを残してDBを温存する返却はしない。deployment/branch/endpoint消失は資源の削除確認であり、開始済みFunction/transactionの即停止を保証するものではない。現writerは実行中処理の監視APIを照会しない。この実処理の停止挙動もlive検証で確認する。

cleanupの実証結果、API認証のscope、自動返却方針、個別削除承認は独立した情報。cleanup未実証を検証済みとして補ったり、tokenがDELETE可能という理由で自動返却条件や個別承認を省略したりしない。intentが一覧で解決できない場合やDBが生成されなかったことを証明できない場合の手動復旧入口は未実装で、貸出を保持して調査する。

削除は通常生成の有効化やNative確認flagをtrueにして許可する仕組みではない。生成停止中でも、記録と実資源の所属・完全な対象集合・必要な読取認証と、マージ済み通常QAの自動返却条件または期限付き個別削除承認が揃えば対象PRの返却を再照合する。旧private `CAKE_QA_DELETE_APPROVALS` は完全DB identityと期限まで一致する既存入力のみ読取互換とし、新標準のために再登録しない。probeのalias有無は `aliasAssignment` 記録に従い、aliasや一部IDが途中で消失しても対象集合を勝手に縮めない。

#### alias UIDを使う削除

[Get an Alias](https://vercel.com/docs/rest-api/aliases/get-an-alias) はhostnameまたはIDからaliasを取得し、`uid`・`alias`・`projectId`・`deploymentId`を返す。[Delete an Alias](https://vercel.com/docs/rest-api/aliases/delete-an-alias) はalias IDを削除対象とし、path説明ではIDまたはaliasを許容している。従って、実機のhostname指定DELETE 404を「hostnameが非対応だから」と断定しない。公式CLIの [alias rm](https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/alias/rm.ts) はlookup後の `alias.uid` を削除し、[Client](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/client.ts) が選択teamをscopeへ渡す。ただしCLIのliteral endpointは `/now/aliases/...` で、v2の根拠はREST仕様。Cakeでのproject・deployment・検証済みaccountIdの照合は追加guardである。PR #42/#43のcleanupではUID指定削除とUID・候補名の不在確認を実証したが、過去のhostname指定DELETE 404の原因を断定する証拠にはしない。

削除候補の正確な名前をGETし、取得したUID・名前・project・deploymentが現在の記録と一致することを確認する。teamはslugやalias名から推測せず、読取・照合済みprojectの `accountId` を使い、同じ `teamId` scopeでUIDを再GETする。DELETE直前にも候補名をGETしてUID・割当先・team所属を再照合し、現在lease・記録全体・自動返却条件または個別承認期限・完全DB identityの既存gateを通した対象だけを `/v2/aliases/{uid}?teamId=...` で削除する。削除専用の読取とDELETEは検証済み `teamId` だけをqueryへ渡し、通常の他Vercel操作が使う `slug` と同時送信しない。HTTP成功と応答の `status=SUCCESS` を確認しても、同じ実行内ではUID・候補名双方のGET404まで消失完了としない。privateな承認の `alias` は候補名のままとし、UIDへの置換や承認項目の追加は行わない。UIDや割当先の変更を観測した場合は新しい対象を自動追跡して削除せず停止する。GETからDELETEまでの完全な排他やCASを保証せず、Actionsの単一queueも外部callerを排他しない。直前GETの後に同じUIDが外部から再割当された競合は、DELETE後の不在確認でも完全に検出できないため、最後に観測した所属の照合を絶対的な誤削除防止保証としない。

| 観測 | 判定と次の処理 |
| --- | --- |
| 正しい認証・team scopeで対象を限定したGETが404 | その読取での不在。`assigned` の記録を保持して他の資源の消失確認を続ける。未確認の `pending` は引き続き保留し、不在だけで `free` にしない |
| UID指定DELETEが404、403、timeout、その他失敗 | 削除成功とせず固定stage/statusを報告して停止し、`deleting` と全記録IDを保持する。hostname DELETEなどへのfallbackや盲目的な再DELETEをしない |
| DELETE応答後のUIDまたは候補名GETが残存、別割当、読取不能 | 未完了・不明として停止する。後続の自動返却条件または個別承認を満たす再開でまずGETし、消失と現在の対象を確認する |
| 同じ実行のUID・候補名、全記録deployment、関連deployment、Native branch・全endpointの不在を確認 | 初めて返却済みDB identityを記録して `free` にできる。HTTP成功だけで解放しない |

現実装はalias UIDを台帳に追加保存しない。transport failureなどの不明結果から別runで再開する場合、最初の候補名GET404は「現在その名前が不在」という証拠であり、前runの旧UIDを独立して確認した証拠ではない。`assigned` の記録と全対象IDを保持したまま、既存serviceの他資源・所属・生成停止gateの確認へ進む。前runのDELETE成功や旧UIDの独立消失を後から確認済みと報告しない。

#### 導入時のcleanup再開条件と現在の適用

導入時の承認はコード修正・検証・draft PRまでであり、remote DELETE、cleanup dispatch、設定変更、main merge、新規deployment/DB生成を含まなかった。その後のPR #42/#43では対象・データ喪失を別承認してcleanupと `free` を確認した。これらは当時の実証履歴であり、現在は利用者がマージ済み通常QAの自動返却方針を承認している。未マージclose・OPEN手動返却・probeには個別承認を維持する。削除済み旧Variableの復元や従前の10:00期限の延長を標準手順にしない。

1. ユーザーがmain導入を判断する前に、自動Production build → `db:setup` の影響、マージ済み通常QAの自動返却方針、個別承認の状態、実行中・待機中writerとイベント・手動実行条件を確認する。Codexはmergeや現在資源の削除を、この実装変更の付随作業として実行しない。
2. main導入後はwriterが現在lease・全記録ID・aliasの所属・完全DB identity・intent/orphanと、RESTのmerged状態または個別承認を再照合する。GET専用 `plan-release` は同じ対象の診断に使えるが、自動返却の前に人が実行する必須手順ではない。UID照合は削除専用の内部読取で行い、GET診断から新owner承認を発行したり、旧Variableの `DENIED` を承認済みへ書き換えたりしない。
3. マージ済み通常QAは個別cleanup承認を要求せずclosed内で完了を待つ。未マージclose・OPEN手動返却は別途許可されたrequest-release（OPENのみ）またはcloseのplanをレビュー・owner承認し、対象PR番号・現在leaseのreleaseで再開する。probeは既存の個別承認を使う。通常経路は旧private JSON再登録を要求せず、旧入力を使う場合だけdeleteApproval.decision=ALLOWEDを確認する。QAの定期監視は廃止しており、上限・失敗時は現在対象の手動再実行で回復する。
4. 失敗したら固定stage/statusだけを記録し、deletingと全記録を保持する。後続writerは現在の記録・資源・自動返却条件または個別承認を再照合して回復する。個別承認は期限を延長せず、最新receiptの失敗・未完了なら新owner dispatch、対象や期限が変われば新planへの別承認を必要とする。
5. 全alias・全記録deployment・関連deployment・Native branch/全endpointの不在と台帳の `free` だけを返却完了とする。次PRの新しいDB identityと旧DB非再利用はcleanup成功だけで検証済みとしない。PR #42から#43への順次貸出で確認した範囲は両PRの実証記録に分けて残す。

### 開発者のコマンドと検証

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

### ローカルSQL検証

`scripts/verify-preview-database-safety.mjs` は任意に導入したPGlite 0.5.8で現行11migrationと初回base照合・guard/seedの実SQLを実行する補助スクリプト。`dataDir`を指定しない[一時メモリDB](https://pglite.dev/docs/filesystems)を使い、`finally`で閉じる。実環境の本番・`CAKE_TEST_DATABASE_URL`を読み込まず、setupの接続先はローカルDBへ差し替え、seedは生成したSQLを同じDBへ実行する。DELETE/DROPもこの一時DB内の検証fixtureに限る。

この成功自体は承認済みNeonテストDBでの実測ではない。PR #42/#43の実環境での初期状態、Native作成・保持・cleanupの記録とは別の証拠として扱い、親fixture継承か空DB初期化かの経路や複数接続の競合を検証済みにしない。一時ディレクトリに残るエンジン・npmキャッシュ・検証ソースは実証DBの保存データではない。再現コマンドと検証結果は [検証報告](qa-pool-verification.md) を参照する。

### 公式仕様

- [GitHub Deployments API](https://docs.github.com/en/rest/deployments/deployments) / [statusとauto_inactive](https://docs.github.com/en/rest/deployments/statuses#create-a-deployment-status) / [status履歴retention](https://docs.github.com/en/rest/deployments/statuses#data-retention)
- [Actions concurrencyとqueue](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency) / [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [Vercel Git生成停止](https://vercel.com/docs/project-configuration/git-configuration) / [GitHub通知field](https://github.com/vercel/sdk/blob/main/docs/models/updateprojectgitprovideroptions.md) / [project設定API](https://vercel.com/docs/rest-api/projects/update-an-existing-project)
- [Vercel deployment作成](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment) / [gitSource schema](https://github.com/vercel/sdk/blob/main/docs/models/gitsource2.md) / [取得](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url) / [一覧](https://vercel.com/docs/rest-api/deployments/list-deployments) / [削除](https://vercel.com/docs/rest-api/deployments/delete-a-deployment)
- [alias割当](https://vercel.com/docs/rest-api/aliases/assign-an-alias) / [alias取得](https://vercel.com/docs/rest-api/aliases/get-an-alias) / [alias削除](https://vercel.com/docs/rest-api/aliases/delete-an-alias)
- [Vercel integration actions](https://vercel.com/docs/integrations/create-integration/deployment-integration-action) / [Neon managed integration](https://neon.com/docs/guides/vercel-managed-integration) / [cleanup](https://neon.com/docs/guides/vercel-branch-cleanup)
- [Neon branches一覧](https://api-docs.neon.tech/reference/listprojectbranches) / [endpoints一覧](https://api-docs.neon.tech/reference/listprojectendpoints) / [branch削除](https://api-docs.neon.tech/reference/deleteprojectbranch) / [API key権限](https://neon.com/docs/manage/api-keys)

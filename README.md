# Cake

個人用・二人用の家計をワークスペース単位で管理する、Next.js製のレスポンシブWebアプリです。

## 主な機能

- Googleアカウントでログイン
- 管理者が登録した二人だけが利用可能（利用者と管理者権限はDBで管理）
- 個人用・共有用ワークスペースの作成、切り替え、削除
- 招待リンクによる二人目の参加
- 取引明細の追加、一覧での直接編集・自動保存、参加者ごとの負担割合の設定
- 毎月指定日の定期支払い（設定、即時変更、停止・再開）と通常明細への自動追加
- チェックした明細の一括削除と「共有費ルールの適用」（清算済みは対象外）
- PayPay CSVの支払い明細をプレビューし、費用区分・負担割合を変更して取込
- 取引先の部分一致による費用区分・負担割合のデフォルトルール（ワークスペース共有、ドラッグで優先順を変更）
- 共通支払い・共通収入と明細ごとの割合から、誰が誰へいくら支払うかを計算
- 清算完了と清算履歴

基本設計は [docs/design.html](docs/design.html) にあります。

## 定期支払い

設定画面の「ワークスペース設定」にある、デフォルトルールの上の定期支払いから登録します。毎月の日、取引先、方法、固定金額、支払者、費用区分、支払い割合、メモを設定できます。開始日・適用月・変更予約は管理せず、指定日と日本時間の当日が一致した設定を処理します。PCは取引明細と同じ横長テーブル、スマートフォンは要約行から詳細を開く一覧です。編集は保存時点で反映します。追加・編集・停止・再開・削除などの操作結果を表示する通知枠は設けず、一覧を更新します。取得・保存の失敗や競合はエラーを表示します。停止・再開も即時です。追加済み明細は設定変更・削除でも変更しません。

次回予定は設定日とサーバーの日本時間から決めます。その月の設定日の09:00より前はその月、09:00以降は翌月です。たとえば10/9に10日を指定した場合は10/10、9日を指定した場合は08:59まで10/9、09:00以降は11/9です。追加履歴は参照しません。設定日の変更によって同じ月に複数回追加されることを許容します。一覧では、停止中・要確認の次回予定を表示しません。画面を開いたままでも09:00に一覧とフォームの予定を更新します。

007〜009を現在の仕様に合わせ、新規DBの定期設定には開始日カラム `start_on` を作成しません。従来の変更予約は009で現在設定へ反映し、適用済みのPreview DBに残る開始日カラムは010で削除します。011で既存設定に処理予定日 `next_scheduled_on` を追加し、設定日と適用時刻の09:00境界から初期化します。旧成功月・適用月・変更予約の列は新しい画面・API・予定判定では使用しません。定期支払いはこのPRで初めて本番へ公開するため、公開中の本番アプリは削除する開始日カラムを参照していません。

Vercel Cronは `0 0 * * *`（UTC毎日00:00、日本時間09:00ごろ）で、当日が予定日の有効設定だけを処理します。29〜31日がない月は月末に追加します。Hobbyでは09:00〜09:59のように実行時刻に幅があります。[Vercelのスケジュール精度](https://vercel.com/docs/cron-jobs/usage-and-pricing)

生成する明細の取引日時は登録処理の実行時刻です。同じ実行で生成する明細には処理開始時の日時を使い、画面では日本時間で表示します。たとえば10月27日09:23 JSTに実行すると、保存・APIでは10月27日00:23 UTC、画面では10月27日09:23と表示されます。追加済み明細の日時は変更しません。

追加・編集・再開の保存時には、同じ09:00境界で処理予定日を決めます。明細の追加と翌月への処理予定日更新は同じトランザクションで行い、設定を変更しない通常の同時実行・再呼出しによる二重追加を防ぎます。明細を削除するだけでは処理予定日は変わりません。

失敗分・Cronが動かなかった日の分は自動補完しません。設定日の09:00以降に保存・再開すると処理予定日は翌月です。必要な未登録分は通常の明細追加で登録してください。生成済み明細には「定期」と表示し、通常の編集・清算・集計に含めます。

Productionの環境変数へ `CRON_SECRET` を設定してから、この機能を含むPRをマージしてください。16文字以上のランダムな値をVercel上で設定し、Git・PR・ログへ保存しません。未設定・Bearer不一致のCronリクエストは401で拒否します。[VercelのCron認証](https://vercel.com/docs/cron-jobs/manage-cron-jobs)

開始・登録成功・省略・失敗・終了は `recurring.*` の構造化サーバーログで確認できます。失敗時は固定のエラーコードと対象設定IDを記録し、金額・取引先・メモ・SQL本文・認証情報は記録しません。「要確認」は支払者・実行承認者・正の割合を持つ参加者の利用不可などで停止した設定です。原因を修正して再開してください。再開時の設定日と時刻から次の処理予定日を決めます。共通ログ画面は今回の機能に含めません。

Previewには定期実行を期待せず、テストログイン中の `POST /api/recurring-payments/run` に `{ "workspaceId": "対象UUID" }` を送って当日予定を検証します。本人が参加するテストworkspaceに限り、日時を指定する入力は受け付けません。Production・Google認証では404になります。設定日の09:00以降に新規保存した設定は翌月予定のため、このAPIを呼んでも当日分は追加しません。固定日時による09:00境界・月末・即時変更/再開・設定日変更後の月内複数登録・同時実行・失敗時ロールバックのDB回帰は、対象タスクの `CAKE_TEST_DATABASE_URL` を設定して `npx tsx scripts/verify-recurring-payments.ts` で実行します。スクリプトは新規の検証データだけを作成・削除し、環境ファイルや本番の `DATABASE_URL` を読み込みません。

実DB回帰の日付比較は、Neonが直接SELECTで返す`Date`とJSONB内の`YYYY-MM-DD`文字列を同じ暦日へ整形し、日時比較ではミリ秒を保持します。通常の`npm test`でもUTC・Asia/Tokyo・America/Los_Angelesでドライバーの返却型を使う回帰テストを実行します。このテストはDBへ接続せず、上記の実DB回帰とは別の検証です。

## 技術構成

- Next.js 16 / React 19 / TypeScript
- Node.js 24 / npm
- Auth.js（Google OAuth）
- Neon PostgreSQL
- Vercel

## 画面の更新とデータ取得

画面ごとに必要なデータを取得します。初回表示、ワークスペース切替、ホーム・取引明細・清算への移動では、明細と清算・履歴を含む全データを取得します。取込・設定への移動と、その画面での保存後は、ユーザー、ワークスペース一覧、招待、選択中のワークスペース・参加者・ルールだけを取得します。

取込・設定での更新では、同じワークスペースの取得済み明細・清算・履歴を保持します。新規作成・削除などで選択先が変わった場合は全データを取得し直します。明細が必要な画面へ戻ると再取得するため、共有相手の変更も反映されます。

ホーム・取引明細・清算の画面上部にある「更新」で、現在のワークスペースの全データを再取得できます。画面、絞り込み条件、スクロール位置は保持します。取引明細では未保存の入力とメモを保存してから再取得し、保存に失敗した場合は更新を中止して入力を保持します。処理中は「更新中…」と表示し、完了または失敗を画面上部のメッセージで知らせます。

画面上部に表示する共通の成功・エラーメッセージは2秒後に自動で消えます。再通知すると表示時間を数え直し、「×」で手動でも閉じられます。

画面用データは、ワークスペース一覧・選択先・参加者・ルール・招待と、必要な明細・清算履歴を1つのSQLでまとめて取得します。通常のログイン済み`GET /api/app`では、従来どおり利用者の利用可否を1つのSQLで確認した後、画面用データを1つのSQLで取得するため、`full`・`metadata`ともに2 SQL・2回のNeon往復になります。`metadata`では明細・清算履歴の取得を省きます。初めてのワークスペース作成や選択先の変更に伴う再取得では、追加の処理が発生します。

データの読込時には、ユーザーのプロフィールをDBへ書き戻しません。プロフィールの更新はログイン時や設定での変更時に行います。

## DBクエリの所要時間ログ

実行したDBクエリの所要時間を、サーバー側の構造化JSONログへ出力します。ローカルではサーバーを起動した端末、Vercelではプロジェクトの`Logs`で確認できます。

`DB_QUERY_LOG`で出力範囲を変更できます。

| 設定 | 出力するDB計測ログ |
| --- | --- |
| `all` | 成功・失敗をすべて記録 |
| `slow` | 閾値以上の成功と、時間にかかわらず失敗をすべて記録 |
| `off` | 失敗を含め、DB計測ログを出力しない |

未設定時はPreview（`VERCEL_ENV=preview`）とローカル開発（`NODE_ENV=development`）で`all`、それ以外で`slow`です。`VERCEL_ENV=production`では、`NODE_ENV`にかかわらず`slow`が既定です。本番ではログ量を抑え、全件が必要な調査時に`all`へ変更します。

遅いクエリの閾値は`DB_SLOW_QUERY_MS`で指定し、既定は500ミリ秒です。0も指定できます。例えば次の設定では、成功は1,000ミリ秒以上、失敗はすべて記録します。`.env.example`の例はコメントにしてあるため、コピーだけでは環境別の既定値を上書きしません。

```dotenv
DB_QUERY_LOG=slow
DB_SLOW_QUERY_MS=1000
```

ログには`event`（`db.query`または`db.transaction`）、`operation`、`queryId`（匿名ハッシュ）、`tables`（アプリの固定テーブル名のみ）、`durationMs`、`sqlCount`、`status`（`ok`または`error`）、`slow`を記録します。失敗時は`errorType`と、取得できた場合にSQLSTATEの`errorCode`を追加します。SQL本文、パラメーター、取得行、エラーメッセージや独自のエラー名は記録しません。

`durationMs`はNeonとの往復通信、DB処理、結果解析を含むアプリ側の経過時間です。トランザクションは一括実行の総時間を1件のログにし、`sqlCount`にSQL文数を記録します。文ごとの時間は計測しません。クエリを作成しただけで実行しなかった場合はログを出力しません。

画面用データをまとめて取得するSQLは、複数のテーブルを参照していても`db.query`・`sqlCount: 1`として記録します。利用者の確認は別の`db.query`です。API全体の時間には認証処理やJSON生成・転送も含まれるため、DBログだけで画面の待ち時間すべてを表すわけではありません。

## ローカルセットアップ

### 1. Neonを作成

1. [Neon Console](https://console.neon.tech/)で無料アカウントを作成します。
2. 新しいプロジェクトを作成します。リージョンは東京に近いものを選びます。
3. `Connect`から接続文字列をコピーします。

### 2. Google OAuthを作成

1. [Google Cloud Console](https://console.cloud.google.com/)へGoogleアカウントでログインします。
2. 新しいプロジェクトを作成します。
3. Google Auth PlatformのBranding、Audience、Data Accessを設定します。
4. Audienceは開発中なら`External`のテストモードにします。基本プロフィール・メールアドレスだけを要求する場合は、[Googleの仕様](https://support.google.com/cloud/answer/15549945?hl=ja)上、テストユーザーの一覧に載っていないアカウントも認証できます。Cakeの利用者制限は、Googleのテストユーザー設定ではなくCakeのDBで行います。
5. OAuth Clientを`Web application`として作成します。
6. ローカル用のAuthorized redirect URIへ次を追加します。

```text
http://localhost:3000/api/auth/callback/google
```

7. 発行されたClient IDとClient secretを控えます。

ログインで要求する情報は基本プロフィールとメールアドレスだけです。GmailやGoogle Driveへのアクセス権限は要求しません。

### 3. 環境変数を設定

`.env.example`を`.env.local`へコピーし、値を設定します。

```bash
cp .env.example .env.local
openssl rand -base64 32
```

生成した値を`AUTH_SECRET`へ設定します。

```dotenv
DATABASE_URL=Neonの接続文字列
AUTH_SECRET=生成したランダム値
AUTH_GOOGLE_ID=GoogleのClient ID
AUTH_GOOGLE_SECRET=GoogleのClient secret
AUTH_URL=http://localhost:3000
AUTH_MODE=google
```

### 4. DBとアプリを起動

```bash
npm install
npm run db:setup
npm run dev
```

[http://localhost:3000](http://localhost:3000)を開きます。

### 利用者を管理する

`npm run db:setup`は番号順に未適用のマイグレーションを実行し、適用履歴を`schema_migrations`へ保存します。既存DBにも更新時に実行してください。繰り返し実行しても登録済みの利用者や権限を初期状態へ戻しません。

初回の利用者管理マイグレーションで、`t.yasu417@gmail.com`を管理者として登録します。このメールアドレスでGoogleログインし、設定の「利用者管理」からもう一人のGoogleアカウントのメールアドレスを登録してください。登録した人は、自分のGoogleアカウントでログインできます。Yahooなどのメールアドレスで作成したGoogleアカウントも、そのGoogleアカウントのメールアドレスを登録すれば利用できます。

登録・利用停止を行えるのは管理者だけです。DBの`app_users.is_admin`で管理者権限、`app_users.is_enabled`で利用可否を管理し、有効な通常アカウントを二人までに制限します。メールアドレスの許可リストを環境変数へ設定する必要はありません。利用停止にしても、既存の取引やワークスペースの記録は保持します。停止後のアカウントは既存のセッションからも利用できなくなります。

既存DBへこのマイグレーションを適用すると、指定された管理者以外の既存アカウントは利用不可になります。必要なもう一人を管理者画面から登録すると、既存のアカウントIDとデータを引き継いで再び利用できます。

### テストユーザーでログインする

ローカルやVercel PreviewでGoogleアカウントを使わずに共有機能を確認する場合は、対象環境へ次を一度設定します。

```dotenv
AUTH_MODE=test
```

ログイン画面で`テストユーザーA`または`テストユーザーB`を選べます。どちらも通常のAuth.jsセッションを発行するため、通常ブラウザとシークレットウィンドウを使って、招待や共有ワークスペースを二人の別ユーザーとして確認できます。

従来のローカルテストでは初回ログイン時に固定ユーザーを登録します。QAでは初回DB guardで空DBまたは承認済みQA初期fixtureを厳密に検査して準備を完了し、ログインは既存ユーザーの照合だけを行います。空DBでは次のseedが固定A/Bと参加済みの`テスト共有家計`を登録します。承認済みfixtureを引き継いだDBではseed済みとしてidentityを登録し、fixtureの再登録や修復をしません。同じQA PRの再実行では既存のデータ・名前・利用可否・権限を保持します。

```bash
npm run db:seed:test
```

固定ユーザーはdummyの`test-a@cake.local`と`test-b@cake.local`です。新QAの初期fixtureは合計2人で、Aをアプリ全体の管理者（`is_admin=true`）と共有家計のOWNER、Bを一般ユーザーとMEMBERにします。管理者判定は有効なQA identityと現在のDB権限を照合し、Aだけ利用者一覧・登録・停止を許可します。Googleログインや実メールは使わず、既存のA/BボタンによるCredentialsログインを使います。従来のローカルfixtureは両方非管理者のままで、固定A/Bは通常アカウント二人の上限に含めません。Vercel Productionでは、誤って`AUTH_MODE=test`を設定してもテストログインは無効になります。Preview・ローカル用には、本番と別のNeonプロジェクトにあるタスク専用DBを使用してください。

公開済み旧版のテストログイン処理は、DBでAを管理者にしてもAを非管理者へ戻す場合があります。新コードの公開とログイン確認が完了するまでは、DBの初期fixture確認だけで管理者ログインを確認済みにしません。

## QA貸出枠（通常運用）

検証枠は `qa1` / `qa2` / `qa3` と候補alias `cake-qa1-fumin.vercel.app` / `cake-qa2-fumin.vercel.app` / `cake-qa3-fumin.vercel.app`。Git枝は各PRの `codex/<task>` のまま使い、固定QA枝・台帳枝・DB保持用parkingは作りません。同じPRではNative DBと検証データを保持し、別PRへの貸出では新DBが承認済みQA初期fixtureと一致することを初回guardで検査します。空DBからの初期化も引き続き使用できます。

台帳は既存GitHub Environment `Preview` の専用task `cake-qa-lease`、protocol `cake-qa/v1`。単一Actions writerのqueueが予約・配置・alias更新・マージ済み通常QAの自動返却と個別承認済みの削除を直列化します。生成用の手動 `probe` はaliasを自動更新しません。既存READY probeだけの手動 `alias-only` は9項目の個別承認を必要とし、`purpose: probe` と全deployment IDを保持し、追加claim・global reconcile・新deployment/DB作成を行いません。返却はVercel資源とNative branch/全endpointの消失確認後だけです。詳細は [QA貸出運用](docs/qa-pool.md) を参照してください。

利用者は通常運用開始を選択しました。2026年10月14日JSTの [GET専用診断](https://github.com/tyask/Cake/actions/runs/38485838972)（job `115599157037`）では `CAKE_QA_POOL_ENABLED` / `CAKE_QA_GIT_GATE_CONFIRMED` / `CAKE_QA_NATIVE_CONFIRMED` が実効true、旧4承認入力が空、qa1がfree、使用中QA DBが0でした。設定と貸出台帳は実行時に再確認し、この時点の結果を永久に仮定しません。3 flagsだけでは生成承認にならず、現在HEADの計画・最新push/PR CI・owner承認・既存ゲートが必要です。Hobbyではmainと稼働対象枝の `vercel.json` に `git.deploymentEnabled: {"**": false, "main": true}` を入れ、今後の枝は更新済みmainから作ります。main以外をtrueにする規則は禁止です。古い枝・設定変更・直接REST/CLI・外部callerまで停止する保証はなく、Ignored Build StepもDB生成前ゲートにしません。Vercel Proや新しい権限・Secretをこの変更の条件にせず、Neonの既存plan・無料枠や無課金は別条件として扱います。

`preflight` はGET以外を拒否するtransportで台帳、project/link、mainの完全SHAにあるGit設定、repository Variables名、Neon metadata件数の読取・照合結果と不足を報告します。対象PR/current headと指定枠はGET専用の `plan-probe` で追加照合できます。貸出取得前とREST POST直前には同一repositoryのmainと対象PRの完全SHAにあるmain-only設定を確認します。flagをtrueにせず、生成・台帳変更・削除・環境変数更新・DB操作を行いません。Native動作が未実証の導入段階で行う限定実証は `CAKE_QA_PROBE_APPROVALS` のJSON配列の `projectId` / `pr` / `sha` / `slot` / `expiresAt` の5項目だけに完全一致する、期限内の手動probeに限定します。同じmainの単一queueを使い、pool/Gitゲート確認/Native確認flagはfalseまたは未設定のまま実証できます。確認flagは実際のGit停止と全稼働枝の監査、Nativeの実証後だけtrueにし、probeのために先に変更しません。認証scopeは生成・削除の承認とは分けます。

[PR #42](https://github.com/tyask/Cake/pull/42) / [PR #43](https://github.com/tyask/Cake/pull/43) でqa1の順次運用、同PR更新時の入力データ保持、別PRの別DBと初期状態、既存owner認証による承認代行、固定aliasの最新READYへの更新、新計画によるcleanupとfreeを実証しました。両PRは未マージでclose済みです。同時3枠、実ブラウザのPC/mobile全操作、外部alias競合、実行中Function/transactionの終了、scheduleだけでの収束は未試験です。未試験事項は各依頼の検証結果に区別して報告し、通常の1件開発を一律禁止する条件にしません。qa1のホスト許可は設定済みです。qa2/qa3のruntimeには `cake-qa2-fumin.vercel.app` / `cake-qa3-fumin.vercel.app` の追加ホスト許可が必要で、許可拒否を迂回しません。PR #37保持と当時の操作禁止は導入時の履歴です。詳しい実測と履歴は [QA貸出運用](docs/qa-pool.md) を参照してください。

PGliteの実SQL検証はローカルWASMの一時メモリDBで行います。承認済みNeon DBを使用せず、実環境の接続情報も読み込みません。検証データは永続化せず、Neonのmigration・seed実測とは区別します。[再現用スクリプト](scripts/verify-preview-database-safety.mjs)と [検証報告](docs/qa-pool-verification.md) を参照してください。

## Codexとの開発フロー

個別の開発依頼と合意した範囲に基づき、Codexがブランチ作成・実装・検証・draft PR・QA計画照合・既存owner認証による承認代行・QA反映・最新の固定URL提示まで進めます。現在HEADごとの計画、CI、lease、台帳世代、資源、生成上限、期限、digest、owner認証を機械照合することと、利用者への毎回の手動再確認は別です。許可済みの同じ対象へ追加のチャット確認やGitHub UI操作を要求しません。依頼範囲を超える対象・生成数・影響は具体的な計画を示して確認し、恒久的な無制限の操作許可は設けません。利用者が承認した運用方針により、同一repositoryのmainへマージ済みの通常QA leaseは自動返却し、対象ごとのcleanup owner承認は要求しません。QA DBと入力データも失われます。未マージclose・OPEN PRの手動返却・限定probeの削除は正確な全対象とデータ喪失を示して別承認を得ます。mergeは利用者、Productionの手動操作は別依頼です。

設計を合意してから、タスクごとのブランチ・worktree・テストDBで開発します。元の作業フォルダにある未コミット変更はそのまま保持します。

依頼例:「設定済みCake Cloudで、取引一覧に取引先名の検索を追加してください。既存手順で実装・検証・draft PR・QA反映まで進め、PRと最新の固定QA URLを提示してください。削除とmergeは行わないでください。」

この依頼例ではCodexによる今回の削除・mergeを行いません。その後に利用者が通常QAのPRをmainへマージすると、既存writerが当該leaseのQA DBと入力データを含めて自動返却します。マージ後も保持したい場合は、マージ前に運用方針の変更を別途決めてください。

### 1. タスクを開始する

Node.js 24、Git、GitHub CLIを利用できる環境で、既存認証を先に確認し、元のリポジトリから次を実行します。設定済みCake Cloudでは既存owner認証とActions内の既存Vercel/Neon認証を使います。初回接続が未設定なら不足を報告し、資格情報・権限の追加を依頼の付随作業として無断で行いません。

```bash
npm run task:start -- feature-name
cd ../Cake-worktrees/feature-name
```

`origin`を取得し、main-only Git設定を導入した最新の`origin/main`から`codex/feature-name`と専用worktreeを作成して`npm ci`を実行します。タスク名は60文字以内の英小文字・数字・ハイフンで指定します。既存のブランチやフォルダは上書きしません。依存関係のインストールに失敗した場合は、作成済みworktreeで`npm ci`を再実行します。

作成先は元のリポジトリの兄弟フォルダ`Cake-worktrees/<タスク名>`です。別の場所に作る場合は、実行時の`CAKE_WORKTREE_ROOT`で指定します。相対パスは元のリポジトリから解決します。

```bash
CAKE_WORKTREE_ROOT=/tmp/cake-worktrees npm run task:start -- feature-name
```

`.env.local`、`.vercel`、`node_modules`はコピーしません。新しいworktreeには上のローカルセットアップを参考に`.env.local`を作り、`DATABASE_URL`へ対象タスクのテストDBを設定します。本番用の環境ファイルを流用しないでください。Git連携のPreview DBはデプロイ時に作られるため、通常の環境変数取得だけではそのDB接続情報を得られない場合があります。ローカルでも実DBを使う場合はNeon Consoleで該当するテスト用ブランチを選び、接続情報を設定します。実DBの主要な検証はPreview上で行えます。

### Codex Cloudで作業する場合

新しいCodexタスクでも選択済みCake Cloud、`tyask/Cake`、既存owner認証とAGENTS.md・このREADME・関連運用手順を確認します。別セッションの認証・許可・設定が自動共有されると仮定しません。依頼範囲と現在の実効flags・台帳をGETで照合します。Variables管理APIの403は報告し、既存GET専用診断の実効値確認と区別します。選択したクラウド環境内でNode.js 24、Git、`gh`を確認し、`git fetch origin main`で接続を確認します。Gitの取得とGitHub APIの認証は別に確認してください。`gh auth status`と`gh api repos/tyask/Cake --jq .full_name`が失敗する場合、取得できてもPR作成ができるとは限りません。認証情報の値はログやPRへ出力しません。

npmの既定キャッシュへ書き込めない環境では、書込み可能な一時ディレクトリを指定します。次の例は、クラウドの`/workspace/Cake`から開始する場合です。`task:start`内の`npm ci`にも同じキャッシュ設定を引き継ぎます。

```bash
cd /workspace/Cake
export npm_config_cache=/tmp/cake-npm-cache
npm ci
npm run task:start -- cloud-check
cd /workspace/Cake-worktrees/cloud-check
npm run lint
npm test
npm run build
npx --no-install tsc --noEmit
```

文書のみのテスト用PRはPreviewが不要です。検証結果を`/tmp/cake-verification.md`へ記録し、変更をコミットしてから次を実行します。アプリのソースコードを変更した場合は、通常のPreview検証手順に従ってください。

```bash
npm run task:pr -- --draft --title 'test: Codex Cloudの開発手順を検証' --verification-file /tmp/cake-verification.md
gh pr view --repo tyask/Cake --json url,isDraft,headRefOid
```

`task:pr --draft` はPreview未検証を明示して作成・更新する通常入口です。mainの完全SHAにある `vercel.json` と対象HEADのローカルcommit・blobのmain-only停止設定を確認し、originとHEADが一致しない場合だけpushしてdraftを作ります。Repository Variablesの管理権限は要求しません。ゲートを確認できない場合はpushを停止し、ローカル差分と未実行理由を報告します。実QA生成の確認flagsは別条件として維持します。

pushやPR作成が失敗した場合は成功として記録せず、確認済みの操作と必要な設定を分けて報告します。

### 2. 開発し、コミットする

コード変更後は次を実行します。業務ロジック・認可を変更した場合は回帰テストを追加・更新し、UI変更はPCとスマートフォンで表示・操作を確認します。

```bash
npm run lint
npm test
npm run build
```

関連する設計書・READMEも更新して、変更したファイルをコミットします。接続文字列や認証情報はGitや検証報告へ保存しません。

### 3. 先にdraft PRを作成する

lint・test・buildとDB分離の確認状況をMarkdownファイルへ記載し、変更をcommitした専用worktreeで実行します。初回はOPEN PRがQA貸出の前提になるため、Previewを待つ前にdraftを作ります。

```bash
npm run task:pr -- --draft --title '変更内容を表すタイトル' --verification-file /tmp/cake-verification.md
```

Preview未実施の理由とブランチ・完全SHAを含むmain向けdraft PRを作成・更新します。push前にmainの完全SHAの設定と対象ローカルcommitのblobを読み、`vercel.json` の `**: false` / `main: true`（main以外のtrueなし）を共通checkerで照合します。originとHEADが一致しない場合だけpushします。設定を確認できない場合はpushを止めます。文書のみの変更はPreview不要と記録できます。クラウド検証や有効化条件が不足する設定PRはdraftのままレビューします。

### 4. 貸出済みPreviewで画面・APIを検証する

下の「Previewへデプロイ」の設定と生成前ゲートを確認し、QA poolが明示承認で有効化された後に実行します。

```bash
npm run deploy:preview
```

コマンドはdraft入口と共通のGitゲート、同feature枝の先行PRと完全HEADを確認してpushし、mainの `request-preview` へ小さな計画を要求します。`WAIT_APPROVAL` では計画を照合し、依頼済み範囲内でCodexが既存owner認証の `qa:approve` を代行できます。承認Actionsの成功確認後、同HEADで `deploy:preview` を再実行して台帳の同PR・同lease・現在HEADのREADY記録を待ちます。CLIはVercel/Neonを直接生成しません。満枠・有効化待ち・失敗・timeoutは未検証として報告します。

コミット、PR、lease、台帳記録、Deployment固有URL、Neon identityを `.cake/preview.json` に記録します。このフォルダはGitへ登録しません。最新HEAD・lease・DB・READY deploymentとalias割当先の実GET一致を確認した固定QA URLで画面とAPI、PC・スマートフォンの表示・操作を検証し、対象PRのテストDBであることを確認します。Deployment固有URLは診断用に併記し、固定aliasの名前だけでコミットを判定しません。同じPRの追加commitは新headのレビュー・承認後に同lease・同DBを使い、入力・編集済みのQAデータを保持します。

### 5. 検証済みPR本文へ更新する

変更内容、完全SHA、lease、Deployment ID/固有URL、Neon project/branch/endpointと隔離確認、migration・seed、lint・test・build、画面・APIの検証結果をMarkdownファイルへ記載します。DB変更は公開中の旧版との互換性も記録し、未実行項目には理由を添えます。接続文字列と資格情報は書きません。

```bash
npm run task:pr -- --title '変更内容を表すタイトル' --verification-file /tmp/cake-verification.md
```

最新HEAD・Preview記録・現在の台帳が一致することを確認し、同じPRの本文を更新します。検証後の変更は再commit・再deployment・再検証が必要です。draftからの公開とmergeはユーザーが判断します。

### 6. レビューして手動マージする

GitHub Actionsの`ci`は、`main`向けPRと`main`・`codex/**`へのpushで`npm ci`、lint、test、buildを実行します。Node.js 24を使い、DBやVercelのSecretsは必要ありません。

`main`のRulesetはPR経由と必須チェック`ci`の成功を要求し、マージ前に最新の`main`へ追従する設定にします。削除とforce pushを禁止します。Codexが本人のアカウントでPRを作る運用では、自分のPRをApproveできないため必須承認人数は0人です。ユーザーが差分とPreviewを確認して手動マージし、Codexはマージ・自動マージ設定を行いません。

マージ後はVercelがProductionをビルドし、本番DBの更新が成功してから公開します。詳細は下の「Productionへデプロイ」を参照してください。

## Vercelへ配置

### 初回設定

1. GitHubリポジトリをVercelの`fumin1`チームの`cake`プロジェクトへ接続し、Production Branchを`main`にします。専用worktreeのCLI接続は次のコマンドで行います。

```bash
npx vercel link --scope fumin1 --project cake
```

2. Build Commandに`npm run build:vercel`、Node.jsに24.xを設定し、`Automatically expose System Environment Variables`を有効にします。`VERCEL_ENV`でPreviewとProductionのDB準備を切り替えます。
3. Environment Variablesへ、`Production`を対象に次を登録します。Preview用の設定は下の「Previewへデプロイ」を参照してください。
   - `DATABASE_URL`
   - `AUTH_SECRET`
   - `AUTH_GOOGLE_ID`
   - `AUTH_GOOGLE_SECRET`
   - `AUTH_URL`（例: `https://cake.example.com`）
   - `AUTH_MODE=google`
   - `CRON_SECRET`（定期支払いのCron認証用。16文字以上のランダムな値）
4. Google Cloud ConsoleのAuthorized redirect URIへ本番URLを追加します。

```text
https://あなたのドメイン/api/auth/callback/google
```

Vercel上の通常のビルドでDBを準備します。環境変数の秘密情報はVercelまたはNeon Consoleで設定し、リポジトリやPRへ書き込みません。

### Previewへデプロイ

PreviewはVercel Marketplaceの既存Neonリソース `cake-preview`、project `misty-meadow-88903426` を使います。本番projectを使わず、新PRのNative branchは承認済みQA初期fixtureを持つ親から作る設計です。初回DB guardは現行001〜011のmigration台帳・schemaと、Aが管理者、Bが一般ユーザーの固定二人・共有家計だけを厳密照合します。業務7表は空で、未知のschema・object・ユーザー・データを許可しません。空DBの初期化も維持します。qa1のA/B試験で子branchの親所属と初回guard成功を確認しましたが、親fixture継承と空DB初期化のどちらの経路だったかは一般ログだけでは区別できず、親fixture継承の実証とは扱いません。fixtureのずれや既知001〜011のsource/schemaと検証基準のずれはfail closedで停止し、検証定義や親の変更にはレビューと明示承認が必要です。自動消去・自動修復はしません。受入後はレビュー済みの後続migrationも適用できます。詳細な照合条件は [QA貸出運用](docs/qa-pool.md#db初期化と同pr更新) を参照してください。

有効化前にGET専用preflightで既存の認証・接続設定と確認不足を読み取り確認します。GET成功や認証scopeだけでNativeを確認済みにしたり、生成・削除を許可したりしません。新Secret・資格情報・権限を依頼の付随作業として無断で登録しません。

標準のPreview生成承認は、信頼済みmainが作る小さな計画とplan IDを使います。`deploy:preview` が `WAIT_APPROVAL` を返したら、計画と期限を照合し、許可済み範囲内ではCodexが既存owner認証で `npm run qa:approve -- --plan-id <ID>` またはmainの承認workflow dispatchを代行し、承認Actionsの成功後に再度 `deploy:preview` を実行します。取消は承認コマンドに `--revoke` を追加します。Run workflowでもmainの `action=approve` / `revoke` と `plan_id` 一個を指定できます。承認run自身は資源を変更しません。承認台帳 `cake-qa-approval` はhostなし対象ID・親branch ID・生成上限・期限とdigestだけを保存し、完全manifestはmain内部で再構成します。期限は既定2時間・最大24時間で、HEAD・必須CI・slot・lease・台帳世代・期限を変更直前ごとに再照合します。最新receiptの失敗・未完了では停止し、古い承認へ戻りません。巨大なVariable JSONや新資格情報は不要で、runtime flagや通常poolの有効化は別承認です。旧 `CAKE_QA_APPROVED_HEADS` / `CAKE_QA_DELETE_APPROVALS` は完全一致する既存承認の読取互換を残します。限定probe / alias-onlyの個別承認は代替しません。詳細は [小さな計画とowner承認](docs/qa-pool.md#小さな計画とowner承認) を参照してください。

- 接続先はPreviewだけとし、Production・Developmentへ接続しない。
- Native供給の接続変数は `CAKE_TEST_DATABASE_URL` を使う。
- Preview action、Native Preview Branching、`Resource must be active before deployment` を確認する。
- 生成前にmainと対象PRの完全SHAにある `vercel.json` の `git.deploymentEnabled: {"**": false, "main": true}` を確認し、貸出取得前とREST POST直前にも再照合する。main以外のtrueは許可しない。全稼働枝を監査し、設定がない古い枝まで止まると推定しない。Ignored Build StepはNative DB生成前ゲートにしない。
- 読取確認した承認済みQA初期fixtureのNative親branch IDを `CAKE_QA_PARENT_BRANCH_ID` として確認し、子DBのfixtureを実DBguardで照合する。通常生成はGit設定、pool/Gitゲート確認/Native確認flagに加え、現在headへのowner plan承認または完全一致する旧 `CAKE_QA_APPROVED_HEADS` を必要とする。同PRの新headも小さな計画を再レビューする。旧入力のunset・空文字・空白だけは `{}`（承認なし）、不正な非空JSON・PR key・非完全SHAは既存matcherに従って拒否する。
- 限定probeのrepository variable `CAKE_QA_PROBE_APPROVALS` はJSON配列とし、 `projectId` / `pr` / `sha` / `slot` / `expiresAt` の5項目だけに一致する現在headを明示承認する。probeは手動入口限定で、追加pushも新SHAへの期限付き承認を必要とする。
- 既存READY probeの `alias-only` は `CAKE_QA_ALIAS_APPROVALS` の `projectId` / `pr` / `headSha` / `slot` / `leaseId` / `deploymentId` / `database` / `alias` / `expiresAt` の9項目だけの承認を使う。完全DB identityはhostを含めてprivateに照合する。pool/確認flagや通常head承認をこのために有効化しない。
- マージ済み通常QAの返却は、RESTで確認したmerged状態と現在のdeleting lease・全記録ID・alias記録・完全DB identityの一致により自動で進める。未マージclose・OPEN手動返却では世代・期限に束縛したowner cleanup plan、probeでは既存の期限付き個別削除承認を使う。完全manifestは内部で再構成し、巨大なprivate JSONの手入力は不要。旧 `CAKE_QA_DELETE_APPROVALS` は完全一致する既存入力だけを読取互換として残す。IDだけの表示計画はコピーできる承認JSONではない。一括boolean、認証scope、Native/cleanup確認flagで自動返却条件や個別承認を代用しない。
- 既存Previewの `AUTH_SECRET` と `AUTH_MODE=test`、既存repository Variableにある読取確認済みの非秘密本番endpoint host `CAKE_QA_PRODUCTION_DATABASE_HOST` を確認する。`AUTH_URL` はDeployment URLを自動検出する。

writerはclaimとintentを先に保存し、REST `gitSource` でNative DBをアプリbuild前に生成します。初回Native hostが未確認のprovisioning deploymentはDBクライアント作成前のguardで停止します。Neon APIでproject・feature枝・parent・作成時刻・branch/endpoint IDと完全identityを照合した後、同feature枝・同leaseのapplication deploymentでDB受入れ・migration/seedを確認します。qa1のA/B試験で、この配置と `env` / `build.env` によるbuild/runtimeのguard情報注入を実測しました。通常運用では現在HEADのowner plan承認とCIを再確認し、最新READYとalias実読取一致後に固定URLを案内します。同PR更新は同lease・同DBを維持し、新HEADへの計画承認を照合します。新PRは新しいGit refとDBを使います。Native未実証の導入段階で使った手動probeは別の限定入口で、通常運用へ自動切替しません。接続情報はNative注入を使い、本番の `DATABASE_URL` へ切り替えません。公式clientと公開REST schemaの記載範囲は [QA貸出運用](docs/qa-pool.md) に従い、qa1以外の未試験条件へ実測結果を広げません。

新PRはlease markerがない初回に、migration前の実DBが空または承認済みQA初期fixtureと厳密一致することを検査してidentityを登録します。空DBでは未適用migrationと固定サンプルを登録し、fixture一致時は`seeded_at`を記録して既存fixtureを使用します。混入・別lease・前貸出endpointは削除して続行せず停止します。同PR更新は同DB identityを照合し、レビュー済みの未適用migrationだけを適用します。初期fixtureの再検査・再登録・権限修復をせず入力・編集済みデータを保持します。build・runtime・直接DBコマンドも同じguardを通します。DB準備やbuildの失敗時はaliasを更新しません。

QA診断・JSON/CLI・console・報告はDB host、deployment URL、接続文字列、資格情報を省略し、安全なIDと判定を示します。hostを含む完全DB identityは承認・内部照合でだけ使い、表示計画をそのまま承認JSONへコピーしません。Actions callerは既存repository Variableの本番host・削除承認JSON・alias承認JSONを `jobs.secrets` から一時的な `workflow_call` secretsへ渡します。remote Secretの登録・移動や値・権限の変更は行いません。Preview Environmentの同名Variable overrideを引き継いだと推定せず、過去ログの消去や実Actionsのmask検証も完了扱いにしません。詳細は [QA貸出運用](docs/qa-pool.md) を参照してください。

最初に `task:pr --draft` でPRを作り、`deploy:preview` で現在HEADの計画を要求・照合します。通常有効化とowner承認Actionsの成功確認後に同HEADで再実行し、最新READY・DB・lease・aliasの実GET一致を待ちます。詳細と未検証事項は [QA貸出運用](docs/qa-pool.md) を参照してください。公式仕様は [Vercel Git生成停止](https://vercel.com/docs/project-configuration/git-configuration)、[deployment作成](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)、[Neon managed連携](https://neon.com/docs/guides/vercel-managed-integration) を参照してください。

### Productionへデプロイ

ユーザーがPRを`main`へマージすると、Git連携により通常のVercelリモートビルドを開始します。必須環境変数を確認し、アプリのビルド、`npm run db:setup`の順に実行して、両方が成功してから新しい版を公開します。ビルド失敗時はDBを更新せず、DB更新失敗時は公開を止めます。Productionではテストデータを登録しません。

DBの更新は自動で巻き戻りません。更新時には公開中の旧版が同じDBを使うため、マイグレーションは旧版との互換性を保つ必要があります。列やテーブルの削除・名前変更は、追加・データ移行・アプリ切替・削除を別の段階で行います。アプリをロールバックしてもDBは戻りません。

Productionへの手動デプロイは、ユーザーから明示的に依頼された場合だけ行います。その場合もDB更新を含む通常のリモートビルドを使います。`--prebuilt`やPreviewの昇格でこの手順を省略しません。

```bash
npx vercel --prod
```

### Deploymentの確認

Preview Deploymentの一覧を表示します。

```bash
npx vercel list --environment=preview
```

特定のDeploymentの状態や設定を確認します。

```bash
npx vercel inspect https://対象のpreview-url.vercel.app
```

Productionだけを一覧表示する場合は次を実行します。

```bash
npx vercel list --prod
```

### Previewの更新と返却

コード変更後は検証・commitして `deploy:preview` を実行します。同PR・同leaseの現在headをwriterが配置し、READYとDB identityを照合してaliasを更新します。直接 `vercel redeploy` で台帳外のdeploymentを追加しません。

利用者が承認した運用方針として、通常QA leaseはPRが同一repositoryのmainへマージされたら自動返却します。既存のclosedイベントからmainの単一writerが `deleting` に進め、GitHub RESTで現在のmerged状態・repository・base・feature枝と、現在leaseの全deployment・alias・完全DB identityを再照合します。対象ごとのcleanup owner承認、追加のRepository Variable・flag・資格情報は不要です。この方針がmainへ導入された後のwriterに適用され、文書やコードの変更だけで現在の資源を削除したとは扱いません。返却ではQA DBと登録データも失われます。限定probe、未マージのclose、OPEN PRの手動返却は自動返却の対象にせず、従来どおり全対象とデータ喪失への別承認を必要とします。

GET専用の `plan-release` は状態変更・生成・削除を行わず、project/PR/slot/lease/head SHA、全記録deployment ID、alias、hostを除いたDB識別情報を表示します。手動返却で使う `deleteApproval` の `valid` / `matches` / `expiry` / `decision` / 固定 `reason` は旧private入力と完全計画の一致診断であり、マージ済み通常leaseの自動返却可否や新owner承認の代用ではありません。承認全文・entry・host・期限原値は表示せず、追加のVariables API呼出しも行いません。失敗は固定 `stage` / `provider` / `method` / `reason` とHTTP `status`だけで分類し、未知の例外は `UNKNOWN`。詳細は [削除承認のGET診断](docs/qa-pool.md#削除承認のget診断と失敗分類) を参照してください。

未マージclose・OPEN PRの手動返却では、正確な全対象とデータ喪失について利用者の別承認を得てcleanup plan IDを承認します。OPEN PRの計画要求はmainの `request-release` にPR・完全source SHA・現在leaseを指定し、close済みPRはcloseで発行した計画を使います。承認run成功後、対象PR・現在leaseを指定した `release` または既存5分scheduleで継続し、OPENでは同対象の `request-release` も使えます。閉じたPRに `request-release` は使いません。限定probeはマージ後も既存の期限付き個別削除承認を必要とします。owner計画承認の代行は利用者が許可した範囲だけとし、承認run自身はDELETEを行いません。

自動・個別承認のどちらも、現在の `deleting` leaseと完全な対象集合を各mutation直前に照合し、全記録deploymentのproject・preview target・PR・feature枝・記録済みSHA・phase・lease、aliasの所属、完全DB identityを検証します。未完了intent/orphanや未確認の `pending` aliasは保持し、消失したIDやaliasを対象集合から除きません。`assigned` のalias GETがnullなら他の消失確認を続けます。alias・全deployment・Native branchと全endpointの直接GETによる不在確認後だけ、返却済みDB identityを追記して `free` にします。scheduleはpool flagがfalseでも同じwriterを起動し、自動返却条件または有効な個別削除承認があれば再照合して継続します。HTTP成功やmergeだけで空き扱いにしません。cancel APIと実行中Function/transactionの監視は現writerに未実装で、cancelや即停止を保証しません。alias除去だけではDeployment固有URLのAPIを止めたことになりません。

alias削除は、候補名のGETからUIDを解決し、正確な名前・project・deploymentと検証済みprojectの `accountId` によるteam所属を照合して、UIDと `teamId` を指定します。削除専用APIには `slug` を同時送信せず、UIDの再GETと削除直前の名前・lease・自動返却条件または個別承認期限・完全DB identityの照合を保ちます。GETの404は正しいscopeでの不在確認に限って扱い、DELETEの404や成功後GETの残存は削除完了とせず `deleting` を保持します。成功後は同じ実行内でUIDと名前の双方を再GETします。UIDは台帳に保存しないため、不明結果から別runで名前の不在を確認しても旧UIDの独立消失確認とは扱いません。外部callerとの完全排他も保証しません。導入時のhostname指定DELETEの404原因は未特定のまま履歴として残します。UID方式のqa1削除はA/B試験で実測しましたが、外部alias競合の安全性を実証したとは扱いません。[UID削除と再開条件](docs/qa-pool.md#alias-uidを使う削除)を参照してください。

最後の関連Vercel deployment削除でNative cleanupが発火します。Neon APIでbranchと全endpointの消失を確認した後だけ `free` にします。403、timeout、delete失敗や曖昧な残存は `deleting` のまま保持し、次leaseによる旧DBの再利用を拒否します。DB保持用parkingは残しません。[Neon cleanup公式仕様](https://neon.com/docs/guides/vercel-branch-cleanup)

mainへのmergeは自動Production buildと既存の `db:setup` を起動し得ます。通常QA leaseの自動返却も、既存closedイベントと5分scheduleのmain writerが進めます。削除のためにowner承認receiptを作成したり、新flagや資格情報を登録したりしません。未マージclose・OPENの手動返却・probeでは、具体的な対象とデータ喪失への別承認と既存の個別削除承認を維持します。旧完全一致の削除承認は読取互換として残り、plan表示だけでscheduleや実行中writerを止めたとは扱いません。失敗時は固定stage/statusを記録して `deleting` を保持し、後続writerが現在の記録・資源・自動返却条件または個別承認を再照合して回復します。導入時の「今回merge・設定変更・cleanup再実行・生成を行わない」とPR #42/#43の個別承認による実証は履歴であり、現在のマージ済み通常QAの自動返却方針とは区別します。[導入と再開の条件](docs/qa-pool.md#導入時のcleanup再開条件と現在の適用)を参照してください。

台帳外の手動削除、Productionや他PRの削除、直接Neon branch削除は行いません。認証scope、Native/cleanupの実証結果、自動返却条件または個別削除承認は別々に確認し、不足する場合は返却未完として報告します。資源消失は開始済みFunction/transactionの即停止保証ではなく、その実挙動はlive検証未実施です。

### ローカルのVercel開発サーバー

VercelのDevelopment環境変数を使ってローカル起動する場合は次を実行します。

```bash
npx vercel dev
```

停止するときは、起動したターミナルで`Ctrl+C`を押します。設定変更後に再起動する場合も、一度`Ctrl+C`で停止してから再度`npx vercel dev`を実行します。

## PayPay CSV

初期版では`取引内容`が`支払い`と完全一致する行だけを取り込みます。口座送金、投資、ポイント獲得、受け取った金額は対象外です。

取込画面の支払者の初期値はログインしている本人（登録者）です。一致する有効なデフォルトルールがない行は共有費とし、ワークスペースのデフォルト割合を使います。一致ルールの費用区分・割合を優先し、登録前に支払者・費用区分・割合を変更できます。

CSVファイル自体はDBへ保存しません。取込後の明細と取込履歴だけを保存します。

PayPay明細の`external_id`は`PayPay_{取引日}_{取引番号}`です。取引日は日本時間で秒まで含む`YYYYMMDDHHMMSS`に正規化します。例えば`2026/10/10 14:30:00`、取引番号`123456789`なら`PayPay_20261010143000_123456789`です。DBの主キー`id`はUUIDのままです。

CSV選択時の重複確認では、この外部IDだけを`/api/import/duplicates`へ送信し、選択中のワークスペースの登録済み外部IDと照合します。IDは重複をまとめ、最大2,000件ずつ問い合わせます。ログインとワークスペースへの参加を確認し、CSV全文や既存明細の全件取得は不要です。同じ取引日・取引番号の明細は重複とし、取引番号が同じでも取引日が異なれば別明細として扱います。取込後に明細の日時や担当者を編集しても外部IDは変更しません。

照合に失敗した場合は未確認のプレビューを表示しません。登録時にもDBの一意制約で重複を防ぐため、照合後に共有相手が同じ明細を取り込んだ場合も二重登録されません。同じ外部IDでも金額または取引先が異なる場合は衝突を知らせ、取込全体を中止します。重複として省略した行は取込件数に含めず、実際に追加できた件数を記録します。

既存DBの更新時は`npm run db:setup`で`006_paypay_external_ids.sql`を適用してください。既存のPayPay明細は、保存済みの`occurred_at`を日本時間へ変換して外部IDを移行します。すでに新形式の明細と手動明細は変更しません。キーが衝突した場合は移行全体が失敗し、明細を削除・統合しません。移行前に取引日時を編集していた明細は元のCSV日時を復元できないため、再取込時に重複として判定できない場合があります。

更新の切替中に旧サーバーから取引番号だけを受け取っても、DBの登録時トリガーで新形式へ変換します。このトリガーは新規登録時だけ動作し、日時編集時には外部IDを変更しません。移行中は取引への書込みをロックし、既存データの変換とトリガー作成の間に旧形式の明細が追加されることを防ぎます。

## コマンド

```bash
npm run dev       # 開発サーバー
npm run build     # production build
npm run lint      # ESLint
npm test          # 清算・CSV解析テスト
npm run db:setup  # 未適用のDBマイグレーションを適用
npm run db:seed:test # テストユーザーA・Bと共有ワークスペースを登録
npm run task:start -- feature-name # 最新mainから専用ブランチとworktreeを作成
npm run task:pr -- --draft --title 'タイトル' --verification-file /tmp/cake-verification.md # 先に未Previewのdraft PRを作成
npm run deploy:preview # 有効化・ゲート・先行PR確認後にpushし、同HEADの台帳を読む
npm run task:pr -- --title 'タイトル' --verification-file /tmp/cake-verification.md # 検証済みの同PR本文を更新
```

## 清算ルール

設定の「共有費のデフォルト割合」は、新しい共有費の初期値です。明細ごとに割合を変更できます。個人費は支払者・受取者が1、相手が0になります。

明細追加・一覧編集・CSV取込の支払い割合（%）と負担金額（円）は、値を削除して空欄のまま入力・保存できます。空欄は0として扱い、相手の分を自動計算します。ワークスペースのデフォルト割合も空欄を0として扱いますが、全員0の設定は保存できません。入力・表示の詳細は[基本設計](docs/design.html#screens)を参照してください。

取引明細とCSV取込は、PC・スマートフォンとも表の先頭のチェックで対象行を全選択・全解除できます。スマートフォンは「全選択／全解除」のラベル付きで、列見出しを横にスクロールしても操作欄を左端に残します。部分選択時はチェックに横線を表示し、対象がなければ無効になります。取引明細の対象は表示中の未清算明細、取込の対象はエラー・登録済みを除く行です。取引明細では上部の「選択解除」ボタンを設けず、全選択チェックを外すと絞り込みで非表示になった選択も解除します。表示対象がなくても非表示の選択が残っていれば、チェックを「全解除」として操作できます。

取引明細は一覧の項目を直接編集できます。文字・金額・日時・割合は欄を離れるかEnterで保存し、種別・担当者・費用区分は変更するとすぐ保存します。清算済みの明細は編集・削除できません。

明細追加と一覧の編集では、支払い割合の「%／円」の選択欄で「1:1」を選ぶと二人の負担を折半にできます。表示は「%」の50%ずつへ戻り、その後も調整できます。一覧では選択時にすぐ保存します。二人参加中の未清算共通費で利用できます。

取引明細のフィルタ設定は、利用者・ワークスペースごとにブラウザの`localStorage`へ保存します。同じ端末・ブラウザでは、画面の切替や再読み込み後も設定を復元します。「絞り込みをすべて解除」で保存済み設定も解除できます。別の端末やブラウザには同期されず、ブラウザのサイトデータを削除すると設定も消えます。

デフォルトルールはワークスペースの参加者全員で共有し、取引先が一致した上のルールから適用します。共有費のルールには独自の割合を設定するか、ワークスペースのデフォルト割合を使うかを選べます。割合は明細の保存時に記録されるため、後からデフォルト割合やルールを変更しても保存済みの明細は変わりません。

ルールは一覧の項目を直接編集でき、入力を確定すると自動保存します。右端のハンドルで並べ替え、左端のチェックボックスで選択したルールをまとめて削除できます。

既存の明細には、マイグレーション時のデフォルト割合を保存します。清算済みの明細では、その清算に保存された割合を使います。

```text
正味共通費 = 共通支払い − 共通収入
明細の負担 = 明細の金額 × 本人の割合 ÷ 明細の割合合計（収入はマイナス）
目標負担   = 共通明細の負担の合計
実質負担   = 本人の支払い − 本人の受け取り
差額       = 実質負担 − 目標負担
```

一円未満の端数は合計してから丸め、二人の目標負担の合計が正味共通費と一致するようにします。

差額が負の人から正の人へ、その絶対額を支払うよう表示します。清算完了はアプリ内のフラグ更新であり、実際の送金は行いません。

## QA導入前の読取診断

GET専用の手動診断は、同一repositoryのmain/対象PRの完全SHAにあるmain-only Git設定とblobを確認します。Git設定の証拠は枝内の自動生成設定に限り、`backendForcedDeploymentPreventionProven: false`を維持します。[QA診断手順](docs/qa-diagnostics.md)を参照してください。Neonのbranch/parent/default/endpoint IDを既存GETから秘密なしで要約し、親候補の観測された子を確認できます。供給された本番hostとQA endpointsの比較は、host値を出さず`match`・`no-match`・`unknown`で報告します。比較結果は本番project全体の分離、空DB、Native生成設定の証明ではありません。診断単体はpool有効化や作成・返却、build/DB/seed/Previewコマンドを実行しません。mainへの導入後に実行できますが、mergeは既存のProduction buildを起動し得ます。

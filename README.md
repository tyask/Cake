# Cake

個人用・二人用の家計をワークスペース単位で管理する、Next.js製のレスポンシブWebアプリです。

## 主な機能

- Googleアカウントでログイン
- 管理者が登録した二人だけが利用可能（利用者と管理者権限はDBで管理）
- 個人用・共有用ワークスペースの作成、切り替え、削除
- 招待リンクによる二人目の参加
- 取引明細の追加、一覧での直接編集・自動保存、参加者ごとの負担割合の設定
- チェックした明細の一括削除と「共有費ルールの適用」（清算済みは対象外）
- PayPay CSVの支払い明細をプレビューし、費用区分・負担割合を変更して取込
- 取引先の部分一致による費用区分・負担割合のデフォルトルール（ワークスペース共有、ドラッグで優先順を変更）
- 共通支払い・共通収入と明細ごとの割合から、誰が誰へいくら支払うかを計算
- 清算完了と清算履歴

基本設計は [docs/design.html](docs/design.html) にあります。

## 技術構成

- Next.js 16 / React 19 / TypeScript
- Auth.js（Google OAuth）
- Neon PostgreSQL
- Vercel

## 画面切替時のデータ取得

画面ごとに必要なデータを取得します。初回表示、ワークスペース切替、ホーム・取引明細・清算への移動では、明細と清算・履歴を含む全データを取得します。取込・設定への移動と、その画面での保存後は、ユーザー、ワークスペース一覧、招待、選択中のワークスペース・参加者・ルールだけを取得します。

取込・設定での更新では、同じワークスペースの取得済み明細・清算・履歴を保持します。新規作成・削除などで選択先が変わった場合は全データを取得し直します。明細が必要な画面へ戻ると再取得するため、共有相手の変更も反映されます。

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

テストユーザーは初回ログイン時に自動登録されます。次を実行すると、テストユーザーA・Bに加えて、両方が参加済みの`テスト共有家計`ワークスペースも登録されます。繰り返し実行しても重複しません。

```bash
npm run db:seed:test
```

固定ユーザーは`test-a@cake.local`と`test-b@cake.local`です。テストユーザーに管理者権限はなく、通常アカウント二人の上限にも含めません。Vercel Productionでは、誤って`AUTH_MODE=test`を設定してもテストログインは無効になります。Preview・ローカル用には本番と別のDB（Neonの別ブランチなど）を使用してください。

## Vercelへ配置

### 初回設定

1. このリポジトリをGitHubへpushしてVercelへImportするか、プロジェクトのルートで次を実行して既存のVercelプロジェクトと接続します。

```bash
npx vercel link
```

2. VercelのEnvironment Variablesへ、本番用の設定として`Production`を対象に次を登録します。Preview用の設定は下の「Previewへデプロイ」を参照してください。
   - `DATABASE_URL`
   - `AUTH_SECRET`
   - `AUTH_GOOGLE_ID`
   - `AUTH_GOOGLE_SECRET`
   - `AUTH_URL`（例: `https://cake.example.com`）
   - `AUTH_MODE=google`
3. Google Cloud ConsoleのAuthorized redirect URIへ本番URLを追加します。

```text
https://あなたのドメイン/api/auth/callback/google
```

4. `npm run db:setup`を本番のNeon接続情報が設定された環境で実行します。初回だけでなく、マイグレーションの追加された更新時にも実行してください。
5. Vercelへデプロイします。

### Previewへデプロイ

Vercelのプロジェクト設定のEnvironment Variablesで、`Preview`を対象に次を登録します。

- `DATABASE_URL`：Preview専用のNeon DBまたはブランチの接続文字列。本番用のDBとは分けてください。
- `AUTH_SECRET`：`openssl rand -base64 32`で生成した値。
- `AUTH_MODE=test`：テストユーザーA・Bのログインを有効にします。

`AUTH_URL=http://localhost:3000`はローカル専用です。Previewには設定せず、VercelのURL自動検出を使用してください。固定URLを指定する場合は、そのPreviewの公開URLを設定します。

VercelでSecretとして設定された環境変数の値は、CLIからローカルへ取得できない場合があります。`npx vercel env run`でDBの準備を行う必要はありません。SecretはVercel上のビルドで利用できるため、Previewのデプロイのために`.env.local`へ接続情報や認証キーをコピーする必要もありません。

まだCLIにログインしていない場合は `npx vercel login` を実行します。ローカルに接続情報がない場合、`npm run deploy:preview` がVercelの接続手順を起動するので、利用するチームと既存の `cake` プロジェクトを選択してください。このプロジェクトではチームは `fumin1` です。接続情報は `.vercel/project.json` または `.vercel/repo.json` に保存され、次回から再利用します。Git連携済みの候補（`linked by git`）を選んだ場合の `.vercel/repo.json` にも対応しています。

接続先を明示して先に設定する場合は、次を実行できます。[Vercelのプロジェクト接続](https://vercel.com/docs/cli/link)も参照してください。

```bash
npx vercel link --scope fumin1 --project cake
```

現在のローカルファイルを送信してPreviewへデプロイします。Gitへのpushは不要です。

```bash
npm run deploy:preview
```

デプロイとビルドが成功すると、固定URL `https://cake-preview-fumin1.vercel.app` を新しいPreviewへ割り当てます。以後はこのURLをブックマークし、同じURLで最新版を開けます。ログ末尾の `Cake: 固定Preview URL:` でアクセス先を確認できます。デプロイやビルドに失敗した場合、固定URLは更新しません。

固定URLの名前を変更する場合は、ローカルの `.env.local` にホスト名のみを設定します。未使用の名前、または自分が管理するドメインを使用してください。`CAKE_PREVIEW_ALIAS` はデプロイする端末用の設定なので、Vercelの環境変数への登録は不要です。

```dotenv
CAKE_PREVIEW_ALIAS=cake-preview-fumin1.vercel.app
```

固定URLの割り当てに失敗した場合は、コマンドに表示される `npx vercel alias set ...` を再実行できます。[Vercel公式のalias手順](https://vercel.com/kb/guide/how-to-alias-a-preview-deployment-using-the-cli)も参照してください。

ビルドログを表示する場合は `npm run deploy:preview -- --logs`、新しくビルドし直す場合は `npm run deploy:preview -- --force` を使用できます。追加引数は `--logs`・`--force`・`--with-cache` に対応しています。

Vercel上のビルドでPreview用DBへ未適用のマイグレーションを適用し、`AUTH_MODE=test`の場合はテストユーザーと共有ワークスペースを登録してから、アプリをビルドします。DB準備に失敗した場合はビルドを停止します。

作成されたDeployment固有のPreview URLもログに表示されます。`AUTH_MODE=test`なら、テストユーザーA・Bは`テスト共有家計`へ参加済みです。この二人に管理者権限はありません。

GoogleログインでPreviewを確認する場合は、Previewの`AUTH_MODE=google`と`AUTH_GOOGLE_ID`・`AUTH_GOOGLE_SECRET`を設定し、Google Cloud側に固定URLのコールバックURL（初期値は `https://cake-preview-fumin1.vercel.app/api/auth/callback/google`）を登録してください。`AUTH_URL` を指定する場合も固定URLを設定します。この場合もマイグレーションは適用されますが、テストユーザーの登録は行いません。管理者による利用者登録はGoogleログインで確認できます。

### Productionへデプロイ

Production環境へ公開するときだけ`--prod`を付けます。本番用の環境変数とDBが正しいことを確認してから実行してください。ProductionのビルドはDBの更新やテストデータの登録を行わないため、必要なマイグレーションは公開前に`npm run db:setup`で適用します。

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

### Preview Deploymentの再デプロイ

同じDeploymentを再ビルドする場合は、対象URLを指定します。環境変数を変更した場合も再デプロイが必要です。

```bash
npx vercel redeploy https://対象のpreview-url.vercel.app
```

ローカルの最新ファイルを改めて配置し、固定URLも更新する場合は次を実行します。

```bash
npm run deploy:preview
```

### Preview Deploymentの削除

最初に一覧から削除対象のURLを確認します。

```bash
npx vercel list --environment=preview
```

プロジェクト名ではなく、削除したいDeploymentの完全なURLを指定します。

```bash
npx vercel remove https://対象のpreview-url.vercel.app
```

この操作で削除されるのは指定したVercel Deploymentだけです。Vercelの環境変数、Gitブランチ、手動作成したNeonの`preview`ブランチとそのデータは削除されません。

### ローカルのVercel開発サーバー

VercelのDevelopment環境変数を使ってローカル起動する場合は次を実行します。

```bash
npx vercel dev
```

停止するときは、起動したターミナルで`Ctrl+C`を押します。設定変更後に再起動する場合も、一度`Ctrl+C`で停止してから再度`npx vercel dev`を実行します。

## PayPay CSV

初期版では`取引内容`が`支払い`と完全一致する行だけを取り込みます。口座送金、投資、ポイント獲得、受け取った金額は対象外です。

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
npm run deploy:preview # Vercel上でPreview用DBを準備してデプロイ
```

## 清算ルール

設定の「共有費のデフォルト割合」は、新しい共有費の初期値です。明細ごとに割合を変更できます。個人費は支払者・受取者が1、相手が0になります。

取引明細は一覧の項目を直接編集できます。文字・金額・日時・割合は欄を離れるかEnterで保存し、種別・担当者・費用区分は変更するとすぐ保存します。清算済みの明細は編集・削除できません。

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

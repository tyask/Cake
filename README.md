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

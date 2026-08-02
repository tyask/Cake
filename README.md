# Cake

個人用・二人用の家計をワークスペース単位で管理する、Next.js製のレスポンシブWebアプリです。

## 主な機能

- Googleアカウントでログイン
- 個人用・共有用ワークスペースの作成、切り替え、削除
- 招待リンクによる二人目の参加
- 取引明細の追加、編集、削除
- PayPay CSVの支払い明細をプレビューし、複数行の費用区分を一括変更して取込
- 取引先の部分一致による費用区分のデフォルトルール
- 共通支払い・共通収入と重みから、誰が誰へいくら支払うかを計算
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
4. Audienceは開発中なら`External`のテストモードにし、利用する二人のGoogleアカウントをテストユーザーへ追加します。
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
```

### 4. DBとアプリを起動

```bash
npm install
npm run db:setup
npm run dev
```

[http://localhost:3000](http://localhost:3000)を開きます。

### テストユーザーでログインする

ローカルやVercel PreviewでGoogleアカウントを使わずに共有機能を確認する場合は、対象環境へ次を一度設定します。

```dotenv
AUTH_MODE=test
```

ログイン画面で`テストユーザーA`または`テストユーザーB`を選べます。どちらも通常のAuth.jsセッションを発行するため、通常ブラウザとシークレットウィンドウを使って、招待や共有ワークスペースを二人の別ユーザーとして確認できます。

テストユーザーは初回ログイン時に自動登録されます。ログイン前に登録しておく場合は、テスト用DBを接続した状態で次を実行します。

```bash
npm run db:seed:test
```

固定ユーザーは`test-a@cake.local`と`test-b@cake.local`です。Vercel Productionでは、誤って`AUTH_MODE=test`を設定してもテストログインは無効になります。

## Vercelへ配置

1. このリポジトリをGitHubへpushし、VercelへImportします。
2. VercelのEnvironment Variablesへ次を登録します。
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

4. `npm run db:setup`は初回に一度だけ、Neonの接続情報を設定した環境で実行します。
5. VercelをDeployします。

## PayPay CSV

初期版では`取引内容`が`支払い`と完全一致する行だけを取り込みます。口座送金、投資、ポイント獲得、受け取った金額は対象外です。

CSVファイル自体はDBへ保存しません。取込後の明細と取込履歴だけを保存します。

## コマンド

```bash
npm run dev       # 開発サーバー
npm run build     # production build
npm run lint      # ESLint
npm test          # 清算・CSV解析テスト
npm run db:setup  # DBスキーマ作成
npm run db:seed:test # テストユーザーA・Bをテスト用DBへ登録
```

## 清算ルール

```text
正味共通費 = 共通支払い − 共通収入
目標負担   = 正味共通費 × 本人の重み ÷ 重み合計
実質負担   = 本人の支払い − 本人の受け取り
差額       = 実質負担 − 目標負担
```

差額が負の人から正の人へ、その絶対額を支払うよう表示します。清算完了はアプリ内のフラグ更新であり、実際の送金は行いません。

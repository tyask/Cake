# Cake

個人用・二人用の家計をワークスペース単位で管理する、Next.js製のレスポンシブWebアプリです。

## 主な機能

- [Googleログインと管理者による利用者管理（通常利用者は二人まで）](docs/detail-design.html#auth)
- [個人用・共有用ワークスペースの管理と招待リンクによる参加](docs/detail-design.html#api)
- [取引明細の追加・直接編集・自動保存](docs/detail-design.html#client)
- [明細の絞り込みと画面の手動更新](docs/detail-design.html#client)
- [明細の一括削除・共有費ルールの適用](docs/detail-design.html#client)
- [毎月指定日の定期支払い](docs/detail-design.html#recurring-payments)
- [PayPay CSVのプレビュー・カテゴリ設定と履歴からの補完・取込・重複確認](docs/detail-design.html#domain)
- [取引先ごとの費用区分・負担割合のデフォルトルール](docs/detail-design.html#client)
- [明細ごとの負担割合に基づく清算額の計算](docs/detail-design.html#domain)
- [清算完了と清算履歴](docs/detail-design.html#domain)
- [対象者・費用区分を選べる負担額のカテゴリ構成比・月別推移・前期間比較](docs/detail-design.html#analytics)

操作・計算ルールやAPI・DBの仕様は[詳細設計書](docs/detail-design.html)、全体構成や画面概要は[基本設計書](docs/design.html)を参照してください。

iPhoneでのPayPay共有ショートカットとCSV貼り付けの確認方法は、[iPhoneからのPayPay CSV取込・実機検証手順](docs/iphone-paypay-import.md)を参照してください。

## 技術構成

- Next.js 16 / React 19 / TypeScript
- Node.js 24 / npm（ローカル・Actionsの検証版は [.node-version](.node-version)）
- Auth.js（Google OAuth）
- Neon PostgreSQL 18以上（UTF8）
- Vercel

データ取得・DBクエリログの仕様は[詳細設計書のRepository・データ取得設計](docs/detail-design.html#repository)を参照してください。

明細の取引先は表示用の値を保持し、NFKC・小文字化・空白整理による照合用の値をDBの生成列へ保存します。手入力・CSV・定期支払いなどの保存経路で同じSQL関数を使い、既存明細もmigrationで補完します。照合規則と互換性は[取引先の照合用正規化](docs/detail-design.html#merchant-normalization)を参照してください。

CSVの「カテゴリ自動補完」は、チェック状態に関係なく登録可能な未分類行へ候補を設定します。同じワークスペース・正規化後の取引先に一致する確認済み支払い履歴の最新30件から最多カテゴリを選び、同率なら最新の履歴を優先します。設定済みカテゴリは保持し、結果は登録前に変更できます。「確認して登録」で最終値を保存し、カテゴリ付き明細を次回の補完に利用します。集計画面では清算済みを含む支払いの負担額を確認できます。対象者・共有費／個人費・カテゴリ階層は取得済みの集計結果から切り替えます。

ソースは実行場所と用途で分けています。依存方向と各境界の責務は[詳細設計書の実装構成](docs/detail-design.html#architecture)を参照してください。

| 配置 | 用途 |
| --- | --- |
| `app/`・`components/` | 画面、Route Handler、UIと画面状態 |
| `lib/client/` | 取得・保存制御、応答反映、ブラウザ保存 |
| `lib/server/` | 認証、HTTP境界、用途別サービス、DB store・接続 |
| `lib/shared/` | 型、定数、`schemas/`、CSV変換・割合・清算などの共通計算 |
| `scripts/` | `task/`・`preview/`・`build/`・`db/`・`cloud/`・`tooling/`・`qa/db/`・`qa/windows/` の運用処理 |
| `tests/` | `shared/`・`client/`・`server/`・`tooling/` の回帰と `architecture/` の依存境界検査 |

## ローカルセットアップ

### DB接続なしの開発・テスト

WSL2/Linux、Codex CloudまたはWindowsネイティブで、[.node-version](.node-version) に記載したNode.js・npm・Git・GitHubの認証・公式Playwright Chromiumを使います。環境ごとに独立したclone/worktreeを用意し、依存・build成果物・環境ファイル・資格情報を混ぜません。GitHubは既存本人認証済みgh、Cloudでは連携された権限を使います。

- WSLは[WSL開発・ブラウザ検証](docs/wsl-development.md)でLinux版ツール・認証・実行方法を確認してください。
- Codex Cloudは[Cloud開発・ブラウザ検証](docs/cloud-development.md)で外部DBなしのCake起動、ブラウザQA、既存Actionsへの引継ぎを確認してください。
- WindowsのPowerShellは `npm.cmd` / `npx.cmd` を使います。QAの認証は[Windows QA手順](docs/windows-qa-credentials.md)を参照してください。

```bash
npm run check:node
npm ci
npx --no-install playwright install chromium
npm run check:fast
npm test
npm run build
```

`npm test` は `tests/` 配下のテストと依存境界検査を再帰的に実行します。ローカルfixture・PGlite・スタブ等を使い、実DBへ接続しません。Chromium fixtureも実Cake全体のE2Eとは別です。最終commitのSHA・clean状態・各コマンドの時間を記録します。文書だけの変更はリンク・コマンド・実装との整合性を確認し、必要な検証を選びます。ローカルとActionsは `.node-version` の完全版を共用します。`npm run check:node` は依存の導入前にも使え、版が異なれば停止します。Vercelの実行環境は `engines.node` の24系を使い、minor/patchはproviderが管理します。

日常の確認は `npm run check:fast`（Node版・lint・型・依存境界・文書参照）を使えます。対象領域だけの回帰は `test:shared`・`test:client`・`test:server`・`test:tooling`・`test:architecture` を使い、最終検証では `npm test` とbuildまで実行します。文書参照チェックの対象と除外は[開発手順](docs/development-workflow.md#日常の高速確認と文書参照チェック)を参照してください。

### Codex CloudでCake全体を起動・操作する

NodeとオンメモリのPGliteでCakeを起動できます。Docker・外部DB・Google/Vercelの秘密値は不要です。

```bash
npm run setup:cloud
npm run dev:cloud
# dev:cloudをCtrl+Cで停止してから、自前サーバーでブラウザQA
npm run qa:cloud -- --port 3001
```

`dev:cloud`は全migrationと固定の非管理者A/B・共有workspace・架空サンプルを準備します。再起動するとDBは初期状態へ戻ります。`qa:cloud`はPC/mobile × A/Bと取引CRUDを確認し、結果を`.cake/cloud/`に保存します。ポート指定、Chromiumのシステム依存、並列worktree、PRまでの流れは[Cloud手順](docs/cloud-development.md)を参照してください。正式Previewの証拠とReady条件は既存のものを使います。

以下は外部Neon DBを使ってlocalhostでCake全体を起動する場合の追加準備です。ログイン後の操作には承認された隔離DB・認証設定・migration/seedが必要です。通常の回帰テストやCloud起動の前提ではなく、他環境から資格情報をコピーしません。既存Previewの検証は[開発手順](docs/development-workflow.md)に従ってください。

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

```powershell
if (-not (Test-Path -LiteralPath .env.local)) {
  Copy-Item -LiteralPath .env.example -Destination .env.local
}
```

`AUTH_SECRET`などは対象タスクで承認された手段で設定し、値をチャット・ログ・Gitへ出しません。

```dotenv
DATABASE_URL=Neonの接続文字列
AUTH_SECRET=対象タスク用のランダム値
AUTH_GOOGLE_ID=GoogleのClient ID
AUTH_GOOGLE_SECRET=GoogleのClient secret
AUTH_URL=http://localhost:3000
AUTH_MODE=google
```

Productionで定期支払いを実行する場合は、Vercelの環境変数に16文字以上のランダムな `CRON_SECRET` を設定してください。実行条件・認証・検証方法は[詳細設計書の定期支払い](docs/detail-design.html#recurring-payments)を参照してください。

### 4. DBとアプリを起動

```powershell
npm.cmd ci
npm.cmd run db:setup
npm.cmd run dev
```

[http://localhost:3000](http://localhost:3000)を開きます。

### 初回ログインと利用者登録

`npm run db:setup`は未適用のマイグレーションを番号順に適用します。既存DBの更新時にも実行してください。 適用履歴を一度取得して未適用ファイルの本文だけを読み、全適用済みの通常再実行は本文0読込・DB往復2回で完了します。Previewの初回所有権確保時は全原文の照合も行います。各migrationはロック下で履歴を再確認し、SQLと履歴を一体で確定します。

取引先の照合用生成列を追加する`019_merchant_normalization.sql`は、既存全明細の値を計算し、テーブルとIndexを書き直します。適用中は`transactions`の`ACCESS EXCLUSIVE`ロックを保持するため、明細の参照・更新が待機します。現在のデータ規模では一つの原子的なmigrationとして適用します。

初回の利用者管理マイグレーションで、`t.yasu417@gmail.com`を管理者として登録します。このアカウントでGoogleログインし、設定の「利用者管理」からもう一人のGoogleアカウントのメールアドレスを登録してください。権限や利用停止の仕様は[詳細設計書の認証・セッション詳細設計](docs/detail-design.html#auth)を参照してください。

### テストユーザーでログインする

ローカルやVercel PreviewでGoogleアカウントを使わずに共有機能を確認する場合は、対象環境へ次を一度設定します。

```dotenv
AUTH_MODE=test
```

ログイン画面で`テストユーザーA`または`テストユーザーB`を選べます。どちらも通常のAuth.jsセッションを発行するため、通常ブラウザとシークレットウィンドウを使って、招待や共有ワークスペースを二人の別ユーザーとして確認できます。

ローカルテストでは初回ログイン時に固定ユーザーを登録します。テスト用のDBを準備して、次のコマンドで固定A/Bと参加済みの`テスト共有家計`を登録できます。

```powershell
npm.cmd run db:seed:test
```

固定ユーザーはdummyの`test-a@cake.local`と`test-b@cake.local`です。Googleログインや実メールは使わず、A/BボタンによるCredentialsログインを使います。ローカルfixtureは両方非管理者で、固定A/Bは通常アカウント二人の上限に含めません。Vercel Productionでは、誤って`AUTH_MODE=test`を設定してもテストログインは無効になります。Preview・ローカル用には、本番と別のテスト用DBを使用してください。

QAのDB初回照合・fixture・migration/seed・同PR更新時のデータ保持は、[開発・QA運用手順](docs/development-workflow.md)に従ってください。

## 開発・QA運用手順

専用worktreeで実装・関連テスト・自己レビューを終えてcommitし、別Agentレビュー→指摘への対応・必要な再レビュー→最終SHAでのローカル検証→draft PR→自動Preview→変更に必要な検証の順に進めます。文書のみの変更も別Agentレビューの対象です。レビュー担当のモデル・推論強度は通常未指定とし、PR本文に最新の要約、PRごとに1件のコメントに詳細を残します。Codexが現在HEADのレビュー・検証を揃えてマージ可能と判断したら、追加確認を待たずReadyにし、このチャットで日本語で通知します。文書のみの変更の検証範囲とReady条件は開発手順を参照してください。PRのタイトル・本文・コメント・レビュー・検証報告は日本語で書きます。「変更内容」は対象機能・変更前後の挙動・主な修正と理由を関連付けて記載します。`task:pr`には説明用の`--changes-file`とレビュー要約を含む検証報告用の`--verification-file`を指定します。マージは依頼された範囲で別に行います。

操作範囲とDB書込、実行前後の対象照合、PR close後の資源削除確認は[開発・QA運用手順](docs/development-workflow.md)にまとめています。WSLは[WSL手順](docs/wsl-development.md)、Codex Cloudは[Cloud手順](docs/cloud-development.md)、Windowsは[Windows QA手順](docs/windows-qa-credentials.md)を使います。ローカル自動テスト、CloudのCake操作、実Previewでの画面移動、明細の追加・編集・削除を分けて報告します。

## コマンド

```bash
npm run dev       # 開発サーバー
npm run setup:cloud # CloudのNode確認・依存・公式Chromiumの準備
npm run dev:cloud # オンメモリDB付き開発サーバー
npm run qa:cloud  # CloudのCake起動・PC/mobile A/B・取引CRUD
npm run build     # production build
npm run lint      # ESLint
npm test          # 回帰テスト・依存境界検査
npm run db:setup  # 未適用のDBマイグレーションを適用
npm run db:seed:test # テストユーザーA・Bと共有ワークスペースを登録
```

## PR Preview

Previewの手動操作は下記のnpmコマンドを使います。作成・状態照合・削除は `scripts/preview/preview-command.ts` を入口としてmainのActionsへ要求し、PR作成・Ready管理は `npm run task:pr` を使います。

同一repositoryの `codex/*` からmainへのPR作成・更新・再openで、draftを含めて専用Vercel PreviewとNeon Native DBを自動作成・更新します。PR未作成のpushだけでは作成せず、Vercel Git連携のfeature deployは止めたままmainのActionsで管理します。PR作成・更新は専用DBへのmigration/seedを、merge/closeは資源削除を起動するため、対象と影響が承認された範囲で実行してください。

Previewの未使用の「テスト共有家計」には階層付きカテゴリ10件と、当月の `[サンプル]` 明細8件を自動設定します。A/Bの支払い・個人費・共通費・受け取り・未分類を確認でき、編集・削除した内容はPR更新後も保持します。入力済み・初期ユーザーや所属を変更済みの環境への追加は省略します。詳細は[初期化とデータ保持](docs/development-workflow.md#3-自動previewとdb書込)を参照してください。

```bash
npm run qa:status
npm run deploy:preview    # 手動の作成/更新が必要な場合
npm run qa:verify         # Vercel認証を供給済みの環境用
npm run qa:release -- --pr <閉じたPR番号>  # 必要な場合だけcleanupを再要求
```

WSL保存済みVercel認証をメモリ内で使う方法は[WSL手順](docs/wsl-development.md)を参照してください。通常の正式検証はPC/mobile × A/Bの画面移動とAPI/runtime確認です。明細追加などの業務更新は依頼範囲に応じた別テストで確認します。認証後のホーム/ `GET /api/app` だけでも初期workspace・membershipをINSERTし得るため、HTTP GETをDB無変更の保証にしません。

close後は自動cleanupの成否に加え、削除前に記録した全Deployment ID・DB branch/endpointの直接GET不在と一覧の再照合を確認します。DB側の照合はActions内の既存資格情報で行えます。失敗・未確認を削除成功と扱わず、main merge・Production操作・追加削除は依頼範囲を確認してください。

# Codex Cloud開発・ブラウザ検証

Codex Cloudでは、次の順に進める。

1. 専用branch/worktreeで実装する。
2. 自動テストとオンメモリDB付きCakeのブラウザ操作を確認する。
3. PRを作る。PR作成後は既存のmainのActionsがVercel Previewと専用Neon Native DBを作成する。
4. 正式Previewの検証とレビューを揃えたCodexがReadyにする。
5. 本人がPreviewと必須CI・レビューを確認してmergeする。

[開発・QA運用手順](development-workflow.md)の承認範囲・Ready条件・資源照合を共用し、[WSL手順](wsl-development.md)は引き続きWSLで使う。

## 1. Cloud環境の準備

[.node-version](../.node-version) と同じ完全版のLinux版Node.js・npm・Gitを使う。
Docker、外部DB、Google OAuth、Vercelの資格情報はCloud内のCake起動とブラウザ検証に不要。
先に[次節](#2-branchworktree並列実行)で対象worktreeを用意し、表示された作業先へ移動する。
以下のsetup・起動・検証コマンドは、その対象worktreeで実行する。
依存と公式Playwright Chromiumを導入する。

```bash
npm run setup:cloud
```

`setup:cloud`はNode版の一致を確認し、`npm ci`と公式Playwright Chromiumのインストールを行う。
導入先は、実行した`setup-cloud.mjs`が属するrepositoryのrootである。
元checkoutでのsetup成功だけでは、別worktreeの依存導入を完了したことにならない。
終了コード0と「Cake Cloud: 依存関係とPlaywright Chromiumを準備しました。」を成功条件とする。
Codex Cloudの環境設定にあるsetup script欄にも、このコマンドを指定できる。
Chromiumのシステム依存が環境に不足し、システムパッケージを導入できる環境では次を使う。

```bash
npm run setup:cloud -- --with-deps
```

Node版が異なる場合は先に実行環境を合わせる。
依存・ブラウザの導入には配布元への通信が必要。
公式Chromiumの配布先`cdn.playwright.dev`と
redirect先`storage.googleapis.com`（Chrome for Testingの配布先）をCloud環境のネットワーク設定で許可する。
`403 Domain forbidden`などで遮断された場合は、サポートされるCloud環境設定で許可先を追加してから再実行する。
CA・proxy・global PATH・権限の変更や別経路からのdownloadで回避しない。
ネットワークやシステム依存の不足は起動・アプリ操作の結果と分けて報告する。

npmの既定キャッシュが書込不可の場合は、書込可能な作業用pathをそのプロセスだけに指定する。たとえば`/workspace`へ書き込める環境では次を使える。

```bash
npm_config_cache=/workspace/.npm-cache npm run setup:cloud
```

## 2. branch・worktree・並列実行

元のcheckoutで次を実行し、表示された作業先へ移動する。
`task:start`は最新`origin/main`から`codex/<task-name>`と専用worktreeを作り、そこで`npm ci`を行う。
Cloudが既に対象タスク専用branch/worktreeを用意している場合は、そのbranch・比較元・既存変更を確認し、同じタスクを重複作成しない。
初回cloneなどで依存がない場合の準備と、作業先・比較元の確認は[開発コマンド](development-commands.md)に従う。

```bash
npm run task:start -- feature-name
```

`task:start`が表示する`cd`を実行してから、前節の`setup:cloud`へ進む。
`npm ci`の途中失敗では作成済みworktreeを保持するため、同じタスクを作り直さない。
原因を解消したら、表示された既存worktreeへ移動し、そこで`npm ci`を再実行する。

同一Cloud環境で並列作業する場合も、タスクごとにworktreeを分け、`node_modules`・`.next`・`.cake`・環境ファイルを分離する。
Next.jsのポートも分ける。
別Cloud環境は別マシンなので、同じポートを使える。
同一実行環境内ではnpm/Playwrightのダウンロードキャッシュを共有できるが、作業中の`node_modules`やbuild成果物は共有しない。

PR・push・Actions操作にはCloudに連携されたGitHubの権限を使う。
ghを使う環境では`gh api repos/tyask/Cake --jq .full_name`で対象repositoryへのアクセスを確認する。
WSL/Windowsから資格情報をコピーしない。
権限不足時は対象と不足操作を値なしで報告し、ログや環境ファイルへtokenを出さない。

## 3. 外部DBなしでCakeを起動する

対象worktreeで次を実行する。

```bash
npm run dev:cloud
```

既定ポートは3000。並列タスクなどで変更する場合は次を使う。

```bash
npm run dev:cloud -- --port 3001
```

このコマンドはNext.js devを`0.0.0.0`で待ち受け、別のNodeプロセスが持つPGliteのオンメモリDBへアプリのSQLを送る。
DB初期化時に全migrationを適用し、既存local test profileの固定A/B、参加済みの共有workspace、架空のカテゴリ・明細サンプルを登録する。
A/Bは両方とも非管理者で、Googleや実メールを使わず、ログイン画面のテストユーザーボタンから通常のAuth.jsセッションを発行する。

CodexがCloud内のブラウザから`http://localhost:3000`（ポート指定時はそのポート）を開き、A/Bを別ブラウザcontextで操作する。
Next.jsのログイン時の正規化に合わせ、アプリの接続先は`localhost`へ揃える。

ホーム・取引明細・設定の表示、明細追加・編集・削除など、変更した機能を確認する。
Next.jsのHMRやworkerが切り替わっても同じsidecar DBを使う。

`Ctrl+C`で停止するとDBを破棄し、次回起動時は初期データへ戻る。
Previewのデータや編集内容とは同期しない。

Cloud専用worktreeには`.env`・`.env.local`・`.env.development`・`.env.development.local`を置かない。
Next.jsによる外部接続設定の自動読込を防ぐため、これらがある場合は起動前に停止する。
WSL側の環境ファイルを削除・コピーせず、環境ファイルのない専用worktreeを使う。
対象worktreeに既存の環境ファイルがある場合も、削除・退避して起動せず、別のCloud専用worktreeを用意する。
外部DB接続文字列、Google/Vercel等の秘密値を設定した`.env.local`は不要。

Cloud runnerは外部接続・provider認証の値を子プロセスへ渡さず、Cloud用DBとテスト認証を使う。
Vercel上でCloudモードを実行することは拒否する。
通常の`dev`、外部DBを使う既存手順、Production/Previewの接続・認証の規則は各環境の手順に従う。

## 4. 自動テストとCloudブラウザQA

編集中は`npm run check:fast`や対象領域の回帰を使う。最終検証は次の順に進める。

1. 実装・関連テスト・自己レビューを終える。
2. commitする。
3. 別Agentレビューと必要な修正を終える。
4. 最終SHAのcleanなworktreeで次を実行する。

```bash
set -e
[ -z "$(git status --porcelain)" ]
TESTED_SHA=$(git rev-parse HEAD)
npm run check:node
npm run lint
npm run typecheck
npm run check:docs
npm test
npm run build
npm run qa:cloud
[ "$(git rev-parse HEAD)" = "$TESTED_SHA" ]
[ -z "$(git status --porcelain)" ]
```

`qa:cloud`は自分でNext.jsと新しいオンメモリDBを起動し、
公式Playwright ChromiumでPC/mobile × A/Bのログイン・画面移動と取引の追加・編集・削除を確認する。

終了時は起動したサーバー・DBを破棄する。
同じworktreeの`dev:cloud`を停止してから実行する。
別タスクと並行して動かす場合はworktreeとポートを両方分ける。

通常CIも既存の自動テスト・build後に`qa:cloud`を実行し、`.cake/cloud/`の結果と画像を7日間保持するartifactへ保存する。
Cloudでのローカル結果に加えて、PRの現在HEADのCI結果を確認する。

```bash
npm run qa:cloud -- --port 3001
```

直前のQAが終了コード0で終わり、`CLOUD_BROWSER_PASSED cases=4 resources=0`を表示したことを確認する。
対象worktreeで、今回の公開結果を次のコマンドで読み取る。
これは結果の確認だけを行い、サーバーやブラウザを起動しない。

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const proof = JSON.parse(readFileSync('.cake/cloud/verification.json', 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
const status = execFileSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' }).trim();
console.log(JSON.stringify({
  success: proof.success, sha: proof.source.after?.sha, unchanged: proof.source.unchanged,
  cases: proof.cases.map(item => ({ name: item.name, success: item.success, checks: item.checks.length })),
  resources: proof.resources, failure: proof.failure,
}, null, 2));
assert.equal(proof.protocol, 'cake-cloud-browser/v1');
assert.equal(proof.success, true);
assert.equal(proof.source.after?.sha, head);
assert.equal(proof.source.after?.branch, branch);
assert.equal(status, '');
assert.equal(proof.source.unchanged, true);
assert.equal(proof.cases.length, 4);
assert.ok(proof.cases.every(item => item.success));
assert.ok(Object.values(proof.resources).every(count => count === 0));
JS
```

`source.unchanged`は前後のSHA・branch一致とclean状態、`resources`の0はこのQAが起動した資源の後片付けを表す。
失敗時は`failure.stage`・対象case・`resources`を確認し、0以外や`null`を残存なしと報告しない。
HEADが進んでいれば、結果ファイルが成功でも現在HEADの検証済み証拠には使わない。

結果と画面画像はGit外の`.cake/cloud/`へ保存する。報告には今回の次の項目を記載する。

- 実行環境
- Node/npm/Chromium版
- 完全SHA
- コマンド別の成否と所要時間
- 実際の検証件数
- 残ったプロセスやデータ

失敗や未実施を成功へ含めず、実行後にHEADが進んだ場合は必要な確認を新しいSHAで揃える。

| 確認 | 対象と限界 |
| --- | --- |
| `npm test` | fixture・PGlite・スタブ等による回帰と依存境界。Cake全体の起動とは別に記録する |
| `qa:cloud` | 同じworktreeのCakeをNode + PGliteで起動し、PC/mobile・非管理者A/Bの画面操作と取引CRUDを確認する |
| 正式Preview検証 | Vercel固有URL・専用Neon Native DB・保護アクセス・runtime proof・前後statusを照合する。Readyには既存の正式証拠を使う |

Cloudのスモークテストは管理者機能、Google OAuth、Vercel/Neonなどproviderの実DB・deployment固有の挙動を対象としない。
変更に必要なら既存Preview等で別途確認する。
Cloudの結果・画像は正式Preview証拠の代わりにならず、Readyの証拠gateを省略する根拠にもならない。

`dev:cloud`と`qa:cloud`はPGliteを所有するNodeプロセスに`--no-wasm-code-gc`を直接指定する。
Node 24のWasmコード解放競合を避ける回避策で、通常のJavaScript GCは維持する。
Wasmコードのメモリはそのプロセスが終了すると解放される。
Next.jsの子プロセス、本番・Previewのアプリ起動・buildには適用しない。
手動でPGliteを使う検証スクリプトを実行する場合も、`node --no-wasm-code-gc ...`と直接引数に指定する。
詳細は[最終SHAの検証手順](development-workflow.md#最終shaの検証)に従う。


## 5. PR・自動Preview・本人確認

次の文書をGit外へ日本語で用意する。

- `.cake/changes.md`：変更説明
- `.cake/report.md`：今回の検証結果と別Agentレビュー要約

通常の変更依頼では[既定の依頼範囲](../AGENTS.md#開発依頼の完了条件)に当該PRと専用Preview/DBの自動処理を含める。
利用者の明示した制限と対象を確認したうえで、追加のPR作成依頼を待たず、既存コマンドでdraft PRを作成・更新する。

```bash
npm run task:pr -- --draft --title '変更内容を日本語で記載' --changes-file /absolute/path/changes.md --verification-file /absolute/path/report.md
```

同一repositoryの`codex/*`からmainへのPR作成・更新・再openが既存Actionsの自動Previewを起動する。
PR未作成のpushだけでは作成しない。
CloudからVercel/Neonの秘密値を渡したり、新しいdeploy経路を作ったりせず、
mainのActionsが発行する正式receiptと`qa:status`で現在HEADの次の項目を確認する。

- Deployment
- 固有URL
- DB
- generation

CloudにVercel資格情報を置かずに正式ブラウザ検証を行う場合は、
[既存のActions検証](development-workflow.md#6-readymergecloseと削除確認)を使う。
最新mainと一致するcleanなcontrol checkoutで実行し、証拠と説明・報告のpathはcontrol側の絶対pathで指定する。

```bash
npm run qa:verify:ci -- --pr <PR番号> --sha <完全SHA> --deployment <Deployment ID>
npm run task:pr -- --title '変更内容を日本語で記載' --changes-file /absolute/path/changes.md --verification-file /absolute/path/report.md --remote-proof /absolute/path/verify-<PR番号>.json --target-worktree /absolute/path/target-worktree
```

成功証拠の保存先はcontrol側の`.cake/verify-<PR番号>.json`。
`--target-worktree`は別の対象worktreeを管理する場合に使い、remote proof必須・非draft専用である。

最新HEADの次の条件が揃えばCodexがReadyにする。条件未達ならdraftを維持する。

- CI
- レビュー
- 必要な検証
- 正式Preview証拠

Readyにしたら、次の項目を日本語で通知する。

- PRリンク
- 結果
- 未実施項目
- 残る資源

本人はPRの必須CI・レビューと自動Previewを確認してmergeする。
main mergeはProduction deploy、PR merge/closeは専用Preview/DBのcleanupを起動するため、対象と影響を含む依頼範囲に従う。
削除確認が必要な場合も、[既存の直接GET・provider一覧の再照合](development-workflow.md#6-readymergecloseと削除確認)を使う。
Cloud用のローカルプロセス・オンメモリDBの破棄と、外部Preview資源の削除は別に記録する。

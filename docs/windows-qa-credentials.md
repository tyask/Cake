# Windows QA資格情報・実行手順

Windowsネイティブの独立したCodexタスクから、保存済みのCake用Vercel tokenで既存Previewの正式QAを再実行する手順。作業開始時は [AGENTS.md](../AGENTS.md) と [開発・QA運用手順](development-workflow.md)を読む。ghの既存本人認証と、Vercel保護用の資格情報は別々に扱う。

## 実行前の条件

- Node.js 24・npm・Git・既存認証済みghと、Windows付属.NET FrameworkのC# compilerが使えること。PowerShellでは `npm.cmd` / `npx.cmd` を使う。
- `status`・`input`・`preflight`・`verify`・`self-test` は、通常の本人Windowsセッションに紐づく実行コンテキストで行う。サンドボックスの仮想プロファイルでは実行しない。
- 専用worktreeで `npm.cmd ci` を済ませ、`npx.cmd playwright install chromium` で公式Chromiumを用意する。必要な準備が許可されていない場合は不足項目を報告して止める。グローバル設定や実行ポリシーは変更しない。
- 対象は同一repositoryのOPEN PRと、完全SHAが一致するcleanな専用worktree。既存のREADY application Deployment、Native DB branch、DB generationを事前に確認する。
- A/BログインとPC/mobile表示、初回に限る個人workspace・OWNER membership作成を含め、対象DBで許可された書込範囲を確認する。HTTP GETの制限だけではDB無変更を保証しない。

verify操作はPreview/DB資源を作成・更新せず、migration・seed・取引作成・cleanupを行わない。ただし認証後のGETによる初期workspace作成は起こり得る。それらが必要なら、対象と影響について別途承認された手順に従う。認証や対象照合の失敗を、別認証・広い権限・TLS検証の回避で修復しない。

## 保存済み資格情報の確認

リポジトリ内のコマンドを使う。以前のタスクの作業フォルダーや手動配置した実行ファイルは不要。

```powershell
npm.cmd run qa:windows -- status
npm.cmd run qa:windows -- preflight
```

`status` は保存有無と本人だけのACL等の状態を確認し、tokenの平文を表示しない。`preflight` は本人のDPAPI CurrentUserで復号し、`preview.config.json` のCake project/teamに固定した正規development env取得APIからOIDCをメモリ内だけへ取得する。project・owner/team・development・有効期限を検査し、公開結果には成否と検査結果だけを含める。token自体の全権限や有効期限を証明する検査ではない。

保存先は `%LOCALAPPDATA%\CakeQa\vercel-token.dpapi.json`。暗号化ファイルと保存フォルダーはWindows本人だけのACLを持ち、既存ファイルは上書きしない。別ユーザーや別PCからファイルをコピーして使う手順ではない。保存状態が確認できないことだけを根拠にtoken未保存と判断せず、通常の本人Windowsコンテキストで `status` を再確認する。そこで未保存と確認できた場合だけ次節へ進む。失効・復号失敗・不正ACL・アクセス拒否なら停止する。自動でACLを緩めたり、別認証で再試行したりしない。

Windowsの保存先がサンドボックスの `Packages/.../AC` 等へ仮想化されている場合は、`WINDOWS_PROFILE_CONTEXT_REJECTED` で停止する。利用可能な通常Windows実行経路で確認できるまで、入力やQAを進めない。別プロファイルを探索したり、既存storeをコピーしたり、権限を回避したりしない。通常の本人コンテキストを利用できなければ、保存状態を未確認として報告する。

## 初回保存と失効時の再設定

初回保存には本人のトークン作成・入力・最終保存操作が必要。既存資格情報が使える場合は作り直さない。

1. 本人が個人アカウントの [Vercel Tokens](https://vercel.com/account/tokens)を開き、名前・有効期限を設定し、Scopeで `fumin1` → **Cake個別project**を選ぶ。All Projectsを選ばない。[公式のproject scoped token手順](https://vercel.com/docs/accounts/access-tokens#project-scoped-access-token)も参照する。
2. `npm.cmd run qa:windows -- input` でローカルの伏字入力画面を開く。
3. 本人がtokenを入力し、scope・期限の確認にチェックして「保存する」を押す。最終確認の「はい」も本人が選ぶ。
4. チャットには保存完了だけを伝える。token値はチャット、スクリーンショット、ログ、コマンド引数、`.env`、Gitへ残さない。
5. `status` → `preflight` を実行する。保存だけでは接続や権限の成功を意味しない。

このtokenはCakeへの読み書きを許可し、Production操作も権限に含み得る。DPAPI CurrentUserと本人ACLは他ユーザーから保護するが、**同じWindowsユーザーとして実行されるプログラムは復号できる**。Previewだけの読み取り専用資格情報とは扱わない。

期限切れ・取り消し時は停止し、本人がDashboardで対象tokenの取り消し・新しいCake専用tokenの作成を行う。`input` は既存ファイルを上書きしないため、保存済み暗号化ファイルの扱いも本人が明示的に決めてから再設定する。コマンドが自動で既存tokenを置換・削除することはない。ローカルの暗号化ファイルを削除するだけではVercel上のtokenは失効しない。

## 対象を固定して正式QAを行う

対象PR・完全SHA・Deployment・DB branch・generationの5項目はすべて指定する。URLやbranch aliasから対象を推測しない。

```powershell
npm.cmd run qa:windows -- verify --pr <PR番号> --sha <40桁の完全SHA> --deployment <Deployment ID> --database <Native branch ID> --generation <DB generation UUID>
```

既定の対象worktreeは現在のworktree。対象と検証実装のcheckoutを分ける場合は、共通ランチャーを持つcleanなcheckoutから次を実行する。

```powershell
npm.cmd run qa:windows -- verify --pr <PR番号> --sha <40桁の完全SHA> --deployment <Deployment ID> --database <Native branch ID> --generation <DB generation UUID> --target-worktree <対象worktreeのpath>
```

実装側checkoutの完全SHAとruntime対象の完全SHAは別々に記録する。旧PRに存在しないCLIを実行させることなく、共通の正式ブラウザ検証を使う。いずれも対象worktreeが指定SHAと一致するcleanな専用branchであることを検査する。

検証は対象PR・HEAD照合 → status前照合 → PC/mobile × A/Bのブラウザ操作 → status後照合の順。前後でDeployment・URL・DB branch・endpoint・generation等を照合し、不一致なら失敗にする。16クリック、session/app GET、runtime proofを確認し、許可した認証callback以外の業務更新は行わない。初回workspace作成の有無を示すSQL差分や、全スクロール範囲の目視確認を行ったとは扱わない。

Vercel tokenを供給するのは専用preflight/QA子プロセスだけ。Git/ghの管理処理には渡さず、親シェルへexportしたり環境ファイルへ保存したりしない。OIDCも対象originだけに使い、秘密値・Cookie・生のprovider/browser例外は公開結果に含めない。ブラウザの場所はPlaywrightが解決するため、個別PCのキャッシュpathを指定しない。

## 証跡とReady

- 対象worktreeの `.cake/verification.json` と画面画像：既存の正式ローカルQA証跡。
- 対象worktreeの `.cake/windows-qa-launch-<UUID>.json`：検証実装SHA、対象SHA、実行時間、前後照合などの公開結果。
- 対象worktreeの `.cake/windows-qa-progress-<UUID>.json`：同じ操作の進捗と停止段階を示す公開結果。
- 実行checkoutの `.cake/windows-tools/run-<一意ID>/`：構築した実行ファイル、公開request metadata、`result.json`。tokenやOIDCは保存しない。

失敗時に以前の成功を再利用しない。QA成功に加えて、現在HEADのpush/PR CIの最新attempt成功、現在のPreview/DBと証跡の一致、変更箇所固有の検証、差分の自己レビューと現在HEADを対象とする別Agentレビューを確認する。QA中に修正した場合も追加差分と影響範囲を再レビューし、PR本文の要約と詳細コメントを更新する。Codexがマージ可能と判断したら、追加のReady依頼を待たず、通常の対象branchではそのworktreeの `task:pr` でローカル証跡を再照合してReadyにし、このチャットで日本語で通知する。利用者がdraft維持を指定している場合は従う。文書のみの変更は開発手順の検証範囲とReady操作に従う。

```powershell
# QA・最新CI・対象照合・自己レビュー・別Agentレビューを完了し、マージ可能と判断したら実行する
npm.cmd run task:pr -- --title '変更内容' --changes-file '.cake\changes.md' --verification-file '.cake\report.md'
```

**別の対象checkoutを最新mainのcontrolから管理する `task:pr --target-worktree` はremote proof必須。** この共通ランチャーのローカル証跡は `qa:verify:ci` のremote proofではなく、代用できない。別checkoutからのReady手順は[Readyと別checkout管理の条件](development-workflow.md#6-readymergecloseと削除確認)に従う。merge/closeと資源cleanupの承認も別途確認する。

## 再構築とダミー試験

エントリーポイントは [scripts/qa/windows/windows-qa.ts](../scripts/qa/windows/windows-qa.ts)、C#ソースは `scripts/qa/windows/windows-token-helper/*.cs`。各実行時にWindows既存の.NET Framework `csc.exe` と実行中Nodeの場所を解決し、`.cake/windows-tools/run-<一意ID>/` へ新規構築する。日付付き絶対path、利用者名、SID、特定PR/SHAやブラウザキャッシュをソースへ固定しない。既存の暗号化tokenは変更せず、自動再構築に新ソフト・拡張機能・実行ポリシー変更は要らない。

```powershell
npm.cmd run qa:windows -- self-test
```

ダミー値の試験でDPAPI、本人ACL、二重保存拒否、改変時の停止、子プロセスへの環境変数限定供給、伏字画面等を確認する。実tokenの内容を読む試験や実Previewへの接続ではない。`self-test` も同じプロファイル分離判定を行うため、通常の本人Windowsコンテキストで実行する。lint・型検査・通常回帰テスト・buildも同じ最終SHAで別途行う。

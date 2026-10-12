# 診断専用bootstrapの検証

この文書はPR #35の診断専用bootstrap導入前に記録した過去の検証報告である。以下の319件というテスト数、remote head、公開保留、Preview source policyの確認結果は当時の対象commitと操作範囲の記録であり、現在のPR #34の結果や必須条件を表さない。

2026-10-12のPR #34のHobby対応では、有料のPreview source policyを必須にする診断を、同一repositoryのmain/対象PRの完全SHAにあるmain-only Git設定とblob SHAの確認へ置き換える。新しい証拠は `gitConfiguration.scope: repository-git-trigger-configuration` とcommit/blobの識別情報を示し、 `backendForcedDeploymentPreventionProven: false` を維持する。project全体の強制停止やNativeのlive実証を意味しない。現行手順は [QA診断手順](qa-diagnostics.md) と [QA貸出運用](qa-pool.md)、今回の検証結果とテスト数は [QA pool検証報告](qa-pool-verification.md) を参照する。

今回のActions host対策は既存repository Variableを一時的な `workflow_call` secretへ渡すコード変更であり、remote Secretの登録・移動や値・権限の変更を伴わない。Native要約・本番比較結果のhost省略、台帳/削除manifestの非秘密QA DB identity、runnerのstep envのmaskを区別し、過去ログの消去や実Actionsでのmask確認は行っていない。PR #34への許可済みcommit/push/本文更新と、別途承認が必要なmainへのmerge・Production自動配置・生成実証・削除を分ける。

2026-10-12。`origin/main`の`1877f0ff88b5250225db5d590a06e3c1e656ecb9`から、`npm run task:start -- qa-readonly-bootstrap`で独立したbranch/worktreeを作成。元worktreeの資格情報・Vercel設定・依存ディレクトリはコピーしていない。依存は専用worktreeで`npm ci`を実行した。default cacheがworkspace外で利用できなかったため、書込可能な`/tmp/cake-bootstrap-npm-cache`で再実行して成功した。

## 対象と不変条件

- 新規のGET専用modules/CLI、main限定の手動診断workflow、対応回帰・手順を追加。既存文書には案内だけを追加。
- `vercel.json`、package/lock、DB/migrations、DB/build/seedの既存import、`task-preview`・`task-pr`・`task-workflow`、アプリ・API・UIはbase mainと同一。
- 追加moduleは診断CLIとテストからだけ参照。既存build/アプリ/DB経路には接続していない。DB migration・seed・SQLは今回実行していない。
- workflowはmanual/mainだけで、GitHubのcontents/pull-requests/deployments readのみ。Environment、writer、PR/close/scheduleの入口、credential作成・配置、remote設定処理を含まない。

## ローカル確認

`npm run lint`、`npm test`（**319成功・失敗0・skip0**）、`npx tsc --noEmit`、`npm run build`はすべて成功。`git diff --check`、HTML読取と追加文書リンクも成功。既存のtracked file 153件はbase mainと同一で、既存ファイルの差分はREADME・基本/詳細設計への診断案内の追加だけ。

GET専用adapterの変更method拒否、資格情報なし/空入力の診断、秘密の出力抑制、401/403/404区別、全ページ読取、破損台帳・古いSHA・満枠・Production/別lease/資源不一致拒否、Native消失の照合、生成設定なしでも既知資源を計画できること、PRの後続push後も記録済みheadを返却対象に使うことを回帰で確認した。

当時のGETでVercel project/linkと空の貸出台帳を確認。旧診断のPreview source policyは未確認だったが、このpolicy確認はHobby対応後の必須条件ではない。Variables APIは403、Neon API key・親ID・本番host比較情報は不足として個別に報告できた。候補alias3件は404。API応答本文・秘密値を保存/出力していない。資格情報を外してoptional dispatch入力を空文字にした実CLIもexit0で不足を報告した。

今回の新枝はremoteに存在せず、Vercel deployment一覧は200・0件。main、PR #33、PR #34のremote headは上記/既知値のままであることを確認した。

## 公開前の保留

新規branchのpushは既存Git連携によるPreviewとNative Neon branchの作成を起動し得る。draft PRやビルド停止だけで作成前の停止を保証できず、現在projectの生成前gateも読取確認できていない。ユーザーが禁止したglobal gateは適用していない。安全な公開方法が未確認のためpushと新規PR作成を保留し、対象と影響を先に報告する。GitHub head CIも公開前には実行できない。

公開を許可する場合の対象は`tyask/Cake`の新規`codex/qa-readonly-bootstrap`枝と、既存Vercel `fumin1/cake` project `prj_Z37vquodhpRd08ZTAtYnP0qa59jD`、Native連携の`cake-preview` Neon project `misty-meadow-88903426`。既存の自動Preview・新しいfeature branch DB・既存build/migration/seedが起動する可能性があり、親DBの空状態や複製内容は未確認。mainへのmergeは今回実施せず、後日のmergeでも通常のProduction build/既存DB処理が起動し得る。

PR #34はhead `4dd1724ba52846377f7ba5b1016f9b838969f1e1`のまま保留し、書き換えていない。PR #33、main、Production、remote設定・credential・権限・ネットワーク、実環境の作成・削除には変更を加えていない。

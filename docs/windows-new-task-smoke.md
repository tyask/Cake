# Windows の独立タスクから draft PR を作る確認

新しい Windows タスクでは、`AGENTS.md` から開発・QA運用手順と README の Windows セットアップをたどる。
`task:start` で最新 `origin/main` から専用 worktree を作り、説明文書だけの変更でも最終 commit の lint・型検査・回帰テスト・build を確認する。

結果は Git 外の `.cake/report.md` に記録し、`task:pr --draft` で作成した PR の HEAD とローカル検証 SHA、同 SHA の push／pull_request CI を照合する。
現在の feature push／draft 作成は通常 CI を起動し、Preview は明示 dispatch で作成する。
新しい Preview／専用 DB と実ブラウザ QA は、対象・資源数・DB 書込範囲を確認してから別途実施する。
